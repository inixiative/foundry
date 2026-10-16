import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { InitializeRequest, SessionUpdate } from '@agentclientprotocol/sdk';
import { liveWatchFixture } from '../../foundry/tests/helpers/live-watch-fixture';
import { m0Scenario } from '../../foundry/tests/helpers/m0-domain-loop';
import { serveDaemon, shape, spawnFoundryAcp, until } from './helpers/acp-host';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Paseo's initialize (`acp-agent.ts:1459-1465`): protocol from SDK 0.17 (v1), terminal handled by the host. */
const PASEO_INITIALIZE: InitializeRequest = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
  clientInfo: { name: 'Paseo', version: 'dev' },
};
/** T3's initialize (`AcpSessionRuntime.ts:2175-2180`, `:1909-1921`): asks for v2 and reads the answer's shape. */
const T3_INITIALIZE: InitializeRequest = {
  protocolVersion: 2,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 't3-code', version: '0.0.0' },
};

async function nativeHost() {
  await mkdir(resolve('.foundry/qa'), { recursive: true });
  const dir = await mkdtemp(resolve('.foundry/qa/acp-'));
  const f = await liveWatchFixture(dir);
  const daemon = serveDaemon(f.viewer);
  cleanup.push(async () => {
    daemon.stop();
    await f.close();
  });
  const host = () => {
    const h = spawnFoundryAcp(daemon.launchPath);
    cleanup.push(() => h.close());
    return h;
  };
  return { f, dir, host };
}

test("Paseo's sequence: new session in a project, streamed turn with tools, cancel, then resume from a new host process", async () => {
  const { f, dir, host } = await nativeHost();
  const paseo = host();

  const init = await paseo.agent.request('initialize', PASEO_INITIALIZE);
  expect(init).toMatchObject({
    protocolVersion: 1,
    agentInfo: { name: 'foundry', title: 'Foundry' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {} },
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
    },
    authMethods: [],
  });

  const cwd = join(dir, 'P');
  const { sessionId } = await paseo.agent.request('session/new', { cwd, mcpServers: [] });
  const thread = f.viewer.directory.get(sessionId)!;
  expect(thread.meta).toMatchObject({ projectId: 'P', cwd });
  expect(thread.meta.tags).toEqual(['acp', 'acp:Paseo']);

  const before = f.attempts.length;
  const prompt = paseo.agent.request('session/prompt', {
    sessionId,
    messageId: crypto.randomUUID(),
    prompt: [
      { type: 'text', text: 'Read the file' },
      { type: 'resource_link', uri: `file://${cwd}/a.ts`, name: 'a.ts' },
    ],
  });
  await until(() => f.attempts.length === before + 1, 'native admission for the ACP turn');
  const a = f.attempts[before];
  a.emit({ kind: 'text_delta', itemId: 'answer', text: 'Reading ' });
  a.emit({ kind: 'text_delta', itemId: 'answer', text: 'now.' });
  a.emit({ kind: 'tool_use', callId: 'c1', toolName: 'Read', toolInput: { file_path: 'a.ts' } });
  a.emit({ kind: 'tool_result', callId: 'c1', toolName: 'Read', toolOutput: 'export {}' });
  await until(
    () =>
      paseo
        .updates(sessionId)
        .some(
          (u) =>
            u.sessionUpdate === 'tool_call_update' &&
            u.status === 'completed' &&
            u.toolCallId.endsWith('c1'),
        ),
    'tool completion projected',
  );
  a.finish(false, 'Reading now.');
  expect(await prompt).toEqual({ stopReason: 'end_turn' });

  // The turn reached Foundry as one payload, the link as an @ reference.
  const user = f.viewer.localStore!.messages(sessionId).find((m) => m.actor === 'user');
  expect(user?.content).toBe(`Read the file\n\n@${cwd}/a.ts`);

  const updates = paseo.updates(sessionId);
  const contextId = updates[0].sessionUpdate === 'tool_call' ? updates[0].toolCallId : '';
  // The context item opens first and completes exactly once, once output starts (its journal read is asynchronous).
  expect(shape(updates[0])).toEqual({ call: contextId, kind: 'think', status: 'in_progress' });
  expect(
    updates.filter((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === contextId),
  ).toHaveLength(1);
  expect(
    updates
      .slice(1)
      .filter((u) => !('toolCallId' in u) || u.toolCallId !== contextId)
      .map(shape),
  ).toEqual([
    { chunk: 'Reading ' },
    { chunk: 'now.' },
    { call: expect.stringContaining(':tool:c1'), kind: 'read', status: 'in_progress' },
    { update: expect.stringContaining(':tool:c1'), status: 'completed' },
  ]);
  const read = updates.find(
    (u): u is Extract<SessionUpdate, { sessionUpdate: 'tool_call' }> =>
      u.sessionUpdate === 'tool_call' && u.kind === 'read',
  )!;
  expect(read).toMatchObject({
    title: 'Read: a.ts',
    rawInput: { file_path: 'a.ts' },
    locations: [{ path: `${cwd}/a.ts` }],
  });
  const readDone = updates.find(
    (u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === read.toolCallId,
  )!;
  expect(readDone).toMatchObject({
    title: 'Read: a.ts',
    kind: 'read',
    rawOutput: { output: 'export {}' },
  });

  // Cancel mid-turn: the runtime is asked to stop and the prompt answers `cancelled`.
  const cancelBefore = f.attempts.length;
  const cancelled = paseo.agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'Long work' }],
  });
  await until(
    () =>
      f.attempts.length === cancelBefore + 1 &&
      f.attempts[cancelBefore].native.dispatch === 'attempted',
    'second turn dispatched',
  );
  await paseo.agent.notify('session/cancel', { sessionId });
  expect(await cancelled).toEqual({ stopReason: 'cancelled' });
  expect(f.interrupts).toEqual([f.attempts[cancelBefore].native.admissionId]);

  // Paseo restarts: a new process resumes the same session (`acp-agent.ts:1856-1866`).
  await paseo.close();
  const restarted = host();
  await restarted.agent.request('initialize', PASEO_INITIALIZE);
  expect(
    await restarted.agent.request('session/resume', { sessionId, cwd, mcpServers: [] }),
  ).toMatchObject({ modes: { currentModeId: 'default' } });
  const resumedBefore = f.attempts.length;
  const resumed = restarted.agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'Again' }],
  });
  await until(() => f.attempts.length === resumedBefore + 1, 'resumed turn admitted');
  f.attempts[resumedBefore].finish(false, 'Same thread.');
  expect(await resumed).toEqual({ stopReason: 'end_turn' });
  expect(
    restarted
      .updates(sessionId)
      .some(
        (u) =>
          u.sessionUpdate === 'agent_message_chunk' &&
          u.content.type === 'text' &&
          u.content.text === 'Same thread.',
      ),
  ).toBe(true);
  expect(new Set(f.viewer.localStore!.messages(sessionId).map((m) => m.turnId)).size).toBe(3);
});

