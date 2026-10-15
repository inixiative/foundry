// The Warden pre-filter: one cheap local yes/no per Warden before it is asked. Data and pure
// functions only, so Oracle scores runs the same way; Foundry's provider makes the call. It fails
// open: a Warden is skipped only on a confident no, and anything else (an unsure score, an error, no
// answer) asks the Warden as before.

import type { WardenTriggerKind } from './warden-labels';

/**
 * Where a moment arrives: before (the user's message), after (the agent's actions of a turn or its
 * plan, and its finished turn), or at a handoff to a subagent. The labelled moments are
 * `WardenFixture`s (`warden-labels`).
 */
export type PrefilterTrigger = WardenTriggerKind | 'post-turn';

/** One (moment, Warden) pair as a run scored it. */
export interface PrefilterPair {
  readonly momentId: string;
  readonly wardenId: string;
  /** Labelled relevance; undefined for an unlabelled pair, which still counts toward the skip rate. */
  readonly relevant?: boolean;
  /** P(the moment is in this Warden's domain); undefined when the call failed (the Warden is asked). */
  readonly score?: number;
}

/** Fail open: skip only when the score is a confident no. */
export function prefilterSkips(score: number | undefined, skipBelow: number): boolean {
  return score !== undefined && score < skipBelow;
}

export interface PrefilterPoint {
  readonly threshold: number;
  /** Share of all pairs skipped: Warden calls saved. */
  readonly skipRate: number;
  /** Share of relevant pairs still asked. */
  readonly recall: number | null;
  /** Share of labelled not-relevant pairs skipped. */
  readonly correctSkips: number | null;
}

