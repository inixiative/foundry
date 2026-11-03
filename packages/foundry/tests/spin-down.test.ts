import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  EventStream,
  Executor,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
import { Hono } from 'hono';
import { RestartRoll } from '../src/daemon/restart-roll';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { ConfigStore } from '../src/viewer/config';
import { registerDaemonUpdateRoutes } from '../src/viewer/routes/daemon-update';
import { registerRuntimeRoutes } from '../src/viewer/routes/runtime';
import { withStreams } from './helpers/data-stream';

// The spin-down (Aron, 2026-11-02): a staged update lets running turns finish, holds new ones,
// restarts when the last running one finishes, and the next boot runs the held ones in order.

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function daemon(path: string, dir: string, gates: Map<string, Promise<void>>) {
  const main = new Thread('main', new ContextStack(), {});
  const ran: string[] = [];
  main.register(
    new Executor({
      id: 'worker',
      stack: main.stack,
      handler: async (_context, payload) => {
        ran.push(String(payload));
        await gates.get(String(payload));
        return `done: ${payload}`;
      },
    }),
  );
  const harness = new Harness(main);
  harness.setDefaultExecutor('worker');
  const store = new LocalSessionStore(path);
  store.saveThread(main);
  const restarts: string[] = [];
  let turnsRef: ReturnType<typeof registerRuntimeRoutes>['turns'] | undefined;
  const roll = new RestartRoll({
    running: () => turnsRef?.runningTurns() ?? [],
    waiting: () => turnsRef?.queuedCount() ?? 0,
    prepare: () => turnsRef?.holdQueuedForRestart(),
    pollMs: 60_000,
  });
  const app = new Hono();
  const { turns } = registerRuntimeRoutes(
    app,
    withStreams({
      harness,
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      configStore: new ConfigStore(dir),
      localStore: store,
      restartGate: roll,
    }),
  );
  turnsRef = turns;
  turns.onSettled(() => roll.check());
  registerDaemonUpdateRoutes(app, roll, () => 'Main thread');
  const offer = () => roll.offerUpdate({ candidate: 'cand', restart: () => restarts.push('cand') });
  return { app, store, turns, roll, ran, restarts, offer };
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(5);
  expect(done()).toBe(true);
};

test('running turns finish, new ones wait, the restart holds them, and the next boot runs them in order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spin-down-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'sessions.sqlite');
  let finishA!: () => void;
  const gates = new Map([['A', new Promise<void>((resolve) => (finishA = resolve))]]);
  const first = daemon(path, dir, gates);

  const a = first.turns.accept({ threadId: 'main', payload: 'A' });
  expect(a.ok).toBe(true);
  await until(() => first.ran.includes('A'));
  first.offer();
  const status = await (await first.app.request('/api/daemon/update')).json();
  expect(status).toMatchObject({
    phase: 'spinning-down',
    candidate: 'cand',
    running: [{ threadId: 'main', name: 'Main thread' }],
  });

  // Accepted while spinning down: they wait, in order, and nothing new starts.
  const b = first.turns.accept({ threadId: 'main', payload: 'B' });
  const c = first.turns.accept({ threadId: 'main', payload: 'C' });
  expect(b.ok && c.ok).toBe(true);
  expect(first.restarts).toEqual([]);
  if (!b.ok || !c.ok) throw Error('unreachable');
  // Held in the journal as they arrive, so a restart landing before the sweep still runs them.
  expect(first.store.heldForRestart().map((held) => held.turnId)).toEqual([b.turnId, c.turnId]);

  // The last running turn finishes: B reaches the front, waits for the restart, the restart happens.
  finishA();
  await until(() => first.restarts.length === 1);
  if (!b.ok || !c.ok || !a.ok) throw Error('unreachable');
  expect(first.store.turn(a.turnId)?.status).toBe('completed');
  expect(first.ran).toEqual(['A']);
  expect(first.store.heldForRestart().map((held) => held.turnId)).toEqual([b.turnId, c.turnId]);
  first.store.close();

  // The next boot: recovery leaves the held turns queued, and they run in the order they arrived.
  const second = daemon(path, dir, new Map());
  expect(second.store.recoverInterrupted()).toEqual({ interrupted: 0, neverSent: 0 });
  expect(await second.turns.resumeHeld()).toEqual({ resumed: 2, failed: [] });
  await until(() => second.store.turn(c.turnId)?.status === 'completed');
  expect(second.ran).toEqual(['B', 'C']);
  expect(second.store.turn(b.turnId)?.status).toBe('completed');
  expect(second.store.heldForRestart()).toEqual([]);
  // Each is one turn in the journal: its user message once, its answer once.
  const rows = second.store.messages('main').filter((m) => m.turnId === b.turnId);
  expect(rows.map((m) => m.actor)).toEqual(['user', 'agent']);
  second.store.close();
});

test('Not now: the waiting turn starts here and nothing restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spin-down-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let finishA!: () => void;
  const gates = new Map([['A', new Promise<void>((resolve) => (finishA = resolve))]]);
  const d = daemon(join(dir, 'sessions.sqlite'), dir, gates);
  cleanup.push(() => d.store.close());
  d.turns.accept({ threadId: 'main', payload: 'A' });
  await until(() => d.ran.includes('A'));
  d.offer();
  const b = d.turns.accept({ threadId: 'main', payload: 'B' });
  const post = (action: string) =>
    d.app.request('/api/daemon/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
  expect((await post('nope')).status).toBe(400);
  expect((await post('update-now')).status).toBe(409);
  expect(((await (await post('postpone')).json()) as { phase: string }).phase).toBe('postponed');
  finishA();
  await until(() => d.ran.includes('B'));
  if (!b.ok) throw Error('unreachable');
  await until(() => d.store.turn(b.turnId)?.status === 'completed');
  expect(d.restarts).toEqual([]);
});

test('the viewer serves the update state; a turn waiting on a person does not hold the restart up', async () => {
  const { createViewer } = await import('../src/viewer/server');
  const { ActionQueue } = await import('@inixiative/foundry-core');
  const dir = mkdtempSync(join(tmpdir(), 'spin-down-viewer-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const actionQueue = new ActionQueue();
  const viewer = createViewer({
    harness: new Harness(new Thread('main', new ContextStack(), {})),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
    actionQueue,
  });
  cleanup.push(() => viewer.localStore?.close());
  expect(await (await viewer.app.request('/api/daemon/update')).json()).toMatchObject({
    phase: 'idle',
    running: [],
  });
  const restarts: string[] = [];
  viewer.restartRoll.offerUpdate({ candidate: 'cand', restart: () => restarts.push('cand') });
  // Nothing running: it restarts at once.
  expect(restarts).toEqual(['cand']);
});