test("T3's sequence: v2 initialize gets a v1 answer; cancel then an immediate new prompt queues behind the cancelled turn", async () => {
  const { f, dir, host } = await nativeHost();
  const t3 = host();
  const init = await t3.agent.request('initialize', T3_INITIALIZE);
  // T3 picks the generation from the shape: v1 carries agentInfo/agentCapabilities, never v2's `info`.
  expect(init.protocolVersion).toBe(1);
  expect(init.agentCapabilities).toBeDefined();
  expect(init.agentInfo).toBeDefined();
  expect('info' in init).toBe(false);

  const { sessionId } = await t3.agent.request('session/new', {
    cwd: join(dir, 'P'),
    mcpServers: [],
  });
  const before = f.attempts.length;
  const first = t3.agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'one' }],
  });
  await until(
    () => f.attempts.length === before + 1 && f.attempts[before].native.dispatch === 'attempted',
    'first dispatched',
  );
  // T3's default cancel writes session/cancel and sends the replacement prompt at once (AcpSessionRuntime.ts:2449-2465).
  await t3.agent.notify('session/cancel', { sessionId });
  const second = t3.agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'two' }],
  });
  expect(await first).toEqual({ stopReason: 'cancelled' });
  await until(
    () => f.attempts.length === before + 2,
    'replacement admitted after the cancelled turn settled',
  );
  // The replacement waited in the thread's queue: the cancelled turn had settled before it was admitted.
  expect(f.attempts[before].done).toBe(true);
  const firstTurn = f.viewer.localStore!.messages(sessionId)[0].turnId;
  expect(f.viewer.localStore!.turn(firstTurn)?.status).toBe('failed');
  f.attempts[before + 1].finish(false, 'two done');
  expect(await second).toEqual({ stopReason: 'end_turn' });
  expect(f.viewer.directory.get(sessionId)!.meta.tags).toEqual(['acp', 'acp:t3-code']);
});

