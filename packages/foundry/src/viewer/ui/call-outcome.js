/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * How one Warden call ended, as the journal records it (core `CallOutcome`): not-sent with a cause,
 * failed with a cause, or answered with a result. Pure: the viewer's reading of that one shape.
 */

import {
  ADVICE_RESULTS,
  adviceSpoke,
  GUARD_CHECK_RESULTS,
  parseCallOutcome,
  recordedOutcomeLabel,
} from './call-outcome-core.js';

const RESULTS = [...ADVICE_RESULTS, ...GUARD_CHECK_RESULTS];

/** The journalled value as a checked outcome (core `parseCallOutcome`), or undefined when it is not one. */
export const recordedOutcome = (value) => parseCallOutcome(value, RESULTS);

/** The outcome as core's `callOutcomeLabel` writes it (`answered:spoke`, `not-sent:cold`), or `unrecorded`. */
export const outcomeLabel = (value) => recordedOutcomeLabel(value, RESULTS) ?? 'unrecorded';

/** The call answered and chimed in with something. */
export const outcomeSpoke = (value) => {
  const outcome = parseCallOutcome(value, ADVICE_RESULTS);
  return !!outcome && adviceSpoke(outcome);
};

/** The call answered with nothing to add. */
export const outcomeNoComment = (value) => {
  const outcome = recordedOutcome(value);
  return (
    outcome?.status === 'answered' &&
    (outcome.result === 'no-comment' || outcome.result === 'all-clear')
  );
};

/**
 * Its tone: ok when it spoke or found something, skip when it said nothing or was never meant to be
 * sent, warn when it timed out, was over or left out for budget or not admitted, error when the call
 * failed, warn when what was journalled is not an outcome.
 */
export function outcomeTone(value) {
  const outcome = recordedOutcome(value);
  if (outcome?.status === 'answered')
    return outcome.result === 'omitted-budget'
      ? 'warn'
      : outcome.result === 'spoke' || outcome.result === 'findings'
        ? 'ok'
        : 'skip';
  if (outcome?.status === 'failed') return outcome.cause === 'timeout' ? 'warn' : 'error';
  if (outcome?.status === 'not-sent')
    return outcome.cause === 'not-admitted' ||
      outcome.cause === 'not-held' ||
      outcome.cause === 'over-budget'
      ? 'warn'
      : 'skip';
  return 'warn';
}
