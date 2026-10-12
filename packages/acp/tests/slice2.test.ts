import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { InitializeRequest, McpServer, SessionUpdate } from '@agentclientprotocol/sdk';
import { newId } from '@inixiative/foundry-core';
import type { CreateSessionOpts } from '../../foundry/src/providers/session-adapter';
import { liveWatchFixture } from '../../foundry/tests/helpers/live-watch-fixture';

type ToolGate = NonNullable<CreateSessionOpts['toolGate']>;

import { serveDaemon, spawnFoundryAcp, until } from './helpers/acp-host';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const INITIALIZE: InitializeRequest = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
  clientInfo: { name: 'Paseo', version: 'dev' },
};

async function nativeHost() {
  await mkdir(resolve('.foundry/qa'), { recursive: true });
  const dir = await mkdtemp(resolve('.foundry/qa/acp2-'));
  const f = await liveWatchFixture(dir);
  const daemon = serveDaemon(f.viewer);
  cleanup.push(async () => {
    daemon.stop();
    await f.close();
  });
  const host = (args: readonly string[] = []) => {
    const h = spawnFoundryAcp(daemon.launchPath, args);
    cleanup.push(() => h.close());
    return h;
  };
  return { f, dir, host };
}

const PASEO_MCP: McpServer = {
  name: 'paseo',
  command: 'paseo',
  args: ['mcp'],
  env: [{ name: 'PASEO_TOKEN', value: 'secret-token' }],
};

/** Run one turn on a session and finish it with `content`; returns the native attempt. */
async function turn(
  h: ReturnType<typeof spawnFoundryAcp>,
  f: Awaited<ReturnType<typeof liveWatchFixture>>,
  sessionId: string,
  text: string,
  during?: (attempt: (typeof f.attempts)[number]) => Promise<void> | void,
  content = 'done',
) {
  const before = f.attempts.length;
  const prompt = h.agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text }],
  });
  await until(
    () => f.attempts.length === before + 1 && f.attempts[before].native.dispatch === 'attempted',
    `turn "${text}" dispatched`,
  );
  const attempt = f.attempts[before];
  await during?.(attempt);
  attempt.finish(false, content);
  expect(await prompt).toEqual({ stopReason: 'end_turn' });
  return attempt;
}

test("modes and config options are the host's: they reach the executor launch and a change relaunches it", async () => {
  const { f, dir, host } = await nativeHost();
  const h = host();
  await h.agent.request('initialize', INITIALIZE);
  const created = await h.agent.request('session/new', {
    cwd: join(dir, 'P'),
    mcpServers: [PASEO_MCP],
  });
  const { sessionId } = created;
  expect(created.modes).toEqual({
    currentModeId: 'default',
    availableModes: [
      expect.objectContaining({ id: 'default' }),
      expect.objectContaining({ id: 'acceptEdits' }),
      expect.objectContaining({ id: 'plan' }),
      expect.objectContaining({ id: 'bypassPermissions', name: 'Full access' }),
    ],
  });
  expect(created.configOptions?.map((option) => [option.id, option.category])).toEqual([
    ['mode', 'mode'],
    ['model', 'model'],
    ['effort', 'thought_level'],
  ]);
  // The command list follows the session's creation.
  await until(
    () => h.all(sessionId).some((u) => u.sessionUpdate === 'available_commands_update'),
    'commands advertised',
  );

  await turn(h, f, sessionId, 'first');
  const launch = f.created.at(-1)!;
  expect(launch).toMatchObject({
    threadId: sessionId,
    permissionMode: 'default',
    mcpServers: [PASEO_MCP],
  });
  expect(typeof launch.toolGate).toBe('function');

  await h.agent.request('session/set_mode', { sessionId, modeId: 'bypassPermissions' });
  await until(
    () => h.updates(sessionId).some((u) => u.sessionUpdate === 'current_mode_update'),
    'mode update',
  );
  const effort = await h.agent.request('session/set_config_option', {
    sessionId,
    configId: 'effort',
    value: 'high',
  });
  expect(effort.configOptions.find((o) => o.id === 'effort')).toMatchObject({
    currentValue: 'high',
  });
  const unknownMode = await h.agent
    .request('session/set_mode', { sessionId, modeId: 'yolo' })
    .catch((e: Error) => e);
  expect(String((unknownMode as Error).message)).toContain('Unknown mode');

  // The next turn relaunches the idle session with the host's new choice, resuming the same thread.
  const sessionsBefore = f.sessions.length;
  await turn(h, f, sessionId, 'second');
  expect(f.sessions.length).toBe(sessionsBefore + 1);
  expect(f.created.at(-1)).toMatchObject({ permissionMode: 'bypassPermissions', effort: 'high' });
  // Secrets stay in daemon memory: the launch view names servers only.
  const view = await f.viewer.app.request(`/api/threads/${sessionId}/launch`);
  expect(JSON.stringify(await view.json())).not.toContain('secret-token');
});

