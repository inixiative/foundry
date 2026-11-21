import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CompletionOpts,
  LLMMessage,
  LLMProvider,
  NativeEvidence,
} from '@inixiative/foundry-core';
import { DECISION_PRIORITY } from '../src/providers/decision-priority';
import { defaultProfileSource } from '../src/providers/default-profiles';
import { NativeAuthentication } from '../src/providers/native-authentication';
import type { NativeTextCall, NativeTextConfig } from '../src/providers/native-text-provider';
import { makeLoginQuotaPause } from '../src/providers/provider-limits';
import {
  buildSubscriptionDecisions,
  type DecisionPressure,
  type SubscriptionDecisionConfig,
} from '../src/providers/subscription-decisions';

const roots: string[] = [];
const hosts: Array<() => Promise<void>> = [];
const home = process.env.HOME;
afterEach(async () => {
  for (const close of hosts.splice(0)) await close();
  process.env.HOME = home;
  await Bun.sleep(10);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Decision runs as a warm project host serves them (controlled): each answer echoes its prompt's
 * label after `delayMs`, so completion order is observable. `rateLimited`: the first call is sent and
 * rate limited; the host then knows the login is blocked and refuses every later call unsent.
 */
function heldRuns(options: { delayMs?: number; rateLimited?: boolean } = {}) {
  let inFlight = 0;
  let blocked = false;
  const state = { peak: 0, turns: [] as string[] };
  const createRun = (_config: NativeTextConfig) => {
    const calls: NativeTextCall[] = [];
    let closed = false;
    const provider: LLMProvider = {
      id: 'held',
      async complete(messages: LLMMessage[], opts: CompletionOpts = {}) {
        const observation = opts.nativeObservation!;
        const call: NativeTextCall = {
          id: Bun.randomUUIDv7(),
          owner: observation.owner!,
          inputHash: '',
          startedAt: Date.now(),
          transport: 'primed',
          settled: false,
          valid: false,
          release: 'not-requested',
          processExit: 'not-started',
          statusProcessExit: 'not-started',
          deadline: false,
        };
        calls.push(call);
        const admission: NativeEvidence = {
          schema: 1,
          owner: observation.owner,
          admissionId: call.id,
          nativeOutcome: 'unknown',
          localOutcome: 'pending',
          dispatch: 'not-dispatched',
        };
        await observation.register(admission);
        const prompt = messages.map((m) => m.content).join('\n');
        if (options.rateLimited) {
          if (!blocked) state.turns.push(prompt);
          blocked = true;
          Object.assign(call, { settled: true, release: 'released', failure: 'rate-limited' });
          throw Error('usage limit');
        }
        state.turns.push(prompt);
        inFlight++;
        state.peak = Math.max(state.peak, inFlight);
        try {
          await Bun.sleep(options.delayMs ?? 0);
        } finally {
          inFlight--;
        }
        const native: NativeEvidence = {
          ...admission,
          nativeOutcome: 'completed',
          localOutcome: 'resolved',
          dispatch: 'attempted',
        };
        Object.assign(call, { settled: true, valid: true, release: 'released' });
        return {
          content: prompt.match(/label:(\S+)/)?.[1] ?? '?',
          model: 'claude-haiku-5-5',
          native,
        };
      },
    };
    return {
      provider,
      snapshot: () => ({ closed, calls }),
      close: () => {
        closed = true;
      },
    };
  };
  return { createRun, state };
}

/** The production scheduler over controlled held runs. */
function scheduler(
  runs: ReturnType<typeof heldRuns>,
  bounds: Partial<SubscriptionDecisionConfig> = {},
) {
  const pressure: DecisionPressure[] = [];
  const decisions = buildSubscriptionDecisions(
    {
      directory: tmpdir(),
      source: defaultProfileSource('claude'),
      model: 'claude-haiku-5-5',
      maxCalls: 10_000,
      maxQueued: 256,
      maxQueuedPerThread: 32,
      maxConcurrent: 8,
      callTimeoutMs: 20_000,
      onPressure: (event) => pressure.push(event),
      ...bounds,
    },
    runs.createRun,
  );
  hosts.push(() => decisions.shutdown());
  return { decisions, pressure };
}
const labelled = (delayMs: number) => heldRuns({ delayMs });
const ask = (
  decisions: ReturnType<typeof scheduler>['decisions'],
  label: string,
  thread: string,
  priority?: number,
) =>
  decisions.provider
    .complete([{ role: 'user', content: `label:${label}` }], {
      threadId: `${thread}:aux:domain:x`,
      ...(priority === undefined ? {} : { priority }),
    })
    .then(
      (result) => result.content,
      (error: Error) => `rejected:${error.message}`,
    );

test('decisions run concurrently up to the cap', async () => {
  const runs = labelled(60);
  const { decisions } = scheduler(runs, { maxConcurrent: 3 });
  const results = await Promise.all(
    Array.from({ length: 7 }, (_, i) => ask(decisions, `d${i}`, `T${i}`)),
  );
  expect(results).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6']);
  // Overlap is proven by concurrent in-flight calls, not wall-clock time (suite load varies).
  expect(runs.state.peak).toBe(3);
  expect(decisions.snapshot()).toMatchObject({ closed: false, running: 0, queued: 0, attempts: 7 });
});

test('a blocked turn outranks guards, which outrank learning review', async () => {
  const order: string[] = [];
  const { decisions } = scheduler(labelled(30), { maxConcurrent: 1 });
  const first = ask(decisions, 'running', 'A').then((label) => order.push(label));
  const queued = [
    ask(decisions, 'review', 'A', DECISION_PRIORITY.review).then((label) => order.push(label)),
    ask(decisions, 'guard', 'B', DECISION_PRIORITY.guard).then((label) => order.push(label)),
    ask(decisions, 'turn', 'C').then((label) => order.push(label)),
  ];
  await Promise.all([first, ...queued]);
  expect(order).toEqual(['running', 'turn', 'guard', 'review']);
});

test('within a priority, a busy thread cannot starve another', async () => {
  const order: string[] = [];
  const { decisions } = scheduler(labelled(20), { maxConcurrent: 1 });
  const calls = [
    ...Array.from({ length: 5 }, (_, i) => ask(decisions, `busy${i}`, 'busy')),
    ask(decisions, 'quiet', 'quiet'),
  ];
  await Promise.all(calls.map((call) => call.then((label) => order.push(label))));
  expect(order.indexOf('quiet')).toBeLessThanOrEqual(2);
});

test('background classes leave capacity for turns', async () => {
  const runs = labelled(80);
  const { decisions } = scheduler(runs, { maxConcurrent: 4 });
  const guards = Array.from({ length: 6 }, (_, i) =>
    ask(decisions, `g${i}`, `G${i}`, DECISION_PRIORITY.guard),
  );
  await Bun.sleep(30);
  expect(decisions.snapshot().running).toBe(3);
  const turn = ask(decisions, 'turn', 'T');
  await Bun.sleep(30);
  expect(decisions.snapshot().running).toBe(4);
  expect(await turn).toBe('turn');
  await Promise.all(guards);
  expect(runs.state.peak).toBe(4);
});

test('debug reasons alone hold at most a quarter of the slots', async () => {
  const { decisions } = scheduler(labelled(80), { maxConcurrent: 8 });
  const debugs = Array.from({ length: 6 }, (_, i) =>
    ask(decisions, `d${i}`, `D${i}`, DECISION_PRIORITY.debug),
  );
  await Bun.sleep(30);
  expect(decisions.snapshot().running).toBe(2);
  const guards = Array.from({ length: 6 }, (_, i) =>
    ask(decisions, `g${i}`, `G${i}`, DECISION_PRIORITY.guard),
  );
  await Bun.sleep(30);
  expect(decisions.snapshot().running).toBe(6);
  await Promise.all([...debugs, ...guards]);
});

test('the class caps nest: reviews at their cap hold debug back, so guards still start', async () => {
  const { decisions } = scheduler(labelled(80), { maxConcurrent: 8 });
  const reviews = Array.from({ length: 4 }, (_, i) =>
    ask(decisions, `r${i}`, `R${i}`, DECISION_PRIORITY.review),
  );
  const debugs = Array.from({ length: 4 }, (_, i) =>
    ask(decisions, `d${i}`, `D${i}`, DECISION_PRIORITY.debug),
  );
  await Bun.sleep(30);
  expect(decisions.snapshot().running).toBe(4);
  const finished: string[] = [];
  const guards = Array.from({ length: 2 }, (_, i) =>
    ask(decisions, `g${i}`, `G${i}`, DECISION_PRIORITY.guard).then((r) => finished.push(r)),
  );
  await Bun.sleep(30);
  expect(decisions.snapshot().running).toBe(6);
  await Promise.all([...guards, ...debugs.map((d) => d.then((r) => finished.push(r))), ...reviews]);
  expect(finished.slice(0, 2).sort()).toEqual(['g0', 'g1']);
});

test('full queues shed lower-priority waits instead of refusing a turn', async () => {
  const { decisions, pressure } = scheduler(labelled(60), {
    maxConcurrent: 1,
    maxQueued: 2,
    maxQueuedPerThread: 2,
  });
  const running = ask(decisions, 'running', 'A');
  const guards = [
    ask(decisions, 'g1', 'B', DECISION_PRIORITY.guard),
    ask(decisions, 'g2', 'C', DECISION_PRIORITY.guard),
  ];
  const turn = ask(decisions, 'turn', 'D');
  expect(await guards[0]).toContain('shed under load');
  expect(pressure).toEqual([
    { kind: 'shed', threadId: 'B', priority: DECISION_PRIORITY.guard, queued: 1 },
  ]);
  const second = ask(decisions, 'turn2', 'E');
  expect(await ask(decisions, 'refused', 'F', DECISION_PRIORITY.review)).toContain('queue full');
  // A second turn sheds the remaining guard too; with only turns queued, the review is refused.
  expect(await guards[1]).toContain('shed under load');
  expect([await running, await turn, await second]).toEqual(['running', 'turn', 'turn2']);
  expect(decisions.snapshot()).toMatchObject({ closed: false, shed: 2 });
});

test('a rate limit backs off and signals, without closing admission or retrying', async () => {
  const limited = heldRuns({ rateLimited: true });
  const { decisions, pressure } = scheduler(limited, { rateLimitBackoffMs: 150 });
  expect(await ask(decisions, 'one', 'A')).toContain('rate limited; no fallback or retry');
  expect(limited.state.turns).toHaveLength(1);
  expect(pressure).toMatchObject([{ kind: 'rate-limited', backoffMs: 150 }]);
  expect(decisions.snapshot()).toMatchObject({ closed: false });
  expect(decisions.snapshot().backoffUntil).toBeGreaterThan(Date.now());
  const started = Date.now();
  expect(await ask(decisions, 'two', 'A')).toContain('rate limited');
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  // The account is known to be blocked: the second decision is refused before any turn is sent.
  expect(limited.state.turns).toHaveLength(1);
  expect(pressure.at(-1)).toMatchObject({ kind: 'rate-limited', backoffMs: 300 });
});

test('a rate limit on a used-up login pauses every decision until its reset, then runs again', async () => {
  const limited = heldRuns({ rateLimited: true });
  const reset = Date.now() + 400;
  const { decisions, pressure } = scheduler(limited, {
    rateLimitBackoffMs: 50,
    quota: makeLoginQuotaPause({ fetchResetAt: async () => reset }),
  });
  expect(await ask(decisions, 'one', 'A')).toContain('rate limited');
  await Bun.sleep(20);
  expect(pressure).toContainEqual({ kind: 'quota-paused', until: reset });
  expect(decisions.snapshot()).toMatchObject({ quotaPausedUntil: reset });
  // Paused: refused at once, as capacity, and no turn reaches the used-up login.
  const started = Date.now();
  expect(await ask(decisions, 'two', 'B')).toContain('Wardens paused');
  expect(Date.now() - started).toBeLessThan(50);
  expect(limited.state.turns).toHaveLength(1);
  await Bun.sleep(reset - Date.now() + 30);
  expect(decisions.snapshot().quotaPausedUntil).toBeUndefined();
  // Said once each way: paused, then resumed, with no rate limit in between.
  expect(pressure.map((event) => event.kind)).toEqual([
    'rate-limited',
    'quota-paused',
    'quota-resumed',
  ]);
  // Admitted again: the scheduler runs it (the host, knowing the login blocked, sends no turn).
  const before = pressure.length;
  expect(await ask(decisions, 'three', 'C')).toContain('rate limited; no fallback or retry');
  expect(pressure.slice(before)).toMatchObject([{ kind: 'rate-limited' }]);
});

test('a rate limit with no known reset keeps the ordinary backoff and no pause', async () => {
  const limited = heldRuns({ rateLimited: true });
  const { decisions, pressure } = scheduler(limited, {
    rateLimitBackoffMs: 50,
    quota: makeLoginQuotaPause({ fetchResetAt: async () => undefined }),
  });
  expect(await ask(decisions, 'one', 'A')).toContain('rate limited');
  await Bun.sleep(20);
  expect(pressure.map((event) => event.kind)).toEqual(['rate-limited']);
  expect(decisions.snapshot().quotaPausedUntil).toBeUndefined();
});

test('shared decision holders and an exclusive worker lock exclude each other on one profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'subscription-lock-'));
  roots.push(root);
  mkdirSync(join(root, '.codex'), { mode: 0o700 });
  process.env.HOME = root;
  const source = defaultProfileSource('codex');
  const shared = new NativeAuthentication({
    directory: join(root, 'auth'),
    sources: [source],
    defaultSourceId: source.id,
    shared: true,
  });
  const exclusive = new NativeAuthentication({
    directory: join(root, 'auth'),
    sources: [source],
    defaultSourceId: source.id,
  });
  const a = await shared.prepare('a', 'codex'),
    b = await shared.prepare('b', 'codex');
  a.launch(['codex'], {});
  b.launch(['codex'], {});
  const worker = await exclusive.prepare('worker', 'codex');
  expect(() => worker.launch(['codex'], {})).toThrow('in use');
  a.release();
  b.release();
  expect(existsSync(join(root, '.codex', '.foundry-auth-shared'))).toBe(false);
  const owned = await exclusive.prepare('worker', 'codex');
  owned.launch(['codex'], {});
  const late = await shared.prepare('late', 'codex');
  expect(() => late.launch(['codex'], {})).toThrow('in use');
  expect(existsSync(join(root, '.codex', '.foundry-auth-shared'))).toBe(true);
  owned.release();
});

/** 10 threads, each a turn (classifier, router, cartographer, 4 Wardens) then 3 tool calls
 * (3 guards each) and 2 background reviews, arriving together. */
async function load(bounds: Partial<SubscriptionDecisionConfig>) {
  const { decisions } = scheduler(heldRuns({ delayMs: 25 }), bounds);
  const turnWaits: number[] = [],
    results: string[] = [];
  let peakQueue = 0;
  const probe = setInterval(() => {
    peakQueue = Math.max(peakQueue, decisions.snapshot().queued);
  }, 2);
  const call = (thread: string, priority: number, track?: number[]) => {
    const started = Date.now();
    return decisions.provider
      .complete([{ role: 'user', content: 'x' }], { threadId: `${thread}:aux:domain:x`, priority })
      .then(
        () => {
          track?.push(Date.now() - started);
          results.push('ok');
        },
        (error: Error) => {
          results.push(error.message);
        },
      );
  };
  await Promise.all(
    Array.from({ length: 10 }, async (_, t) => {
      const thread = `thread-${t}`;
      await Promise.all(
        Array.from({ length: 7 }, () => call(thread, DECISION_PRIORITY.turn, turnWaits)),
      );
      await Promise.all([
        ...Array.from({ length: 9 }, () => call(thread, DECISION_PRIORITY.guard)),
        ...Array.from({ length: 2 }, () => call(thread, DECISION_PRIORITY.review)),
      ]);
    }),
  );
  clearInterval(probe);
  turnWaits.sort((a, b) => a - b);
  return {
    calls: results.length,
    rejected: results.filter((r) => r !== 'ok').length,
    peakQueue,
    turnP50: turnWaits[Math.floor(turnWaits.length / 2)] ?? 0,
    turnMax: turnWaits.at(-1) ?? 0,
  };
}

test('load: 10 threads with tool calls, before (serial, 8 queued) and after (defaults)', async () => {
  const before = await load({ maxConcurrent: 1, maxQueued: 8, maxQueuedPerThread: 8 });
  const serial = await load({ maxConcurrent: 1 });
  const after = await load({});
  console.log(JSON.stringify({ before, serialUnbounded: serial, after }));
  expect(before.rejected).toBeGreaterThan(100);
  expect(after).toMatchObject({ calls: 180, rejected: 0 });
  expect(after.turnMax * 3).toBeLessThan(serial.turnMax);
}, 30_000);

test('a decision that waited in the queue still gets its full run budget once it starts', async () => {
  // 1 slot, 400 ms calls, 600 ms budget: the second waits ~400 ms, then needs another 400 ms to run.
  // Cutting its run to the queue deadline would interrupt it mid-turn; an unacknowledged interrupt
  // closes admission for good.
  const { decisions, pressure } = scheduler(labelled(400), {
    maxConcurrent: 1,
    callTimeoutMs: 600,
  });
  const [first, second] = await Promise.all([
    ask(decisions, 'first', 'A'),
    ask(decisions, 'second', 'B'),
  ]);
  expect([first, second]).toEqual(['first', 'second']);
  expect(decisions.snapshot()).toMatchObject({ closed: false });
  expect(pressure).toEqual([]);
});
