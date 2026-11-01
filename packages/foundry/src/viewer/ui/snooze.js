/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Snoozes: a thread put out of mind until a time, recorded on the thread (`meta.snooze`) through
 * `PUT /api/threads/:id/snooze` and cleared with `DELETE`. Foundry ends a snooze itself when its time
 * passes; the thread's status never changes. `threadState` reads it, so every status (rail, board,
 * Watchtower) agrees.
 */

import { allThreads, authFetch, toast } from './store.js';
import { snoozeRunning } from './thread-status.js';

const snoozeOf = (threadId) =>
  allThreads.value.find((t) => t.threadId === threadId)?.meta?.snooze ?? null;

/** Is the thread snoozed right now? */
export const isSnoozed = (threadId, now = Date.now()) => snoozeRunning(snoozeOf(threadId), now);

/** When the snooze ends (epoch ms), or null. */
export function snoozedUntil(threadId) {
  const snooze = snoozeOf(threadId);
  return snooze ? Date.parse(snooze.until) : null;
}

/** The snooze's condition, when it was set by one ('quota-reset'). */
export const snoozeCondition = (threadId) => snoozeOf(threadId)?.condition ?? null;

async function send(threadId, method, body) {
  try {
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/snooze`, {
      method,
      ...(body
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    if (res.ok) return true;
    const { error } = await res.json().catch(() => ({}));
    toast.value = { message: `Couldn’t snooze: ${error ?? res.status}`, type: 'error' };
  } catch (err) {
    toast.value = { message: `Couldn’t snooze: ${err.message}`, type: 'error' };
  }
  return false;
}

/** Snooze until a time (epoch ms). */
export const snooze = (threadId, until) =>
  send(threadId, 'PUT', { until: new Date(until).toISOString() });

/** Snooze until the subscription's usage window resets (Foundry finds the reached window). */
export const snoozeUntilQuotaReset = (threadId) =>
  send(threadId, 'PUT', { condition: 'quota-reset' });

export const unsnooze = (threadId) => send(threadId, 'DELETE');

/** Tomorrow at 9:00 local time. */
export function tomorrowMorning(now = new Date()) {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next.getTime();
}
