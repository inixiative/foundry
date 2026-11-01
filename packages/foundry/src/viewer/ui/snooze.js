/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Snoozes: a thread put out of mind until a time. Foundry doesn't record snoozes on the thread yet
 * (its meta has no field for one), so they live in this browser's storage, keyed by thread id, and
 * the UI says so. `threadState` reads them, so every status (rail, board, Watchtower) agrees.
 */

import { signal } from './lib.js';

const KEY = 'foundry.snoozes';

function load() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** threadId → epoch ms the snooze ends. */
export const snoozes = signal(load());

function save(next) {
  snoozes.value = next;
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the snooze lasts while this tab is open.
  }
}

/** Is the thread snoozed right now? An expired snooze reads as not snoozed. */
export function isSnoozed(threadId, now = Date.now()) {
  const until = snoozes.value[threadId];
  return typeof until === 'number' && until > now;
}

export const snoozedUntil = (threadId) => snoozes.value[threadId] ?? null;

export function snooze(threadId, until) {
  save({ ...snoozes.value, [threadId]: until });
}

export function unsnooze(threadId) {
  const { [threadId]: _gone, ...rest } = snoozes.value;
  save(rest);
}

/** Tomorrow at 9:00 local time. */
export function tomorrowMorning(now = new Date()) {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next.getTime();
}
