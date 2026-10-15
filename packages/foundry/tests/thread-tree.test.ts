// Spec A (docs/THREAD-TREE.md): a thread is a tree, stitched into Archive by Foundry.
import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { EventStream, type NativeEvidence, type ThreadMeta } from '@inixiative/foundry-core';
import { ArchiveCapture, captureThread } from '../src/archives/capture';
import { REDUCED_PHASE } from '../src/archives/reduced-middleware';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { SubagentRecorder } from '../src/turns/subagents';
import { startFakeArchive } from './helpers/fake-archive';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});

const main = (id = 'main') => ({
  id,
  meta: {
    description: 'Main thread',
    projectId: 'project-a',
    tags: [],
    status: 'active' as const,
    createdAt: 1,
    lastActiveAt: 1,
  } satisfies ThreadMeta,
});

function journal() {
  const store = new LocalSessionStore(':memory:');
  cleanup.push(() => store.close());
  return store;
}

/** Composed text large enough to be stored by reference in the journal's content store. */
const BULK = 'SEGMENT TEXT '.repeat(200);

const supplied = (served: object, versions?: object) => ({
  status: 'supplied',
  phase: 'advice',
  providerId: 'decisions',
  messages: [{ role: 'system', content: 'THE COMPOSED INSTRUCTIONS THE WARDEN WAS SENT' }],
  capturedAt: 1,
  served,
  ...(versions ? { versions } : {}),
});

/** A turn with routing and four Wardens: three NO_COMMENT, one that chimed in. */
function turnWithWardens(store: LocalSessionStore, t: ReturnType<typeof main>, turnId: string) {
  store.beginTurn(t, turnId, 'Rename the public settings key');
  store.startTurn(t, turnId);
  store.appendPhase(t, {
    id: `route-${turnId}`,
    turnId,
    dispatchId: 'd',
    phase: 'route',
    record: {
      routing: {
        status: 'routed',
        layers: ['conventions'],
        request: supplied({ model: 'claude-haiku-5-5' }),
      },
    },
  });
  store.appendPhase(t, {
    id: `advice-${turnId}`,
    turnId,
    dispatchId: 'd',
    phase: 'advice',
    record: {
      trigger: 'user-message',
      charter: 'charter-abc',
      participants: [
        ...['docs', 'testing', 'security'].map((domain) => ({
          domain,
          decision: 'no-comment',
          snippets: [],
          segments: {
            instructions: BULK,
            domainKnowledge: BULK,
            threadKnowledge: '',
          },
          request: supplied(
            { model: 'claude-haiku-5-5' },
            { instructions: 'cv_i', domainKnowledge: 'cv_d' },
          ),
          threadKnowledgeRevision: 2,
        })),
        {
          domain: 'conventions',
          decision: 'contribute',
          snippets: ['Never rename public settings keys (fb_1).'],
          segments: {
            instructions: BULK,
            domainKnowledge: BULK,
            threadKnowledge: '',
          },
          request: supplied(
            { model: 'claude-haiku-5-5', effort: 'low' },
            { instructions: 'cv_i', domainKnowledge: 'cv_d' },
          ),
          threadKnowledgeRevision: 3,
        },
      ],
    },
  });
}

const trace = (turnId: string) => ({
  id: `trace-${turnId}`,
  messageId: turnId,
  startedAt: 1,
  root: {},
  summary: {},
  spans: [],
});

