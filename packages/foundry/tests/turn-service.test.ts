import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ContextStack,
  EventStream,
  Executor,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
import { CANCELLED_BEFORE_DISPATCH, CANCELLED_BEFORE_START } from '../src/turns/turn-service';
import { createViewer } from '../src/viewer/server';
import { connectStreams } from './helpers/data-stream';
import { liveWatchFixture, until } from './helpers/live-watch-fixture';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/**
 * A viewer whose `main` executor records each turn as it starts and holds it until released. The
 * executor can also ask for native admission, which runs the turn's real native preflight.
 */
function heldViewer() {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-turns-'));
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const preflights: Array<{ payload: string; error?: string }> = [];
  const main = new Thread('main', new ContextStack());
  main.register(
    new Executor({
      id: 'worker',
      stack: main.stack,
      handler: async (_context, payload, meta) => {
        started.push(String(payload));
        await new Promise<void>((resolve) => gates.set(String(payload), resolve));
        const observation = meta?.nativeObservation;
        if (String(payload).startsWith('native') && observation) {
          try {
            await observation.preflight?.(observation.owner);
            preflights.push({ payload: String(payload) });
          } catch (error) {
            preflights.push({ payload: String(payload), error: (error as Error).message });
            throw error;
          }
        }
        return `done:${payload}`;
      },
    }),
  );
  const harness = new Harness(main);
  harness.setDefaultExecutor('worker');
  const viewer = createViewer({
    harness,
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
  });
  const client = connectStreams(viewer);
  cleanup.push(async () => {
    for (const release of gates.values()) release();
    client.disconnect();
    await viewer.analyticsReady.catch(() => {});
    viewer.localStore?.close();
    rmSync(dir, { force: true, recursive: true });
  });
  const post = (path: string, body: unknown = {}) =>
    viewer.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    main,
    viewer,
    client,
    started,
    preflights,
    release: (payload: string) => gates.get(payload)?.(),
    send: (id: string) =>
      post('/api/messages/send', {
        id,
        threadId: 'main',
        message: id,
        clientId: client.socket.data.clientId,
      }),
    interrupt: (id: string, threadId = 'main') =>
      post(`/api/threads/${threadId}/turns/${id}/interrupt`),
    terminal: (id: string) => client.terminal('main', id),
  };
}

test('a busy thread queues: the second turn is accepted at once and runs after the first settles', async () => {
  const v = heldViewer();
  await v.client.open('thread:main');
  const first = await v.send('first');
  expect(first.status).toBe(202);
  expect(await first.json()).toMatchObject({ status: 'accepted', queued: false });
  await until(() => v.started.length === 1, 'first started');
  // The executor holds the first turn's input, so it is active; the second waits queued.
  expect(v.viewer.localStore!.turn('first')?.status).toBe('active');

  const second = await v.send('second');
  expect(second.status).toBe(202);
  expect(await second.json()).toMatchObject({ status: 'accepted', queued: true });
  // Accepted durably while queued: the journal holds it, the executor has not seen it.
  expect(v.viewer.localStore!.turn('second')?.status).toBe('queued');
  await Bun.sleep(50);
  expect(v.started).toEqual(['first']);

  v.release('first');
  expect((await v.terminal('first')).type).toBe('done');
  await until(() => v.started.length === 2, 'second started after first settled');
  expect(v.started).toEqual(['first', 'second']);
  v.release('second');
  expect(await v.terminal('second')).toMatchObject({ type: 'done', content: 'done:second' });
  expect(v.viewer.localStore!.turn('first')?.status).toBe('completed');
  expect(v.viewer.localStore!.turn('second')?.status).toBe('completed');
});

test('the synchronous route runs through the same queue', async () => {
  const v = heldViewer();
  await v.client.open('thread:main');
  await v.send('streamed');
  await until(() => v.started.length === 1, 'streamed started');
  const sync = v.viewer.app.request('/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'sync', threadId: 'main', message: 'sync' }),
  });
  await Bun.sleep(50);
  expect(v.started).toEqual(['streamed']);
  v.release('streamed');
  await until(() => v.started.length === 2, 'sync started');
  v.release('sync');
  const response = await sync;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: 'sync', content: 'done:sync' });
});

