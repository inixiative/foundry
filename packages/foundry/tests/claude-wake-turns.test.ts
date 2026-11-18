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
  const main = new Thread('main', new ContextStack());
  main.register(
    new Executor({
      id: 'worker',
      stack: main.stack,
      handler: async (_context, payload) => {
        started.push(String(payload));
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
  const lifecycle = (taskId: string) => ({ taskId, taskType: 'claude-wake' });
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
    wake: (taskId: string, text: string) => {
      sink!(
        'main',
        evidence(taskId, { kind: 'task' }),
        { ...lifecycle(taskId), phase: 'started' },
        control(taskId),
      );
      sink!('main', evidence(taskId, { kind: 'text', text }), undefined, control(taskId));
    },
    finish,
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
