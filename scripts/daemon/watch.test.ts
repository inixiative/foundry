import { expect, test } from 'bun:test';
import { drain } from './watch';

// The auto-updater restarted the daemon mid-turn (2026-11-02) and lost the turn's outcome; it now
// waits for running turns before restarting, up to a timeout.

test('drain waits until no turn is live', async () => {
  const live = [2, 1, 0];
  const log: string[] = [];
  expect(
    await drain(
      () => live.shift() ?? 0,
      10_000,
      1,
      (m) => log.push(m),
    ),
  ).toBe(true);
  expect(log).toEqual([
    'waiting for 2 running turn(s) to finish before restarting',
    'waiting for 1 running turn(s) to finish before restarting',
  ]);
});

test('drain gives up at the timeout; a daemon not yet booted has nothing to drain', async () => {
  expect(
    await drain(
      () => 1,
      20,
      5,
      () => {},
    ),
  ).toBe(false);
  expect(
    await drain(
      () => undefined,
      20,
      5,
      () => {},
    ),
  ).toBe(true);
  expect(await drain(undefined, 20, 5, () => {})).toBe(true);
});
