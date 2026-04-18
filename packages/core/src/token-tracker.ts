// ---------------------------------------------------------------------------
// Token & Cost Tracking
// ---------------------------------------------------------------------------

/**
 * Accumulated token usage with estimated cost.
 */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly total: number;
  readonly estimatedCost: number;
}

/**
 * A single recorded usage entry — one LLM call.
 */
export interface UsageEntry {
  readonly timestamp: number;
  readonly provider: string;
  readonly model: string;
  readonly agentId?: string;
  readonly threadId?: string;
  readonly spanId?: string;
  readonly tokens: { readonly input: number; readonly output: number };
  readonly cost: number;
  readonly cached?: boolean;
}

/**
 * Per-model pricing: cost in dollars per 1 million tokens.
 */
export interface ModelPricing {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
}

/**
 * Nested cost table: provider -> model -> pricing.
 */
export interface CostTable {
  readonly [provider: string]: {
    readonly [model: string]: ModelPricing;
  };
}

/**
 * Budget enforcement configuration.
 */
export interface BudgetConfig {
  /** Maximum total tokens (input + output) before budget is exceeded. */
  readonly maxTokens?: number;
  /** Maximum cost in dollars before budget is exceeded. */
  readonly maxCost?: number;
  /** Percentage (0-1) of budget at which to emit a warning. Default 0.8. */
  readonly warnAt?: number;
  /** Percentage (0-1) of budget at which to throw / halt. Default 1.0. */
  readonly haltAt?: number;
}

/**
 * Current budget status snapshot.
 */
export interface BudgetStatus {
  readonly usedTokens: number;
  readonly usedCost: number;
  readonly limitTokens: number | undefined;
  readonly limitCost: number | undefined;
  readonly percentage: number;
  readonly warning: boolean;
  readonly exceeded: boolean;
}

/**
 * Breakdown row used inside UsageSummary.
 */
export interface UsageBreakdown {
  readonly key: string;
  readonly input: number;
  readonly output: number;
  readonly total: number;
  readonly cost: number;
  readonly calls: number;
}

/**
 * Full summary across all dimensions.
 */
export interface UsageSummary {
  readonly totalInput: number;
  readonly totalOutput: number;
  readonly totalTokens: number;
  readonly totalCost: number;
  readonly totalCalls: number;
  readonly byProvider: ReadonlyArray<UsageBreakdown>;
  readonly byModel: ReadonlyArray<UsageBreakdown>;
  readonly byAgent: ReadonlyArray<UsageBreakdown>;
  readonly byThread: ReadonlyArray<UsageBreakdown>;
  readonly budget: BudgetStatus;
}

// ---------------------------------------------------------------------------
// Default cost table (approximate pricing as of early 2026)
// ---------------------------------------------------------------------------

export const DEFAULT_COST_TABLE: CostTable = {
  anthropic: {
    "claude-opus-4-7": { inputPer1M: 5, outputPer1M: 25 },
    "claude-opus-4-6": { inputPer1M: 5, outputPer1M: 25 },
    "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
    "claude-haiku-4-5-20251001": { inputPer1M: 1, outputPer1M: 5 },
  },
  openai: {
    "gpt-5.4": { inputPer1M: 2.5, outputPer1M: 15 },
    "gpt-5.4-mini": { inputPer1M: 0.75, outputPer1M: 4.5 },
    "gpt-5.3-codex": { inputPer1M: 1.75, outputPer1M: 14 },
    "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 }, // retired Feb 2026 — kept for historical cost tracking
  },
  gemini: {
    "gemini-3.1-pro-preview": { inputPer1M: 2, outputPer1M: 12 },
    "gemini-3-flash-preview": { inputPer1M: 0.5, outputPer1M: 3 },
    "gemini-3.1-flash-lite-preview": { inputPer1M: 0.25, outputPer1M: 1.5 },
  },
  // Claude Code provider tracks usage via session output, not cost table
  "claude-code": {},
};

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Heuristic patterns that indicate source code rather than prose. */
const CODE_SIGNALS = /[{}();=]|=>|function\s|import\s|export\s|const\s|let\s|var\s|class\s|def\s|return\s/;

/**
 * Estimate the number of tokens in `text` without a full tokenizer.
 *
 * Strategy:
 * - Detect whether the text is predominantly code or natural language.
 * - For code, use ~0.4 tokens per character (code is denser).
 * - For prose, use ~0.75 tokens per whitespace-delimited word.
 * - Falls back gracefully for empty / tiny strings.
 *
 * This is intentionally fast — no WASM, no external deps — but
 * meaningfully more accurate than the naive `Math.ceil(len / 4)`.
 */
