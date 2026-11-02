import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  EventStream,
  Executor,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
import { Hono } from 'hono';
import {
  LocalSessionStore,
  NATIVE_OUTCOME_UNRESOLVED,
} from '../src/persistence/local-session-store';
import {
  locateNativeRecord,
  NATIVE_TOOL_QUIET_MS,
  NativeOutcomeRecovery,
  readClaudeTranscript,
  readCodexRollout,
} from '../src/turns/native-outcome-recovery';
import { ConfigStore } from '../src/viewer/config';
import { registerRuntimeRoutes } from '../src/viewer/routes/runtime';
import { withStreams } from './helpers/data-stream';

// A daemon restart mid-turn (the auto-updater, 2026-11-02) left a thread refusing every message with
// "Previous native outcome unresolved". The lost turn is settled from the native session's own
// record before the next admission; what that record can't settle goes to the owner.

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const QUIET = 2 * 60_000;
const SESSION = '5b3f8cd8-efdc-4b71-a133-3daf16a89eb4';
const at = (ms: number) => new Date(ms).toISOString();
const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
const user = (ms: number, content: unknown = 'do it') => ({
  type: 'user',
  timestamp: at(ms),
  message: { role: 'user', content },
});
const assistant = (ms: number, stop: string, type = 'text') => ({
  type: 'assistant',
  timestamp: at(ms),
  message: { role: 'assistant', stop_reason: stop, content: [{ type }] },
});
const toolResult = (ms: number) => user(ms, [{ type: 'tool_result', content: 'ok' }]);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'native-recovery-'));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const store = new LocalSessionStore(join(dir, 'sessions.sqlite'));
  cleanup.push(() => store.close());
  const thread = new Thread('thread-lost', new ContextStack(), { projectId: 'P' });
  const home = join(dir, 'claude-home');
  mkdirSync(join(home, 'projects', '-Users-me-repo'), { recursive: true });
  return { dir, store, thread, home };
}

/** A turn admitted to the native session, then cut off by a restart (`recoverInterrupted`). */
function lostTurn(store: LocalSessionStore, thread: Thread, turnId = 'turn-lost') {
  store.beginTurn(thread, turnId, 'please load more projects');
  const owner = {
    threadId: thread.id,
    projectId: thread.meta.projectId,
    messageId: turnId,
    generation: 'g',
    dispatchId: 'd',
    providerSessionKey: thread.id,
  };
  store.registerNative(thread, {
    schema: 1,
    admissionId: `adm-${turnId}`,
    nativeOutcome: 'unknown',
    owner,
  });
  store.appendNative(thread, {
    schema: 1,
    admissionId: `adm-${turnId}`,
    nativeOutcome: 'unknown',
    owner,
    nativeSessionId: SESSION,
    kind: 'tool_use',
  });
  store.recoverInterrupted();
  return owner;
}

const nextOwner = (thread: Thread, turnId: string) => ({
  threadId: thread.id,
  projectId: thread.meta.projectId,
  messageId: turnId,
  generation: 'g2',
  dispatchId: 'd2',
  providerSessionKey: thread.id,
});

test('Claude transcript: end_turn after the admission is completed; a dangling tool result is interrupted once quiet', () => {
  const t = 1_000_000;
  const done = jsonl([
    user(t - 60_000),
    assistant(t - 50_000, 'end_turn'),
    user(t + 10),
    assistant(t + 20, 'tool_use', 'tool_use'),
    toolResult(t + 30),
    assistant(t + 40, 'end_turn'),
    { type: 'last-prompt' },
  ]);
  expect(readClaudeTranscript(done, t, 0).outcome).toBe('completed');
  const cut = jsonl([user(t + 10), assistant(t + 20, 'tool_use', 'tool_use'), toolResult(t + 30)]);
  expect(readClaudeTranscript(cut, t, 0).outcome).toBe('undecided');
  expect(readClaudeTranscript(cut, t, QUIET).outcome).toBe('interrupted');
  // The previous turn's end_turn says nothing about this one: the message never arrived.
  const never = jsonl([user(t - 60_000), assistant(t - 50_000, 'end_turn')]);
  expect(readClaudeTranscript(never, t, QUIET)).toMatchObject({
    outcome: 'interrupted',
    detail: 'the message never reached the native session',
  });
  expect(readClaudeTranscript(`${cut}{"type":"assist`, t, QUIET).outcome).toBe('interrupted');
});

