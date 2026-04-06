import type { AssembledContext } from "../agents/context-stack";
import { join, resolve, relative } from "path";
import { writeFile, unlink } from "fs/promises";

// ---------------------------------------------------------------------------
// Runtime hook types — for wrapping agent runtimes (Claude Code, Codex, etc.)
// ---------------------------------------------------------------------------

/** An event emitted by an agent runtime that Foundry can observe. */
export interface RuntimeEvent {
  readonly kind: RuntimeEventKind;
  readonly timestamp: number;
  readonly data: Record<string, unknown>;
}

export type RuntimeEventKind =
  | "session_start"
  | "session_end"
  | "tool_call"
  | "tool_result"
  | "completion"
  | "error"
  | "user_input"
  | "context_inject";

/** Callback for runtime events. */
export type RuntimeEventHandler = (event: RuntimeEvent) => void | Promise<void>;

/**
 * A context injection payload — what Foundry feeds into an agent runtime.
 *
 * Each runtime adapter maps this to its own injection mechanism:
 * - Claude Code: CLAUDE.md content, hook scripts, env vars
 * - Codex: system prompt, instructions file
 * - Cursor: .cursorrules, context files
 */
export interface ContextInjection {
  /** Formatted text ready for injection (runtime-specific format). */
  readonly formatted: string;
  /** Metadata about what's in the injection. */
  readonly meta: {
    readonly layerIds: string[];
    readonly tokenEstimate: number;
    readonly hash: string;
  };
}

/**
 * The runtime adapter interface.
 *
 * Each agent runtime (Claude Code, Codex, Cursor) implements this.
 * The adapter handles the runtime-specific plumbing:
 * - How to inject context (CLAUDE.md, system prompt, .cursorrules)
 * - How to observe the agent loop (hooks, log parsing, API intercept)
 * - How to extract signals from the agent's actions
 */
export interface RuntimeAdapter {
  readonly id: string;
  readonly runtime: string;

  /**
   * Prepare a context injection for this runtime.
   * Takes assembled context and formats it for the runtime's injection mechanism.
   */
  prepareInjection(assembled: AssembledContext): ContextInjection;

  /**
   * Inject context into the agent runtime.
   * Returns a teardown function that undoes the injection.
   */
  inject(injection: ContextInjection): Promise<() => Promise<void>>;

