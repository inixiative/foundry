/**
 * @atlas
 * @kind helper
 * @partOf primitive:nativeSessions
 */
// Import-free: the viewer is served this same module (`/ui/call-outcome-core.js`).

/** Why a Warden call was never sent: no provider saw it. */
export type CallNotSentCause =
  /** The pre-filter scored the message below the Warden's threshold. */
  | 'prefiltered'
  /** It was asked with `heldOnly` and no warm session was held for it. */
  | 'not-held'
  /** The Warden has no knowledge to answer from yet. */
  | 'cold'
  /** The prompt is over the Warden role's token budget. */
  | 'over-budget'
  /** The provider queue or the plan deadline refused it before dispatch (full, shed, expired, closed). */
  | 'not-admitted'
  /** Its trigger point does not ask this Warden. */
  | 'trigger-gated';

/** Why a sent Warden call ended without a usable answer. */
export type CallFailedCause = 'timeout' | 'provider-error' | 'invalid-response' | 'aborted';

/**
 * How one Warden call ended: the single outcome list for advice and guard checks. Only `answered`
 * carries a result; its values depend on the kind of call.
 */
export type CallOutcome<Result extends string> =
  | { readonly status: 'not-sent'; readonly cause: CallNotSentCause }
  | { readonly status: 'failed'; readonly cause: CallFailedCause }
  | { readonly status: 'answered'; readonly result: Result };

/** An advice call's answer: it spoke, said NO_COMMENT, or spoke but the composition budget left it out. */
export type AdviceResult = 'spoke' | 'no-comment' | 'omitted-budget';
/** A guard check's answer: findings, or an empty all-clear. */
export type GuardCheckResult = 'findings' | 'all-clear';

/** A debug follow-up's answer ("why did you answer that?"): the decision stands, or it would answer otherwise. */
export type DebugReasonResult = 'kept' | 'revised';

export type AdviceOutcome = CallOutcome<AdviceResult>;
export type GuardCheckOutcome = CallOutcome<GuardCheckResult>;
export type DebugReasonOutcome = CallOutcome<DebugReasonResult>;

/** A call that was never sent, and the bounded reason recorded with its cause. */
export interface NotSentCall {
  readonly cause: CallNotSentCause;
  readonly reason: string;
}

/** `not-sent:cold`, `failed:timeout`, `answered:spoke`: one string for logs, archives and the viewer. */
export function callOutcomeLabel(outcome: CallOutcome<string>): string {
  return `${outcome.status}:${outcome.status === 'answered' ? outcome.result : outcome.cause}`;
}

const NOT_SENT_CAUSES: readonly string[] = [
  'prefiltered',
  'not-held',
  'cold',
  'over-budget',
  'not-admitted',
  'trigger-gated',
] satisfies readonly CallNotSentCause[];
const FAILED_CAUSES: readonly string[] = [
  'timeout',
  'provider-error',
  'invalid-response',
  'aborted',
] satisfies readonly CallFailedCause[];

/** A journalled outcome read back, checked against `results`; undefined when it is not one. */
export function parseCallOutcome<Result extends string>(
  value: unknown,
  results: readonly Result[],
): CallOutcome<Result> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { status, cause, result } = value as Record<string, unknown>;
  if (status === 'not-sent' && typeof cause === 'string' && NOT_SENT_CAUSES.includes(cause))
    return { status, cause: cause as CallNotSentCause };
  if (status === 'failed' && typeof cause === 'string' && FAILED_CAUSES.includes(cause))
    return { status, cause: cause as CallFailedCause };
  if (status === 'answered' && (results as readonly unknown[]).includes(result))
    return { status, result: result as Result };
  return undefined;
}

/** A journalled outcome's label, or undefined when the value is not an outcome with one of `results`. */
export function recordedOutcomeLabel(
  value: unknown,
  results: readonly string[],
): string | undefined {
  const outcome = parseCallOutcome(value, results);
  return outcome ? callOutcomeLabel(outcome) : undefined;
}

/** Every advice result, for `parseCallOutcome`. */
export const ADVICE_RESULTS: readonly AdviceResult[] = ['spoke', 'no-comment', 'omitted-budget'];
/** Every guard check result, for `parseCallOutcome`. */
export const GUARD_CHECK_RESULTS: readonly GuardCheckResult[] = ['findings', 'all-clear'];
/** Every debug follow-up result, for `parseCallOutcome`. */
export const DEBUG_REASON_RESULTS: readonly DebugReasonResult[] = ['kept', 'revised'];

/** An advice call that reached the thread. */
export function adviceSpoke(outcome: AdviceOutcome): boolean {
  return outcome.status === 'answered' && outcome.result === 'spoke';
}