test("a session starts in the mode the host's configuration passes; a mode the host sets wins", async () => {
  const { f, dir, host } = await nativeHost();
  const h = host(['--permission-mode', 'bypassPermissions']);
  await h.agent.request('initialize', INITIALIZE);
  const cwd = join(dir, 'P');
  const created = await h.agent.request('session/new', { cwd, mcpServers: [] });
  const { sessionId } = created;
  expect(created.modes?.currentModeId).toBe('bypassPermissions');
  expect(created.configOptions?.find((o) => o.id === 'mode')).toMatchObject({
    currentValue: 'bypassPermissions',
  });
  await turn(h, f, sessionId, 'first');
  expect(f.created.at(-1)).toMatchObject({
    threadId: sessionId,
    permissionMode: 'bypassPermissions',
  });

  // A mode the host sets on the session wins over its configured one, and holds across a resume.
  await h.agent.request('session/set_mode', { sessionId, modeId: 'plan' });
  await h.close();
  const again = host(['--permission-mode', 'bypassPermissions']);
  await again.agent.request('initialize', INITIALIZE);
  const resumed = await again.agent.request('session/resume', { sessionId, cwd, mcpServers: [] });
  expect(resumed.modes?.currentModeId).toBe('plan');
  await turn(again, f, sessionId, 'second');
  expect(f.created.at(-1)).toMatchObject({ permissionMode: 'plan' });

  // A host that expresses nothing gets `default`.
  const plain = host();
  await plain.agent.request('initialize', INITIALIZE);
  const fresh = await plain.agent.request('session/new', { cwd, mcpServers: [] });
  expect(fresh.modes?.currentModeId).toBe('default');
});

test('the mode is also a `mode` config option, kept in step with session/set_mode', async () => {
  const { f, dir, host } = await nativeHost();
  const h = host();
  await h.agent.request('initialize', INITIALIZE);
  const { sessionId } = await h.agent.request('session/new', {
    cwd: join(dir, 'P'),
    mcpServers: [],
  });
  const set = await h.agent.request('session/set_config_option', {
    sessionId,
    configId: 'mode',
    value: 'acceptEdits',
  });
  expect(set.configOptions.find((o) => o.id === 'mode')).toMatchObject({
    category: 'mode',
    currentValue: 'acceptEdits',
  });
  await until(
    () =>
      h
        .updates(sessionId)
        .some(
          (u) => u.sessionUpdate === 'current_mode_update' && u.currentModeId === 'acceptEdits',
        ),
    'mode update from the config option',
  );
  await turn(h, f, sessionId, 'edit');
  expect(f.created.at(-1)).toMatchObject({ permissionMode: 'acceptEdits' });

  await h.agent.request('session/set_mode', { sessionId, modeId: 'bypassPermissions' });
  await until(
    () =>
      h
        .updates(sessionId)
        .some(
          (u) =>
            u.sessionUpdate === 'config_option_update' &&
            u.configOptions.find((o) => o.id === 'mode')?.currentValue === 'bypassPermissions',
        ),
    'config option update from set_mode',
  );
  const unknown = await h.agent
    .request('session/set_config_option', { sessionId, configId: 'mode', value: 'yolo' })
    .catch((e: Error) => e);
  expect(String((unknown as Error).message)).toContain('Unknown mode');
});

