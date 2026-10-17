/**
 * The weighted cost of the Warden eval report (the reporting standard, Oracle docs/foundry/EVAL-REPORTING.md): exact tokens weighted by
 * kind, then by model, converted to window points with one coefficient fixed from the after-run.
 */

/** Token weights by kind: cache reads cheap, writes and generated tokens dear. */
export const COST_WEIGHTS = {
  input: 1,
  cacheRead: 0.1,
  cacheWrite: 2,
  output: 5,
  thinking: 5,
} as const;

/**
 * Per-model weights (pre-registered in the recogniser-granularity design): the coefficient is
 * Haiku's, so a Sonnet token counts 9 (the model round's coarse window ratio). A model with no weight
 * here gets no weighted cost, never a guessed one.
 */
export const MODEL_COST_WEIGHTS: Readonly<Record<string, number>> = {
  'claude-haiku-5-5': 1,
  'claude-sonnet-5-5': 9,
};

/** Window points per weighted token: 0.11 pt/moment ÷ 224,661 weighted Haiku tokens/moment (after-sub30-20261015). */
export const POINTS_PER_WEIGHTED_TOKEN = 0.11 / 224_661;

export interface TokenKinds {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinking: number;
}

/** Tokens weighted by kind. */
export const kindWeighted = (t: TokenKinds): number =>
  t.input * COST_WEIGHTS.input +
  t.cacheRead * COST_WEIGHTS.cacheRead +
  t.cacheWrite * COST_WEIGHTS.cacheWrite +
  t.output * COST_WEIGHTS.output +
  t.thinking * COST_WEIGHTS.thinking;

/** Each stage's kind-weighted tokens times its model's weight, summed; null when any model has no weight. */
export function modelWeighted(
  parts: readonly { model: string; tokens: TokenKinds; calls: number }[],
) {
  const byModel = parts.map((p) => {
    const kind = kindWeighted(p.tokens);
    const weight = MODEL_COST_WEIGHTS[p.model] ?? null;
    return {
      model: p.model,
      modelWeight: weight,
      calls: p.calls,
      kindWeightedTokens: Math.round(kind),
      weightedTokens: weight === null ? null : Math.round(kind * weight),
    };
  });
  const noModelWeight = byModel.filter((b) => b.modelWeight === null).map((b) => b.model);
  const total = noModelWeight.length
    ? null
    : byModel.reduce((n, b) => n + (b.weightedTokens ?? 0), 0);
  return { byModel, noModelWeight, total };
}
