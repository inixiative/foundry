// ---------------------------------------------------------------------------
// GatedProvider — wraps any LLMProvider with capability checks
// ---------------------------------------------------------------------------
//
// Sits in front of any provider (Anthropic, OpenAI, etc.) and checks
// the CapabilityGate before each call. If the gate prompts, the call
// blocks until the operator approves. If denied, throws.
//
// Usage:
//   const provider = new GatedProvider(anthropicProvider, gate, { threadId: "main" });
//   const result = await provider.complete(messages, opts);
//   // ^ may block for approval if policy requires it
// ---------------------------------------------------------------------------

import type {
  LLMProvider,
  LLMMessage,
  CompletionOpts,
  CompletionResult,
  LLMStreamEvent,
  CapabilityGate,
} from "@inixiative/foundry-core";
import { estimateTokens, DEFAULT_COST_TABLE } from "@inixiative/foundry-core";

export interface GatedProviderConfig {
  /** The underlying provider to wrap. */
  provider: LLMProvider;
  /** Capability gate for permission checks. */
  gate: CapabilityGate;
  /** Default thread ID for prompts (can be overridden per-call). */
  threadId: string;
  /** Estimate cost from token count. Uses DEFAULT_COST_TABLE if not provided. */
  costEstimator?: (model: string, inputTokens: number) => number;
}

export class GatedProvider implements LLMProvider {
  readonly id: string;
  private _provider: LLMProvider;
  private _gate: CapabilityGate;
  private _threadId: string;
  private _estimateCost: (model: string, inputTokens: number) => number;

  constructor(config: GatedProviderConfig) {
    this._provider = config.provider;
    this._gate = config.gate;
    this._threadId = config.threadId;
    this.id = `gated:${config.provider.id}`;

    this._estimateCost = config.costEstimator ?? ((model, inputTokens) => {
      // Cost table is provider→model→pricing, search all providers
      for (const models of Object.values(DEFAULT_COST_TABLE)) {
        const pricing = models[model];
        if (pricing) return (inputTokens / 1_000_000) * pricing.inputPer1M;
      }
      return 0;
    });
  }

  async complete(
    messages: LLMMessage[],
    opts?: CompletionOpts
  ): Promise<CompletionResult> {
    const model = opts?.model ?? "unknown";
    const inputText = messages.map((m) => m.content).join("\n");
    const inputTokens = estimateTokens(inputText);
    const estimatedCost = this._estimateCost(model, inputTokens);

    // Check llm:call capability
    await this._gate.require("llm:call", {
      agentId: this.id,
      threadId: this._threadId,
      detail: `${model}, ~${inputTokens} tokens`,
      meta: { model, inputTokens, estimatedCost },
    });

    // Check llm:expensive if cost threshold is set
    if (this._gate.policy.costThreshold != null && estimatedCost > this._gate.policy.costThreshold) {
      await this._gate.require("llm:expensive", {
        agentId: this.id,
        threadId: this._threadId,
        detail: `$${estimatedCost.toFixed(4)} estimated (${model}, ~${inputTokens} tokens)`,
        meta: { model, inputTokens, estimatedCost },
      });
    }

    return this._provider.complete(messages, opts);
  }

  async *stream(
    messages: LLMMessage[],
    opts?: CompletionOpts
  ): AsyncGenerator<LLMStreamEvent> {
    const model = opts?.model ?? "unknown";
    const inputText = messages.map((m) => m.content).join("\n");
    const inputTokens = estimateTokens(inputText);
    const estimatedCost = this._estimateCost(model, inputTokens);

    await this._gate.require("llm:call", {
      agentId: this.id,
      threadId: this._threadId,
      detail: `stream ${model}, ~${inputTokens} tokens`,
      meta: { model, inputTokens, estimatedCost },
    });

    if (this._gate.policy.costThreshold != null && estimatedCost > this._gate.policy.costThreshold) {
      await this._gate.require("llm:expensive", {
        agentId: this.id,
        threadId: this._threadId,
        detail: `$${estimatedCost.toFixed(4)} estimated (stream ${model})`,
        meta: { model, inputTokens, estimatedCost },
      });
    }

    if (this._provider.stream) {
      yield* this._provider.stream(messages, opts);
    }
  }

  /** Access the underlying provider. */
  get inner(): LLMProvider {
    return this._provider;
  }
}
