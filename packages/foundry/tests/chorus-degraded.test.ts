import { expect, test } from 'bun:test';
import type { ClassifyStageTrace } from '@inixiative/foundry-core';
import {
  allDegraded,
  chorusRetries,
  degradedGuards,
  degradedWardens,
  journalActivity,
  turnChorus,
} from '../src/agents/chorus-degraded';

// FEAT-008: a Warden the system kept quiet (timeout, error, never admitted) at Layer 1 or Layer 2.

const stage = (index: number, rest: Partial<ClassifyStageTrace> = {}): ClassifyStageTrace => ({
  stage: index,
  task: index === 0 ? 'recognise' : 'point',
  doc: 'knowledge.md',
  elapsedMs: 10,
  ...rest,
});

test('a Layer 1 timeout inside the stage run is a silent timeout at layer 1', () => {
  expect(
    degradedWardens([
      {
        domain: 'db',
        decision: 'error',
        reason: 'stage 1 timed out',
        classified: {
          stages: [stage(0, { timedOut: true, error: 'no answer within 900ms' })],
        },
      },
    ]),
  ).toEqual([
    { domain: 'db', kind: 'timeout', layer: 1, silent: true, reason: 'no answer within 900ms' },
  ]);
});

test("the orchestrator's deadline (no stage reported) is a silent timeout at an unknown layer", () => {
  expect(
    degradedWardens([{ domain: 'db', decision: 'timeout', reason: 'no answer within 8000ms' }]),
  ).toEqual([
    { domain: 'db', kind: 'timeout', layer: null, silent: true, reason: 'no answer within 8000ms' },
  ]);
});

test('a Layer 2 failure after a recognising yes is silent: the pointer was lost', () => {
  expect(
    degradedWardens([
      {
        domain: 'locks',
        decision: 'no-comment',
        classified: {
          fallback: 'timeout',
          stages: [stage(0, { outcome: 'yes' }), stage(1, { timedOut: true, error: 'late' })],
        },
      },
    ]),
  ).toEqual([{ domain: 'locks', kind: 'timeout', layer: 2, silent: true, reason: 'late' }]);
});

test("a Layer 2 failure where a pointing Layer 1's answer stood is shown, not silent", () => {
  expect(
    degradedWardens([
      {
        domain: 'locks',
        decision: 'contribute',
        classified: {
          fallback: 'error',
          stages: [stage(0, { outcome: 'yes' }), stage(1, { error: 'provider failed' })],
        },
      },
    ]),
  ).toEqual([
    { domain: 'locks', kind: 'error', layer: 2, silent: false, reason: 'provider failed' },
  ]);
});

test('never admitted is not-started; real answers and skips are not degraded', () => {
  expect(
    degradedWardens([
      { domain: 'a', decision: 'excluded', reason: 'deadline-queued' },
      { domain: 'b', decision: 'no-comment' },
      { domain: 'c', decision: 'contribute' },
      { domain: 'd', decision: 'skipped', reason: 'cold-cache' },
      { domain: 'e', decision: 'omitted', reason: 'budget' },
    ]),
  ).toEqual([
    { domain: 'a', kind: 'not-started', layer: null, silent: true, reason: 'deadline-queued' },
  ]);
});

test('guard: the checks the report lists as failed, with the layer from the staged run', () => {
  expect(
    degradedGuards(
      [
        { domain: 'ok', status: 'completed', noComment: true, findings: 0 },
        { domain: 'spoke', status: 'completed', findings: 1 },
        { domain: 'refused', status: 'not-admitted', error: 'queue full' },
        {
          domain: 'late',
          status: 'provider-error',
          error: 'stage 1 failed',
          classified: { stages: [stage(0, { error: 'provider timed out' })] },
        },
        { domain: 'cold', status: 'cold-cache' },
      ],
      ['refused', 'late'],
    ),
  ).toEqual([
    { domain: 'refused', kind: 'not-started', layer: null, silent: true, reason: 'queue full' },
    { domain: 'late', kind: 'error', layer: 1, silent: true, reason: 'provider timed out' },
  ]);
});

