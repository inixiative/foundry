import { expect, test } from 'bun:test';
import { ActionQueue } from '@inixiative/foundry-core';
import {
  blockedOnPerson,
  PAUSE_SETTLE_MS,
  type PauseAnswer,
  RestartRoll,
  type RunningTurnRef,
} from '../src/daemon/restart-roll';

// Aron, 2026-11-02: "Pause: finish all open threads. Don't stop them. Everything else waits. Once
// the last one finishes, restart, then reopen." Superseded 2026-11-14: "more aggressively seek to
// pause running agents for a restart of foundry to not do long blocking. pause + resume". Turns get
// a short grace, then are paused (stopped, a continuation queued) and resume after the restart.

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

test('a newer update while spinning down keeps the deadline; work a turn left behind is waited for', () => {
  const now = { t: 0 };
  const running = [{ threadId: 'a', turnId: 't1' }];
  let drafts = 1;
  const restarts: string[] = [];
  const r = new RestartRoll({
    running: () => running,
    waiting: () => 0,
    finishing: () => drafts,
    prepare: () => {},
    now: () => now.t,
    pollMs: 60_000,
  });
  r.offerUpdate({ candidate: 'c1', timeoutMs: 1_000, restart: () => restarts.push('c1') });
  now.t = 900;
  r.offerUpdate({ candidate: 'c2', timeoutMs: 1_000, restart: () => restarts.push('c2') });
  expect(r.status()).toMatchObject({ candidate: 'c2', deadline: 1_000, finishing: 1 });
  running.pop();
  r.check();
  expect(restarts).toEqual([]);
  drafts = 0;
  r.check();
  expect(restarts).toEqual(['c2']);
});

test("only the turn's own approval or question makes it not running; a held send or raised hand doesn't", () => {
  const queue = new ActionQueue();
  const turn = { threadId: 'a', turnId: 't1' };
  void queue.prompt({
    kind: 'approval',
    message: 'send to member?',
    agentId: 'conversation',
    threadId: 'a',
  });
  expect(blockedOnPerson(queue, turn)).toBe(false);
  void queue.prompt({
    kind: 'approval',
    message: 'Bash rm -rf',
    agentId: 'artificer',
    threadId: 'a',
  });
  expect(blockedOnPerson(queue, turn)).toBe(true);
  expect(blockedOnPerson(queue, { threadId: 'b', turnId: 't2' })).toBe(false);
  expect(blockedOnPerson(undefined, turn)).toBe(false);
});

/** A roll that can pause: `pause` records each ask and resolves with the next queued answer. */
function pausingRoll(running: RunningTurnRef[], opts: { waitingOnPerson?: string[] } = {}) {
  const now = { t: 0 };
  const restarts: string[] = [];
  const asked: string[] = [];
  const answers: PauseAnswer[] = [];
  const settle: Array<() => void> = [];
  const r = new RestartRoll({
    running: () => running,
    waiting: () => 0,
    prepare: () => {},
    waitingOnPerson: (turn) => opts.waitingOnPerson?.includes(turn.turnId) ?? false,
    pause: (turn) => {
      asked.push(turn.turnId);
      const answer = answers.shift() ?? 'paused';
      return new Promise((resolve) => settle.push(() => resolve(answer)));
    },
    now: () => now.t,
    pollMs: 1_000,
  });
  const offer = (pauseAfterMs = 1_000) =>
    r.offerUpdate({
      candidate: 'c1',
      timeoutMs: 60 * 60_000,
      pauseAfterMs,
      restart: () => restarts.push('c1'),
    });
  /** Every pending pause call answers. */
  const answer = async () => {
    for (const fn of settle.splice(0)) fn();
    await Bun.sleep(0);
  };
  return { r, offer, now, restarts, asked, answers, answer };
}

