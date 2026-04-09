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
  /** Defaults to "gpt-4o". */
  defaultModel?: string;
  /** Override base URL for Cursor, Azure, local proxies, etc. */
  baseUrl?: string;
  /** Optional organization header. */
  organization?: string;
}

const DEFAULT_BASE = "https://api.openai.com";

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

  private _apiKey: string;
  private _defaultModel: string;
  private _baseUrl: string;
  private _organization: string | undefined;

  constructor(config: OpenAIConfig, id?: string) {
    this.id = id ?? "openai";
    this._apiKey = config.apiKey;
    this._defaultModel = config.defaultModel ?? "gpt-4o";
    this._baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this._organization = config.organization;
  }

  async complete(
    messages: LLMMessage[],
    opts?: CompletionOpts
  ): Promise<CompletionResult> {
    const model = opts?.model ?? this._defaultModel;

    const body: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.topP !== undefined) body.top_p = opts.topP;
    if (opts?.stop) body.stop = opts.stop;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this._apiKey}`,
    };
    if (this._organization) {
      headers["openai-organization"] = this._organization;
    }

    const res = await fetch(`${this._baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API ${res.status}: ${text}`);
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

    const body: Record<string, unknown> = {
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.topP !== undefined) body.top_p = opts.topP;
    if (opts?.stop) body.stop = opts.stop;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this._apiKey}`,
    };
    if (this._organization) {
      headers["openai-organization"] = this._organization;
    }

    const res = await fetch(`${this._baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      yield { type: "error", error: `OpenAI API ${res.status}: ${text}` };
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
  private _baseUrl: string;

  constructor(config: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  }) {
    this._apiKey = config.apiKey;
    this._model = config.model ?? "text-embedding-3-small";
    this._baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
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

    const res = await fetch(`${this._baseUrl}/v1/embeddings`, {
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
      baseUrl: config?.baseUrl ?? "http://localhost:11434",
      defaultModel: config?.defaultModel ?? "llama3",
    },
    "ollama"
  );
}