test('stopping a queued turn cancels it before it runs; it settles failed with cancelled evidence', async () => {
  const v = heldViewer();
  await v.client.open('thread:main');
  await v.send('running');
  await until(() => v.started.length === 1, 'running started');
  await v.send('queued');

  const stop = await v.interrupt('queued');
  expect(stop.status).toBe(200);
  expect(await stop.json()).toEqual({ outcome: 'cancelled' });
  // Settled at once, while the turn ahead of it still runs.
  const terminal = await v.terminal('queued');
  expect(terminal).toMatchObject({ type: 'error', error: CANCELLED_BEFORE_START, cancelled: true });
  expect(v.viewer.localStore!.turn('queued')?.status).toBe('failed');
  expect(v.viewer.localStore!.turn('running')?.status).toBe('active');

  v.release('running');
  expect((await v.terminal('running')).type).toBe('done');
  expect(v.started).toEqual(['running']);
  const turn = v.viewer.localStore!.turn('queued');
  expect(turn?.status).toBe('failed');
  const recorded = v.viewer
    .localStore!.messages('main')
    .find((message) => message.turnId === 'queued' && message.actor === 'agent');
  expect(recorded?.meta).toMatchObject({ cancelled: true, turnStatus: 'failed' });
});

test('a turn stopped before native dispatch is refused at its native preflight', async () => {
  const v = heldViewer();
  await v.client.open('thread:main');
  await v.send('native-turn');
  await until(() => v.started.length === 1, 'native turn in its executor');
  // No admission yet: the stop is recorded and takes effect at the native boundary.
  const stop = await v.interrupt('native-turn');
  expect(await stop.json()).toEqual({ outcome: 'requested' });
  v.release('native-turn');
  const terminal = await v.terminal('native-turn');
  expect(terminal).toMatchObject({ type: 'error', cancelled: true });
  expect(v.preflights).toEqual([{ payload: 'native-turn', error: CANCELLED_BEFORE_DISPATCH }]);
  expect(v.viewer.localStore!.turn('native-turn')?.status).toBe('failed');
});

test('the stop route names unknown and finished turns', async () => {
  const v = heldViewer();
  await v.client.open('thread:main');
  expect((await v.interrupt('missing')).status).toBe(404);
  await v.send('done-turn');
  await until(() => v.started.length === 1, 'started');
  // The turn belongs to `main`, not another thread.
  expect((await v.interrupt('done-turn', 'elsewhere')).status).toBe(404);
  v.release('done-turn');
  await v.terminal('done-turn');
  const finished = await v.interrupt('done-turn');
  expect(finished.status).toBe(409);
  expect(((await finished.json()) as { error: string }).error).toContain('not running');
});

test('a dispatched native turn is stopped by its runtime; the thread then takes the next turn', async () => {
  const dir = await mkdtemp(resolve('.foundry/qa/turn-stop-'));
  const f = await liveWatchFixture(dir);
  try {
    const first = f.send('native-first');
    expect((await first.response).status).toBe(202);
    await until(
      () => f.attempts.length === 1 && f.attempts[0].native.dispatch === 'attempted',
      'dispatched',
    );
    const stop = await f.viewer.app.request(
      `/api/threads/${f.thread.id}/turns/native-first/interrupt`,
      { method: 'POST' },
    );
    expect(await stop.json()).toEqual({ outcome: 'acknowledged' });
    expect(f.interrupts).toEqual([f.attempts[0].native.admissionId]);
    expect(await first.done).toMatchObject({ type: 'error', cancelled: true });
    expect(f.viewer.localStore!.turn('native-first')?.status).toBe('failed');

    const next = f.send('native-next');
    await until(() => f.attempts.length === 2, 'next turn admitted');
    f.attempts[1].finish();
    expect(await next.done).toMatchObject({ type: 'done', content: 'FINAL_ONLY' });
  } finally {
    await f.close();
  }
});

test('a stop that arrives while the native session is still starting refuses its admission: nothing is sent', async () => {
  const dir = await mkdtemp(resolve('.foundry/qa/turn-stop-'));
  const f = await liveWatchFixture(dir);
  try {
    f.holdConstruction();
    const turn = f.send('starting');
    expect((await turn.response).status).toBe(202);
    await until(() => f.sessions.length === 1, 'native session constructing');
    const stop = await f.viewer.app.request(
      `/api/threads/${f.thread.id}/turns/starting/interrupt`,
      { method: 'POST' },
    );
    expect(await stop.json()).toEqual({ outcome: 'requested' });
    f.releaseConstruction();
    expect(await turn.done).toMatchObject({ type: 'error', cancelled: true });
    expect(f.interrupts).toEqual([]);
    expect(f.attempts.every((a) => a.native.dispatch === 'not-dispatched')).toBe(true);
  } finally {
    await f.close();
  }
});