test('every ACP turn runs the middleware: the context item reports the sealed routing and each Warden', async () => {
  const scenario = await m0Scenario();
  const daemon = serveDaemon(scenario.current);
  cleanup.push(async () => {
    daemon.stop();
    await scenario.close();
  });
  const h = spawnFoundryAcp(daemon.launchPath);
  cleanup.push(() => h.close());
  await h.agent.request('initialize', PASEO_INITIALIZE);

  const { sessionId } = await h.agent.request('session/new', {
    cwd: join(scenario.dir, 'P'),
    mcpServers: [],
  });
  expect(
    await h.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Continue' }],
    }),
  ).toEqual({
    stopReason: 'end_turn',
  });
  // The thread's Cartographer and both Wardens were asked before the executor ran.
  const calls = scenario.calls.filter((call) => call.thread === sessionId);
  expect(calls.some((call) => call.phase === 'route')).toBe(true);
  expect(
    calls
      .filter((call) => call.phase === 'pre')
      .map((call) => call.domain)
      .sort(),
  ).toEqual(['architecture', 'testing']);
  expect(
    calls
      .find((call) => call.phase === 'central')!
      .messages.map((m) => m.content)
      .join('\n'),
  ).toContain('guidance: DOMAIN_ARCH');

  const updates = h.updates(sessionId);
  const context = updates.find(
    (u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId.startsWith('foundry-context:'),
  ) as Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>;
  const text =
    context.content?.[0]?.type === 'content' && context.content[0].content.type === 'text'
      ? context.content[0].content.text
      : '';
  expect(text).toContain('Routing (');
  expect(text).toContain('- architecture:');
  expect(text).toContain('- testing:');
  const foundry = (
    context._meta as { foundry: { threadId: string; participants: Array<{ domain: string }> } }
  ).foundry;
  expect(foundry.threadId).toBe(sessionId);
  expect(foundry.participants.map((p) => p.domain).sort()).toEqual(['architecture', 'testing']);
  // The answer arrives exactly once.
  expect(
    updates
      .filter((u) => u.sessionUpdate === 'agent_message_chunk')
      .map((u) => (u.content.type === 'text' ? u.content.text : '')),
  ).toEqual(['CONTINUED_WITHOUT_REPEATING_MIGRATION']);
});

test('a session outside every project runs in the global scope', async () => {
  const scenario = await m0Scenario();
  const daemon = serveDaemon(scenario.current);
  cleanup.push(async () => {
    daemon.stop();
    await scenario.close();
  });
  const h = spawnFoundryAcp(daemon.launchPath);
  cleanup.push(() => h.close());
  await h.agent.request('initialize', T3_INITIALIZE);
  const outside = await mkdtemp(join(scenario.dir, 'unregistered-'));
  const { sessionId } = await h.agent.request('session/new', { cwd: outside, mcpServers: [] });
  expect(scenario.current.directory.get(sessionId)!.meta.projectId).toBeUndefined();
  expect(
    await h.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Continue' }],
    }),
  ).toEqual({
    stopReason: 'end_turn',
  });
  expect(scenario.calls.some((call) => call.thread === sessionId && call.phase === 'pre')).toBe(
    true,
  );
});

test('an unreachable daemon on a non-default launch path is reported, never started', async () => {
  const dir = await mkdtemp(resolve('.foundry/qa/acp-down-'));
  const h = spawnFoundryAcp(join(dir, 'missing-launch.json'));
  cleanup.push(() => h.close());
  const error = await h.agent.request('initialize', PASEO_INITIALIZE).catch((e: Error) => e);
  expect(String((error as Error).message)).toContain('not reachable');
  expect(h.stderr()).not.toContain('starting it');
});

test('two sessions on one connection run side by side; an unknown session is refused', async () => {
  const { f, dir, host } = await nativeHost();
  const h = host();
  await h.agent.request('initialize', PASEO_INITIALIZE);
  const one = await h.agent.request('session/new', { cwd: join(dir, 'P'), mcpServers: [] });
  const two = await h.agent.request('session/new', { cwd: join(dir, 'P'), mcpServers: [] });
  expect(one.sessionId).not.toBe(two.sessionId);
  const before = f.attempts.length;
  const first = h.agent.request('session/prompt', {
    sessionId: one.sessionId,
    prompt: [{ type: 'text', text: 'a' }],
  });
  const second = h.agent.request('session/prompt', {
    sessionId: two.sessionId,
    prompt: [{ type: 'text', text: 'b' }],
  });
  // Different threads do not queue behind each other.
  await until(() => f.attempts.length === before + 2, 'both sessions admitted at once');
  for (const a of f.attempts.slice(before)) a.finish(false, 'ok');
  expect(await first).toEqual({ stopReason: 'end_turn' });
  expect(await second).toEqual({ stopReason: 'end_turn' });
  expect(h.updates(one.sessionId).some((u) => u.sessionUpdate === 'agent_message_chunk')).toBe(
    true,
  );
  expect(h.updates(two.sessionId).some((u) => u.sessionUpdate === 'agent_message_chunk')).toBe(
    true,
  );

  const unknown = await h.agent
    .request('session/prompt', {
      sessionId: 'thread_missing',
      prompt: [{ type: 'text', text: 'x' }],
    })
    .catch((e: Error) => e);
  expect(String((unknown as Error).message)).toContain('Unknown session');
});
