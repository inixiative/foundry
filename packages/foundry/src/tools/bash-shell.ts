// ---------------------------------------------------------------------------
// BashShell — real filesystem shell tool
// ---------------------------------------------------------------------------
//
// Unlike JustBashShell (sandboxed/virtual), BashShell executes against the
// real filesystem. This is what agents need for actual development work:
// reading files, running tests, git operations, etc.
//
// Safety is handled at the capability gate level (exec:shell permission),
// not by sandboxing. The agent's permission policy decides what's allowed.
//
// Usage:
//   const shell = new BashShell({ cwd: "/path/to/project" });
//   registry.register(shell, "Execute shell commands in the project directory");
//
//   const result = await shell.exec("git status");
//   const files = await shell.run("ls src/");
// ---------------------------------------------------------------------------

import type {
  ShellTool,
  ShellResult,
  ShellOpts,
  OutputFilter,
  ToolResult,
} from "@inixiative/foundry-core";

export interface BashShellConfig {
  id?: string;
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
  /** Default timeout in ms. Default: 120000. */
  timeout?: number;
  /** Max stdout bytes before truncation. Default: 200KB. */
  maxOutput?: number;
  /** Default output filter (RTK-style token reduction). */
  outputFilter?: OutputFilter;
  /** Shell binary. Default: /bin/bash. */
  shell?: string;
}

export class BashShell implements ShellTool {
  readonly id: string;
  readonly kind = "shell" as const;
  readonly capability = "exec:shell" as const;

  private _cwd: string;
  private _timeout: number;
  private _maxOutput: number;
  private _defaultFilter: OutputFilter | undefined;
  private _shell: string;

  constructor(config?: BashShellConfig) {
    this.id = config?.id ?? "bash";
    this._cwd = config?.cwd ?? process.cwd();
    this._timeout = config?.timeout ?? 120_000;
    this._maxOutput = config?.maxOutput ?? 200 * 1024;
    this._defaultFilter = config?.outputFilter;
    this._shell = config?.shell ?? "/bin/bash";
  }

  async exec(command: string, opts?: ShellOpts): Promise<ToolResult<ShellResult>> {
    const cwd = opts?.cwd ?? this._cwd;
    const timeout = opts?.timeout ?? this._timeout;
    const maxOutput = opts?.maxOutput ?? this._maxOutput;
    const start = performance.now();

    try {
      const proc = Bun.spawn([this._shell, "-c", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: opts?.env ? { ...process.env, ...opts.env } : undefined,
      });

      // Race against timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error(`Command timed out after ${timeout}ms`));
        }, timeout);
        proc.exited.then(() => clearTimeout(timer));
      });

      const [rawStdout, stderr] = await Promise.race([
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]),
        timeoutPromise.then(() => ["", ""] as [string, string]),
      ]);

      const exitCode = await proc.exited;
      const durationMs = Math.round(performance.now() - start);

      // Apply output filter (RTK-style token reduction)
      const filter = opts?.outputFilter ?? this._defaultFilter;
      const filtered = filter ? filter(rawStdout, command) : rawStdout;

      const truncated = filtered.length > maxOutput;
      const stdout = truncated
        ? filtered.slice(0, maxOutput) + `\n... (truncated at ${maxOutput} bytes)`
        : filtered;

      const ok = exitCode === 0;
      const summary = ok
        ? `$ ${command} — OK (${durationMs}ms, ${stdout.length} chars)`
        : `$ ${command} — exit ${exitCode} (${durationMs}ms)`;

      return {
        ok,
        data: { exitCode, stdout, stderr, truncated, durationMs },
        summary,
        error: ok ? undefined : stderr.trim() || `exit code ${exitCode}`,
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