test('a runtime that cannot stop a turn says so, and the turn runs to its end', async () => {
  const dir = await mkdtemp(resolve('.foundry/qa/turn-stop-'));
  const f = await liveWatchFixture(dir, { interruptible: false });
  try {
    const turn = f.send('unstoppable');
    await until(
      () => f.attempts.length === 1 && f.attempts[0].native.dispatch === 'attempted',
      'dispatched',
    );
    const stop = await f.viewer.app.request(
      `/api/threads/${f.thread.id}/turns/unstoppable/interrupt`,
      { method: 'POST' },
    );
    expect(await stop.json()).toEqual({ outcome: 'unsupported' });
    f.attempts[0].finish();
    expect(await turn.done).toMatchObject({ type: 'done', content: 'FINAL_ONLY' });
    expect(f.viewer.localStore!.turn('unstoppable')?.status).toBe('completed');
  } finally {
    await f.close();
  }
});

test('live tool rows carry bounded input and output; text rows carry exactly the appended text', async () => {
  const dir = await mkdtemp(resolve('.foundry/qa/turn-rows-'));
  const f = await liveWatchFixture(dir);
  try {
    const turn = f.send('rows');
    await until(() => f.attempts.length === 1, 'admission');
    const a = f.attempts[0];
    a.emit({ kind: 'text_delta', itemId: 'answer', text: 'Hello ' });
    a.emit({ kind: 'text_delta', itemId: 'answer', text: 'world' });
    a.emit({ kind: 'text', itemId: 'answer', text: 'Hello world' });
    a.emit({
      kind: 'tool_use',
      callId: 'c1',
      toolName: 'Read',
      toolInput: { file_path: '/x/a.ts' },
    });
    a.emit({ kind: 'tool_result', callId: 'c1', toolName: 'Read', toolOutput: 'contents' });
    a.emit({
      kind: 'tool_use',
      callId: 'c2',
      toolName: 'Write',
      toolInput: { file_path: '/x/big.ts', content: 'x'.repeat(5000) },
    });
    await until(
      () =>
        turn.client
          .data(`thread:${f.thread.id}`)
          .some((frame) => frame.payload.kind === 'activity' && frame.payload.row.callId === 'c2'),
      'rows delivered',
    );
    const rows = turn.client
      .data(`thread:${f.thread.id}`)
      .filter((frame) => frame.payload.kind === 'activity')
      .map((frame) => frame.payload);
    expect(rows.filter((p) => p.row.kind === 'text').map((p) => p.appended)).toEqual([
      'Hello ',
      'world',
    ]);
    const read = rows.filter((p) => p.row.callId === 'c1').map((p) => p.row);
    expect(read[0]).toMatchObject({ state: 'running', input: { file_path: '/x/a.ts' } });
    expect(read.at(-1)).toMatchObject({
      state: 'completed',
      output: 'contents',
      input: { file_path: '/x/a.ts' },
    });
    // Input too large to carry whole is omitted rather than cut.
    expect(rows.find((p) => p.row.callId === 'c2')!.row.input).toBeUndefined();
    a.finish();
    await turn.done;
  } finally {
    await f.close();
  }
});

test('host instruction wrappers reach the executor verbatim; the journal and dispatch observation see only the user words', async () => {
  const v = heldViewer();
  const observed: string[] = [];
  v.main.signals.on('dispatch', (signal) => {
    observed.push((signal.content as { payload: string }).payload);
  });
  await v.client.open('thread:main');
  const prompt =
    '<t3_code_instructions>\nUse the T3 browser tools.\n</t3_code_instructions>\n\n<user_request>\nFix the flaky test\n</user_request>';
  const response = await v.viewer.app.request('/api/messages/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'wrapped',
      threadId: 'main',
      message: prompt,
      clientId: v.client.socket.data.clientId,
    }),
  });
  expect(response.status).toBe(202);
  await until(() => v.started.length === 1, 'wrapped started');
  expect(v.started).toEqual([prompt]);
  v.release(prompt);
  expect((await v.terminal('wrapped')).type).toBe('done');
  const user = v.viewer
    .localStore!.messages('main')
    .find((m) => m.turnId === 'wrapped' && m.actor === 'user')!;
  expect(user.content).toBe('Fix the flaky test');
  expect(user.meta).toEqual({
    hostInstructions: [{ tag: 't3_code_instructions', text: 'Use the T3 browser tools.' }],
  });
  expect(observed).toEqual(['Fix the flaky test']);
});
