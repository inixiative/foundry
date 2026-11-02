import { expect, test } from 'bun:test';
import type { ToolRequest } from '@inixiative/agent-session';
import { ActionQueue } from '@inixiative/foundry-core';
import type { PermissionMode } from '../src/providers/thread-launch';
import { createToolGate, rulesFor, structuralLevel, type ToolRules } from '../src/turns/tool-gate';

function gate(rules: ToolRules | undefined, mode?: PermissionMode) {
  const queue = new ActionQueue();
  const rows: Array<{ phase: string; turnId: string | null; record: Record<string, unknown> }> = [];
  const decide = createToolGate({
    threadId: 'thread',
    rules: () => rules,
    mode: () => mode,
    queue,
    turnId: () => 'turn-1',
    journal: (_id, phase, turnId, record) => rows.push({ phase, turnId, record }),
  });
  return { decide, queue, rows };
}

const bash = (stage: ToolRequest['stage'], extra: Partial<ToolRequest> = {}): ToolRequest => ({
  stage,
  toolName: 'Bash',
  toolInput: { command: 'rm -rf build' },
  callId: 'call-1',
  ...extra,
});

test('a structural deny is final in every mode, makes no prompt and is journalled', async () => {
  for (const mode of ['bypassPermissions', 'default', undefined] as const) {
    const { decide, queue, rows } = gate({ capabilities: { 'exec:shell': 'deny' } }, mode);
    const started = performance.now();
    const decision = await decide(bash('pre-use'));
    expect(performance.now() - started).toBeLessThan(100);
    expect(decision).toMatchObject({ behavior: 'deny' });
    expect(decision.behavior === 'deny' && decision.message).toContain('every mode');
    expect(queue.pending()).toEqual([]);
    expect(rows.map((row) => [row.phase, row.turnId])).toEqual([
      ['gate-request', 'turn-1'],
      ['gate-outcome', 'turn-1'],
    ]);
    expect(rows[0]!.record).toMatchObject({
      stage: 'pre-use',
      capability: 'exec:shell',
      level: 'deny',
    });
    expect(rows[1]!.record).toMatchObject({ decision: 'deny', by: 'structure' });
  }
});

test('a pre-use call the rules allow is left to the native mode; a native ask goes to the user', async () => {
  const { decide, queue } = gate(undefined, 'default');
  expect(await decide(bash('pre-use'))).toEqual({ behavior: 'allow' });
  expect(queue.pending()).toEqual([]);

  const asked = decide(bash('permission'));
  await Bun.sleep(0);
  const [prompt] = queue.pending();
  expect(prompt).toMatchObject({
    threadId: 'thread',
    capability: 'exec:shell',
    meta: { stage: 'permission', toolName: 'Bash', callId: 'call-1', turnId: 'turn-1' },
  });
  queue.resolve(prompt!.id, 'rejected');
  expect(await asked).toMatchObject({ behavior: 'deny', message: 'The user rejected Bash.' });
});

test('a structural prompt asks at pre-use, and that approval answers the native ask for the same call', async () => {
  const { decide, queue } = gate({ protectedPaths: ['/secrets/'] }, 'bypassPermissions');
  const edit: ToolRequest = {
    stage: 'pre-use',
    toolName: 'Edit',
    toolInput: { file_path: '/repo/secrets/key.env' },
    callId: 'call-2',
  };
  const asked = decide(edit);
  await Bun.sleep(0);
  queue.resolve(queue.pending()[0]!.id, 'approved');
  expect(await asked).toEqual({ behavior: 'allow' });
  expect(await decide({ ...edit, stage: 'permission' })).toEqual({ behavior: 'allow' });
  expect(queue.pending()).toEqual([]);
});

test('a withdrawn native request withdraws its prompt', async () => {
  const { decide, queue } = gate(undefined, 'default');
  const controller = new AbortController();
  const asked = decide(bash('permission', { signal: controller.signal }));
  await Bun.sleep(0);
  expect(queue.pending()).toHaveLength(1);
  controller.abort();
  expect(await asked).toMatchObject({ behavior: 'deny' });
  expect(queue.pending()).toEqual([]);
});

test("Codex's acceptEdits file-change asks are escalations and go to the user, as Claude's do", async () => {
  const { decide, queue } = gate(undefined, 'acceptEdits');
  const asked = decide({
    stage: 'permission',
    toolName: 'apply_patch',
    toolInput: { changes: [{ path: '/elsewhere/a.ts' }] },
  });
  await Bun.sleep(0);
  expect(queue.pending()).toHaveLength(1);
  queue.resolve(queue.pending()[0]!.id, 'rejected');
  expect(await asked).toMatchObject({ behavior: 'deny' });
});

test('an ask no one answers times out and denies, saying so', async () => {
  const queue = new ActionQueue();
  const decide = createToolGate({
    threadId: 'thread',
    rules: () => undefined,
    mode: () => 'default',
    queue,
    turnId: () => null,
    journal: () => {},
    askTimeoutMs: 30,
  });
  const decision = await decide(bash('permission'));
  expect(decision).toMatchObject({ behavior: 'deny' });
  expect(decision.behavior === 'deny' && decision.message).toContain('No one answered');
  expect(queue.pending()).toEqual([]);
});

