/**
 * @atlas
 * @kind transformer
 * @partOf feature:feedback
 */
import { activeChanges, type FeedbackItem } from './lifecycle';
import type { FeedbackService } from './service';

/** Where an item is in its cycle, in the order the view reads it. */
export const FEEDBACK_STAGES = [
  'captured',
  'routed',
  'tuned',
  'applied',
  'in use',
  'holding',
  'recurred',
  'dismissed',
] as const;
export type FeedbackStage = (typeof FEEDBACK_STAGES)[number];

/** Whether the item needs the person: back to the drawing board, still moving, or fine as it is. */
export type FeedbackAttention = 'needs attention' | 'in progress' | 'healthy';
const ATTENTION_ORDER: Record<FeedbackAttention, number> = {
  'needs attention': 0,
  'in progress': 1,
  healthy: 2,
};

/** Exposures without a recurrence after which an applied rule counts as holding. */
export const HOLDING_EXPOSURES = 3;

type Use = ReturnType<FeedbackService['uses']>[number];

/**
 * Stage, attention and confidence from the journal evidence alone. Confidence is exposure-based in this
 * slice (how often the rule was in front of its Warden with no recurrence since it was applied); Oracle's
 * recurrence measurement replaces it when that wiring lands.
 */
export function assess(item: FeedbackItem, uses: readonly Use[]) {
  const active = activeChanges(item);
  const since = active.length ? Math.min(...active.map((change) => change.appliedAt)) : undefined;
  const recurredSince =
    since === undefined ? 0 : item.recurrences.filter((r) => r.at >= since).length;
  const exposures = uses.length;
  const answered = item.tuning.at(-1)?.answer;
  const stage: FeedbackStage =
    item.status === 'dismissed'
      ? 'dismissed'
      : active.length
        ? recurredSince
          ? 'recurred'
          : exposures >= HOLDING_EXPOSURES
            ? 'holding'
            : exposures
              ? 'in use'
              : 'applied'
        : answered
          ? 'tuned'
          : item.route
            ? 'routed'
            : 'captured';
  // Explicit feedback is recorded as said, not tuned: the inbox (open / archived) is its attention.
  if (item.originKind === 'explicit')
    return {
      stage,
      attention: (item.inbox === 'open' ? 'in progress' : 'healthy') as FeedbackAttention,
      reason: 'Given with /feedback.',
      confidence: { value: null, basis: 'exposure' as const },
      exposures,
      recurredSince,
    };
  const attention: FeedbackAttention =
    stage === 'recurred' || (!item.sharp && stage !== 'dismissed')
      ? 'needs attention'
      : stage === 'holding' || stage === 'dismissed'
        ? 'healthy'
        : 'in progress';
  const confidence =
    since === undefined
      ? null
      : Math.round(
          (recurredSince ? 0.25 / recurredSince : exposures / (exposures + HOLDING_EXPOSURES)) *
            100,
        ) / 100;
  const reason =
    stage === 'recurred'
      ? `Came back ${recurredSince}× after it was applied: sharpen it, reroute it, or make it a guard.`
      : !item.sharp && stage !== 'dismissed'
        ? 'Not yet a crisp rule: write it in one line.'
        : stage === 'holding'
          ? `In front of its Warden ${exposures}× with no recurrence.`
          : stage === 'dismissed'
            ? 'Dismissed: counted, never applied.'
            : stage === 'in use' || stage === 'applied'
              ? `Applied; ${exposures} exposure${exposures === 1 ? '' : 's'} so far.`
              : 'Waiting on your answer to its tuning prompt.';
  return {
    stage,
    attention,
    reason,
    confidence: { value: confidence, basis: 'exposure' as const },
    exposures,
    recurredSince,
  };
}

/** An item as the lifecycle view shows it: feedback → routed → change → uses → recurrence, assessed. */
export function feedbackView(service: FeedbackService, item: FeedbackItem) {
  const uses = service.uses(item.id);
  const assessment = assess(item, uses);
  return {
    ...item,
    ...assessment,
    uses: { exposures: uses.length, lastAt: uses.at(-1)?.at ?? null, recent: uses.slice(-5) },
    recurrence: {
      total: item.recurrences.length,
      sinceChange: assessment.recurredSince,
      whileExposed: item.recurrences.filter((r) => r.exposedAtTurn).length,
    },
  };
}
export type FeedbackView = ReturnType<typeof feedbackView>;

/** Needs-attention first, then in progress, then healthy; newest first within each. */
export const byAttention = (a: FeedbackView, b: FeedbackView): number =>
  ATTENTION_ORDER[a.attention] - ATTENTION_ORDER[b.attention] || b.updatedAt - a.updatedAt;

/** Newest first, by when the feedback was given. */
export const newestFirst = (a: FeedbackView, b: FeedbackView): number =>
  b.origin.at - a.origin.at || b.id.localeCompare(a.id);
