// ---------------------------------------------------------------------------
// BunScript — ScriptTool adapter using Bun subprocess isolation
// ---------------------------------------------------------------------------
//
// Agents write TypeScript/JS that executes in an isolated Bun subprocess.
// Each evaluation spawns a fresh process — no state leaks between calls.
//
// Why this beats bash for data work:
//   bash:   agent writes `curl | jq '.[] | select(.active)'` — fragile, verbose
//   script: agent writes `data.filter(u => u.active)` — typed, composable
//
// Communication with shared data sources happens through the agent's handler,
// not through the subprocess. The script is pure computation — it receives
// input, transforms it, returns output. Data flows through ContextStack and
// ToolResult, not through inter-process channels.
//
// Usage:
//   const script = new BunScript({ timeout: 10_000 });
//   registry.register(script, "Execute TypeScript for data transformation");
//
//   const result = await script.evaluate(`
//     const data = JSON.parse(input);
//     return data.users.filter(u => u.lastLogin > Date.now() - 86400000);
//   `, { modules: { input: JSON.stringify(userData) } });
// ---------------------------------------------------------------------------

import type {
  ScriptTool,
  ScriptResult,
  ScriptOpts,
  ToolResult,
} from "@inixiative/foundry-core";

export interface BunScriptConfig {
  id?: string;
  /** Default timeout in ms. Default: 30000. */
  timeout?: number;
  /** Max stdout size in bytes before truncation. Default: 512KB. */
  maxOutput?: number;
  /** Working directory for the subprocess. Default: process.cwd(). */
  cwd?: string;
}

export class BunScript implements ScriptTool {
  readonly id: string;
  readonly kind = "script" as const;
  readonly capability = "exec:process" as const;

  private _timeout: number;
  private _maxOutput: number;
  private _cwd: string;

  constructor(config?: BunScriptConfig) {
    this.id = config?.id ?? "script";
    this._timeout = config?.timeout ?? 30_000;
    this._maxOutput = config?.maxOutput ?? 512 * 1024;
    this._cwd = config?.cwd ?? process.cwd();
  }

  async evaluate<T = unknown>(
    code: string,
    opts?: ScriptOpts
  ): Promise<ToolResult<ScriptResult<T>>> {
    const timeout = opts?.timeout ?? this._timeout;
    const captureLogs = opts?.captureLogs !== false;

    // Build a wrapper script that:
    // 1. Injects modules as globals
    // 2. Captures console.log
    // 3. Runs the user code
    // 4. Serializes the result to stdout as JSON
    const modules = opts?.modules ?? {};
    const moduleInjections = Object.entries(modules)
      .map(([name, value]) => `globalThis[${JSON.stringify(name)}] = ${JSON.stringify(value)};`)
      .join("\n");

    const wrapper = `
const __logs = [];
const __origLog = console.log;
${captureLogs ? `console.log = (...args) => { __logs.push(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")); };` : ""}

${moduleInjections}

async function __run() {
  ${code}
}

try {
  const __result = await __run();
  __origLog(JSON.stringify({ ok: true, result: __result, logs: __logs }));
} catch (e) {
  __origLog(JSON.stringify({ ok: false, error: e.message || String(e), logs: __logs }));
}
`;

    const start = performance.now();

    const proc = Bun.spawn(["bun", "eval", wrapper], {
      cwd: this._cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Don't inherit credentials into script subprocess
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
      },
    });

    // Race against timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Script timed out after ${timeout}ms`));
      }, timeout);
      proc.exited.then(() => clearTimeout(timer));
    });

    try {
      const [stdout, stderr] = await Promise.race([
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]),
        timeoutPromise.then(() => ["", ""] as [string, string]),
      ]);

      const durationMs = Math.round(performance.now() - start);
      const exitCode = await proc.exited;

      // Truncate if needed
      const truncatedStdout = stdout.length > this._maxOutput
        ? stdout.slice(0, this._maxOutput)
        : stdout;

      if (exitCode !== 0) {
        const errMsg = stderr.trim() || truncatedStdout.trim().slice(0, 200) || `exit code ${exitCode}`;
        return {
          ok: false,
          summary: `Script failed (${durationMs}ms): ${errMsg.slice(0, 100)}`,
          error: errMsg,
        };
      }

      // Parse the JSON wrapper output
      let parsed: { ok: boolean; result?: T; error?: string; logs: string[] };
      try {
        parsed = JSON.parse(truncatedStdout.trim());
      } catch {
        // Script produced non-JSON output — treat stdout as the result
        return {
          ok: true,
          data: {
            result: truncatedStdout.trim() as unknown as T,
            logs: [],
            durationMs,
          },
          summary: `Script completed (${durationMs}ms) — ${truncatedStdout.trim().length} chars output`,
        };
      }

      if (!parsed.ok) {
        return {
          ok: false,
          summary: `Script error (${durationMs}ms): ${parsed.error}`,
          error: parsed.error,
          data: { result: undefined as unknown as T, logs: parsed.logs, durationMs },
        };
      }

      const resultStr = JSON.stringify(parsed.result);
      const summary = resultStr.length > 200
        ? `Script completed (${durationMs}ms) — ${resultStr.length} chars of data`
        : `Script completed (${durationMs}ms): ${resultStr}`;

      return {
        ok: true,
        data: {
          result: parsed.result as T,
          logs: parsed.logs,
          durationMs,
        },
        summary,
        estimatedTokens: Math.ceil(resultStr.length / 4),
      };
    } catch (err) {
      try { proc.kill(); } catch { /* already dead */ }
      const durationMs = Math.round(performance.now() - start);
      return {
        ok: false,
        summary: `Script failed (${durationMs}ms)`,
        error: (err as Error).message,
      };
    }
  }
}
