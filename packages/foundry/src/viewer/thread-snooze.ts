/**
 * @atlas
 * @kind service
 * @partOf feature:threads, feature:viewer
 */
import type { Thread, ThreadSnooze, WindowReading } from '@inixiative/foundry-core';

/**
 * Snoozing a thread: `meta.snooze` records until when it is quiet. It is journalled with the
 * thread's meta (so it survives a restart) and never touches `meta.status`, so when it is cleared,
 * by hand or because its time passed (`expireSnoozes`, run by the viewer's ticker), the thread is
 * exactly as it was. A condition is resolved to a time when it is set:
 * - `quota-reset`: the latest reset among the usage windows the newest reading shows as reached.
 * `ci-finished` is refused: Foundry reads no CI or PR state (thread references are URLs only).
 */

export type SnoozeRequest = { until?: unknown; condition?: unknown };
export type SnoozeResult = { snooze: ThreadSnooze } | { error: string; status: 400 | 409 | 422 };

/** The time a reached quota frees up: the newest reading's reached windows, their latest reset. */
export function quotaResetAt(readings: readonly WindowReading[], now: number): number | undefined {
  const latest = readings.reduce<WindowReading | undefined>(
    (best, r) => (!best || r.timestamp > best.timestamp ? r : best),
    undefined,
  );
  if (!latest) return undefined;
  const resets = Object.values(latest.windows)
    .filter((w) => w.usedPercent >= 100 && w.resetsAt !== undefined && w.resetsAt > now)
    .map((w) => w.resetsAt!);
  return resets.length ? Math.max(...resets) : undefined;
}

export function resolveSnooze(
  body: SnoozeRequest,
  readings: () => readonly WindowReading[],
  now = Date.now(),
): SnoozeResult {
  const setAt = new Date(now).toISOString();
  if (body.condition !== undefined) {
    if (body.until !== undefined)
      return { error: 'give until or condition, not both', status: 400 };
    if (body.condition === 'ci-finished')
      return {
        error: 'ci-finished is not available: Foundry reads no CI or pull request state',
        status: 422,
      };
    if (body.condition !== 'quota-reset')
      return { error: 'condition must be quota-reset', status: 400 };
    const at = quotaResetAt(readings(), now);
    if (at === undefined)
      return { error: 'no usage window is reached, so there is no reset to wait for', status: 409 };
    return { snooze: { until: new Date(at).toISOString(), condition: 'quota-reset', setAt } };
  }
  if (typeof body.until !== 'string' || Number.isNaN(Date.parse(body.until)))
    return { error: 'until must be an ISO time (or give a condition)', status: 400 };
  const until = Date.parse(body.until);
  if (until <= now) return { error: 'until must be in the future', status: 400 };
  return { snooze: { until: new Date(until).toISOString(), setAt } };
}

/** Clear every snooze whose time has passed; returns the threads it changed. */
export function expireSnoozes(
  threads: Iterable<Thread>,
  changed: (thread: Thread) => void,
  now = Date.now(),
): Thread[] {
  const woke: Thread[] = [];
  for (const thread of threads) {
    const snooze = thread.meta.snooze;
    if (!snooze || Date.parse(snooze.until) > now) continue;
    delete thread.meta.snooze;
    woke.push(thread);
    changed(thread);
  }
  return woke;
}
