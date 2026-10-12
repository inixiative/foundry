import { expect, test } from 'bun:test';
import type { ToolRequest } from '@inixiative/agent-session';
import { ActionQueue } from '@inixiative/foundry-core';
import type { PermissionMode } from '../src/providers/thread-launch';
import { createToolGate, rulesFor, type ToolRules } from '../src/turns/tool-gate';

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

test('acceptEdits accepts file changes the native runtime asks about', async () => {
  const { decide, queue } = gate(undefined, 'acceptEdits');
  expect(
    await decide({
      stage: 'permission',
      toolName: 'apply_patch',
      toolInput: { path: '/repo/a.ts' },
    }),
  ).toEqual({ behavior: 'allow' });
  expect(queue.pending()).toEqual([]);
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
