import type {
  LLMProvider,
  LLMMessage,
  CompletionOpts,
  CompletionResult,
  LLMStreamEvent,
} from "@inixiative/foundry-core";
import { splitSystemMessage } from "@inixiative/foundry-core";

export interface ClaudeCodeConfig {
  /** Path to claude CLI binary. Defaults to "claude". */
  bin?: string;
  /** Default model. Defaults to "sonnet". */
  defaultModel?: string;
  /** Default max tokens. */
  defaultMaxTokens?: number;
  /** Working directory for claude CLI invocations. */
  cwd?: string;
  /** Max agentic turns. Defaults to 25. */
  maxTurns?: number;
  /** Subprocess timeout in ms. Defaults to 600000 (10 minutes). */
  timeout?: number;
  /**
   * Session persistence mode:
   * - "auto": sessions are persisted and can be resumed (default)
   * - "none": no session persistence (--no-session-persistence)
   */
  sessionMode?: "auto" | "none";
}

/**
 * Claude Code CLI provider — runs real agentic sessions.
 *
 * Each invocation spawns a `claude` session that has full access to
 * Claude Code's built-in tools (Read, Write, Bash, Grep, etc.).
 *
 * Session persistence:
 * - First call uses `-p` and captures the session ID from output.
 * - Subsequent calls use `--resume <sessionId> -p` to continue the session.
 * - Call `resetSession()` to start fresh.
 *
 * For lightweight completion-only tasks (classifiers, routers), use
 * GeminiProvider or AnthropicProvider instead.
 */
export class ClaudeCodeProvider implements LLMProvider {
  readonly id = "claude-code";

  private _bin: string;
  private _defaultModel: string;
  private _defaultMaxTokens: number;
  private _cwd: string;
  private _maxTurns: number;
  private _timeout: number;
  private _sessionMode: "auto" | "none";

  /**
   * Active session IDs keyed by thread/context.
   * Default key is "__default" for single-thread usage.
   */
  private _sessions: Map<string, string> = new Map();

