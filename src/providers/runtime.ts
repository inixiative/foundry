import type { AssembledContext } from "../agents/context-stack";
import type { Signal, SignalKind } from "../agents/signal";

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
  /** Assembled system prompt + layer content. */
  readonly assembled: AssembledContext;
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
export class ClaudeCodeRuntime implements RuntimeAdapter {
  readonly id = "claude-code";
  readonly runtime = "claude-code";

  private _config: ClaudeCodeConfig;
  private _handlers: RuntimeEventHandler[] = [];
  private _contextFile: string;

  constructor(config: ClaudeCodeConfig) {
    this._config = config;
    this._contextFile = config.contextFile ?? ".foundry-context.md";
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
    const layerIds = [
      ...new Set(
        assembled.blocks.filter((b) => b.id).map((b) => b.id as string)
      ),
    ];

    return {
      assembled,
      formatted,
      meta: {
        layerIds,
        tokenEstimate: Math.ceil(formatted.length / 4),
        hash: Bun.hash(formatted).toString(16).slice(0, 16),
      },
    };
  }

  async inject(injection: ContextInjection): Promise<() => Promise<void>> {
    const { join } = await import("path");
    const { writeFile, unlink, readFile } = await import("fs/promises");

    const filePath = join(this._config.projectRoot, this._contextFile);

    // Write the context file
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

    // Teardown: remove the injected file
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

  /**
   * Generate a hook script that reports tool events back to Foundry.
   * Returns the script content for use in Claude Code's hooks configuration.
   *
   * Usage in settings.json:
   * {
   *   "hooks": {
   *     "PostToolUse": [{ "type": "command", "command": "node .foundry-hook.mjs" }]
   *   }
   * }
   */
  generateHookScript(callbackUrl: string): string {
    return [
      "#!/usr/bin/env node",
      "// Generated by Foundry — reports tool events for observation",
      `const CALLBACK = ${JSON.stringify(callbackUrl)};`,
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

  private _emit(event: RuntimeEvent): void {
    const snapshot = [...this._handlers];
    for (const handler of snapshot) {
      try {
        const result = handler(event);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch(() => {});
        }
      } catch {
        // Don't let one handler break others
      }
    }
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
export class CodexRuntime implements RuntimeAdapter {
  readonly id = "codex";
  readonly runtime = "codex";

  private _config: CodexConfig;
  private _handlers: RuntimeEventHandler[] = [];
  private _instructionsFile: string;

  constructor(config: CodexConfig) {
    this._config = config;
    this._instructionsFile =
      config.instructionsFile ?? ".foundry-instructions.md";
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
    const layerIds = [
      ...new Set(
        assembled.blocks.filter((b) => b.id).map((b) => b.id as string)
      ),
    ];

    return {
      assembled,
      formatted,
      meta: {
        layerIds,
        tokenEstimate: Math.ceil(formatted.length / 4),
        hash: Bun.hash(formatted).toString(16).slice(0, 16),
      },
    };
  }

  async inject(injection: ContextInjection): Promise<() => Promise<void>> {
    const { join } = await import("path");
    const { writeFile, unlink } = await import("fs/promises");

    const filePath = join(this._config.projectRoot, this._instructionsFile);
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

  private _emit(event: RuntimeEvent): void {
    const snapshot = [...this._handlers];
    for (const handler of snapshot) {
      try {
        const result = handler(event);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch(() => {});
        }
      } catch {
        // Don't let one handler break others
      }
    }
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
export class CursorRuntime implements RuntimeAdapter {
  readonly id = "cursor";
  readonly runtime = "cursor";

  private _config: CursorConfig;
  private _handlers: RuntimeEventHandler[] = [];
  private _rulesFile: string;

  constructor(config: CursorConfig) {
    this._config = config;
    this._rulesFile = config.rulesFile ?? ".foundry-cursorrules";
  }

  prepareInjection(assembled: AssembledContext): ContextInjection {
    // Cursor rules are plain text, no markdown headers
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
    const layerIds = [
      ...new Set(
        assembled.blocks.filter((b) => b.id).map((b) => b.id as string)
      ),
    ];

    return {
      assembled,
      formatted,
      meta: {
        layerIds,
        tokenEstimate: Math.ceil(formatted.length / 4),
        hash: Bun.hash(formatted).toString(16).slice(0, 16),
      },
    };
  }

  async inject(injection: ContextInjection): Promise<() => Promise<void>> {
    const { join } = await import("path");
    const { writeFile, unlink } = await import("fs/promises");

    const filePath = join(this._config.projectRoot, this._rulesFile);
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

  private _emit(event: RuntimeEvent): void {
    const snapshot = [...this._handlers];
    for (const handler of snapshot) {
      try {
        const result = handler(event);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch(() => {});
        }
      } catch {
        // Don't let one handler break others
      }
    }
  }
}
