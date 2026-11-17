import { expect, test } from 'bun:test';
import type { ToolDecision, ToolRequest } from '@inixiative/agent-session';
import { type HandoffCall, handoffMoment, withChorusAtCall } from '../src/turns/handoff-brief';

// The thread's tool gate with the handoff brief after it (Aron, 2026-11-02: every turn that would get
// injection calls the Wardens, subagents included). Only a pre-use handoff the gate allowed is
// briefed; its text comes back rewritten when a Warden spoke.

const spawn: ToolRequest = {
  stage: 'pre-use',
  toolName: 'Agent',
  toolInput: { description: 'audit', subagent_type: 'general-purpose', prompt: 'Audit it.' },
  callId: 'toolu_1',
};

function gated(decision: ToolDecision, answer: string | undefined | Error) {
  const asked: HandoffCall[] = [];
  const gate = withChorusAtCall(
    async () => decision,
    {
      brief: async (call) => {
        asked.push(call);
        if (answer instanceof Error) throw answer;
        return answer;
      },
      milestone: async () => undefined,
    },
    { turnId: () => 'turn-1' },
  );
  return { gate, asked };
}

test('an allowed pre-use spawn is briefed: the prompt is rewritten, the rest of the input kept', async () => {
  const { gate, asked } = gated(
    { behavior: 'allow' },
    'Audit it.\n\n---\n\nThe x Warden chimed in…',
  );
  expect(await gate(spawn)).toEqual({
    behavior: 'allow',
    updatedInput: {
      description: 'audit',
      subagent_type: 'general-purpose',
      prompt: 'Audit it.\n\n---\n\nThe x Warden chimed in…',
    },
  });
  expect(asked).toEqual([
    { callId: 'toolu_1', toolName: 'Agent', toolInput: spawn.toolInput, turnId: 'turn-1' },
  ]);
});

test('a deny, a permission ask, another tool, a silent or failed brief pass through unchanged', async () => {
  const deny: ToolDecision = { behavior: 'deny', message: 'no' };
  const denied = gated(deny, 'x');
  expect(await denied.gate(spawn)).toBe(deny);
  expect(denied.asked).toHaveLength(0);
  const allow: ToolDecision = { behavior: 'allow' };
  const ask = gated(allow, 'x');
  expect(await ask.gate({ ...spawn, stage: 'permission' })).toBe(allow);
  expect(await ask.gate({ ...spawn, toolName: 'Bash', toolInput: { command: 'ls' } })).toBe(allow);
  expect(ask.asked).toHaveLength(0);
  expect(await gated(allow, undefined).gate(spawn)).toBe(allow);
  expect(await gated(allow, 'Audit it.').gate(spawn)).toBe(allow);
  expect(await gated(allow, new Error('chorus down')).gate(spawn)).toBe(allow);
});

test('a SendMessage hands its message; the brief reads the input an earlier gate rewrote', async () => {
  const earlier: ToolDecision = {
    behavior: 'allow',
    updatedInput: { to: 'auditor', message: 'Redacted task.' },
  };
  const { gate, asked } = gated(earlier, 'Redacted task.\n\n---\n\nchime');
  const out = await gate({
    stage: 'pre-use',
    toolName: 'SendMessage',
    toolInput: { to: 'auditor', message: 'Task with $$secret.' },
    callId: 'toolu_2',
  });
  expect(asked[0]!.toolInput).toEqual({ to: 'auditor', message: 'Redacted task.' });
  expect(out).toEqual({
    behavior: 'allow',
    updatedInput: { to: 'auditor', message: 'Redacted task.\n\n---\n\nchime' },
  });
  expect(
    handoffMoment({ toolName: 'SendMessage', toolInput: { to: 'auditor', message: 'm' } }),
  ).toMatchObject({ field: 'message', moment: { agentType: 'auditor', prompt: 'm' } });
  expect(handoffMoment({ toolName: 'Agent', toolInput: { prompt: '  ' } })).toBeUndefined();
});

function milestoneGated(decision: ToolDecision, answer: string | undefined | Error) {
  const asked: HandoffCall[] = [];
  const gate = withChorusAtCall(
    async () => decision,
    {
      brief: async () => undefined,
      milestone: async (call) => {
        asked.push(call);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    { turnId: () => 'turn-1' },
  );
  return { gate, asked };
}

const merge: ToolRequest = {
  stage: 'pre-use',
  toolName: 'Bash',
  toolInput: { command: 'gh pr merge 12 --squash' },
  callId: 'toolu_9',
};

test('an allowed pre-use milestone carries the advice as context; the call is unchanged', async () => {
  const { gate, asked } = milestoneGated({ behavior: 'allow' }, 'The workflow Warden chimed in…');
  expect(await gate(merge)).toEqual({
    behavior: 'allow',
    context: 'The workflow Warden chimed in…',
  });
  expect(asked).toEqual([
    { callId: 'toolu_9', toolName: 'Bash', toolInput: merge.toolInput, turnId: 'turn-1' },
  ]);
});

test("a milestone's advice joins an earlier gate's context", async () => {
  const { gate } = milestoneGated({ behavior: 'allow', context: 'earlier' }, 'chime');
  expect(await gate(merge)).toEqual({ behavior: 'allow', context: 'earlier\n\nchime' });
});

test('a deny, a permission ask, a silent or failed milestone pass through unchanged', async () => {
  const deny: ToolDecision = { behavior: 'deny', message: 'no' };
  const denied = milestoneGated(deny, 'x');
  expect(await denied.gate(merge)).toBe(deny);
  expect(denied.asked).toHaveLength(0);
  const allow: ToolDecision = { behavior: 'allow' };
  expect(await milestoneGated(allow, 'x').gate({ ...merge, stage: 'permission' })).toBe(allow);
  expect(await milestoneGated(allow, undefined).gate(merge)).toBe(allow);
  expect(await milestoneGated(allow, new Error('chorus down')).gate(merge)).toBe(allow);
});
