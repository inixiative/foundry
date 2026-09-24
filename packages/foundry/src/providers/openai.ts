import { HttpCompletionSettlement } from "./http-settlement";
import type {
  LLMProvider,
  LLMMessage,
  CompletionOpts,
  CompletionResult,
  LLMStreamEvent,
  EmbeddingProvider,
  EmbeddingResult,
} from "@inixiative/foundry-core";

export interface OpenAIConfig {
  apiKey: string;
  /** Defaults to "gpt-5.6-luna". */
  defaultModel?: string;
  /** Override base URL for Cursor, Azure, local proxies, etc. Normalized to a versioned root. */
  baseUrl?: string;
  /** Exact API root, used verbatim. For hosts whose published root is not /v1 (DeepSeek, GLM). */
  apiRoot?: string;
  /** Optional organization header. */
  organization?: string;
  /** Extra headers sent on every request (compatible hosts that require attribution). */
  headers?: Record<string, string>;
  /** Which model ids take `reasoning_effort`. Defaults to the OpenAI gpt-5.6 family. */
  reasoningModels?: (model: string) => boolean;
  /** Send `reasoning_effort: "none"` when the caller asked for no thinking. Off for hosts that reject it. */
  explicitNoReasoning?: boolean;
}

const DEFAULT_BASE = "https://api.openai.com";
const OPENAI_REASONING_MODELS = (model: string) => /^gpt-5\.6(?:-|$)/.test(model);

/**
 * Resolve the versioned API root for an OpenAI-compatible host.
 * Hosts publish their base either bare ("https://api.openai.com") or already
 * versioned ("https://api.x.ai/v1", "https://api.z.ai/api/paas/v4"); both must
 * produce exactly one version segment.
 */
export function openAiApiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * OpenAI Chat Completions adapter.
 * Covers GPT-4o, Codex, o-series, and any OpenAI-compatible API
 * (Cursor, Azure, Together, Groq, local LLMs via LiteLLM/Ollama).
 *
 * Set baseUrl to point at any compatible endpoint:
 *   - Cursor: uses OpenAI-compatible format
 *   - Azure: "https://{resource}.openai.azure.com/openai/deployments/{deployment}"
 *   - Local: "http://localhost:11434/v1" (Ollama)
 */
export class OpenAIProvider implements LLMProvider {
  readonly id: string;
  private readonly _settlement = new HttpCompletionSettlement();
  readonly completionLifecycle = this._settlement.lifecycle;

  private _apiKey: string;
  private _defaultModel: string;
  private _apiRoot: string;
  private _organization: string | undefined;
  private _extraHeaders: Record<string, string>;
  protected _isReasoningModel: (model: string) => boolean;
  private _explicitNoReasoning: boolean;

  constructor(config: OpenAIConfig, id?: string) {
    this.id = id ?? "openai";
    this._apiKey = config.apiKey;
    this._defaultModel = config.defaultModel ?? "gpt-5.6-luna";
    this._apiRoot = config.apiRoot?.trim() || openAiApiRoot(config.baseUrl ?? DEFAULT_BASE);
    this._organization = config.organization;
    this._extraHeaders = config.headers ?? {};
    this._isReasoningModel = config.reasoningModels ?? OPENAI_REASONING_MODELS;
    this._explicitNoReasoning = config.explicitNoReasoning ?? true;
  }

  /** Versioned API root this adapter posts to. */
  get apiRoot(): string { return this._apiRoot; }