test("Claude transcript: only this turn's own prompt opens it; a tool call with no result waits longer; sidechains don't count", () => {
  const t = 1_000_000;
  // The previous turn ended a moment before this one was admitted: a tool result and end_turn
  // stamped just around the admission are not this turn's answer.
  const previous = jsonl([user(t - 5_000), toolResult(t - 400), assistant(t - 300, 'end_turn')]);
  expect(readClaudeTranscript(previous, t, QUIET)).toMatchObject({
    outcome: 'interrupted',
    neverReached: true,
  });
  // A long command or a subagent: the tool call has no result yet.
  const running = jsonl([user(t + 10), assistant(t + 20, 'tool_use', 'tool_use')]);
  expect(readClaudeTranscript(running, t, QUIET).outcome).toBe('undecided');
  expect(readClaudeTranscript(running, t, NATIVE_TOOL_QUIET_MS).outcome).toBe('interrupted');
  const sidechain = jsonl([
    user(t + 10),
    toolResult(t + 20),
    { ...assistant(t + 30, 'end_turn'), isSidechain: true },
  ]);
  expect(readClaudeTranscript(sidechain, t, QUIET).outcome).toBe('interrupted');
});

test("Codex rollout: a terminal before this turn's task_started is the previous turn's", () => {
  const t = 2_000_000;
  const rows = jsonl([
    { type: 'event_msg', timestamp: at(t + 5), payload: { type: 'task_complete' } },
  ]);
  expect(readCodexRollout(rows, t, QUIET)).toMatchObject({
    outcome: 'interrupted',
    neverReached: true,
  });
});

test('Codex rollout: the last task event after the admission decides', () => {
  const t = 2_000_000;
  const event = (ms: number, type: string) => ({
    type: 'event_msg',
    timestamp: at(ms),
    payload: { type },
  });
  const rows = (...types: string[]) => jsonl(types.map((type, i) => event(t + 10 + i, type)));
  expect(readCodexRollout(rows('task_started', 'task_complete'), t, 0).outcome).toBe('completed');
  expect(readCodexRollout(rows('task_started', 'turn_aborted'), t, 0).outcome).toBe('interrupted');
  expect(readCodexRollout(rows('task_started'), t, 0).outcome).toBe('undecided');
  expect(readCodexRollout(rows('task_started'), t, QUIET).outcome).toBe('interrupted');
});

test('the native record is found in any profile home, Claude project or Codex date shard', () => {
  const { home, dir } = setup();
  const transcript = join(home, 'projects', '-Users-me-repo', `${SESSION}.jsonl`);
  writeFileSync(transcript, '');
  const codexHome = join(dir, 'codex-home');
  mkdirSync(join(codexHome, 'sessions', '2026', '11', '02'), { recursive: true });
  const rollout = join(
    codexHome,
    'sessions',
    '2026',
    '11',
    '02',
    'rollout-2026-11-02T20-02-33-cx1.jsonl',
  );
  writeFileSync(rollout, '');
  expect(locateNativeRecord(SESSION, [join(dir, 'missing'), home])).toEqual({
    kind: 'claude',
    path: transcript,
  });
  expect(locateNativeRecord('cx1', [home, codexHome])).toEqual({ kind: 'codex', path: rollout });
  expect(locateNativeRecord('../etc', [home])).toBeUndefined();
});

test('a turn lost to a restart is settled from its transcript, and the next admission goes through', () => {
  const { store, thread, home } = setup();
  lostTurn(store, thread);
  const transcript = join(home, 'projects', '-Users-me-repo', `${SESSION}.jsonl`);
  const admitted = store.unsettledAdmissions(thread.id)[0]!.admittedAt;
  writeFileSync(
    transcript,
    jsonl([
      user(admitted + 10),
      assistant(admitted + 20, 'tool_use', 'tool_use'),
      toolResult(admitted + 30),
    ]),
  );
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(transcript, old, old);

  // Before: the guard refuses the next turn, now with words the owner can act on.
  store.beginTurn(thread, 'turn-next', 'why?');
  expect(() => store.assertNativeCapacity(thread, nextOwner(thread, 'turn-next'))).toThrow(
    NATIVE_OUTCOME_UNRESOLVED,
  );

  const recovery = new NativeOutcomeRecovery({
    store,
    homes: () => [home],
    bootedAt: Date.now() + 1,
  });
  expect(recovery.settle(thread.id)).toEqual({
    settled: [{ turnId: 'turn-lost', outcome: 'interrupted' }],
    undecided: [],
  });
  expect(store.unsettledAdmissions(thread.id)).toEqual([]);
  expect(() => store.assertNativeCapacity(thread, nextOwner(thread, 'turn-next'))).not.toThrow();
  // The lost turn's answer says how it was settled.
  const lost = store
    .messageIndex(thread.id)
    .messages.find((m) => m.turnId === 'turn-lost' && m.actor === 'agent');
  expect(lost?.meta).toMatchObject({ recovery: 'interrupted', nativeOutcome: 'failed' });
  // Settling again is a no-op.
  expect(recovery.settle(thread.id).settled).toEqual([]);
});

