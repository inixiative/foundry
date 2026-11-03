import { expect, test } from 'bun:test';
import { RestartRoll, type RunningTurnRef } from '../src/daemon/restart-roll';

// Aron, 2026-11-02: "Pause: finish all open threads. Don't stop them. Everything else waits. Once
// the last one finishes, restart, then reopen."

function roll(running: RunningTurnRef[], now = { t: 0 }) {
  const restarts: string[] = [];
  const prepared: number[] = [];
  const r = new RestartRoll({
    running: () => running,
    waiting: () => 2,
    prepare: () => prepared.push(1),
    now: () => now.t,
    pollMs: 60_000,
  });
  const offer = (candidate = 'c1', timeoutMs = 1_000) =>
    r.offerUpdate({ candidate, timeoutMs, restart: () => restarts.push(candidate) });
  return { r, offer, restarts, prepared };
}

test('spins down while turns run, holds new ones, restarts when the last one finishes', async () => {
  const running: RunningTurnRef[] = [
    { threadId: 'a', turnId: 't1' },
    { threadId: 'b', turnId: 't2' },
  ];
  const { r, offer, restarts, prepared } = roll(running);
  expect(r.holding()).toBe(false);
  offer();
  expect(r.status()).toMatchObject({ phase: 'spinning-down', candidate: 'c1', waiting: 2 });
  expect(r.status().running).toHaveLength(2);
  expect(r.holding()).toBe(true);
  running.pop();
  r.check();
  expect(restarts).toEqual([]);
  running.pop();
  r.check();
  expect(restarts).toEqual(['c1']);
  expect(prepared).toEqual([1]);
  expect(r.status().phase).toBe('restarting');
  // Offering again while restarting does nothing.
  offer('c2');
  expect(restarts).toEqual(['c1']);
});

test('nothing running: restarts at once', () => {
  const { offer, restarts } = roll([]);
  offer();
  expect(restarts).toEqual(['c1']);
});

test('the backstop restarts anyway at the timeout', () => {
  const now = { t: 0 };
  const { r, offer, restarts } = roll([{ threadId: 'a', turnId: 't1' }], now);
  offer('c1', 1_000);
  now.t = 999;
  r.check();
  expect(restarts).toEqual([]);
  now.t = 1_000;
  r.check();
  expect(restarts).toEqual(['c1']);
});

test('Not now opens the gate and keeps the update; the same candidate is not re-offered; Update now spins down again', async () => {
  const running = [{ threadId: 'a', turnId: 't1' }];
  const { r, offer, restarts } = roll(running);
  offer();
  let opened = false;
  void r.whenOpen().then(() => {
    opened = true;
  });
  expect(r.postpone()).toBe(true);
  await Bun.sleep(0);
  expect(opened).toBe(true);
  expect(r.holding()).toBe(false);
  expect(r.status()).toMatchObject({ phase: 'postponed', candidate: 'c1' });
  offer('c1');
  expect(r.status().phase).toBe('postponed');
  expect(r.updateNow()).toBe(true);
  expect(r.status().phase).toBe('spinning-down');
  running.pop();
  r.check();
  expect(restarts).toEqual(['c1']);
});

test('a newer update after Not now spins down again; Restart now cuts what runs', () => {
  const { r, offer, restarts } = roll([{ threadId: 'a', turnId: 't1' }]);
  offer('c1');
  r.postpone();
  offer('c2');
  expect(r.status()).toMatchObject({ phase: 'spinning-down', candidate: 'c2' });
  expect(r.restartNow()).toBe(true);
  expect(restarts).toEqual(['c2']);
  expect(r.postpone()).toBe(false);
});
