/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * How one Warden call ended, as the journal records it (core `CallOutcome`): not-sent with a cause,
 * failed with a cause, or answered with a result. Pure: the viewer's reading of that one shape.
 */

/** The outcome as one word pair, the way core's `callOutcomeLabel` writes it: `answered:spoke`, `not-sent:cold`. */
export const outcomeLabel = (outcome) =>
  outcome?.status === 'answered'
    ? `answered:${outcome.result}`
    : outcome?.status === 'not-sent' || outcome?.status === 'failed'
      ? `${outcome.status}:${outcome.cause}`
      : 'unrecorded';

/** The call answered and chimed in with something. */
export const outcomeSpoke = (outcome) =>
  outcome?.status === 'answered' && outcome.result === 'spoke';

/** The call answered with nothing to add. */
export const outcomeNoComment = (outcome) =>
  outcome?.status === 'answered' &&
  (outcome.result === 'no-comment' || outcome.result === 'all-clear');

/**
 * Its tone: ok when it spoke or found something, skip when it said nothing or was never meant to be
 * sent, warn when it timed out, was left out for budget or not admitted, error when the call failed.
 */
export function outcomeTone(outcome) {
  if (outcome?.status === 'answered')
    return outcome.result === 'omitted-budget'
      ? 'warn'
      : outcome.result === 'spoke' || outcome.result === 'findings'
        ? 'ok'
        : 'skip';
  if (outcome?.status === 'failed') return outcome.cause === 'timeout' ? 'warn' : 'error';
  if (outcome?.status === 'not-sent')
    return outcome.cause === 'not-admitted' || outcome.cause === 'not-held' ? 'warn' : 'skip';
  return 'warn';
}
