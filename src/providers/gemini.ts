import type {
  LLMProvider,
  LLMMessage,
  CompletionOpts,
  CompletionResult,
  LLMStreamEvent,
  EmbeddingProvider,
  EmbeddingResult,
} from "./types";
import { splitSystemMessage } from "./types";

export interface GeminiConfig {
  apiKey: string;
  /** Defaults to "gemini-2.5-flash". */
  defaultModel?: string;
  /** Override base URL. */
  baseUrl?: string;
}

const DEFAULT_BASE = "https://generativelanguage.googleapis.com";

/**
 * Google Gemini generateContent adapter.
 * Uses raw fetch — zero SDK dependency.
 */
export class GeminiProvider implements LLMProvider {
  readonly id = "gemini";

  private _apiKey: string;
  private _defaultModel: string;
  private _baseUrl: string;

  constructor(config: GeminiConfig) {
    this._apiKey = config.apiKey;
    this._defaultModel = config.defaultModel ?? "gemini-2.5-flash";
    this._baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  }

  async complete(
    messages: LLMMessage[],
    opts?: CompletionOpts
  ): Promise<CompletionResult> {
    const model = opts?.model ?? this._defaultModel;
    const { system, turns } = splitSystemMessage(messages);

    // Map LLMMessage roles to Gemini roles
    const contents = turns.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const body: Record<string, unknown> = { contents };

    if (system) {
      body.system_instruction = { parts: [{ text: system }] };
    }

    const generationConfig: Record<string, unknown> = {};
    if (opts?.maxTokens !== undefined)
      generationConfig.maxOutputTokens = opts.maxTokens;
    if (opts?.temperature !== undefined)
      generationConfig.temperature = opts.temperature;
    if (opts?.topP !== undefined) generationConfig.topP = opts.topP;
    if (opts?.stop) generationConfig.stopSequences = opts.stop;

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    const url = `${this._baseUrl}/v1beta/models/${model}:generateContent`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this._apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini API ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      candidates: Array<{
        content: { parts: Array<{ text: string }> };
        finishReason: string;
      }>;
      usageMetadata?: {
        promptTokenCount: number;
        candidatesTokenCount: number;
      };
    };

    const candidate = data.candidates?.[0];
    const content =
      candidate?.content?.parts?.map((p) => p.text).join("") ?? "";

    return {
      content,
      model,
      tokens: data.usageMetadata
        ? {
            input: data.usageMetadata.promptTokenCount,
            output: data.usageMetadata.candidatesTokenCount,
          }
        : undefined,
      finishReason: candidate?.finishReason,
      raw: data,
    };
  }

  /**
   * Stream a completion using Gemini's streamGenerateContent endpoint.
   *
   * Uses the `alt=sse` parameter to get Server-Sent Events instead of
   * the default JSON array streaming format.
   */
  async *stream(
    messages: LLMMessage[],
    opts?: CompletionOpts
  ): AsyncGenerator<LLMStreamEvent> {
    const model = opts?.model ?? this._defaultModel;
    const { system, turns } = splitSystemMessage(messages);

    const contents = turns.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const body: Record<string, unknown> = { contents };

    if (system) {
      body.system_instruction = { parts: [{ text: system }] };
    }

    const generationConfig: Record<string, unknown> = {};
    if (opts?.maxTokens !== undefined)
      generationConfig.maxOutputTokens = opts.maxTokens;
    if (opts?.temperature !== undefined)
      generationConfig.temperature = opts.temperature;
    if (opts?.topP !== undefined) generationConfig.topP = opts.topP;
    if (opts?.stop) generationConfig.stopSequences = opts.stop;

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    const url = `${this._baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this._apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      yield { type: "error", error: `Gemini API ${res.status}: ${text}` };
      return;
    }

    if (!res.body) {
      yield { type: "error", error: "No response body for streaming" };
      return;
    }

    let finishReason: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

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
          try {
            const parsed = JSON.parse(data);

            // Extract text parts from candidates
            const candidate = parsed.candidates?.[0];
            if (candidate?.content?.parts) {
              for (const part of candidate.content.parts) {
                if (part.text) {
                  yield { type: "text", text: part.text };
                }
              }
            }

            if (candidate?.finishReason) {
              finishReason = candidate.finishReason;
            }

            // Usage metadata
            if (parsed.usageMetadata) {
              inputTokens = parsed.usageMetadata.promptTokenCount ?? inputTokens;
              outputTokens = parsed.usageMetadata.candidatesTokenCount ?? outputTokens;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (inputTokens > 0 || outputTokens > 0) {
      yield { type: "usage", tokens: { input: inputTokens, output: outputTokens } };
    }

    yield { type: "done", finishReason };
  }
}

/**
 * Gemini Embedding adapter.
 * Uses the embedContent / batchEmbedContents endpoints.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly id = "gemini-embed";

  private _apiKey: string;
  private _model: string;
  private _baseUrl: string;

  constructor(config: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  }) {
    this._apiKey = config.apiKey;
    this._model = config.model ?? "text-embedding-004";
    this._baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const url = `${this._baseUrl}/v1beta/models/${this._model}:embedContent`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this._apiKey,
      },
      body: JSON.stringify({
        model: `models/${this._model}`,
        content: { parts: [{ text }] },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini Embedding API ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as {
      embedding: { values: number[] };
    };

    return { embedding: data.embedding.values };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const url = `${this._baseUrl}/v1beta/models/${this._model}:batchEmbedContents`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this._apiKey,
      },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${this._model}`,
          content: { parts: [{ text }] },
        })),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini Batch Embedding API ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as {
      embeddings: Array<{ values: number[] }>;
    };

    return data.embeddings.map((e) => ({ embedding: e.values }));
  }
}