  protected _headers(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this._extraHeaders,
      "content-type": "application/json",
      authorization: `Bearer ${this._apiKey}`,
    };
    if (this._organization) headers["openai-organization"] = this._organization;
    return headers;
  }

  protected _body(messages: LLMMessage[], opts: CompletionOpts | undefined, model: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    const reasoningModel = this._isReasoningModel(model);
    if (reasoningModel) {
      const effort = typeof opts?.thinking === "string" ? opts.thinking : "none";
      if (effort !== "none" || this._explicitNoReasoning) body.reasoning_effort = effort;
    }
    if (opts?.maxTokens !== undefined) body[reasoningModel ? "max_completion_tokens" : "max_tokens"] = opts.maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.topP !== undefined) body.top_p = opts.topP;
    if (opts?.stop) body.stop = opts.stop;
    return body;
  }

  async complete(
    messages: LLMMessage[],
    opts?: CompletionOpts
  ): Promise<CompletionResult> {
    const model = opts?.model ?? this._defaultModel;
    const body = this._body(messages, opts, model);

    const res = await fetch(`${this._apiRoot}/chat/completions`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts?.timeout && opts.timeout > 0 ? opts.timeout : 30_000),
    });

    if (!res.ok) {
      await res.text();
      throw this._settlement.completedError(`OpenAI API ${res.status}`);
    }

    const data = (await res.json()) as {
      choices: Array<{
        message: { content: string };
        finish_reason: string;
      }>;
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];

    return {
      content: choice?.message?.content ?? "",
      model: data.model,
      tokens: data.usage
        ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens }
        : undefined,
      finishReason: choice?.finish_reason,
      raw: data,
    };
  }

  /**
   * Stream a completion using OpenAI's SSE streaming API.
   *
   * Parses `data: {...}` lines, yields delta.content chunks,
   * and handles the `[DONE]` sentinel. Usage comes in the final
   * chunk if the API provides it.
   */
  async *stream(
    messages: LLMMessage[],
    opts?: CompletionOpts
  ): AsyncGenerator<LLMStreamEvent> {
    const model = opts?.model ?? this._defaultModel;
    const body = { ...this._body(messages, opts, model), stream: true, stream_options: { include_usage: true } };

    const res = await fetch(`${this._apiRoot}/chat/completions`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts?.timeout && opts.timeout > 0 ? opts.timeout : 30_000),
    });

    if (!res.ok) {
      await res.text();
      yield { type: "error", error: `OpenAI API ${res.status}` };
      return;
    }

    if (!res.body) {
      yield { type: "error", error: "No response body for streaming" };
      return;
    }

    let finishReason: string | undefined;

    const reader = res.body.getReader();
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
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];

            if (choice?.delta?.content) {
              yield { type: "text", text: choice.delta.content };
            }

            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }

            // Usage in the final chunk (when stream_options.include_usage is set)
            if (parsed.usage) {
              yield {
                type: "usage",
                tokens: {
                  input: parsed.usage.prompt_tokens ?? 0,
                  output: parsed.usage.completion_tokens ?? 0,
                },
              };
            }
          } catch (err) {
            console.warn("[OpenAI] malformed stream chunk:", (err as Error).message);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "done", finishReason };
  }
}

/**
 * OpenAI Embeddings adapter.
 * Works with text-embedding-3-small, text-embedding-3-large, ada-002,
 * and any OpenAI-compatible embedding endpoint.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai-embed";

  private _apiKey: string;
  private _model: string;
  private _apiRoot: string;

  constructor(config: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  }) {
    this._apiKey = config.apiKey;
    this._model = config.model ?? "text-embedding-3-small";
    this._apiRoot = openAiApiRoot(config.baseUrl ?? DEFAULT_BASE);
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const results = await this._request([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return this._request(texts);
  }

  private async _request(input: string[]): Promise<EmbeddingResult[]> {
    if (input.length === 0) return [];

    const res = await fetch(`${this._apiRoot}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this._apiKey}`,
      },
      body: JSON.stringify({ model: this._model, input }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI Embeddings API ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      usage: { prompt_tokens: number; total_tokens: number };
    };

    const tokensPerItem = Math.ceil(
      (data.usage?.total_tokens ?? 0) / input.length
    );

    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => ({ embedding: d.embedding, tokens: tokensPerItem }));
  }
}

// ---------------------------------------------------------------------------
// Convenience factories for common OpenAI-compatible providers
// ---------------------------------------------------------------------------

/** Create a provider pointing at Cursor's OpenAI-compatible API. */
export function createCursorProvider(config: {
  apiKey: string;
  baseUrl: string;
  defaultModel?: string;
}): OpenAIProvider {
  return new OpenAIProvider(
    {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      defaultModel: config.defaultModel ?? "cursor",
    },
    "cursor"
  );
}

/** Create a provider pointing at a local Ollama instance. */
export function createOllamaProvider(config?: {
  baseUrl?: string;
  defaultModel?: string;
}): OpenAIProvider {
  return new OpenAIProvider(
    {
      apiKey: "ollama", // Ollama ignores auth
      baseUrl: config?.baseUrl ?? "http://localhost:11434/v1",
      defaultModel: config?.defaultModel ?? "llama3.2:3b",
    },
    "ollama"
  );
}
