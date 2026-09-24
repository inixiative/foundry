import { OpenAIProvider, type OpenAIConfig } from "./openai";
import type { CompletionOpts, LLMMessage } from "@inixiative/foundry-core";

export type XAIConfig = Omit<OpenAIConfig, "explicitNoReasoning">;

const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

/**
 * xAI Grok. Chat Completions is wire-compatible with OpenAI apart from the
 * reasoning controls: effort is a nested `reasoning` object rather than
 * `reasoning_effort`, it cannot be switched off, and reasoning models reject
 * `stop` and the penalty parameters.
 */
export class XAIProvider extends OpenAIProvider {
  constructor(config: XAIConfig, id?: string) {
    super({ ...config, baseUrl: config.baseUrl ?? "https://api.x.ai/v1" }, id ?? "xai");
  }

  protected _body(messages: LLMMessage[], opts: CompletionOpts | undefined, model: string): Record<string, unknown> {
    const body = super._body(messages, opts, model);
    delete body.reasoning_effort;
    if (body.max_completion_tokens !== undefined) {
      body.max_tokens = body.max_completion_tokens;
      delete body.max_completion_tokens;
    }
    if (!this._isReasoningModel(model)) return body;
    delete body.stop;
    const effort = typeof opts?.thinking === "string" ? opts.thinking : undefined;
    if (effort && EFFORTS.has(effort)) body.reasoning = { effort };
    return body;
  }
}