  constructor(config?: ClaudeCodeConfig) {
    const bin = config?.bin ?? "claude";
    if (!/^[a-zA-Z0-9_.\/\\-]+$/.test(bin)) {
      throw new Error(`Invalid claude CLI binary path: "${bin}". Only alphanumeric, dots, slashes, dashes, and underscores are allowed.`);
    }
    this._bin = bin;
    this._defaultModel = config?.defaultModel ?? "sonnet";
    this._defaultMaxTokens = config?.defaultMaxTokens ?? 4096;
    this._cwd = config?.cwd ?? process.cwd();
    this._maxTurns = config?.maxTurns ?? 25;
    this._timeout = config?.timeout ?? 600_000; // 10 minutes
    this._sessionMode = config?.sessionMode ?? "auto";
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  /** Get the active session ID for a thread (or the default session). */
  getSession(threadId?: string): string | undefined {
    return this._sessions.get(threadId ?? "__default");
  }

  /** Explicitly set a session ID (e.g. to resume a known session). */
  setSession(sessionId: string, threadId?: string): void {
    this._sessions.set(threadId ?? "__default", sessionId);
  }

  /** Clear the session for a thread, forcing a new session on next call. */
  resetSession(threadId?: string): void {
    this._sessions.delete(threadId ?? "__default");
  }

  /** Clear all tracked sessions. */
  resetAllSessions(): void {
    this._sessions.clear();
  }

  // ---------------------------------------------------------------------------
  // Completion
  // ---------------------------------------------------------------------------

  async complete(
    messages: LLMMessage[],
    opts?: CompletionOpts
  ): Promise<CompletionResult> {
    const { system, turns } = splitSystemMessage(messages);
    const model = opts?.model ?? this._defaultModel;
    const prompt = turns.map((m) => m.content).join("\n\n");
    const maxTurns = opts?.maxTurns ?? this._maxTurns;
    const timeout = opts?.timeout ?? this._timeout;
    const threadId = opts?.threadId as string | undefined;

    // Permission mode
    const permissionMap: Record<string, string> = {
      bypass: "bypassPermissions",
      supervised: "default",
      restricted: "plan",
    };
    const permMode = permissionMap[opts?.permissions ?? "bypass"] ?? "bypassPermissions";

    const args = this._buildArgs({
      prompt,
      model,
      maxTurns,
      permMode,
      system,
      threadId,
    });

    // Strip API key env vars so the CLI uses subscription auth
    const env: Record<string, string | undefined> = {
      ...process.env,
      DISABLE_AUTOUPDATER: "1",
    };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const proc = Bun.spawn([this._bin, ...args], {
      cwd: opts?.cwd ?? this._cwd,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`claude CLI timed out after ${timeout}ms`));
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

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const errMsg = this._extractError(stdout)
          || stderr.trim()
          || stdout.trim().slice(0, 200)
          || `exit code ${exitCode} (no output)`;
        throw new Error(`claude CLI error: ${errMsg}`);
      }

      if (!stdout.trim()) {
        throw new Error("claude CLI returned empty output");
      }

      const result = this._parseOutput(stdout, model);

      // Capture session ID for future resumption
      this._captureSessionId(stdout, threadId);

      return result;
    } catch (err) {
      try { proc.kill(); } catch { /* already dead */ }
      throw err;
    }
  }

  async *stream(
    messages: LLMMessage[],
    opts?: CompletionOpts
  ): AsyncGenerator<LLMStreamEvent> {
    const { system, turns } = splitSystemMessage(messages);
    const model = opts?.model ?? this._defaultModel;
    const prompt = turns.map((m) => m.content).join("\n\n");
    const maxTurns = opts?.maxTurns ?? this._maxTurns;
    const timeout = opts?.timeout ?? this._timeout;
    const threadId = opts?.threadId as string | undefined;

    const args = this._buildArgs({
      prompt,
      model,
      maxTurns,
      permMode: "bypassPermissions",
      system,
      threadId,
      streaming: true,
    });

    const env: Record<string, string | undefined> = {
      ...process.env,
      DISABLE_AUTOUPDATER: "1",
    };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const proc = Bun.spawn([this._bin, ...args], {
      cwd: opts?.cwd ?? this._cwd,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeout);

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let capturedSessionId: string | undefined;

    try {
      while (true) {
        if (timedOut) {
          yield { type: "error", error: `claude CLI timed out after ${timeout}ms` };
          yield { type: "done", finishReason: "error" };
          return;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch (err) {
            console.warn("[ClaudeCode] malformed stream line:", (err as Error).message);
            continue;
          }

          // Capture session ID from stream events
          if (msg.session_id && !capturedSessionId) {
            capturedSessionId = msg.session_id as string;
            this._sessions.set(threadId ?? "__default", capturedSessionId);
          }

          if (msg.type === "assistant" && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                yield { type: "text", text: block.text };
              }
            }
          } else if (msg.type === "result") {
            // Capture session ID from result message
            if (msg.session_id && !capturedSessionId) {
              capturedSessionId = msg.session_id as string;
              this._sessions.set(threadId ?? "__default", capturedSessionId);
            }
            if (msg.result) {
              yield { type: "text", text: msg.result };
            }
            yield { type: "done", finishReason: msg.subtype === "success" ? "end_turn" : "error" };
            return;
          }
        }
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
      try { proc.kill(); } catch { /* already dead */ }
    }

    yield { type: "done", finishReason: "end_turn" };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _buildArgs(opts: {
    prompt: string;
    model: string;
    maxTurns: number;
    permMode: string;
    system?: string;
    threadId?: string;
    streaming?: boolean;
  }): string[] {
    const sessionId = this._sessions.get(opts.threadId ?? "__default");

    const args: string[] = [];

    // Resume existing session or start new
    if (sessionId && this._sessionMode === "auto") {
      args.push("--resume", sessionId);
    }

    args.push(
      "-p", opts.prompt,
      "--output-format", opts.streaming ? "stream-json" : "json",
      "--model", opts.model,
      "--max-turns", String(opts.maxTurns),
      "--permission-mode", opts.permMode,
    );

    if (opts.system && !sessionId) {
      // Only set system prompt on first call — resumed sessions keep their system prompt
      args.push("--system-prompt", opts.system);
    }

    if (this._sessionMode === "none") {
      args.push("--no-session-persistence");
    }

    return args;
  }

  /** Extract session_id from CLI JSON output and store it for resumption. */
  private _captureSessionId(stdout: string, threadId?: string): void {
    if (this._sessionMode !== "auto") return;

    try {
      const data = JSON.parse(stdout.trim());

      // Single result object
      if (data?.session_id) {
        this._sessions.set(threadId ?? "__default", data.session_id);
        return;
      }

      // Array of messages — check the result message
      if (Array.isArray(data)) {
        for (let i = data.length - 1; i >= 0; i--) {
          if (data[i]?.session_id) {
            this._sessions.set(threadId ?? "__default", data[i].session_id);
            return;
          }
        }
      }
    } catch {
      // Not valid JSON or no session_id — that's fine
    }
  }

  private _extractError(stdout: string): string | null {
    if (!stdout.trim()) return null;
    try {
      const data = JSON.parse(stdout.trim());
      if (data?.is_error && data?.result) return data.result;
      if (Array.isArray(data)) {
        const last = data[data.length - 1];
        if (last?.is_error && last?.result) return last.result;
      }
    } catch { /* not JSON */ }
    return null;
  }

  private _parseOutput(raw: string, model: string): CompletionResult {
    let data: unknown;
    try {
      data = JSON.parse(raw.trim());
    } catch {
      throw new Error(`claude CLI returned invalid JSON: ${raw.slice(0, 200)}`);
    }

    if (Array.isArray(data)) {
      for (let i = data.length - 1; i >= 0; i--) {
        const msg = data[i];

        if (msg.type === "result") {
          return {
            content: msg.result ?? "",
            model,
            tokens: msg.usage
              ? { input: msg.usage.input_tokens ?? 0, output: msg.usage.output_tokens ?? 0 }
              : undefined,
            finishReason: msg.subtype === "success" ? "end_turn" : "error",
            raw: msg,
          };
        }

        if (msg.role === "assistant" && typeof msg.content === "string") {
          return { content: msg.content, model, finishReason: "end_turn", raw: msg };
        }

        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const text = msg.content
            .filter((b: { type: string; text?: string }) => b.type === "text")
            .map((b: { type: string; text?: string }) => b.text ?? "")
            .join("");
          return { content: text, model, finishReason: "end_turn", raw: msg };
        }
      }
    }

    if (typeof data === "object" && data !== null && "result" in data) {
      return { content: (data as any).result, model, finishReason: "end_turn", raw: data };
    }

    throw new Error(`claude CLI returned unexpected format: ${raw.slice(0, 200)}`);
  }
}