export interface PrefilterScore {
  readonly pairs: number;
  readonly relevant: number;
  readonly labelledIrrelevant: number;
  readonly errors: number;
  /** Ranking quality over labelled pairs (relevant against labelled not relevant). */
  readonly auroc: number | null;
  /** Recall when the threshold skips this share of all pairs. */
  readonly recallAtSkip: Readonly<Record<string, number | null>>;
  /** The share of pairs skipped while still asking this share of relevant pairs. */
  readonly skipAtRecall: Readonly<Record<string, { threshold: number; skipRate: number } | null>>;
  readonly sweep: readonly PrefilterPoint[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const ratio = (n: number, d: number) => (d ? round(n / d) : null);

export const PREFILTER_SWEEP = [
  0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9,
] as const;

/** Recall against skip rate, both ways, and the threshold sweep. */
export function scorePrefilter(
  pairs: readonly PrefilterPair[],
  options: { skipRates?: readonly number[]; recalls?: readonly number[] } = {},
): PrefilterScore {
  const positives = pairs.filter((p) => p.relevant === true);
  const negatives = pairs.filter((p) => p.relevant === false);
  const at = (threshold: number): PrefilterPoint => {
    const skip = (p: PrefilterPair) => prefilterSkips(p.score, threshold);
    return {
      threshold,
      skipRate: ratio(pairs.filter(skip).length, pairs.length) ?? 0,
      recall: ratio(positives.filter((p) => !skip(p)).length, positives.length),
      correctSkips: ratio(negatives.filter(skip).length, negatives.length),
    };
  };
  const scoreOf = (p: PrefilterPair) => p.score ?? Number.POSITIVE_INFINITY;
  // Recall at a skip rate: the threshold is the score that skips that share of all pairs.
  const ascending = pairs.map(scoreOf).sort((a, b) => a - b);
  const recallAtSkip: Record<string, number | null> = {};
  for (const rate of options.skipRates ?? [0.3, 0.5, 0.7]) {
    const threshold =
      ascending[Math.min(ascending.length - 1, Math.floor(rate * ascending.length))];
    recallAtSkip[String(rate)] =
      threshold === undefined || !Number.isFinite(threshold) ? null : at(threshold).recall;
  }
  // Skip rate at a recall: the highest threshold that still asks that share of relevant pairs.
  const positiveScores = positives.map(scoreOf).sort((a, b) => a - b);
  const skipAtRecall: Record<string, { threshold: number; skipRate: number } | null> = {};
  for (const target of options.recalls ?? [0.8, 0.9, 0.95]) {
    const threshold = positiveScores[Math.floor((1 - target) * positiveScores.length + 1e-9)];
    skipAtRecall[String(target)] =
      threshold === undefined || !Number.isFinite(threshold)
        ? null
        : { threshold: round(threshold), skipRate: at(threshold).skipRate };
  }
  return {
    pairs: pairs.length,
    relevant: positives.length,
    labelledIrrelevant: negatives.length,
    errors: pairs.filter((p) => p.score === undefined).length,
    auroc: auroc(positives, negatives),
    recallAtSkip,
    skipAtRecall,
    sweep: PREFILTER_SWEEP.map(at),
  };
}

function auroc(positives: readonly PrefilterPair[], negatives: readonly PrefilterPair[]) {
  const pos = positives.flatMap((p) => (p.score === undefined ? [] : [p.score]));
  const neg = negatives.flatMap((p) => (p.score === undefined ? [] : [p.score]));
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return round(wins / (pos.length * neg.length));
}

/**
 * The same pair scored N times: the share whose skip/ask decision never changed at the threshold,
 * and the mean spread (max − min) of its score.
 */
export function prefilterConsistency(
  repeats: ReadonlyMap<string, readonly (number | undefined)[]>,
  skipBelow: number,
) {
  let same = 0,
    spread = 0,
    n = 0;
  for (const scores of repeats.values()) {
    if (!scores.length) continue;
    n++;
    if (new Set(scores.map((s) => prefilterSkips(s, skipBelow))).size === 1) same++;
    const values = scores.filter((s): s is number => s !== undefined);
    spread += values.length ? Math.max(...values) - Math.min(...values) : 1;
  }
  return { pairs: n, sameDecision: ratio(same, n), meanSpread: n ? round(spread / n) : null };
}

export function percentiles(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  return { p50: pick(50), p95: pick(95), max: sorted.at(-1) ?? 0 };
}

/** Characters of a Warden's instructions a question carries: the decision model reads 192 tokens of it. */
export const PREFILTER_DESCRIPTION_CHARS = 480;
/** Characters of the moment, head and tail, and of the thread context, a state carries. */
export const PREFILTER_MOMENT_CHARS = 1600;
export const PREFILTER_CONTEXT_CHARS = 400;

/**
 * A Warden's domain as the question states it: its instructions without the "You are the … Warden."
 * opener, so the question reads as a topic.
 */
export function prefilterDescription(instructions: string): string {
  const text = instructions
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^You are the [^.]*\.\s*/, '');
  return clip(text, PREFILTER_DESCRIPTION_CHARS);
}

/**
 * The System One yes/no asked per Warden, as a topic ("Is this about …"). On a small hand-checked
 * grid it separated in-domain moments far better than asking about "a reviewer's domain".
 */
export function prefilterQuestion(description: string) {
  return { type: 'noul' as const, instructions: `Is this about ${description}` };
}

/** The System One state for a moment: a bounded view of what the thread holds, then the moment. */
export function prefilterState(trigger: PrefilterTrigger, text: string, context?: string): string {
  const label = {
    'user-message': "The user's message",
    'agent-action': "The agent's actions this turn",
    'agent-plan': "The agent's plan",
    'subagent-spawn': 'The task the agent is handing to a subagent',
    'post-turn': "The agent's finished turn",
  }[trigger];
  const moment = window(text.trim(), PREFILTER_MOMENT_CHARS);
  return context?.trim()
    ? `${label}:\n${moment}\n\nThread so far: ${clip(context.trim(), PREFILTER_CONTEXT_CHARS)}`
    : `${label}:\n${moment}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Head and tail of a long text: an agent turn states its plan first and its result last. */
function window(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 3) / 2);
  return `${text.slice(0, half)} … ${text.slice(-half)}`;
}