export function estimateTokens(text: string, _model?: string): number {
  if (!text) return 0;

  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;

  // Sample up to the first 2000 chars for the code-detection heuristic
  const sample = trimmed.slice(0, 2000);
  const isCode = CODE_SIGNALS.test(sample);

  if (isCode) {
    // Code: roughly 0.4 tokens per character
    return Math.max(1, Math.ceil(trimmed.length * 0.4));
  }

  // Prose: roughly 0.75 tokens per word
  const words = trimmed.split(/\s+/).length;
  return Math.max(1, Math.ceil(words * 0.75));
}

// ---------------------------------------------------------------------------
// TokenTracker
// ---------------------------------------------------------------------------

type EventHandler = (status: BudgetStatus) => void;

export class TokenTracker {
  private readonly _entries: UsageEntry[] = [];
  private readonly _costTable: CostTable;
  private readonly _budget: BudgetConfig;
  private readonly _warningHandlers: EventHandler[] = [];
  private readonly _exceededHandlers: EventHandler[] = [];

  /** Tracks whether a warning has already been emitted for this budget cycle. */
  private _warningEmitted = false;

  constructor(opts?: { costTable?: CostTable; budget?: BudgetConfig }) {
    this._costTable = opts?.costTable ?? DEFAULT_COST_TABLE;
    this._budget = opts?.budget ?? {};
  }

  // -----------------------------------------------------------------------
  // Recording
  // -----------------------------------------------------------------------

