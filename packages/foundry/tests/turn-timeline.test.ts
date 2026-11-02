import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import type { NativeEvidence } from '@inixiative/foundry-core';
import type { TurnDetail } from '../src/persistence/local-session-store';
import { type TimelineStep, turnTimeline } from '../src/viewer/turn-timeline';
import { m0Scenario } from './helpers/m0-domain-loop';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

type Timeline = ReturnType<typeof turnTimeline>;
const of = <K extends TimelineStep['kind']>(timeline: Timeline, kind: K) =>
  timeline.steps.filter((s): s is Extract<TimelineStep, { kind: K }> => s.kind === kind);

test('a recorded turn reads as its steps in order: input, routing, chorus, plan, delivery, guard, writeback, archive', async () => {
  const s = await m0Scenario();
  cleanup.push(() => s.close());
  await s.send('a', 't1', 'Perform the migration');
  await s.committed('a', 'architecture');
  await s.settled('a');
  await s.send('a', 't2', 'Perform the migration');
  await s.settled('a');

  const res = await s.current.app.request('/api/threads/a/turns/t1/timeline');
  expect(res.status).toBe(200);
  const t1 = (await res.json()) as Timeline;
  expect(t1).toMatchObject({ threadId: 'a', turnId: 't1', status: 'completed' });
  expect([...new Set(t1.steps.map((step) => step.kind))]).toEqual([
    'input',
    'route',
    'chorus',
    'plan',
    'delivery',
    'guard',
    'writeback',
    'archive',
  ]);
  expect(of(t1, 'input')[0]).toMatchObject({ text: 'Perform the migration' });
  expect(of(t1, 'route')[0]).toMatchObject({
    status: 'routed',
    domains: ['architecture', 'testing'],
  });
  const chorus = of(t1, 'chorus')[0]!;
  expect(chorus.trigger).toBe('user-message');
  expect(chorus.regions.map((r) => [r.region, r.decision])).toEqual([
    ['architecture', 'contribute'],
    ['testing', 'contribute'],
  ]);
  const delivery = of(t1, 'delivery')[0]!;
  expect(delivery.chimes.map((c) => [c.region, c.saidBefore])).toEqual([
    ['architecture', null],
    ['testing', null],
  ]);
  expect(
    of(t1, 'guard')[0]!
      .regions.map((r) => r.region)
      .sort(),
  ).toEqual(['architecture', 'testing']);
  // Writeback: each region's review was requested, then learned from the turn.
  expect(
    of(t1, 'writeback')
      .map((w) => `${w.region}:${w.decision}`)
      .sort(),
  ).toEqual([
    'architecture:learned',
    'architecture:requested',
    'testing:learned',
    'testing:requested',
  ]);

  // The second turn's Wardens said the same again: recorded as said before, still delivered (no suppression).
  const t2 = (await (
    await s.current.app.request('/api/threads/a/turns/t2/timeline')
  ).json()) as Timeline;
  const chimes = of(t2, 'delivery')[0]!.chimes;
  expect(chimes.map((c) => c.region)).toEqual(['architecture', 'testing']);
  expect(chimes.every((c) => c.saidBefore?.turnId === 't1')).toBe(true);

  expect((await s.current.app.request('/api/threads/b/turns/t1/timeline')).status).toBe(404);
});

test('tool calls pair each use with its result, in observed order', () => {
  const evidence = (e: Partial<NativeEvidence>): NativeEvidence => ({
    schema: 1,
    nativeOutcome: 'completed',
    ...e,
  });
  const detail: TurnDetail = {
    threadId: 'a',
    turnId: 't',
    turn: { id: 't', threadId: 'a', status: 'completed', startedAt: 1, endedAt: 9 },
    messages: [],
    trace: null,
    injection: null,
    nativeHistory: [
      evidence({
        kind: 'tool_use',
        callId: 'c2',
        toolName: 'Read',
        toolInput: { file_path: '/x' },
        observedAt: 5,
      }),
      evidence({
        kind: 'tool_use',
        callId: 'c1',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        observedAt: 3,
      }),
      evidence({ kind: 'tool_result', callId: 'c1', toolOutput: 'a\nb', observedAt: 4 }),
      evidence({
        kind: 'tool_result',
        callId: 'c2',
        toolError: true,
        toolOutput: 'ENOENT',
        observedAt: 6,
      }),
    ],
    nativeTools: [],
    phases: [],
  };
  const tools = of(turnTimeline(detail), 'tool');
  expect(tools.map((t) => [t.tool, t.input, t.output, t.error, t.finishedAt])).toEqual([
    ['Bash', { command: 'ls' }, 'a\nb', false, 4],
    ['Read', { file_path: '/x' }, 'ENOENT', true, 6],
  ]);
  expect(of(turnTimeline(detail), 'archive')[0]).toMatchObject({ state: 'unavailable' });
  expect(
    of(turnTimeline(detail, { archive: { stored: { at: 10, archiveId: 'ar' } } }), 'archive')[0],
  ).toMatchObject({ state: 'captured', at: 10 });
  expect(
    of(turnTimeline(detail, { archive: { error: 'Archive unreachable' } }), 'archive')[0],
  ).toMatchObject({ state: 'failed', error: 'Archive unreachable' });
});

test('a retry of the message chorus (FEAT-008) is its own step in the work, not the pre-plan chorus', () => {
  const row = (id: string, record: Record<string, unknown>, storedAt: number) => ({
    id,
    threadId: 'a',
    turnId: 't',
    dispatchId: null,
    phase: 'advice',
    record,
    storedAt,
  });
  const detail: TurnDetail = {
    threadId: 'a',
    turnId: 't',
    turn: { id: 't', threadId: 'a', status: 'completed', startedAt: 1, endedAt: 9 },
    messages: [],
    trace: null,
    injection: null,
    nativeHistory: [],
    nativeTools: [],
    phases: [
      row(
        'p1',
        { trigger: 'user-message', participants: [{ domain: 'db', decision: 'timeout' }] },
        2,
      ),
      row(
        'p2',
        {
          trigger: 'user-message',
          retryOf: 'p1',
          participants: [{ domain: 'db', decision: 'contribute', snippets: ['x'] }],
        },
        20,
      ),
    ],
  };
  const steps = turnTimeline(detail).steps;
  const chorus = steps.filter((s) => s.kind === 'chorus');
  expect(
    chorus.map((s) => (s as { regions: { decision: string }[] }).regions[0]!.decision),
  ).toEqual(['timeout', 'contribute']);
  // The sealed chorus comes before the plan's place; the retry sits with the work, by its time.
  expect(steps.findIndex((s) => s === chorus[1])).toBe(steps.length - 2);
});
