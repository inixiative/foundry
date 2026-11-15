/**
 * @atlas
 * @kind utils
 * @partOf feature:scheduler
 */
import { everyMs, type ScheduleWhen } from './types';

/** A due time this many ms past and once-only is missed, not run: its moment is gone. */
export const ONCE_GRACE_MS = 60 * 60_000;

/** Counting a cron's missed due times stops here; past it the count reads "at least". */
const MAX_COUNTED = 1000;

/** The first due time strictly after `after`, or undefined when there is none (a once already past). */
export function nextDueAfter(when: ScheduleWhen, since: number, after: number): number | undefined {
  if ('every' in when) {
    const ms = everyMs(when.every);
    const from = Math.max(after, since);
    return since + (Math.floor((from - since) / ms) + 1) * ms;
  }
  if ('cron' in when) {
    const next = Bun.cron.parse(
      when.cron,
      new Date(Math.max(after, since)),
      when.tz ? { tz: when.tz } : undefined,
    );
    return next ? next.getTime() : undefined;
  }
  const at = Date.parse(when.at);
  return at > after && at > since ? at : undefined;
}

/**
 * The due times in (`cursor`, `now`]: the latest, and how many earlier ones fell in the window too
 * (they were missed while Foundry was off; only the latest runs).
 */
export function dueBetween(
  when: ScheduleWhen,
  since: number,
  cursor: number,
  now: number,
): { latest: number; earlier: number } | undefined {
  if ('every' in when) {
    const ms = everyMs(when.every);
    const from = Math.max(cursor, since);
    if (now < since + ms) return undefined;
    const latestK = Math.floor((now - since) / ms);
    const firstK = Math.floor((from - since) / ms) + 1;
    if (latestK < firstK) return undefined;
    return { latest: since + latestK * ms, earlier: latestK - firstK };
  }
  let latest: number | undefined;
  let earlier = -1;
  let at = Math.max(cursor, since);
  for (let i = 0; i <= MAX_COUNTED; i++) {
    const next = nextDueAfter(when, since, at);
    if (next === undefined || next > now) break;
    latest = next;
    earlier++;
    at = next;
  }
  if (latest === undefined) return undefined;
  // A cron left off for long: the rest of the window, past the count, holds only its latest.
  if (earlier >= MAX_COUNTED) {
    const tail = lastCronDueAtOrBefore(when, latest, now);
    if (tail !== undefined) latest = tail;
  }
  return { latest, earlier };
}

/** A cron's last due time at or before `now`, stepping from `from` (a known due time). */
function lastCronDueAtOrBefore(when: ScheduleWhen, from: number, now: number): number | undefined {
  if (!('cron' in when)) return undefined;
  // Walk back from now in widening windows until one holds a due time, then walk forward in it.
  for (let span = 3_600_000; span <= 400 * 86_400_000; span *= 4) {
    let at = Math.max(from, now - span);
    let last: number | undefined;
    for (let i = 0; i < 100_000; i++) {
      const next = nextDueAfter(when, 0, at);
      if (next === undefined || next > now) break;
      last = next;
      at = next;
    }
    if (last !== undefined) return last;
  }
  return undefined;
}

/** Whether a once-only due time is too late to run now. */
export const onceMissed = (when: ScheduleWhen, due: number, now: number): boolean =>
  'at' in when && now - due > ONCE_GRACE_MS;
