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
  type NativeEvidence,
  Thread,
} from '@inixiative/foundry-core';
import type { NativeTurnSink } from '../src/providers/session-backed';
import { RunningTasks } from '../src/turns/running-tasks';
import { RESTART_RESUME_NOTE, restartResumeNote } from '../src/turns/turn-service';
import { createViewer } from '../src/viewer/server';
import { connectStreams } from './helpers/data-stream';
import { until } from './helpers/until';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/**
 * A viewer whose `main` thread's session can start turns itself (a Claude wake on a background task
 * finishing): `wake` opens one, `finish` ends it. Foundry's own turns are recorded as they start.
 */
function wakeViewer() {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-wake-'));
  const started: string[] = [];
  let hold: Promise<void> | undefined;
  const main = new Thread('main', new ContextStack());
  main.register(
    new Executor({
      id: 'worker',
      stack: main.stack,
      handler: async (_context, payload) => {
        started.push(String(payload));
        await hold;
        return `done:${payload}`;
      },
    }),
  );
  const harness = new Harness(main);
  harness.setDefaultExecutor('worker');
  let sink: NativeTurnSink | undefined;
  const interrupts: string[] = [];
  const viewer = createViewer({
    harness,
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
    nativeTurnSources: [
      {
        observeNativeTurns(next) {
          sink = next;
          return () => {};
        },
      },
    ],
  });
  const client = connectStreams(viewer);
  cleanup.push(async () => {
    client.disconnect();
    await viewer.analyticsReady.catch(() => {});
    viewer.localStore?.close();
    rmSync(dir, { force: true, recursive: true });
  });
  const evidence = (taskId: string, fields: Partial<NativeEvidence>): NativeEvidence => ({
    schema: 1,
    nativeOutcome: 'unknown',
    turnId: taskId,
    correlation: 'native-turn',
    ...fields,
  });
  const kinds = new Map<string, string>();
  const lifecycle = (taskId: string) => ({ taskId, taskType: kinds.get(taskId) ?? 'claude-wake' });
  const finish = (taskId: string, status = 'completed', summary?: string) =>
    sink!('main', evidence(taskId, { kind: 'task' }), {
      ...lifecycle(taskId),
      phase: 'ended',
      status,
      ...(summary ? { summary } : {}),
    });
  const control = (taskId: string) => ({
    interrupt: async () => {
      interrupts.push(taskId);
      finish(taskId, 'interrupted');
      return 'acknowledged' as const;
    },
  });
  const post = (path: string, body: unknown = {}) =>
    viewer.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    viewer,
    client,
    started,
    interrupts,
    /** The session starts a turn itself and says something in it. */
    wake: (taskId: string, text: string, kind = 'claude-wake', description?: string) => {
      kinds.set(taskId, kind);
      sink!(
        'main',
        evidence(taskId, { kind: 'task' }),
        { ...lifecycle(taskId), phase: 'started', ...(description ? { description } : {}) },
        control(taskId),
      );
      sink!('main', evidence(taskId, { kind: 'text', text }), undefined, control(taskId));
    },
    finish,
    /** Another event of a turn already started. */
    say: (taskId: string, fields: Partial<NativeEvidence>) =>
      sink!('main', evidence(taskId, fields), undefined, control(taskId)),
    /** Foundry's own turns wait on this until it resolves. */
    holdTurns: (until: Promise<void>) => {
      hold = until;
    },
    thread: main,
    turns: () => viewer.localStore!.archiveRecords('main').turns,
    steer: (id: string) => post(`/api/threads/main/turns/${id}/steer`),
    send: (id: string) =>
      post('/api/messages/send', {
        id,
        threadId: 'main',
        message: id,
        clientId: client.socket.data.clientId,
      }),
  };
}

test('a wake is a live turn: Working while it runs, then its text is the latest answer', async () => {
  const v = wakeViewer();
  v.wake('wake-1', 'The tests passed.');
  const [turn] = v.turns();
  expect(turn).toBeDefined();
  expect(v.viewer.liveTurns()).toBe(1);
  v.finish('wake-1', 'completed', 'The tests passed.');
  await until(() => v.viewer.liveTurns() === 0, 'wake settled');
  expect(v.viewer.localStore!.turn(turn!.id)?.status).toBe('completed');
  const messages = v.viewer.localStore!.messages('main').filter((m) => m.turnId === turn!.id);
  expect(messages.map((m) => [m.actor, m.content])).toEqual([
    ['user', 'The agent started this turn itself, woken by a background task finishing.'],
    ['agent', 'The tests passed.'],
  ]);
  expect(messages[0]?.meta).toMatchObject({ foundryLine: 'woken by a background task finishing' });
});

test("a wake with a long trigger keeps Foundry's line in the message list", async () => {
  const v = wakeViewer();
  v.wake('wake-long', 'Done.', 'claude-wake', 'x'.repeat(600));
  v.finish('wake-long', 'completed', 'Done.');
  await until(() => v.viewer.liveTurns() === 0, 'wake settled');
  const [opening] = v.viewer.localStore!.messageIndex('main').messages;
  const line = opening?.meta?.foundryLine;
  expect(typeof line).toBe('string');
  expect(String(line)).toStartWith('woken by xxx');
  expect(String(line).length).toBeLessThan(200);
});

