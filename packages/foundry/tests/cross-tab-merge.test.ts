import { expect, test } from 'bun:test';
import { discardKeys, mergeStoredMessages } from '../src/viewer/ui/conversation-state.js';

const user = (turnId: string, timestamp: number, extra: Record<string, unknown> = {}) => ({
  actor: 'user',
  turnId,
  content: `ask ${turnId}`,
  timestamp,
  ...extra,
});
const unsaved = {
  actor: 'agent',
  turnId: 'a',
  content: 'DONE',
  output: 'DONE',
  timestamp: 3,
  terminalSource: 'response',
  storage: 'browser-only',
  meta: { executionOutcome: 'completed', persistence: 'failed' },
};

test('a stored row this tab lacks is kept, in thread order', () => {
  const mine = [user('b', 5), { actor: 'agent', turnId: 'b', content: 'B', timestamp: 6 }];
  const merged = mergeStoredMessages([user('a', 1), unsaved], mine);
  expect(merged.map((m: any) => `${m.actor}:${m.turnId}`)).toEqual([
    'user:a',
    'agent:a',
    'user:b',
    'agent:b',
  ]);
  expect(merged[1]).toBe(unsaved);
});

test("nothing stored that this tab already has returns this tab's array", () => {
  const legacy = { actor: 'user', content: 'legacy', timestamp: 0 };
  const mine = [{ ...legacy, storage: 'browser-only' }, user('a', 1), unsaved];
  expect(
    mergeStoredMessages(
      [legacy, user('a', 1), { ...unsaved, browserStorage: { status: 'saved' } }],
      mine,
    ),
  ).toBe(mine);
});

test('a server-saved copy wins over a plain browser copy of the same row', () => {
  const saved = {
    actor: 'agent',
    turnId: 'a',
    id: 'r',
    content: 'durable',
    timestamp: 3,
    storage: 'server',
  };
  const mine = [
    user('a', 1),
    {
      actor: 'agent',
      turnId: 'a',
      content: 'partial',
      timestamp: 2,
      connectionStatus: 'unconfirmed',
      storage: 'browser-only',
    },
  ];
  const row = mergeStoredMessages([user('a', 1), saved], mine)[1] as any;
  expect(row).toMatchObject({ id: 'r', content: 'durable', storage: 'server', streaming: false });
  expect(row.connectionStatus).toBeUndefined();
});

test('an unsaved completion reconciles with an interrupted server record instead of being replaced', () => {
  const interrupted = {
    actor: 'agent',
    turnId: 'a',
    id: 'r',
    content: 'Journal outcome unresolved',
    timestamp: 2,
    storage: 'server',
    meta: { turnStatus: 'interrupted', persistence: 'committed' },
  };
  for (const [stored, mine] of [
    [[unsaved], [interrupted]],
    [[interrupted], [unsaved]],
  ]) {
    const [row] = mergeStoredMessages(stored, mine) as any[];
    expect(row).toMatchObject({
      output: 'DONE',
      storage: 'browser-only',
      journalRecord: { meta: { turnStatus: 'interrupted' } },
    });
  }
});

test("between browser copies the evidence-bearing, then the newer, row wins; a tie keeps this tab's", () => {
  const watch = {
    actor: 'agent',
    turnId: 'a',
    content: 'DONE',
    timestamp: 9,
    terminalSource: 'watch',
    storage: 'browser-only',
    meta: { executionOutcome: 'completed', persistence: 'failed' },
  };
  expect(
    mergeStoredMessages([unsaved], [{ ...watch, meta: { executionOutcome: 'failed' } }])[0],
  ).toBe(unsaved);
  const older = { actor: 'agent', turnId: 'c', content: 'old', timestamp: 1 };
  const newer = { actor: 'agent', turnId: 'c', content: 'new', timestamp: 2 };
  expect(mergeStoredMessages([newer], [older])[0]).toBe(newer);
  expect(mergeStoredMessages([older], [newer])[0]).toBe(newer);
  const twin = { ...older, content: 'other tab' };
  expect(mergeStoredMessages([twin], [older])[0]).toBe(older);
});

test("this tab's running stream yields only to the sender's full terminal", () => {
  const streaming = { actor: 'agent', turnId: 'a', content: 'par', timestamp: 2, streaming: true };
  const saved = {
    actor: 'agent',
    turnId: 'a',
    id: 'r',
    content: 'durable',
    timestamp: 3,
    storage: 'server',
  };
  expect(mergeStoredMessages([saved], [streaming])[0]).toBe(streaming);
  expect(mergeStoredMessages([unsaved], [streaming])[0]).toBe(unsaved);
});

test('discarded rows leave both copies', () => {
  const dropped = [unsaved, { actor: 'user', content: 'legacy', timestamp: 0 }];
  const discarded = new Set(discardKeys(dropped));
  const merged = mergeStoredMessages(
    [
      user('a', 1),
      unsaved,
      { actor: 'user', content: 'legacy', timestamp: 0, storage: 'browser-only' },
    ],
    [user('a', 1), unsaved],
    discarded,
  );
  expect(merged.map((m: any) => `${m.actor}:${m.turnId}`)).toEqual(['user:a']);
});