test('past the grace each running turn is paused; the restart follows once they stop', async () => {
  const running: RunningTurnRef[] = [
    { threadId: 'a', turnId: 't1' },
    { threadId: 'b', turnId: 't2' },
  ];
  const { r, offer, now, restarts, asked, answer } = pausingRoll(running);
  offer(1_000);
  expect(r.status()).toMatchObject({ phase: 'spinning-down', pauseAt: 1_000, pausing: [] });
  now.t = 999;
  r.check();
  expect(asked).toEqual([]);
  now.t = 1_000;
  r.check();
  expect(asked).toEqual(['t1', 't2']);
  expect(r.status().pausing).toHaveLength(2);
  // Asked again on a later check: each is paused once.
  r.check();
  expect(asked).toEqual(['t1', 't2']);
  // The turns stopped, but a continuation is still being queued: no restart yet.
  running.splice(0);
  r.check();
  expect(restarts).toEqual([]);
  await answer();
  expect(restarts).toEqual(['c1']);
});

test('a turn waiting on its person is paused at once; the others keep their grace', () => {
  const running: RunningTurnRef[] = [
    { threadId: 'a', turnId: 't1' },
    { threadId: 'b', turnId: 't2' },
  ];
  const { offer, asked } = pausingRoll(running, { waitingOnPerson: ['t2'] });
  offer(60_000);
  expect(asked).toEqual(['t2']);
});

test("a turn that hasn't reached its runtime is asked again a poll later, never in the same tick", async () => {
  const running: RunningTurnRef[] = [{ threadId: 'a', turnId: 't1' }];
  const { r, offer, now, asked, answers, answer } = pausingRoll(running);
  answers.push('not-yet');
  offer(0);
  expect(asked).toEqual(['t1']);
  await answer();
  // The answer re-checks, but it is not asked again until the poll interval has passed.
  r.check();
  expect(asked).toEqual(['t1']);
  expect(r.status().pausing).toEqual([]);
  now.t = 1_000;
  r.check();
  expect(asked).toEqual(['t1', 't1']);
  expect(r.status().pausing).toHaveLength(1);
});

test("a turn whose runtime can't stop it runs on; the restart waits for it, not the settle cap", async () => {
  const running: RunningTurnRef[] = [{ threadId: 'a', turnId: 't1' }];
  const { r, offer, now, restarts, asked, answers, answer } = pausingRoll(running);
  answers.push('cannot');
  offer(0);
  await answer();
  expect(r.status().pausing).toEqual([]);
  now.t = PAUSE_SETTLE_MS * 2;
  r.check();
  expect(asked).toEqual(['t1']);
  expect(restarts).toEqual([]);
  running.pop();
  r.check();
  expect(restarts).toEqual(['c1']);
});

test('Restart now while a pause is between its stop and its continuation waits for it', async () => {
  const running: RunningTurnRef[] = [{ threadId: 'a', turnId: 't1' }];
  const { r, offer, restarts, answer } = pausingRoll(running);
  offer(0);
  expect(r.restartNow()).toBe(true);
  expect(restarts).toEqual([]);
  await answer();
  expect(restarts).toEqual(['c1']);
});

test('a paused turn that never stops holds the restart only so long', async () => {
  const running: RunningTurnRef[] = [{ threadId: 'a', turnId: 't1' }];
  const { r, offer, now, restarts, answer } = pausingRoll(running);
  offer(0);
  await answer();
  expect(restarts).toEqual([]);
  now.t = PAUSE_SETTLE_MS - 1;
  r.check();
  expect(restarts).toEqual([]);
  now.t = PAUSE_SETTLE_MS;
  r.check();
  expect(restarts).toEqual(['c1']);
});

test('Pause now skips the grace; without a way to pause there is nothing to do', async () => {
  const running: RunningTurnRef[] = [{ threadId: 'a', turnId: 't1' }];
  const { r, offer, now, asked } = pausingRoll(running);
  expect(r.pauseNow()).toBe(false);
  offer(60_000);
  now.t = 5;
  expect(r.pauseNow()).toBe(true);
  expect(asked).toEqual(['t1']);
  expect(r.status().pauseAt).toBe(5);

  const plain = roll([{ threadId: 'a', turnId: 't1' }]);
  plain.offer();
  expect(plain.r.pauseNow()).toBe(false);
  expect(plain.r.status().pauseAt).toBeUndefined();
});