test('each Warden call reaches Archive as a small reduced entry: state and result, never its input', () => {
  const store = journal();
  const t = main();
  store.saveThread(t);
  turnWithWardens(store, t, 'turn-1');
  // Before the turn ends nothing is reduced, and capture holds no middleware entry for it.
  expect(store.phaseHistory(t.id).some((p) => p.phase === REDUCED_PHASE)).toBe(false);
  expect(
    captureThread(store, crypto.randomUUID(), t.id).entries.some((e) => e.id.startsWith('mw:')),
  ).toBe(false);
  store.completeTurn(t, 'turn-1', 'Done', {}, trace('turn-1'));

  // Raw rows are kept (and still verify); one reduced row per call is appended.
  const phases = store.phaseHistory(t.id);
  expect(phases.filter((p) => p.phase === 'advice')).toHaveLength(1);
  const reduced = phases.filter((p) => p.phase === REDUCED_PHASE);
  expect(reduced).toHaveLength(5);

  const snapshot = captureThread(store, crypto.randomUUID(), t.id);
  const mw = snapshot.entries.filter((e) => e.id.startsWith('mw:'));
  expect(mw).toHaveLength(5);
  expect(snapshot.entries.some((e) => e.sourceRef.startsWith('phase:advice'))).toBe(false);
  for (const entry of mw) {
    expect(entry.text.length).toBeLessThan(2_000);
    expect(entry.text).not.toContain('COMPOSED INSTRUCTIONS');
    expect(entry.text).not.toContain('SEGMENT TEXT');
    expect(entry.text).not.toContain('"messages"');
  }
  const byRole = Object.fromEntries(mw.map((e) => [JSON.parse(e.text).role, JSON.parse(e.text)]));
  expect(byRole.conventions).toMatchObject({
    decision: 'contribute',
    result: ['Never rename public settings keys (fb_1).'],
    state: {
      charter: 'charter-abc',
      versions: { instructions: 'cv_i', domainKnowledge: 'cv_d' },
      threadKnowledgeRevision: 3,
    },
  });
  // NO_COMMENT is recorded: it is the denominator of every exposure count.
  expect(byRole.docs).toMatchObject({ decision: 'no-comment', result: null });
  expect(byRole.cartographer).toMatchObject({
    decision: 'routed',
    result: { layers: ['conventions'] },
  });
  expect(mw.find((e) => JSON.parse(e.text).role === 'conventions')).toMatchObject({
    model: 'claude-haiku-5-5',
    effort: 'low',
  });
  // Re-capturing is stable.
  const again = captureThread(store, snapshot.sourceId, t.id);
  expect(again.entries.map((e) => e.id)).toEqual(snapshot.entries.map((e) => e.id));
});

test('a turn a restart interrupted is reduced on start, its raw rows kept', () => {
  const store = journal();
  const t = main();
  store.saveThread(t);
  turnWithWardens(store, t, 'turn-1');
  expect(store.recoverInterrupted()).toMatchObject({ interrupted: 1 });
  expect(store.compactClosedTurns()).toBe(5);
  expect(store.compactClosedTurns()).toBe(0);
  const phases = store.phaseHistory(t.id).map((p) => p.phase);
  expect(phases.filter((p) => p === REDUCED_PHASE)).toHaveLength(5);
  expect(phases).toContain('advice');
});

test('raw middleware rows age out after the retention window; reduced rows and exposure remain', () => {
  const store = journal();
  const t = main();
  store.saveThread(t);
  turnWithWardens(store, t, 'turn-1');
  store.completeTurn(t, 'turn-1', 'Done', {}, trace('turn-1'));
  // A composition version holding the rule (spec B), named by the Warden calls above.
  store.compositionVersion('conventions', 'instructions', {
    parts: [{ sv: 'sv1', text: store.putContent('- Never rename public settings keys (fb_1)') }],
    omitted: [],
  });
  const cv = (store as unknown as { query(sql: string): { get(): { id: string } } })
    .query('SELECT id FROM composition_version')
    .get().id;
  store.appendPhase(t, {
    id: 'advice-cv',
    turnId: 'turn-1',
    dispatchId: 'd',
    phase: 'advice',
    record: {
      participants: [
        {
          domain: 'conventions',
          decision: 'no-comment',
          snippets: [],
          request: supplied(
            { model: 'claude-haiku-5-5' },
            { instructions: cv, domainKnowledge: 'cv_d' },
          ),
        },
      ],
    },
  });
  store.compactClosedTurns();
  const before = store.phasesContaining('(fb_1)', 0);
  expect(before.map((r) => r.phase)).toEqual(['advice']);

  // Inside the window nothing is pruned.
  expect(store.pruneRawMiddleware(Date.now() - 86_400_000).rows).toBe(0);
  // Past it, the raw rows go, the reduced rows stay, and the content only they held is released.
  const pruned = store.pruneRawMiddleware(Date.now() + 1);
  expect(pruned.rows).toBe(3);
  expect(pruned.content).toBeGreaterThan(0);
  const phases = store.phaseHistory(t.id).map((p) => p.phase);
  expect(phases.some((p) => p === 'advice' || p === 'route')).toBe(false);
  expect(phases.filter((p) => p === REDUCED_PHASE)).toHaveLength(6);
  // Exposure is still counted, once, from the reduced row.
  expect(store.phasesContaining('(fb_1)', 0).map((r) => [r.phase, r.roles])).toEqual([
    [REDUCED_PHASE, ['conventions']],
  ]);
  // The composition version's text survives the sweep.
  expect(store.compositionsHolding('(fb_1)').has(cv)).toBe(true);
});