test('a one-layer Warden fails at Layer 1 by definition; a cold Warden that missed its warm deadline is not-started', () => {
  const context = { stageCount: () => 1, notWarm: new Set(['cold']) };
  expect(
    degradedWardens(
      [
        { domain: 'db', decision: 'timeout', reason: 'no answer within 8000ms' },
        { domain: 'cold', decision: 'skipped', reason: 'cold-cache' },
        { domain: 'empty', decision: 'skipped', reason: 'cold-cache' },
      ],
      context,
    ),
  ).toEqual([
    { domain: 'db', kind: 'timeout', layer: 1, silent: true, reason: 'no answer within 8000ms' },
    { domain: 'cold', kind: 'not-started', layer: 1, silent: true, reason: 'not warm in time' },
  ]);
  expect(allDegraded(['a'], 'boom', context)).toEqual([
    { domain: 'a', kind: 'error', layer: 1, silent: true, reason: 'boom' },
  ]);
});

const down = (domain: string) => ({
  domain,
  kind: 'timeout' as const,
  layer: 1,
  silent: true,
  reason: 'late',
});

test('a turn: a retried or dismissed row is no longer open; a retry that failed again is', () => {
  expect(
    turnChorus([
      { id: 'a1', phase: 'advice', trigger: 'user-message', degraded: [down('db')] },
      { id: 'g1', phase: 'guard-outcome', degraded: [down('locks')] },
      { id: 'a2', phase: 'advice', trigger: 'user-message', retryOf: 'a1', degraded: [down('db')] },
      { id: 'd1', phase: 'chorus-dismiss', of: ['g1'] },
    ]),
  ).toEqual({
    notices: [
      { rowId: 'a1', trigger: 'user-message', degraded: [down('db')], retriedBy: 'a2' },
      { rowId: 'g1', trigger: 'agent-action', degraded: [down('locks')], retriedBy: null },
      { rowId: 'a2', trigger: 'user-message', degraded: [down('db')], retriedBy: null },
    ],
    open: ['a2'],
  });
  expect(turnChorus([{ id: 'a1', phase: 'advice', trigger: 'user-message' }])).toBeUndefined();
});

test('retries: advice on its recorded moment, the guard on exactly its recorded calls', () => {
  const nativeHistory = [
    { kind: 'tool_use', callId: 'c1', toolName: 'Edit', toolInput: { file_path: 'a.ts' } },
    { kind: 'tool_result', callId: 'c1', toolOutput: 'ok' },
    { kind: 'tool_use', callId: 'c2', toolName: 'Read', toolInput: { file_path: 'b.ts' } },
  ] as never;
  const { retries, unavailable } = chorusRetries({
    turnId: 't1',
    nativeHistory,
    phases: [
      {
        id: 'a1',
        phase: 'advice',
        record: { trigger: 'user-message', moment: 'Fix the lock', degraded: [down('db')] },
      },
      {
        id: 'g1',
        phase: 'guard-outcome',
        record: {
          trigger: 'agent-action',
          activity: { turnId: 't1', calls: [{ tool: 'Edit', callId: 'c1', ok: true }] },
          degraded: [down('locks'), down('locks')],
        },
      },
      {
        id: 'b1',
        phase: 'advice',
        record: { trigger: 'subagent-spawn', degraded: [down('db')] },
      },
    ],
  });
  expect(retries).toEqual([
    {
      kind: 'advice',
      of: 'a1',
      turnId: 't1',
      trigger: 'user-message',
      moment: 'Fix the lock',
      domains: ['db'],
    },
    {
      kind: 'guard',
      of: 'g1',
      turnId: 't1',
      observations: [
        { tool: 'Edit', input: { file_path: 'a.ts' }, output: 'ok', callId: 'c1', ok: true },
      ],
      domains: ['locks'],
    },
  ]);
  expect(unavailable).toEqual([
    { rowId: 'b1', reason: 'the journal does not hold the moment it was asked on' },
  ]);
  expect(journalActivity({ activity: { calls: [{ callId: 'gone' }] } }, nativeHistory)).toEqual({
    unavailable: 'the journal does not hold call gone',
  });
  expect(
    journalActivity({ activity: { calls: [{ callId: 'c1' }], overflow: 3 } }, nativeHistory),
  ).toEqual({ unavailable: 'the row elided calls past its bound' });
});