test('foundry-acp refuses a permission mode or flag it does not know', async () => {
  for (const args of [
    ['--permission-mode', 'yolo'],
    ['--mode', 'plan'],
  ]) {
    const proc = Bun.spawn(['bun', join(import.meta.dir, '../src/cli.ts'), ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, FOUNDRY_ACP_LAUNCH: join(import.meta.dir, 'no-such-launch.json') },
    });
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain('foundry-acp:');
  }
});

test('an ask names the call and its paths, so a host can answer it by its own policy', async () => {
  const { f, dir, host } = await nativeHost();
  const h = host();
  await h.agent.request('initialize', INITIALIZE);
  const cwd = join(dir, 'P');
  const { sessionId } = await h.agent.request('session/new', { cwd, mcpServers: [] });
  h.answerPermissions(async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }));
  await turn(h, f, sessionId, 'edit', async (attempt) => {
    const gate = attempt.session.toolGate as ToolGate;
    const toolInput = { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' };
    expect(await gate({ stage: 'permission', toolName: 'Edit', toolInput, callId: 'e1' })).toEqual({
      behavior: 'allow',
    });
    expect(h.permissions[0]!.request.toolCall).toMatchObject({
      kind: 'edit',
      rawInput: toolInput,
      locations: [{ path: join(cwd, 'src/a.ts') }],
    });
  });
});