function recorder(store: LocalSessionStore) {
  const adopted: string[] = [];
  const events = new EventStream();
  const r = new SubagentRecorder({
    store,
    thread: (id) => store.threads().find((t) => t.id === id),
    adopt: (child) => adopted.push(child.id),
    events,
  });
  return { r, adopted, events };
}

const life = (
  subagent: NonNullable<NativeEvidence['subagent']>,
  extra: Partial<NativeEvidence> = {},
): NativeEvidence => ({
  schema: 1,
  nativeOutcome: 'unknown',
  kind: 'subagent',
  subagent,
  ...extra,
});
const childEvent = (parentToolUseId: string, extra: Partial<NativeEvidence>): NativeEvidence => ({
  schema: 1,
  nativeOutcome: 'unknown',
  parentToolUseId,
  ...extra,
});

test('subagents to any depth become child threads tied to their real parent, stitched with lineage', () => {
  const store = journal();
  const t = main();
  store.saveThread(t);
  store.beginTurn(t, 'turn-1', 'Explore and fix');
  store.startTurn(t, 'turn-1');
  const { r, adopted } = recorder(store);
  // The main thread spawns A; A spawns B.
  r.observe(
    t.id,
    life({
      phase: 'started',
      taskId: 'task-a',
      toolUseId: 'call-a',
      agentType: 'explorer',
      description: 'look around',
      prompt: 'Find the settings',
      depth: 1,
    }),
  );
  r.observe(t.id, childEvent('call-a', { kind: 'tool_use', toolName: 'Agent', callId: 'call-b' }));
  r.observe(
    t.id,
    life({
      phase: 'started',
      taskId: 'task-b',
      toolUseId: 'call-b',
      agentType: 'reviewer',
      prompt: 'Check the rename',
      depth: 2,
    }),
  );
  r.observe(t.id, childEvent('call-b', { kind: 'text', text: 'B FOUND IT' }));
  r.observe(
    t.id,
    life({ phase: 'ended', taskId: 'task-b', toolUseId: 'call-b', status: 'completed' }),
  );
  r.observe(t.id, childEvent('call-a', { kind: 'text', text: 'A DONE' }));
  r.observe(
    t.id,
    life({
      phase: 'ended',
      taskId: 'task-a',
      toolUseId: 'call-a',
      status: 'completed',
      usage: { totalTokens: 1711 },
    }),
  );
  expect(adopted).toHaveLength(2);
  const threads = store.threads();
  const a = threads.find((x) => x.meta.spawn?.nativeTaskId === 'task-a')!;
  const b = threads.find((x) => x.meta.spawn?.nativeTaskId === 'task-b')!;
  expect(a.meta).toMatchObject({
    parentThreadId: t.id,
    parentTurnId: 'turn-1',
    depth: 1,
    spawn: { via: 'native-claude', toolCallId: 'call-a', observed: true },
  });
  // B's parent is A, not the root.
  expect(b.meta).toMatchObject({ parentThreadId: a.id, depth: 2 });

  // The parent journals the handoff and its return; the child holds its own activity.
  const parentPhases = store.phaseHistory(t.id).map((p) => p.phase);
  expect(parentPhases).toEqual(['handoff', 'handoff-return']);
  const handoff = store.phaseHistory(t.id)[0]!.record;
  expect(handoff).toMatchObject({
    childThreadId: a.id,
    composition: null,
    observed: true,
    task: { excerpt: 'Find the settings' },
  });
  expect(store.phaseHistory(t.id)[1]!.record).toMatchObject({
    outcome: 'completed',
    text: { excerpt: 'A DONE' },
    usage: { totalTokens: 1711 },
  });

  const snapA = captureThread(store, crypto.randomUUID(), a.id);
  const snapB = captureThread(store, snapA.sourceId, b.id);
  expect(snapB.lineage).toMatchObject({
    kind: 'subagent',
    parentSessionId: a.id,
    rootSessionId: t.id,
    parentEntryId: `phase:${a.meta.spawn ? b.meta.spawn!.handoffId : ''}`,
    toolUseId: 'call-b',
    agentType: 'reviewer',
    depth: 2,
  });
  expect(snapA.lineage).toMatchObject({ parentSessionId: t.id, rootSessionId: t.id });
  // The root carries no lineage; its snapshot never holds the children's text.
  const root = captureThread(store, snapA.sourceId, t.id);
  expect(root.lineage).toBeUndefined();
  expect(JSON.stringify(root.entries)).not.toContain('B FOUND IT');
  expect(JSON.stringify(snapB.entries)).toContain('B FOUND IT');
  expect(snapB.entries.find((e) => e.kind === 'user')?.text).toBe('Check the rename');
  expect(
    snapB.entries.find((e) => e.kind === 'assistant' && e.text === 'B FOUND IT'),
  ).toBeDefined();
});

