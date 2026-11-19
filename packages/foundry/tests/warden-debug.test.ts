import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RAW_MIDDLEWARE_PHASES, reduceMiddleware } from '../src/archives/reduced-middleware';
import type { TurnDetail } from '../src/persistence/local-session-store';
import { validateChorusSettings } from '../src/viewer/config';
import { projectChorus } from '../src/viewer/config-resolve';
import { type TimelineStep, turnTimeline } from '../src/viewer/turn-timeline';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const advice = {
  id: 'p1',
  turnId: 't',
  phase: 'advice',
  record: {
    trigger: 'user-message',
    participants: [
      {
        domain: 'db',
        outcome: { status: 'answered', result: 'no-comment' },
        snippets: [],
        classified: { stages: [{ stage: 0, task: 'point', outcome: 'no' }] },
      },
    ],
  },
  storedAt: 2,
};
const debug = {
  id: 'p2',
  turnId: 't',
  phase: 'warden-debug',
  record: {
    wraps: 'p1:db',
    explains: 'advice',
    domain: 'db',
    stage: 0,
    explainsOutcome: 'no',
    outcome: { status: 'answered', result: 'revised' },
    why: 'It adds a column after all.',
    revised: 'yes',
    elapsedMs: 40,
  },
  storedAt: 5,
};

test('a debug reason is a raw middleware row, reduced as its own call linked to the decision it explains', () => {
  expect(RAW_MIDDLEWARE_PHASES).toContain('warden-debug');
  const reduced = reduceMiddleware([advice, debug]);
  expect(reduced.map((r) => r.callId)).toEqual(['p1:db', 'p1:db:debug']);
  expect(reduced[1]).toEqual({
    callId: 'p1:db:debug',
    role: 'db',
    trigger: 'debug',
    wraps: 'p1:db',
    outcome: 'answered:revised',
    result: { why: 'It adds a column after all.', revised: 'yes' },
    state: { explains: 'advice', explainsOutcome: 'no', stage: 0 },
    at: 5,
    sources: ['p2'],
  });
  // A debug call that failed keeps its error as the reason and has no result.
  const failed = reduceMiddleware([
    {
      ...debug,
      record: {
        ...debug.record,
        outcome: { status: 'failed', cause: 'timeout' },
        why: undefined,
        revised: undefined,
        error: 'timed out',
      },
    },
  ])[0]!;
  expect(failed).toMatchObject({ outcome: 'failed:timeout', reason: 'timed out', result: null });
});

test('the turn timeline shows the debug reason beside the Warden, on the layer that decided', () => {
  const row = (r: typeof advice | typeof debug) => ({ ...r, threadId: 'a', dispatchId: null });
  const detail: TurnDetail = {
    threadId: 'a',
    turnId: 't',
    turn: { id: 't', threadId: 'a', status: 'completed', startedAt: 1, endedAt: 9 },
    messages: [],
    trace: null,
    injection: null,
    nativeHistory: [],
    nativeTools: [],
    phases: [row(advice), row(debug)],
  };
  const chorus = turnTimeline(detail).steps.find(
    (s): s is Extract<TimelineStep, { kind: 'chorus' }> => s.kind === 'chorus',
  )!;
  expect(chorus.regions[0]!.debugReason).toEqual({
    layer: 1,
    why: 'It adds a column after all.',
    revised: 'yes',
    status: 'answered',
  });
  // The layer keeps only what the decision itself said.
  expect(chorus.regions[0]!.layers[0]?.revised).toBeUndefined();
});

test('chorus.heralds takes no debugReason: Heralds are not built', () => {
  expect(() => validateChorusSettings('chorus', { heralds: { debugReason: false } })).toThrow(
    /heralds\.debugReason is not a role setting \(stages\)/,
  );
});

test('chorus.wardens.debugReason is a boolean role setting; the machine’s wins over the repository’s', () => {
  expect(() => validateChorusSettings('chorus', { wardens: { debugReason: false } })).not.toThrow();
  expect(() => validateChorusSettings('chorus', { wardens: { debugReason: 'off' } })).toThrow(
    /debugReason must be true or false/,
  );
  const root = mkdtempSync(join(tmpdir(), 'warden-debug-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.foundry'), { recursive: true });
  writeFileSync(
    join(root, '.foundry', 'project.json'),
    JSON.stringify({ chorus: { wardens: { debugReason: false } } }),
  );
  const project = { id: 'P', name: 'P', path: root } as Parameters<typeof projectChorus>[0];
  expect(projectChorus(project).chorus.wardens).toEqual({ debugReason: false });
  expect(
    projectChorus({ ...project, chorus: { wardens: { debugReason: true } } }).chorus.wardens,
  ).toEqual({ debugReason: true });
});
