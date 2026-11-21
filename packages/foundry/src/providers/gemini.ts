/**
 * @atlas
 * @kind provider
 * @partOf primitive:providers
 */
import type {
  CompletionOpts,
  CompletionResult,
  LLMMessage,
  LLMProvider,
  LLMStreamEvent,
  ModelReasoning,
  TokenCounts,
  ToolCall,
  ToolDefinition,
} from '@inixiative/foundry-core';
import { newId, registryModel, splitSystemMessage } from '@inixiative/foundry-core';
import { HttpCompletionSettlement } from './http-settlement';

export interface GeminiConfig {
  apiKey: string;
  /** Defaults to "gemini-3.5-flash-lite". */
  defaultModel?: string;
  /** Override base URL. */
  baseUrl?: string;
}

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

// ---------------------------------------------------------------------------
// Gemini generateContent helpers
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown> };
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

/** Gemini response shape (with function call and thinking support). */
interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsageMetadata;
}

/** A turn as Gemini generateContent takes it: inline image parts ahead of text. */
function geminiContent(message: LLMMessage) {
  const role = message.role === 'assistant' ? 'model' : 'user';
  if (!message.images?.length) {
    return { role, parts: [{ text: message.content }] };
  }
  return {
    role,
    parts: [
      ...message.images.map((image) => {
        if (!image.data) throw Error(`Image ${image.id} has no data; nothing was sent`);
        return {
          inlineData: { mimeType: image.mediaType, data: image.data },
        };
      }),
      ...(message.content ? [{ text: message.content }] : []),
    ],
  };
}

/** Map Gemini usageMetadata into disjoint TokenCounts (cacheRead split out of input; thinking folded into output). */
function parseGeminiUsage(usage?: GeminiUsageMetadata): TokenCounts | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.promptTokenCount ?? 0;
  const cached = usage.cachedContentTokenCount;
  const candidates = usage.candidatesTokenCount ?? 0;
  const thoughts = usage.thoughtsTokenCount;
  return {
    input: cached !== undefined ? Math.max(0, promptTokens - cached) : promptTokens,
    output: candidates + (thoughts ?? 0),
    ...(cached !== undefined ? { cacheRead: cached } : {}),
    ...(thoughts !== undefined ? { thinking: thoughts } : {}),
  };
}

/** Map our ToolDefinition to Gemini's functionDeclaration format. */
function toGeminiFunctionDecl(tool: ToolDefinition): Record<string, unknown> {
  const decl: Record<string, unknown> = {
    name: tool.name,
    description: tool.description,
  };

  // Gemini expects OpenAPI-style parameters schema
  if (tool.inputSchema && Object.keys(tool.inputSchema).length > 0) {
    decl.parameters = tool.inputSchema;
  }

  return decl;
}

/**
 * Google Gemini generateContent adapter.
 * Uses raw fetch — zero SDK dependency.
 */
export class GeminiProvider implements LLMProvider {
  private readonly _settlement = new HttpCompletionSettlement();
  readonly completionLifecycle = this._settlement.lifecycle;
  readonly id = 'gemini';
  readonly imageInput = true;

  private _apiKey: string;
  private _defaultModel: string;
  private _baseUrl: string;

  constructor(config: GeminiConfig) {
    this._apiKey = config.apiKey;
    this._defaultModel = config.defaultModel ?? DEFAULT_MODEL;
    this._baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  }

  private _buildBody(
    messages: LLMMessage[],
    opts: CompletionOpts | undefined,
    model: string,
  ): Record<string, unknown> {
    const { system, turns } = splitSystemMessage(messages);
    const body: Record<string, unknown> = {
      contents: turns.map(geminiContent),
    };

    if (system) {
      body.system_instruction = { parts: [{ text: system }] };
    }

    const generationConfig: Record<string, unknown> = {};
    if (opts?.maxTokens !== undefined) generationConfig.maxOutputTokens = opts.maxTokens;
    if (opts?.temperature !== undefined) generationConfig.temperature = opts.temperature;
    if (opts?.topP !== undefined) generationConfig.topP = opts.topP;
    if (opts?.stop) generationConfig.stopSequences = opts.stop;

    if (opts?.thinking !== undefined) {
      if (typeof opts.thinking === 'number') {
        generationConfig.thinkingConfig = { thinkingBudget: opts.thinking };
      } else {
        const reasoning = registryModel('gemini', model)?.reasoning;
        if (reasoning?.param === 'thinking_level') {
          const asked = opts.thinking as ModelReasoning['fallback'];
          const level = reasoning.efforts.includes(asked) ? asked : reasoning.fallback;
          generationConfig.thinkingConfig = { thinkingLevel: level.toUpperCase() };
        }
      }
    }

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    if (opts?.tools !== false && opts?.toolDefinitions?.length) {
      body.tools = [{ functionDeclarations: opts.toolDefinitions.map(toGeminiFunctionDecl) }];
    }

    return body;
  }

  async complete(messages: LLMMessage[], opts?: CompletionOpts): Promise<CompletionResult> {
    const model = opts?.model ?? this._defaultModel;
    const body = this._buildBody(messages, opts, model);
    const url = `${this._baseUrl}/v1beta/models/${model}:generateContent`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this._apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw this._settlement.completedError(`Gemini API ${res.status}: ${text}`);
    }

    const data = (await res.json()) as GeminiResponse;

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    // Extract plain text (excluding internal thought parts) and function calls
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const part of parts) {
      if (part.text && !part.thought) {
        textParts.push(part.text);
      }
      if (part.functionCall) {
        toolCalls.push({
          id: newId('gemini'),
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        });
      }
    }

    return {
      content: textParts.join(''),
      model,
      tokens: parseGeminiUsage(data.usageMetadata),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
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
  async *stream(messages: LLMMessage[], opts?: CompletionOpts): AsyncGenerator<LLMStreamEvent> {
    const model = opts?.model ?? this._defaultModel;
    const body = this._buildBody(messages, opts, model);
    const url = `${this._baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this._apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      yield { type: 'error', error: `Gemini API ${res.status}: ${text}` };
      return;
    }

    if (!res.body) {
      yield { type: 'error', error: 'No response body for streaming' };
      return;
    }

    let finishReason: string | undefined;
    let lastUsage: GeminiUsageMetadata | undefined;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          try {
            const parsed = JSON.parse(data) as GeminiResponse;

            // Extract plain text parts from candidates, skipping thought parts
            const candidate = parsed.candidates?.[0];
            if (candidate?.content?.parts) {
              for (const part of candidate.content.parts) {
                if (part.text && !part.thought) {
                  yield { type: 'text', text: part.text };
                }
              }
            }

            if (candidate?.finishReason) {
              finishReason = candidate.finishReason;
            }

            if (parsed.usageMetadata) {
              lastUsage = { ...lastUsage, ...parsed.usageMetadata };
            }
          } catch (err) {
            console.warn('[Gemini] malformed stream chunk:', (err as Error).message);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const tokens = parseGeminiUsage(lastUsage);
    if (tokens && (tokens.input > 0 || tokens.output > 0 || (tokens.cacheRead ?? 0) > 0)) {
      yield { type: 'usage', tokens };
    }

    yield { type: 'done', finishReason };
  }
}