  /**
   * Record a token usage entry. Automatically computes cost from the cost
   * table and timestamps the entry. Returns the full entry.
   *
   * Throws if budget.haltAt is exceeded (when configured).
   */
  record(
    entry: Omit<UsageEntry, "timestamp" | "cost">
  ): UsageEntry {
    const cost = this._computeCost(
      entry.provider,
      entry.model,
      entry.tokens.input,
      entry.tokens.output,
      entry.cached
    );

    const full: UsageEntry = {
      ...entry,
      timestamp: Date.now(),
      cost,
    };

    this._entries.push(full);
    this._checkBudget();
    return full;
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  get totalTokens(): TokenUsage {
    return this._aggregate(this._entries);
  }

  byProvider(provider: string): TokenUsage {
    return this._aggregate(this._entries.filter((e) => e.provider === provider));
  }

  byModel(model: string): TokenUsage {
    return this._aggregate(this._entries.filter((e) => e.model === model));
  }

  byAgent(agentId: string): TokenUsage {
    return this._aggregate(this._entries.filter((e) => e.agentId === agentId));
  }

  byThread(threadId: string): TokenUsage {
    return this._aggregate(this._entries.filter((e) => e.threadId === threadId));
  }

  // -----------------------------------------------------------------------
  // Budget
  // -----------------------------------------------------------------------

  get budgetStatus(): BudgetStatus {
    return this._buildBudgetStatus();
  }

  // -----------------------------------------------------------------------
  // History & summary
  // -----------------------------------------------------------------------

  /** Return the most recent entries (default 50). */
  recent(limit = 50): ReadonlyArray<UsageEntry> {
    return this._entries.slice(-limit);
  }

  /** Full usage summary across all dimensions. */
  summary(): UsageSummary {
    return {
      totalInput: this._sum("input"),
      totalOutput: this._sum("output"),
      totalTokens: this._sum("input") + this._sum("output"),
      totalCost: this._entries.reduce((s, e) => s + e.cost, 0),
      totalCalls: this._entries.length,
      byProvider: this._groupBy("provider"),
      byModel: this._groupBy("model"),
      byAgent: this._groupBy("agentId"),
      byThread: this._groupBy("threadId"),
      budget: this._buildBudgetStatus(),
    };
  }

  /** Clear all recorded entries and reset warning state. */
  reset(): void {
    this._entries.length = 0;
    this._warningEmitted = false;
  }

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  /** Subscribe to budget warnings. Returns an unsubscribe function. */
  onWarning(handler: EventHandler): () => void {
    this._warningHandlers.push(handler);
    return () => {
      const idx = this._warningHandlers.indexOf(handler);
      if (idx !== -1) this._warningHandlers.splice(idx, 1);
    };
  }

  /** Subscribe to budget exceeded events. Returns an unsubscribe function. */
  onExceeded(handler: EventHandler): () => void {
    this._exceededHandlers.push(handler);
    return () => {
      const idx = this._exceededHandlers.indexOf(handler);
      if (idx !== -1) this._exceededHandlers.splice(idx, 1);
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private _computeCost(
    provider: string,
    model: string,
    input: number,
    output: number,
    cached?: boolean
  ): number {
    const pricing = this._costTable[provider]?.[model];
    if (!pricing) return 0;

    // Cached input tokens are typically free or heavily discounted
    const effectiveInput = cached ? input * 0.1 : input;
    return (
      (effectiveInput / 1_000_000) * pricing.inputPer1M +
      (output / 1_000_000) * pricing.outputPer1M
    );
  }

  private _aggregate(entries: UsageEntry[]): TokenUsage {
    let input = 0;
    let output = 0;
    let cost = 0;
    for (const e of entries) {
      input += e.tokens.input;
      output += e.tokens.output;
      cost += e.cost;
    }
    return { input, output, total: input + output, estimatedCost: cost };
  }

  private _sum(field: "input" | "output"): number {
    let total = 0;
    for (const e of this._entries) {
      total += e.tokens[field];
    }
    return total;
  }

  private _groupBy(
    field: "provider" | "model" | "agentId" | "threadId"
  ): UsageBreakdown[] {
    const map = new Map<
      string,
      { input: number; output: number; cost: number; calls: number }
    >();

    for (const e of this._entries) {
      const key = e[field];
      if (key == null) continue;
      const existing = map.get(key);
      if (existing) {
        existing.input += e.tokens.input;
        existing.output += e.tokens.output;
        existing.cost += e.cost;
        existing.calls += 1;
      } else {
        map.set(key, {
          input: e.tokens.input,
          output: e.tokens.output,
          cost: e.cost,
          calls: 1,
        });
      }
    }

    const result: UsageBreakdown[] = [];
    for (const [key, v] of map) {
      result.push({
        key,
        input: v.input,
        output: v.output,
        total: v.input + v.output,
        cost: v.cost,
        calls: v.calls,
      });
    }
    return result;
  }

  private _buildBudgetStatus(): BudgetStatus {
    const usedTokens = this._sum("input") + this._sum("output");
    const usedCost = this._entries.reduce((s, e) => s + e.cost, 0);

    const limitTokens = this._budget.maxTokens;
    const limitCost = this._budget.maxCost;

    // Calculate percentage based on whichever limit is closer to being hit
    let percentage = 0;
    if (limitTokens != null && limitTokens > 0) {
      percentage = Math.max(percentage, usedTokens / limitTokens);
    }
    if (limitCost != null && limitCost > 0) {
      percentage = Math.max(percentage, usedCost / limitCost);
    }

    const warnAt = this._budget.warnAt ?? 0.8;
    const haltAt = this._budget.haltAt ?? 1.0;

    return {
      usedTokens,
      usedCost,
      limitTokens,
      limitCost,
      percentage,
      warning: percentage >= warnAt,
      exceeded: percentage >= haltAt,
    };
  }

  private _checkBudget(): void {
    const status = this._buildBudgetStatus();

    if (status.warning && !this._warningEmitted) {
      this._warningEmitted = true;
      for (const handler of [...this._warningHandlers]) {
        try {
          handler(status);
        } catch {
          // Don't let one bad handler break recording
        }
      }
    }

    if (status.exceeded) {
      for (const handler of [...this._exceededHandlers]) {
        try {
          handler(status);
        } catch {
          // Don't let one bad handler break recording
        }
      }
      throw new BudgetExceededError(status);
    }
  }
}

/**
 * Thrown when token/cost budget is exceeded (at haltAt threshold).
 */
export class BudgetExceededError extends Error {
  readonly status: BudgetStatus;

  constructor(status: BudgetStatus) {
    const parts: string[] = [];
    if (status.limitTokens != null) {
      parts.push(`${status.usedTokens}/${status.limitTokens} tokens`);
    }
    if (status.limitCost != null) {
      parts.push(`$${status.usedCost.toFixed(4)}/$${status.limitCost.toFixed(2)}`);
    }
    super(`Budget exceeded: ${parts.join(", ")} (${(status.percentage * 100).toFixed(1)}%)`);
    this.name = "BudgetExceededError";
    this.status = status;
  }
}