test('a transcript still being written stays unsettled; settleAll finds every thread once it is quiet', () => {
  const { store, thread, home } = setup();
  lostTurn(store, thread);
  const transcript = join(home, 'projects', '-Users-me-repo', `${SESSION}.jsonl`);
  const admitted = store.unsettledAdmissions(thread.id)[0]!.admittedAt;
  writeFileSync(transcript, jsonl([user(admitted + 10), toolResult(admitted + 30)]));
  let now = Date.now();
  const recovery = new NativeOutcomeRecovery({
    store,
    homes: () => [home],
    bootedAt: Date.now() + 1,
    now: () => now,
  });
  expect(recovery.settleAll()).toMatchObject({
    settled: [],
    undecided: [{ turnId: 'turn-lost', detail: 'the native session may still be working' }],
  });
  // An orphaned native process finished the turn while Foundry was down.
  writeFileSync(
    transcript,
    jsonl([user(admitted + 10), toolResult(admitted + 30), assistant(admitted + 40, 'end_turn')]),
  );
  expect(recovery.settleAll().settled).toEqual([{ turnId: 'turn-lost', outcome: 'completed' }]);
  now += 1;
  expect(store.threadsWithUnknownAdmissions()).toEqual([]);
});

test('no record anywhere: the latest answer carries Continue / Retry, and the owner settles it', () => {
  const { store, thread, home } = setup();
  lostTurn(store, thread);
  const recovery = new NativeOutcomeRecovery({
    store,
    homes: () => [home],
    bootedAt: Date.now() + 1,
  });
  expect(recovery.settle(thread.id).undecided).toEqual([
    { turnId: 'turn-lost', detail: "the native session's record was not found on this machine" },
  ]);
  const index = store.messageIndex(thread.id).messages;
  expect(index.at(-1)?.meta?.recovery).toBe('pending');
  // An older page never carries the card.
  expect(
    store.messageIndex(thread.id, { before: index.at(-1)!.seq + 1 }).messages.at(-1)?.meta
      ?.recovery,
  ).toBeUndefined();
  expect(recovery.resolveByOwner(thread.id, 'continue')).toHaveLength(1);
  expect(store.unsettledAdmissions(thread.id)).toEqual([]);
  expect(store.messageIndex(thread.id).messages.at(-1)?.meta).toMatchObject({
    recovery: 'continued',
  });
  expect(recovery.resolveByOwner(thread.id, 'continue')).toEqual([]);
});

test('the external-session binding names the session when the turn died before any native event', () => {
  const { store, thread, home } = setup();
  store.beginTurn(thread, 'turn-early', 'start');
  store.registerNative(thread, {
    schema: 1,
    admissionId: 'adm-early',
    nativeOutcome: 'unknown',
    owner: nextOwner(thread, 'turn-early'),
  });
  store.recoverInterrupted();
  const transcript = join(home, 'projects', '-Users-me-repo', `${SESSION}.jsonl`);
  // A bound session with no sign of this turn says nothing; one holding its prompt settles it.
  writeFileSync(transcript, jsonl([user(1), assistant(2, 'end_turn')]));
  const stale = (Date.now() - 120_000) / 1000;
  utimesSync(transcript, stale, stale);
  const unbound = new NativeOutcomeRecovery({
    store,
    homes: () => [home],
    bootedAt: Date.now() + 1,
    boundSessions: () => [SESSION],
  });
  expect(unbound.settle(thread.id).undecided).toHaveLength(1);
  const admitted = store.unsettledAdmissions(thread.id)[0]!.admittedAt;
  writeFileSync(
    transcript,
    jsonl([user(1), assistant(2, 'end_turn'), user(admitted + 10), toolResult(admitted + 20)]),
  );
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(transcript, old, old);
  const recovery = new NativeOutcomeRecovery({
    store,
    homes: () => [home],
    bootedAt: Date.now() + 1,
    boundSessions: (threadId) => (threadId === thread.id ? [SESSION] : []),
  });
  expect(recovery.settle(thread.id).settled).toEqual([
    { turnId: 'turn-early', outcome: 'interrupted' },
  ]);
});

