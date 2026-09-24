import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StreamBufferRegistry } from '../src/viewer/stream-buffer';
import { liveWatchFixture, until } from './helpers/live-watch-fixture';
// @ts-expect-error native browser module
import { terminalMessagePatch, updateTurnMessage, persistBrowserMessages, reconcileThreadMessages } from '../src/viewer/ui/conversation-state.js';
// @ts-expect-error native browser module
import { mergeLiveSnapshot, liveThreadStatus, liveWorkLabel } from '../src/viewer/ui/live-state.js';

test('actual cached-watch persistence order retains an empty full response and later native/RPC facts', () => {
  const r = new StreamBufferRegistry(), b = r.open('M', 'T', 'P');
  const owner = { threadId: 'T', projectId: 'P', messageId: 'M', dispatchId: 'D', generation: 'G', providerSessionKey: 'T' };
  const original = { schema: 1 as const, owner, admissionId: 'A', nativeOutcome: 'unknown' as const, rpcOutcome: 'pending' as const };
  b.register(original); b.append('old preview');
  const snapshot = () => ({ buffers: r.forThread('T') });
  let rows = mergeLiveSnapshot([], snapshot());
  const event = { type: 'done', output: '', meta: { executionOutcome: 'completed', persistence: 'failed', injection: { original: 'INPUT' } }, traceSnapshot: { original: 'TRACE' } };
  rows = updateTurnMessage(rows, 'M', terminalMessagePatch(event));
  let saved = '';
  rows = persistBrowserMessages(mergeLiveSnapshot(rows, snapshot()), (text: string) => saved = text);
  expect(rows[0].content).toBe('');
  expect(liveWorkLabel(rows[0])).toBe('Completed · persistence failed');
  expect(liveThreadStatus(rows)).toBe('unconfirmed');
  expect(JSON.parse(saved)[0].traceSnapshot).toEqual(event.traceSnapshot);
  b.observe({ ...original, kind: 'result', nativeOutcome: 'completed' });
  rows = mergeLiveSnapshot(rows, snapshot());
  expect(rows[0].live.native).toEqual({ outcome: 'completed', rpc: 'pending' });
  expect(liveThreadStatus(rows)).toBe('unconfirmed');
  b.observe({ ...original, kind: 'result', nativeOutcome: 'completed', rpcOutcome: 'resolved' });
  rows = mergeLiveSnapshot(rows, snapshot());
  expect(liveThreadStatus(rows)).toBeNull();
  expect(rows[0].content).toBe('');
  expect(rows[0].meta.injection).toEqual(event.meta.injection);
});

test('watch terminal does not claim a full response; rich sender evidence survives journal catch-up', () => {
  const r = new StreamBufferRegistry(), b = r.open('M', 'T');
  b.complete({ content: 'bounded', meta: { executionOutcome: 'completed', persistence: 'failed' } });
  let rows = mergeLiveSnapshot([], { buffers: r.forThread('T') });
  expect(rows[0].terminalSource).toBe('watch');
  const full = 'START' + 'x'.repeat(40000) + 'END';
  rows = updateTurnMessage(rows, 'M', terminalMessagePatch({ type: 'done', output: full, meta: { executionOutcome: 'completed', persistence: 'failed', injection: { original: 'INPUT' } }, traceSnapshot: { original: 'TRACE' } }));
  rows = reconcileThreadMessages(rows, [{ actor: 'agent', threadId: 'T', turnId: 'M', content: 'interrupted', meta: { turnStatus: 'interrupted', persistence: 'committed' } }], 'T');
  rows = mergeLiveSnapshot(rows, { buffers: r.forThread('T') });
  expect(rows[0].content).toBe(full);
  expect(rows[0].traceSnapshot).toEqual({ original: 'TRACE' });
  expect(rows[0].meta.injection).toEqual({ original: 'INPUT' });
  expect(rows[0].journalRecord.meta.turnStatus).toBe('interrupted');
  expect(rows[0].storage).toBe('browser-only');
});

test('transport-only disconnection is not a terminal and foreign thread cannot patch the sender', () => {
  const r = new StreamBufferRegistry(), b = r.open('M', 'T'); b.append('actual active');
  const lost = { actor: 'agent', turnId: 'M', threadId: 'T', content: 'partial', streaming: false, error: true, connectionStatus: 'unconfirmed' };
  const rows = mergeLiveSnapshot([lost], { buffers: r.forThread('T') });
  expect(liveThreadStatus(rows)).toBe('active');
  expect(rows[0].streaming).toBe(true);
  const foreign = { ...lost, threadId: 'other', ...terminalMessagePatch({ type: 'error', error: 'OWNED', meta: { executionOutcome: 'failed' } }) };
  expect(mergeLiveSnapshot([foreign], { buffers: r.forThread('T') })[0]).toEqual(foreign);
});

test('a durable lightweight index cannot erase full sender failure input or original trace', () => {
  const full = { actor: 'agent', turnId: 'M', threadId: 'T', ...terminalMessagePatch({ type: 'error', error: 'FAILED', trace: { original: 'TRACE' }, meta: { turnStatus: 'failed', persistence: 'committed', injection: { original: 'INPUT' }, nativeOutcome: 'unknown' } }) };
  const index = { actor: 'agent', turnId: 'M', threadId: 'T', content: 'FAILED', meta: { turnStatus: 'failed', persistence: 'committed', nativeOutcome: 'unknown' } };
  const merged = reconcileThreadMessages([full], [index], 'T');
  expect(merged[0].trace).toEqual(full.trace);
  expect(merged[0].meta.injection).toEqual(full.meta.injection);
  expect(merged[0].error).toBe(true);
});

test('production local rejection remains failed through exact late terminal and RPC settlement without replay', async () => {
  const dir = await mkdtemp(resolve('.foundry/qa/lw-terminal-provider-'));
  const f = await liveWatchFixture(dir);
  try {
    const turn = f.send('local');
    await until(() => f.attempts.length === 1, 'original admitted');
    const a = f.attempts[0]; a.rejectObservation();
    expect(JSON.stringify(await turn.done)).toContain('CONTROLLED_LOCAL_OBSERVATION_EXPIRED');
    expect((await f.snapshot()).turns[0]).toMatchObject({ status: 'failed', native: { outcome: 'unknown', rpc: 'pending' } });
    a.observeTerminal();
    expect((await f.snapshot()).turns[0]).toMatchObject({ status: 'failed', native: { outcome: 'completed', rpc: 'pending' } });
    expect(f.exits).toHaveLength(0);
    a.finish();
    expect((await f.snapshot()).turns[0]).toMatchObject({ status: 'failed', native: { outcome: 'completed', rpc: 'resolved' } });
    expect(f.attempts).toHaveLength(1);
    expect(a.native.localOutcome).toBe('rejected');
  } finally { await f.close(); console.log(`Retained provider lifecycle: ${dir}`); }
});
