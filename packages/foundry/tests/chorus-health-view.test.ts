import { expect, test } from 'bun:test';
import { chorusNotice, lastDegraded, wardenLine } from '../src/viewer/ui/chorus-health.js';
import { mergeMessageHistory } from '../src/viewer/ui/conversation-state.js';

// FEAT-008, the viewer side: what the thread says about a degraded chorus, and that the turn's chorus
// health always comes from the journal, so a retry or dismissal reaches a tab that already holds the turn.

const timeout = { domain: 'security', kind: 'timeout', layer: 1, silent: true, reason: 'late' };
const unconfirmed = { domain: 'locks', kind: 'timeout', layer: 2, silent: false, reason: 'late' };

test('an open notice names each Warden, its layer and the moment; the turn went on without them', () => {
  expect(wardenLine(timeout)).toBe('security (Layer 1 timed out)');
  expect(wardenLine(unconfirmed)).toBe(
    'locks (Layer 2 timed out; spoke from Layer 1 only, unconfirmed)',
  );
  expect(
    chorusNotice({
      notices: [
        { rowId: 'a', trigger: 'user-message', degraded: [timeout], retriedBy: null },
        { rowId: 'g', trigger: 'agent-action', degraded: [unconfirmed], retriedBy: null },
      ],
      open: ['a', 'g'],
    }),
  ).toEqual({
    state: 'open',
    count: 2,
    text: "The chorus was degraded on this turn: on the message security (Layer 1 timed out); on the turn's actions locks (Layer 2 timed out; spoke from Layer 1 only, unconfirmed). The turn went on without them.",
  });
});

test('asked again reads as retried; dismissed or never degraded shows nothing', () => {
  const retried = {
    notices: [{ rowId: 'a', trigger: 'user-message', degraded: [timeout], retriedBy: 'b' }],
    open: [],
  };
  expect(chorusNotice(retried)?.state).toBe('retried');
  expect(
    chorusNotice({
      notices: [{ rowId: 'a', trigger: 'user-message', degraded: [timeout], retriedBy: null }],
      open: [],
    }),
  ).toBeNull();
  expect(chorusNotice(undefined)).toBeNull();
});

test("the context bar follows the newest turn's chorus only", () => {
  const open = {
    notices: [{ rowId: 'a', trigger: 'user-message', degraded: [timeout] }],
    open: ['a'],
  };
  const messages = [
    { actor: 'agent', turnId: 't1', chorus: open },
    { actor: 'user', turnId: 't2' },
    { actor: 'agent', turnId: 't2' },
  ];
  expect(lastDegraded(messages)?.turnId).toBe('t1');
  expect(
    lastDegraded([
      ...messages,
      { actor: 'agent', turnId: 't3', chorus: { notices: [], open: [] } },
    ]),
  ).toBeNull();
});

test("a turn's chorus is the journal's: a later index row replaces what this tab's own response held", () => {
  const open = { notices: [{ rowId: 'a', degraded: [timeout] }], open: ['a'] };
  const local = [
    {
      actor: 'agent',
      turnId: 't',
      id: 'r',
      content: 'done',
      terminalSource: 'response',
      chorus: open,
    },
  ];
  const resolved = { notices: [{ rowId: 'a', degraded: [timeout], retriedBy: 'b' }], open: [] };
  const merged = mergeMessageHistory(local, [
    { actor: 'agent', turnId: 't', id: 'r', content: 'done', chorus: resolved },
  ]);
  expect(merged[0].chorus).toEqual(resolved);
});