test('routes: GET says whether a message can be admitted; Continue opens it, Retry sends the lost message again', async () => {
  const { dir, store, home } = setup();
  const main = new Thread('main', new ContextStack(), { projectId: 'P' });
  const ran: string[] = [];
  main.register(
    new Executor({
      id: 'worker',
      stack: main.stack,
      handler: async (_context, payload) => {
        ran.push(String(payload));
        return 'ok';
      },
    }),
  );
  const harness = new Harness(main);
  harness.setDefaultExecutor('worker');
  store.saveThread(main);
  lostTurn(store, main);
  const app = new Hono();
  registerRuntimeRoutes(
    app,
    withStreams({
      harness,
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      configStore: new ConfigStore(dir),
      localStore: store,
      nativeRecovery: new NativeOutcomeRecovery({
        store,
        homes: () => [home],
        bootedAt: Date.now() + 1,
      }),
    }),
  );
  const state = async () => (await app.request('/api/threads/main/recovery')).json();
  expect(await state()).toMatchObject({
    admissionAllowed: false,
    unsettled: [{ turnId: 'turn-lost', nativeSessionId: SESSION }],
  });
  const post = (action: string) =>
    app.request('/api/threads/main/recovery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
  expect((await post('nope')).status).toBe(400);
  const retried = await post('retry');
  expect(retried.status).toBe(200);
  const body = (await retried.json()) as { resolved: number; retried: { id: string } };
  expect(body.resolved).toBe(1);
  expect(await state()).toMatchObject({ admissionAllowed: true, unsettled: [] });
  for (let i = 0; i < 100 && store.turn(body.retried.id)?.status !== 'completed'; i++)
    await Bun.sleep(10);
  expect(store.turn(body.retried.id)?.status).toBe('completed');
  expect(ran).toEqual(['please load more projects']);
  // Nothing left to resolve.
  expect(await (await post('continue')).json()).toEqual({ resolved: 0 });
});

test("an admission of this Foundry run is live, not lost; a subagent's writes keep the session awake", () => {
  const { store, thread, home } = setup();
  lostTurn(store, thread);
  const transcript = join(home, 'projects', '-Users-me-repo', `${SESSION}.jsonl`);
  const admitted = store.unsettledAdmissions(thread.id)[0]!.admittedAt;
  writeFileSync(transcript, jsonl([user(admitted + 10), toolResult(admitted + 30)]));
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(transcript, old, old);
  // Booted before the admission: this run owns it.
  expect(
    new NativeOutcomeRecovery({ store, homes: () => [home], bootedAt: admitted }).settle(thread.id),
  ).toEqual({ settled: [], undecided: [] });
  // A subagent still writing beside the transcript.
  const subagents = join(home, 'projects', '-Users-me-repo', SESSION, 'subagents');
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(subagents, 'agent-1.jsonl'), '{}\n');
  const recovery = new NativeOutcomeRecovery({
    store,
    homes: () => [home],
    bootedAt: Date.now() + 1,
  });
  expect(recovery.settle(thread.id).undecided).toHaveLength(1);
  utimesSync(join(subagents, 'agent-1.jsonl'), old, old);
  expect(recovery.settle(thread.id).settled).toEqual([
    { turnId: 'turn-lost', outcome: 'interrupted' },
  ]);
});

test("a decision session's lost admission is settled without touching the turn's answer", () => {
  const { store, thread, home } = setup();
  store.beginTurn(thread, 'turn-aux', 'route this');
  store.registerNative(thread, {
    schema: 1,
    admissionId: 'adm-aux',
    nativeOutcome: 'unknown',
    owner: { ...nextOwner(thread, 'turn-aux'), providerSessionKey: `${thread.id}:aux:route` },
  });
  store.recoverInterrupted();
  const recovery = new NativeOutcomeRecovery({
    store,
    homes: () => [home],
    bootedAt: Date.now() + 1,
  });
  expect(store.messageIndex(thread.id).messages.at(-1)?.meta?.recovery).toBeUndefined();
  expect(recovery.resolveByOwner(thread.id, 'continue')).toHaveLength(1);
  expect(store.unsettledAdmissions(thread.id)).toEqual([]);
  expect(store.messageIndex(thread.id).messages.at(-1)?.meta?.recovery).toBeUndefined();
});