test('an explicit file:write allow never switches protected paths off; an explicit deny still denies', () => {
  const write = {
    stage: 'pre-use' as const,
    toolName: 'Write',
    toolInput: { file_path: '/repo/.env' },
  };
  expect(
    structuralLevel({ capabilities: { 'file:write': 'allow' }, protectedPaths: ['.env'] }, write)
      .level,
  ).toBe('prompt');
  expect(
    structuralLevel({ capabilities: { 'file:write': 'deny' }, protectedPaths: ['.env'] }, write)
      .level,
  ).toBe('deny');
  expect(
    structuralLevel(
      { capabilities: { 'file:write': 'allow' }, protectedPaths: ['.env'] },
      { ...write, toolInput: { file_path: '/repo/a.ts' } },
    ).level,
  ).toBe('allow');
});

test('project rules override global capabilities and add protected paths', () => {
  expect(
    rulesFor(
      { capabilities: { 'exec:shell': 'deny', 'net:api': 'prompt' }, protectedPaths: ['/a'] },
      { capabilities: { 'exec:shell': 'allow' }, protectedPaths: ['/b'] },
    ),
  ).toEqual({
    capabilities: { 'exec:shell': 'allow', 'net:api': 'prompt' },
    protectedPaths: ['/a', '/b'],
  });
  expect(rulesFor(undefined, undefined)).toBeUndefined();
});

test('Codex file changes are checked on every path they touch; a misspelled level fails closed', async () => {
  const { decide } = gate({ protectedPaths: ['/secrets/'] }, 'default');
  const asked = decide({
    stage: 'permission',
    toolName: 'apply_patch',
    toolInput: { changes: [{ path: '/repo/a.ts' }, { path: '/repo/secrets/key.env' }] },
  });
  const typo = gate({ capabilities: { 'exec:shell': 'block' as never } }, 'bypassPermissions');
  expect(await typo.decide(bash('pre-use'))).toMatchObject({ behavior: 'deny' });
  // The protected path makes the change a structural ask, even under acceptEdits' shortcut.
  const edits = gate({ protectedPaths: ['/secrets/'] }, 'acceptEdits');
  const structural = edits.decide({
    stage: 'permission',
    toolName: 'apply_patch',
    toolInput: { changes: [{ path: '/repo/secrets/key.env' }] },
  });
  await Bun.sleep(0);
  expect(edits.queue.pending()[0]?.meta).toMatchObject({
    structural: true,
    path: '/repo/secrets/key.env',
  });
  edits.queue.resolve(edits.queue.pending()[0]!.id, 'rejected');
  expect(await structural).toMatchObject({ behavior: 'deny' });
  void asked;
});

test('a rejection carries the note the user typed with it to the agent', async () => {
  const { decide, queue } = gate(undefined, 'default');
  const asked = decide(bash('permission'));
  await Bun.sleep(0);
  const [prompt] = queue.pending();
  queue.resolve(prompt!.id, 'rejected', { note: 'push only after CI is green' });
  expect(await asked).toMatchObject({
    behavior: 'deny',
    message: 'The user rejected Bash. Their note: push only after CI is green',
  });
  expect(queue.get(prompt!.id)?.resolution?.note).toBe('push only after CI is green');
});

test("Foundry's own record and read tools never wait on an approval; sends and structural denies still apply", async () => {
  const bridge = 'mcp__foundry_3f6951c8a5284627a049eba9839ad6dc';
  const call = (operation: string): ToolRequest => ({
    stage: 'permission',
    toolName: `${bridge}__${operation}`,
    toolInput: {},
    callId: `call-${operation}`,
  });
  const { decide, queue, rows } = gate(undefined, 'default');
  for (const operation of [
    'set_plan',
    'set_status',
    'rename_thread',
    'loop_round',
    'get_plan',
    'ask_herald',
    'foundry_threads',
  ])
    expect(await decide(call(operation))).toEqual({ behavior: 'allow' });
  expect(queue.pending()).toEqual([]);
  expect(rows.at(-1)!.record).toMatchObject({ decision: 'allow', by: 'foundry-own' });

  // A send to a member is the host's mode to decide: it asks.
  void decide(call('send_to_member'));
  await Bun.sleep(0);
  expect(queue.pending()).toHaveLength(1);

  // A user's structural rule naming the tool still holds.
  const strict = gate({ capabilities: { [`tool:${bridge}__set_status`]: 'deny' } }, 'default');
  expect(await strict.decide(call('set_status'))).toMatchObject({ behavior: 'deny' });
});

test("a Codex thread's launch pre-approves exactly Foundry's own tools on its bridge; sends keep Codex's mode", async () => {
  const { appServerBridgeConfiguration } = await import('../src/providers/native-launch');
  const { FOUNDRY_OWN_TOOLS } = await import('../src/tools/thread-record');
  const name = 'foundry_3f6951c8a5284627a049eba9839ad6dc';
  const lease = {
    name,
    check() {},
    launch: {
      claudeJson: JSON.stringify({
        mcpServers: { [name]: { command: 'bun', args: ['run', 'bridge.ts'] } },
      }),
    },
  } as unknown as Parameters<typeof appServerBridgeConfiguration>[0];
  const server = appServerBridgeConfiguration(lease)[`mcp_servers.${name}`] as {
    tools: Record<string, { approval_mode: string }>;
  };
  expect(Object.keys(server.tools).sort()).toEqual([...FOUNDRY_OWN_TOOLS].sort());
  expect(Object.values(server.tools).every((t) => t.approval_mode === 'approve')).toBe(true);
  expect(server.tools.send_to_member).toBeUndefined();
  expect(server.tools.fork_thread).toBeUndefined();
});
