// ---------------------------------------------------------------------------
// JustBashShell — ShellTool adapter wrapping just-bash for sandboxed execution
// ---------------------------------------------------------------------------
//
// Provides bash-like shell semantics in a fully isolated environment.
// Agents write the same grep/find/cat commands they'd use with real bash,
// but nothing touches the real filesystem.
//
// Peer dependency: `bun add just-bash`
//
// The virtual filesystem is seeded at construction time with project files.
// All reads/writes happen in-memory. When the agent is done, the sandbox
// is discarded — no cleanup needed.
//
// Usage:
//   const shell = new JustBashShell({
//     files: { "src/index.ts": "export default ...", "package.json": "{...}" },
//   });
//   registry.register(shell, "Sandboxed shell for code analysis");
//
//   const result = await shell.exec("grep -rn 'export' src/");
// ---------------------------------------------------------------------------

import type {
  ShellTool,
  ShellResult,
  ShellOpts,
  OutputFilter,
  ToolResult,
} from "@inixiative/foundry-core";

export interface JustBashShellConfig {
  id?: string;
  /** Virtual filesystem — map of path → content. */
  files?: Record<string, string>;
  /** Default timeout in ms. Default: 30000. */
  timeout?: number;
  /** Max stdout size in bytes before truncation. Default: 100KB. */
  maxOutput?: number;
  /**
   * Default output filter applied to every command.
   * Use builtinFilters.rtk() for RTK-style token reduction.
   * Per-command filters in ShellOpts override this.
   */
  outputFilter?: OutputFilter;
}

// just-bash types — declared loosely for peer dep pattern
type JustBashInstance = {
  exec: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  writeFile?: (path: string, content: string) => void;
};
type JustBashFactory = (opts?: { files?: Record<string, string> }) => JustBashInstance | Promise<JustBashInstance>;

export class JustBashShell implements ShellTool {
  readonly id: string;
  readonly kind = "shell" as const;
  readonly capability = "exec:shell" as const;

  private _config: Required<Omit<JustBashShellConfig, "id" | "outputFilter">>;
  private _defaultFilter: OutputFilter | undefined;
  private _instance: JustBashInstance | null = null;
  private _factory: JustBashFactory | null = null;

  constructor(config?: JustBashShellConfig) {
    this.id = config?.id ?? "shell";
    this._defaultFilter = config?.outputFilter;
    this._config = {
      files: config?.files ?? {},
      timeout: config?.timeout ?? 30_000,
      maxOutput: config?.maxOutput ?? 100 * 1024,
    };
  }

  /** Initialize the just-bash instance. Called lazily on first exec. */
  private async _init(): Promise<JustBashInstance> {
    if (this._instance) return this._instance;

    if (!this._factory) {
      try {
        // @ts-expect-error - peer dep may not be installed
        const mod = await import("just-bash");
        this._factory = mod.createJustBash ?? mod.default ?? mod;
      } catch {
        throw new Error(
          "just-bash is not installed. Install it with: bun add just-bash"
        );
      }
    }

    this._instance = await this._factory!({ files: this._config.files });
    return this._instance!;
  }

  /** Seed additional files into the virtual filesystem. */
  async seedFiles(files: Record<string, string>): Promise<void> {
    const instance = await this._init();
    for (const [path, content] of Object.entries(files)) {
      instance.writeFile?.(path, content);
    }
    // Also update config for re-initialization
    Object.assign(this._config.files, files);
  }

  // ---- ShellTool interface ----

  async exec(command: string, opts?: ShellOpts): Promise<ToolResult<ShellResult>> {
    const timeout = opts?.timeout ?? this._config.timeout;
    const maxOutput = opts?.maxOutput ?? this._config.maxOutput;
    const start = performance.now();

    try {
      const instance = await this._init();

      // Race against timeout
      const result = await Promise.race([
        instance.exec(command),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Command timed out after ${timeout}ms`)), timeout)
        ),
      ]);

      const durationMs = Math.round(performance.now() - start);

      // Apply output filter (RTK-style token reduction)
      const filter = opts?.outputFilter ?? this._defaultFilter;
      const filtered = filter ? filter(result.stdout, command) : result.stdout;

      const truncated = filtered.length > maxOutput;
      const stdout = truncated
        ? filtered.slice(0, maxOutput) + `\n... (truncated at ${maxOutput} bytes)`
        : filtered;

      const ok = result.exitCode === 0;
      const summary = ok
        ? `$ ${command} — OK (${durationMs}ms, ${stdout.length} chars)`
        : `$ ${command} — exit ${result.exitCode} (${durationMs}ms)`;

      return {
        ok,
        data: {
          exitCode: result.exitCode,
          stdout,
          stderr: result.stderr,
          truncated,
          durationMs,
        },
        summary,
        error: ok ? undefined : result.stderr || `exit code ${result.exitCode}`,
        estimatedTokens: Math.ceil(stdout.length / 4),
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      return {
        ok: false,
        summary: `$ ${command} — failed (${durationMs}ms)`,
        error: (err as Error).message,
      };
    }
  }

  async run(command: string, opts?: ShellOpts): Promise<string> {
    const result = await this.exec(command, opts);
    if (!result.ok) throw new Error(result.error ?? "Command failed");
    return result.data?.stdout ?? "";
  }

  async which(command: string): Promise<string | null> {
    const result = await this.exec(`which ${command}`);
    return result.ok ? (result.data?.stdout.trim() ?? null) : null;
  }
}