test('a message sent during a wake queues behind it and runs once the wake ends, never interleaved', async () => {
  const v = wakeViewer();
  await v.client.open('thread:main');
  v.wake('wake-2', 'Checking the build.');
  const sent = await v.send('after-wake');
  expect(sent.status).toBe(202);
  expect(await sent.json()).toMatchObject({ status: 'accepted', queued: true });
  await Bun.sleep(30);
  expect(v.started).toEqual([]);
  // It can't be steered into the wake: the refusal says why, and it stays queued.
  const steered = await v.steer('after-wake');
  expect(await steered.json()).toEqual({
    steered: false,
    reason: 'the agent started this turn itself; your message runs next',
  });
  expect(v.viewer.localStore!.turn('after-wake')?.status).toBe('queued');
  v.finish('wake-2', 'completed', 'Build is green.');
  await until(() => v.started.length === 1, 'queued message ran');
  expect(v.started).toEqual(['after-wake']);
  await until(
    () => v.viewer.localStore!.turn('after-wake')?.status === 'completed',
    'message done',
  );
});

test('a restart during a wake stops it and holds a continuation for the next boot', async () => {
  const v = wakeViewer();
  v.wake('wake-3', 'Waiting on CI.');
  const restarts: string[] = [];
  v.viewer.restartRoll.offerUpdate({
    candidate: 'cand',
    pauseAfterMs: 0,
    restart: () => restarts.push('cand'),
  });
  await until(() => restarts.length === 1, 'restarted after the pause');
  expect(v.interrupts).toEqual(['wake-3']);
  const held = v.viewer.localStore!.heldForRestart();
  expect(held).toHaveLength(1);
  const resume = v.viewer
    .localStore!.messages('main')
    .find((m) => m.turnId === held[0]!.turnId && m.actor === 'user');
  expect(resume?.content).toBe(RESTART_RESUME_NOTE);
  expect(v.turns().find((t) => t.id !== held[0]!.turnId)?.status).toBe('failed');
});

test('the restart note names the background commands that were running', () => {
  expect(restartResumeNote([])).toBe(RESTART_RESUME_NOTE);
  const note = restartResumeNote(['Run the test suite', 'tail the dev server']);
  expect(note.startsWith(RESTART_RESUME_NOTE)).toBe(true);
  expect(note).toContain('- Run the test suite\n- tail the dev server');

  const tasks = new RunningTasks(() => undefined);
  tasks.observe(
    'main',
    {
      phase: 'started',
      taskId: 'sh-1',
      taskType: 'local_bash',
      toolUseId: 'toolu_1',
      description: 'Run the test suite',
    },
    1,
  );
  tasks.observe('main', { phase: 'started', taskId: 'wake', taskType: 'claude-wake' }, 1);
  tasks.observe(
    'main',
    {
      phase: 'started',
      taskId: 'sh-2',
      taskType: 'local_bash',
      toolUseId: 'toolu_2',
      description: 'done already',
    },
    1,
  );
  tasks.observe(
    'main',
    { phase: 'ended', taskId: 'sh-2', taskType: 'local_bash', status: 'completed' },
    2,
  );
  expect(tasks.startedByTools('main')).toEqual(['Run the test suite']);
});

test('a turn Muse starts itself is journalled but never holds the thread', async () => {
  const v = wakeViewer();
  v.wake('cron-1', 'Ran the nightly report.', 'muse-cron');
  expect(v.turns()).toHaveLength(1);
  expect(v.viewer.liveTurns()).toBe(0);
  v.finish('cron-1', 'completed', 'Report sent.');
  expect(v.viewer.localStore!.turn(v.turns()[0]!.id)?.status).toBe('completed');
});

test('a wake that starts while a Foundry turn runs goes live on its next event once the thread is free', async () => {
  const v = wakeViewer();
  let release!: () => void;
  v.holdTurns(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  expect((await v.send('busy')).status).toBe(202);
  await until(() => v.started.length === 1, 'Foundry turn running');
  v.wake('wake-4', 'Background job done.');
  expect(v.viewer.liveTurns()).toBe(1);
  release();
  await until(() => v.viewer.liveTurns() === 0, 'Foundry turn settled');
  v.say('wake-4', { kind: 'text', text: 'Looking at the output.' });
  expect(v.viewer.liveTurns()).toBe(1);
  v.finish('wake-4', 'completed', 'All good.');
  await until(() => v.viewer.liveTurns() === 0, 'wake settled');
});

test("a wake's end reaches the thread only after every call it made, even one with no result", async () => {
  const v = wakeViewer();
  const order: string[] = [];
  v.thread.signals.on('tool_observation', async (signal) => {
    await Bun.sleep(10);
    order.push(`call:${(signal.content as { callId: string }).callId}`);
  });
  v.thread.signals.on('native_turn', async () => {
    order.push('end');
  });
  v.wake('wake-5', 'Starting.');
  v.say('wake-5', {
    kind: 'tool_use',
    callId: 'c1',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
  });
  v.say('wake-5', { kind: 'tool_result', callId: 'c1', toolOutput: 'a.ts' });
  v.say('wake-5', { kind: 'tool_use', callId: 'c2', toolName: 'Edit', toolInput: {} });
  v.finish('wake-5', 'completed', 'Done.');
  await until(() => order.includes('end'), 'end delivered');
  expect(order).toEqual(['call:c1', 'call:c2', 'end']);
});