  /**
   * Subscribe to events from the agent runtime.
   * Returns an unsubscribe function.
   */
  onEvent(handler: RuntimeEventHandler): () => void;
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/** Extract unique layer IDs from assembled blocks. */
function extractLayerIds(assembled: AssembledContext): string[] {
  return [
    ...new Set(
      assembled.blocks.filter((b) => b.id).map((b) => b.id as string)
    ),
  ];
}

/** Validate that a file path stays within a root directory. */
function safePath(root: string, filename: string): string {
  // Strip directory separators — filename must be a simple name
  const safe = filename.replace(/[\/\\]/g, "_");
  const filePath = join(root, safe);
  const rel = relative(resolve(root), resolve(filePath));
  if (rel.startsWith("..") || rel.includes("/..")) {
    throw new Error(`Invalid injection file path: ${filename}`);
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// Base runtime — shared event handling and inject/teardown logic
// ---------------------------------------------------------------------------

abstract class BaseRuntime implements RuntimeAdapter {
  abstract readonly id: string;
  abstract readonly runtime: string;

  protected _projectRoot: string;
  protected _filename: string;
  private _handlers: RuntimeEventHandler[] = [];

  constructor(projectRoot: string, filename: string) {
    this._projectRoot = projectRoot;
    this._filename = filename;
  }

  abstract prepareInjection(assembled: AssembledContext): ContextInjection;

  async inject(injection: ContextInjection): Promise<() => Promise<void>> {
    const filePath = safePath(this._projectRoot, this._filename);

    await writeFile(filePath, injection.formatted, "utf-8");

    this._emit({
      kind: "context_inject",
      timestamp: Date.now(),
      data: {
        file: filePath,
        layerIds: injection.meta.layerIds,
        tokens: injection.meta.tokenEstimate,
      },
    });

    return async () => {
      try {
        await unlink(filePath);
      } catch {
        // File may already be gone
      }
    };
  }

  onEvent(handler: RuntimeEventHandler): () => void {
    this._handlers.push(handler);
    return () => {
      const idx = this._handlers.indexOf(handler);
      if (idx !== -1) this._handlers.splice(idx, 1);
    };
  }

  protected _emit(event: RuntimeEvent): void {
    const snapshot = [...this._handlers];
    for (const handler of snapshot) {
      try {
        const result = handler(event);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch(async (err) => {
            (await import("../logger")).log.warn(`[Runtime] async handler error for "${event.kind}":`, (err as Error).message ?? err);
          });
        }
      } catch (err) {
        import("../logger").then(({ log }) => log.warn(`[Runtime] handler error for "${event.kind}":`, (err as Error).message ?? err));
      }
    }
  }

  protected _buildMeta(
    formatted: string,
    assembled: AssembledContext
  ): ContextInjection["meta"] {
    return {
      layerIds: extractLayerIds(assembled),
      tokenEstimate: Math.ceil(formatted.length / 4),
      hash: Bun.hash(formatted).toString(16).slice(0, 16),
    };
  }
}

// ---------------------------------------------------------------------------
// Claude Code runtime adapter
// ---------------------------------------------------------------------------

export interface ClaudeCodeConfig {
  /** Path to the project root where CLAUDE.md lives. */
  projectRoot: string;
  /** Filename for Foundry's injected context. Defaults to ".foundry-context.md". */
  contextFile?: string;
  /**
   * Injection strategy:
   * - "file": Write a .foundry-context.md that CLAUDE.md references
   * - "append": Append directly to CLAUDE.md (riskier, harder to teardown)
   * - "env": Set CLAUDE_CONTEXT env var (if supported)
   */
  strategy?: "file" | "append" | "env";
  /** Hook scripts directory for Claude Code hooks. */
  hooksDir?: string;
}

/**
 * Claude Code runtime adapter.
 *
 * Injects Foundry context by writing a context file that gets referenced
 * from CLAUDE.md. Observes the agent loop via Claude Code's hook system
 * (PreToolUse, PostToolUse, Notification hooks).
 */
export class ClaudeCodeRuntime extends BaseRuntime {
  readonly id = "claude-code";
  readonly runtime = "claude-code";

  constructor(config: ClaudeCodeConfig) {
    super(config.projectRoot, config.contextFile ?? ".foundry-context.md");
  }

  prepareInjection(assembled: AssembledContext): ContextInjection {
    const lines: string[] = [];
    lines.push("# Foundry Context");
    lines.push("");

    for (const block of assembled.blocks) {
      if (block.role === "system") {
        lines.push("## System");
        lines.push(block.text);
        lines.push("");
      } else if (block.role === "layer") {
        lines.push(`## ${block.id}`);
        lines.push(`> ${block.text}`);
        lines.push("");
      } else if (block.role === "content") {
        lines.push(block.text);
        lines.push("");
      }
    }

    const formatted = lines.join("\n");
    return { formatted, meta: this._buildMeta(formatted, assembled) };
  }

  /**
   * Generate a hook script that reports tool events back to Foundry.
   * Returns the script content for use in Claude Code's hooks configuration.
   *
   * Security: The callback URL is read from the FOUNDRY_HOOK_CALLBACK
   * environment variable at runtime rather than embedded in the script.
   * This prevents auth tokens in the URL from leaking into files that
   * may be committed to version control or visible to other processes.
   *
   * The caller must set FOUNDRY_HOOK_CALLBACK in the environment when
   * spawning the hook (see inject()).
   *
   * Usage in settings.json:
   * {
   *   "hooks": {
   *     "PostToolUse": [{ "type": "command", "command": "node .foundry-hook.mjs" }]
   *   }
   * }
   */
  generateHookScript(): string {
    return [
      "#!/usr/bin/env node",
      "// Generated by Foundry — reports tool events for observation",
      "// Security: callback URL is read from env to avoid leaking auth tokens into files.",
      "const CALLBACK = process.env.FOUNDRY_HOOK_CALLBACK;",
      "if (!CALLBACK) process.exit(0); // Silently exit if not configured",
      "",
      "const input = JSON.parse(process.env.CLAUDE_HOOK_INPUT || '{}');",
      "const event = {",
      "  kind: 'tool_result',",
      "  timestamp: Date.now(),",
      "  data: {",
      "    tool: input.tool_name,",
      "    input: input.tool_input,",
      "    output: input.tool_output,",
      "    session: input.session_id,",
      "  }",
      "};",
      "",
      "fetch(CALLBACK, {",
      "  method: 'POST',",
      "  headers: { 'content-type': 'application/json' },",
      "  body: JSON.stringify(event),",
      "}).catch(() => {});",
    ].join("\n");
  }
}

// ---------------------------------------------------------------------------
// Codex (OpenAI CLI agent) runtime adapter
// ---------------------------------------------------------------------------

export interface CodexConfig {
  /** Path to the project root. */
  projectRoot: string;
  /** Filename for Foundry's injected instructions. Defaults to ".foundry-instructions.md". */
  instructionsFile?: string;
}

/**
 * OpenAI Codex CLI runtime adapter.
 *
 * Codex reads instructions from markdown files in the project root.
 * Foundry injects context by writing an instructions file and
 * observes via the Codex event stream / output parsing.
 */
export class CodexRuntime extends BaseRuntime {
  readonly id = "codex";
  readonly runtime = "codex";

  constructor(config: CodexConfig) {
    super(config.projectRoot, config.instructionsFile ?? ".foundry-instructions.md");
  }

  prepareInjection(assembled: AssembledContext): ContextInjection {
    const lines: string[] = [];
    lines.push("# Foundry Context for Codex");
    lines.push("");

    for (const block of assembled.blocks) {
      if (block.role === "system") {
        lines.push(block.text);
        lines.push("");
      } else if (block.role === "layer") {
        lines.push(`### ${block.id}`);
        lines.push(block.text);
        lines.push("");
      } else if (block.role === "content") {
        lines.push(block.text);
        lines.push("");
      }
    }

    const formatted = lines.join("\n");
    return { formatted, meta: this._buildMeta(formatted, assembled) };
  }
}

// ---------------------------------------------------------------------------
// Cursor runtime adapter
// ---------------------------------------------------------------------------

export interface CursorConfig {
  /** Path to the project root where .cursorrules lives. */
  projectRoot: string;
  /** Filename for Foundry's injected rules. Defaults to ".foundry-cursorrules". */
  rulesFile?: string;
}

/**
 * Cursor runtime adapter.
 *
 * Cursor reads project-level instructions from .cursorrules files.
 * Foundry injects context by writing rules files in the project root.
 */
export class CursorRuntime extends BaseRuntime {
  readonly id = "cursor";
  readonly runtime = "cursor";

  constructor(config: CursorConfig) {
    super(config.projectRoot, config.rulesFile ?? ".foundry-cursorrules");
  }

  prepareInjection(assembled: AssembledContext): ContextInjection {
    const lines: string[] = [];

    for (const block of assembled.blocks) {
      if (block.role === "system") {
        lines.push(block.text);
        lines.push("");
      } else if (block.role === "layer") {
        lines.push(`[${block.id}]`);
        lines.push(block.text);
        lines.push("");
      } else if (block.role === "content") {
        lines.push(block.text);
        lines.push("");
      }
    }

    const formatted = lines.join("\n");
    return { formatted, meta: this._buildMeta(formatted, assembled) };
  }
}
