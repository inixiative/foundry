import type {
  LLMProvider,
  LLMMessage,
  CompletionOpts,
  CompletionResult,
  EmbeddingProvider,
  EmbeddingResult,
} from "./types";
import { splitSystemMessage } from "./types";

export interface AnthropicConfig {
  apiKey: string;
  /** Defaults to "claude-sonnet-4-20250514". */
  defaultModel?: string;
  /** Defaults to 1024. */
  defaultMaxTokens?: number;
  /** Override base URL (e.g. for proxies). */
  baseUrl?: string;
}

const DEFAULT_BASE = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

/**
 * Anthropic Messages API adapter.
 * Uses raw fetch — zero SDK dependency.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";

  private _apiKey: string;
  private _defaultModel: string;
  private _defaultMaxTokens: number;
  private _baseUrl: string;

  constructor(config: AnthropicConfig) {
    this._apiKey = config.apiKey;
    this._defaultModel = config.defaultModel ?? "claude-sonnet-4-20250514";
    this._defaultMaxTokens = config.defaultMaxTokens ?? 1024;
    this._baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  }

  async complete(
    messages: LLMMessage[],
    opts?: CompletionOpts
  ): Promise<CompletionResult> {
    const { system, turns } = splitSystemMessage(messages);
    const model = opts?.model ?? this._defaultModel;
    const maxTokens = opts?.maxTokens ?? this._defaultMaxTokens;

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: turns.map((m) => ({ role: m.role, content: m.content })),
    };

    if (system) body.system = system;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.topP !== undefined) body.top_p = opts.topP;
    if (opts?.stop) body.stop_sequences = opts.stop;

    const res = await fetch(`${this._baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this._apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    };

    const content = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      content,
      model: data.model,
      tokens: { input: data.usage.input_tokens, output: data.usage.output_tokens },
      finishReason: data.stop_reason,
      raw: data,
    };
  }
}

/**
 * Voyage AI embedding adapter (Anthropic's recommended embedding provider).
 * Also works with any provider that follows the /v1/embeddings OpenAI-compatible format
 * by overriding baseUrl.
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly id = "voyage";

  private _apiKey: string;
  private _model: string;
  private _baseUrl: string;

  constructor(config: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  }) {
    this._apiKey = config.apiKey;
    this._model = config.model ?? "voyage-3";
    this._baseUrl = (config.baseUrl ?? "https://api.voyageai.com").replace(/\/$/, "");
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const results = await this._request([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return this._request(texts);
  }

  private async _request(input: string[]): Promise<EmbeddingResult[]> {
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
      throw new Error(`Voyage API ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      usage: { total_tokens: number };
    };

    const tokensPerItem = Math.ceil(
      (data.usage?.total_tokens ?? 0) / input.length
    );

    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => ({ embedding: d.embedding, tokens: tokensPerItem }));
  }
}