test('a Codex sub-agent is its own thread, claimed by its own id; a later child turn opens a new turn', () => {
  const store = journal();
  const t = main();
  store.saveThread(t);
  const { r } = recorder(store);
  r.observe(
    t.id,
    life(
      {
        phase: 'started',
        taskId: 'codex-child',
        toolUseId: 'spawn-1',
        agentType: 'spawnAgent',
        prompt: 'You are Warden 0.',
      },
      { threadId: 'codex-child' },
    ),
  );
  r.observe(t.id, childEvent('spawn-1', { kind: 'text', text: 'READY', threadId: 'codex-child' }));
  r.observe(
    t.id,
    life(
      { phase: 'updated', taskId: 'codex-child', toolUseId: 'spawn-1', status: 'completed' },
      { threadId: 'codex-child', parentToolUseId: 'spawn-1' },
    ),
  );
  r.observe(
    t.id,
    childEvent('spawn-1', { kind: 'text', text: 'NO_COMMENT', threadId: 'codex-child' }),
  );
  r.observe(
    t.id,
    life({ phase: 'ended', taskId: 'codex-child', toolUseId: 'spawn-1', status: 'closed' }),
  );
  const child = store.threads().find((x) => x.meta.spawn?.nativeTaskId === 'codex-child')!;
  expect(child.meta.spawn?.via).toBe('native-codex');
  const snapshot = captureThread(store, crypto.randomUUID(), child.id);
  expect(snapshot.entries.filter((e) => e.kind === 'assistant').map((e) => e.text)).toEqual(
    expect.arrayContaining(['READY', 'NO_COMMENT']),
  );
});

test('Foundry claims the native sessions it drives while it writes them, and fulfils them with what it wrote', async () => {
  const store = journal();
  const archive = startFakeArchive();
  cleanup.push(() => archive.stop());
  const t = main();
  store.saveThread(t);
  store.beginTurn(t, 'turn-1', 'Hello');
  const executor = {
    schema: 1 as const,
    admissionId: 'executor',
    nativeOutcome: 'unknown' as const,
    externalSessionId: 'claude-session-1',
    owner: {
      threadId: t.id,
      projectId: 'project-a',
      messageId: 'turn-1',
      generation: 'g',
      dispatchId: 'd',
    },
  };
  store.registerNative(t, executor);
  // A Codex sub-agent observed under the same thread.
  const { r } = recorder(store);
  r.observe(
    t.id,
    life(
      { phase: 'started', taskId: 'codex-child', toolUseId: 'spawn-1' },
      { threadId: 'codex-child' },
    ),
  );
  const capture = new ArchiveCapture(store, () => archive.client(), new EventStream());
  cleanup.push(() => capture.close());
  capture.schedule(t.id);
  await capture.flush();
  const claim = archive.claims.get('claude-code:claude-session-1');
  expect(claim?.claimant).toStartWith('foundry:');
  expect(claim?.fulfilledBy).toBe(archive.listings()[0]?.id ?? claim?.fulfilledBy);
  expect(claim?.fulfilledBy).toBeString();
  // The observed Codex child is claimed by its own thread id when its node is captured.
  const child = store.threads().find((x) => x.meta.spawn?.nativeTaskId === 'codex-child')!;
  capture.schedule(child.id);
  await capture.flush();
  expect(archive.claims.get('codex:codex-child')?.fulfilledBy).toBeString();
  // A thread at work keeps its lease renewed.
  archive.claims.clear();
  await capture.renew();
  expect(archive.claims.get('claude-code:claude-session-1')?.fulfilledBy).toBeUndefined();
});
