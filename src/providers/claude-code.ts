import type {
  LLMProvider,
  LLMMessage,
  CompletionOpts,
  CompletionResult,
  LLMStreamEvent,
} from "./types";
import { splitSystemMessage } from "./types";

export interface ClaudeCodeConfig {
  /** Path to claude CLI binary. Defaults to "claude". */
  bin?: string;
  /** Default model. Defaults to "claude-sonnet-4-20250514". */
  defaultModel?: string;
  /** Default max tokens. */
  defaultMaxTokens?: number;
  /** Working directory for claude CLI invocations. */
  cwd?: string;
  /** Max turns (1 = pure completion, no tool use). Defaults to 1. */
  maxTurns?: number;
}

/**
 * Claude Code CLI provider.
 *
 * Uses `claude -p` (print mode) to get completions through the user's
 * Claude Code subscription — no API key required.
 *
 * This is a completion-only provider by default (maxTurns=1, no tool use).
 * For full agentic Claude Code with tools, use ClaudeCodeRuntime instead.
 */
export class ClaudeCodeProvider implements LLMProvider {
  readonly id = "claude-code";

  private _bin: string;
  private _defaultModel: string;
  private _defaultMaxTokens: number;
  private _cwd: string;
  private _maxTurns: number;

  constructor(config?: ClaudeCodeConfig) {
    this._bin = config?.bin ?? "claude";
    this._defaultModel = config?.defaultModel ?? "claude-sonnet-4-20250514";
    this._defaultMaxTokens = config?.defaultMaxTokens ?? 4096;
    this._cwd = config?.cwd ?? process.cwd();
    this._maxTurns = config?.maxTurns ?? 1;
  }

  async complete(
    messages: LLMMessage[],
    opts?: CompletionOpts
  ): Promise<CompletionResult> {
    const { system, turns } = splitSystemMessage(messages);
    const model = opts?.model ?? this._defaultModel;

    // Build the user prompt from non-system messages
    const prompt = turns.map((m) => m.content).join("\n\n");

    // Build CLI args
    const args: string[] = [
      "-p", prompt,
      "--output-format", "json",
      "--model", model,
      "--max-turns", String(this._maxTurns),
    ];

    if (system) {
      args.push("--system-prompt", system);
    }

    const proc = Bun.spawn([this._bin, ...args], {
      cwd: this._cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`claude CLI exited with ${exitCode}: ${stderr.trim()}`);
    }

    return this._parseOutput(stdout, model);
  }

  async *stream(
    messages: LLMMessage[],
    opts?: CompletionOpts
  ): AsyncGenerator<LLMStreamEvent> {
    const { system, turns } = splitSystemMessage(messages);
    const model = opts?.model ?? this._defaultModel;
    const prompt = turns.map((m) => m.content).join("\n\n");

    const args: string[] = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--model", model,
      "--max-turns", String(this._maxTurns),
    ];

    if (system) {
      args.push("--system-prompt", system);
    }

    const proc = Bun.spawn([this._bin, ...args], {
      cwd: this._cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "assistant" && msg.message?.content) {
              // Content block delta
              for (const block of msg.message.content) {
                if (block.type === "text" && block.text) {
                  yield { type: "text", text: block.text };
                }
              }
            } else if (msg.type === "result") {
              if (msg.result) {
                yield { type: "text", text: msg.result };
              }
              yield { type: "done", finishReason: msg.subtype === "success" ? "end_turn" : "error" };
              return;
            }
          } catch {
            // Skip malformed lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "done", finishReason: "end_turn" };
  }

  /**
   * Parse the JSON output from `claude -p --output-format json`.
   *
   * The CLI returns an array of conversation messages. We extract the
   * last assistant response (or result message) as the completion.
   */
  private _parseOutput(raw: string, model: string): CompletionResult {
    try {
      const data = JSON.parse(raw.trim());

      // Array of conversation messages
      if (Array.isArray(data)) {
        for (let i = data.length - 1; i >= 0; i--) {
          const msg = data[i];

          // Result message (final)
          if (msg.type === "result") {
            return {
              content: msg.result ?? "",
              model,
              tokens: msg.total_cost_usd != null
                ? { input: 0, output: 0 } // CLI doesn't expose raw token counts
                : undefined,
              finishReason: msg.subtype === "success" ? "end_turn" : "error",
              raw: msg,
            };
          }

          // Assistant message with string content
          if (msg.role === "assistant" && typeof msg.content === "string") {
            return { content: msg.content, model, finishReason: "end_turn", raw: msg };
          }

          // Assistant message with content blocks
          if (msg.role === "assistant" && Array.isArray(msg.content)) {
            const text = msg.content
              .filter((b: { type: string; text?: string }) => b.type === "text")
              .map((b: { type: string; text?: string }) => b.text ?? "")
              .join("");
            return { content: text, model, finishReason: "end_turn", raw: msg };
          }
        }
      }

      // Single result object
      if (typeof data === "object" && data.result) {
        return { content: data.result, model, finishReason: "end_turn", raw: data };
      }

      // Fallback: treat raw output as text
      return { content: raw.trim(), model, finishReason: "end_turn" };
    } catch {
      return { content: raw.trim(), model, finishReason: "end_turn" };
    }
  }
}