test('a native ask reaches the host as request_permission; allow_always remembers; the viewer can answer first', async () => {
  const { f, dir, host } = await nativeHost();
  const h = host();
  await h.agent.request('initialize', INITIALIZE);
  const { sessionId } = await h.agent.request('session/new', {
    cwd: join(dir, 'P'),
    mcpServers: [],
  });
  const ask = (gate: ToolGate, callId: string) =>
    gate({ stage: 'permission', toolName: 'Bash', toolInput: { command: 'make' }, callId });

  await turn(h, f, sessionId, 'build', async (attempt) => {
    const gate = attempt.session.toolGate as ToolGate;
    attempt.emit({
      kind: 'tool_use',
      callId: 'c1',
      toolName: 'Bash',
      toolInput: { command: 'make' },
    });
    await until(
      () => h.updates(sessionId).some((u) => u.sessionUpdate === 'tool_call'),
      'tool call shown',
    );

    h.answerPermissions(async () => ({
      outcome: { outcome: 'selected', optionId: 'allow_always' },
    }));
    expect(await ask(gate, 'c1')).toEqual({ behavior: 'allow' });
    const [first] = h.permissions;
    expect(first!.request.options.map((o) => o.kind)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
      'reject_always',
    ]);
    // The ask names the tool call the host already shows.
    expect(first!.request.toolCall.toolCallId).toEndWith(':tool:c1');

    // Remembered for this tool in this thread: no second request reaches the host.
    expect(await ask(gate, 'c2')).toEqual({ behavior: 'allow' });
    expect(h.permissions).toHaveLength(1);

    // Another tool: the viewer answers first and the host's request is withdrawn.
    h.answerPermissions(() => new Promise(() => {}));
    const pending = gate({
      stage: 'permission',
      toolName: 'WebFetch',
      toolInput: { url: 'https://example.com' },
      callId: 'c3',
    });
    await until(() => h.permissions.length === 2, 'second request at the host');
    const prompt = f.actionQueue.pending()[0]!;
    await f.viewer.app.request(`/api/prompts/${prompt.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'rejected' }),
    });
    expect(await pending).toMatchObject({ behavior: 'deny' });
    await until(() => h.permissions[1]!.signal.aborted, 'host request withdrawn');
  });

  const detail = f.viewer.localStore!.turnDetail(
    sessionId,
    f.viewer.localStore!.recentTurnIds(sessionId, 1)[0]!,
  )!;
  const gateRows = detail.phases.filter((row) => row.phase.startsWith('gate-'));
  expect(gateRows.map((row) => row.phase)).toEqual([
    'gate-request',
    'gate-outcome',
    'gate-request',
    'gate-outcome',
    'gate-request',
    'gate-outcome',
  ]);
  expect(gateRows[1]!.record).toMatchObject({ decision: 'allow', by: 'human' });
  expect(gateRows[3]!.record).toMatchObject({ decision: 'allow', by: 'policy' });
});

test('a structural deny holds under full access without asking anyone', async () => {
  const { f, dir, host } = await nativeHost();
  await f.viewer.configStore.patch('toolRules', { capabilities: { 'exec:shell': 'deny' } });
  const h = host();
  await h.agent.request('initialize', INITIALIZE);
  const { sessionId } = await h.agent.request('session/new', {
    cwd: join(dir, 'P'),
    mcpServers: [],
  });
  await h.agent.request('session/set_mode', { sessionId, modeId: 'bypassPermissions' });
  await turn(h, f, sessionId, 'clean', async (attempt) => {
    const gate = attempt.session.toolGate as ToolGate;
    const started = performance.now();
    const decision = await gate({
      stage: 'pre-use',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf build' },
      callId: 'c1',
    });
    expect(performance.now() - started).toBeLessThan(100);
    expect(decision).toMatchObject({ behavior: 'deny' });
    expect(h.permissions).toHaveLength(0);
    expect(f.actionQueue.pending()).toHaveLength(0);
  });
});

test('thinking, the plan tool and Warden notes project as thought chunks, a plan and guard comments', async () => {
  const { f, dir, host } = await nativeHost();
  const h = host();
  await h.agent.request('initialize', INITIALIZE);
  const { sessionId } = await h.agent.request('session/new', {
    cwd: join(dir, 'P'),
    mcpServers: [],
  });
  await turn(h, f, sessionId, 'plan it', async (attempt) => {
    attempt.emit({ kind: 'thinking', text: 'Look at the parser.' });
    attempt.emit({
      kind: 'tool_use',
      callId: 'todo',
      toolName: 'TodoWrite',
      toolInput: {
        todos: [
          { content: 'Read parser', status: 'completed', activeForm: 'Reading' },
          { content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing' },
        ],
      },
    });
    const thread = f.viewer.directory.get(sessionId)!;
    const turnId = f.viewer.localStore!.recentTurnIds(sessionId, 1)[0]!;
    f.viewer.localStore!.appendPhase(thread, {
      id: newId('phase'),
      turnId,
      dispatchId: null,
      phase: 'guard-outcome',
      record: {
        observation: { tool: 'Edit' },
        status: 'reported',
        domainsChecked: ['security'],
        findings: 1,
        critical: 0,
        notes: [{ severity: 'advisory', description: 'Secrets file touched', location: '.env' }],
      },
    });
    f.events.push({
      kind: 'journal',
      threadId: sessionId,
      projectId: 'P',
      turnId,
      timestamp: Date.now(),
    });
    await until(
      () =>
        h
          .updates(sessionId)
          .some((u) => u.sessionUpdate === 'tool_call' && u.title === 'Foundry: guard'),
      'guard comment',
    );
  });
  const updates = h.updates(sessionId);
  expect(updates.find((u) => u.sessionUpdate === 'agent_thought_chunk')).toMatchObject({
    content: { type: 'text', text: 'Look at the parser.' },
  });
  expect(updates.find((u) => u.sessionUpdate === 'plan')).toEqual({
    sessionUpdate: 'plan',
    entries: [
      { content: 'Read parser', priority: 'medium', status: 'completed' },
      { content: 'Fix bug', priority: 'medium', status: 'in_progress' },
    ],
  });
  // The plan tool is the plan, not a tool call.
  expect(
    updates.some((u) => u.sessionUpdate === 'tool_call' && u.toolCallId.endsWith(':tool:todo')),
  ).toBe(false);
  const guard = updates.find(
    (u): u is Extract<SessionUpdate, { sessionUpdate: 'tool_call' }> =>
      u.sessionUpdate === 'tool_call' && u.title === 'Foundry: guard',
  )!;
  expect(guard).toMatchObject({ kind: 'think', status: 'completed' });
  expect(JSON.stringify(guard.content)).toContain('Secrets file touched');
});

test('session/load from a new host replays the history before answering, and re-applies its MCP servers', async () => {
  const { f, dir, host } = await nativeHost();
  const first = host();
  await first.agent.request('initialize', INITIALIZE);
  const cwd = join(dir, 'P');
  const { sessionId } = await first.agent.request('session/new', { cwd, mcpServers: [] });
  await turn(
    first,
    f,
    sessionId,
    'Read a.ts',
    (attempt) => {
      attempt.emit({
        kind: 'tool_use',
        callId: 'r1',
        toolName: 'Read',
        toolInput: { file_path: 'a.ts' },
      });
      attempt.emit({
        kind: 'tool_result',
        callId: 'r1',
        toolName: 'Read',
        toolOutput: 'export {}',
      });
    },
    'It exports nothing.',
  );
  await first.close();

  const second = host();
  const init = await second.agent.request('initialize', INITIALIZE);
  expect(init.agentCapabilities?.loadSession).toBe(true);
  const loaded = await second.agent.request('session/load', {
    sessionId,
    cwd,
    mcpServers: [PASEO_MCP],
  });
  expect(loaded.modes?.currentModeId).toBe('default');
  // Replayed before the response arrived.
  const replay = second.updates(sessionId);
  expect(replay[0]).toEqual({
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'Read a.ts' },
  });
  expect(replay[1]).toMatchObject({
    sessionUpdate: 'tool_call',
    title: 'Read: a.ts',
    kind: 'read',
    status: 'completed',
    rawOutput: { output: 'export {}' },
  });
  expect(replay[2]).toEqual({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'It exports nothing.' },
  });
  expect(f.threadLaunch.get(sessionId).mcpServers).toEqual([PASEO_MCP]);
  // The same thread takes the next turn.
  await turn(second, f, sessionId, 'Again');
  expect(f.viewer.localStore!.recentTurnIds(sessionId, 10)).toHaveLength(2);
});

test('/correction records a correction against the last turn without running a turn', async () => {
  const { f, dir, host } = await nativeHost();
  const h = host();
  await h.agent.request('initialize', INITIALIZE);
  const { sessionId } = await h.agent.request('session/new', {
    cwd: join(dir, 'P'),
    mcpServers: [],
  });
  const empty = await h.agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '/correction use the parser' }],
  });
  expect(empty).toEqual({ stopReason: 'end_turn' });
  expect(JSON.stringify(h.updates(sessionId))).toContain('Nothing to correct yet');

  await turn(h, f, sessionId, 'Fix it');
  const before = f.attempts.length;
  expect(
    await h.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/correction  Use the existing parser, not a new one' }],
    }),
  ).toEqual({ stopReason: 'end_turn' });
  expect(f.attempts.length).toBe(before);
  expect(JSON.stringify(h.updates(sessionId))).toContain('Correction recorded');
  const interventions = (await (await f.viewer.app.request('/api/interventions')).json()) as Array<{
    threadId: string;
    correction: string;
    operator: string;
  }>;
  expect(interventions[0]).toMatchObject({
    threadId: sessionId,
    correction: 'Use the existing parser, not a new one',
    operator: 'acp:Paseo',
  });
});
