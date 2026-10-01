import { afterEach, expect, test } from 'bun:test';
import { userInfo } from 'node:os';
import type { ArchiveSnapshot } from '@inixiative/archive';
import { EventStream } from '@inixiative/foundry-core';
import { Hono } from 'hono';
import { ArchiveCapture, captureThread } from '../src/archives/capture';
import { ArchiveContextSource } from '../src/archives/context-source';
import { registerArchiveRoutes } from '../src/archives/routes';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { type FakeArchive, startFakeArchive } from './helpers/fake-archive';

const thread = () => ({
  id: 'archive-thread',
  meta: {
    description: 'Test archive',
    projectId: 'project-a',
    tags: ['explicit'],
    status: 'idle' as const,
    createdAt: 1,
    lastActiveAt: 1,
  },
});
const conversational = (snapshot: ArchiveSnapshot | undefined) =>
  snapshot?.entries.filter((entry) => entry.kind !== 'event') ?? [];

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});
const fixture = () => {
  const archive = startFakeArchive(),
    journal = new LocalSessionStore(':memory:');
  cleanup.push(
    () => journal.close(),
    () => archive.stop(),
  );
  const t = thread();
  journal.saveThread(t);
  return { archive, journal, t };
};
const latest = (archive: FakeArchive) => {
  const [listing] = archive.listings();
  return listing ? archive.snapshots(listing.id).at(-1) : undefined;
};

test('journal capture writes every page to the local Archive, retains partial turns, and refreshes on a durable event', async () => {
  const { archive, journal, t } = fixture(),
    events = new EventStream();
  for (let i = 0; i < 510; i++) {
    journal.beginTurn(t, `turn-${i}`, `Question ${i}`);
    journal.completeTurn(
      t,
      `turn-${i}`,
      `Answer ${i}`,
      {},
      { id: `trace-${i}`, messageId: `turn-${i}`, startedAt: 1, root: {}, summary: {}, spans: [] },
    );
  }
  const client = archive.client();
  const capture = new ArchiveCapture(journal, () => client, events);
  await capture.flush();
  expect(conversational(latest(archive))).toHaveLength(1020);
  journal.beginTurn(t, 'last-turn', 'Pending response');
  events.push({ kind: 'journal', threadId: t.id, turnId: 'last-turn', timestamp: Date.now() });
  await capture.flush();
  const [listing] = archive.listings();
  expect(listing?.revision).toBe(2);
  expect(conversational(archive.snapshots(listing?.id ?? '')[0])).toHaveLength(1020);
  expect(conversational(latest(archive))).toHaveLength(1021);
  expect(capture.errors.size).toBe(0);
  expect(latest(archive)?.sourceId).toBe(archive.sourceId);
  expect(latest(archive)?.coverage.reasoning).toBe('unavailable');
});

test('a missing or failing local Archive records the thread, still reports its snapshot, and the retry captures it', async () => {
  const { archive, journal, t } = fixture();
  journal.beginTurn(t, 'turn-a', 'Remember this');
  const observed: ArchiveSnapshot[] = [];
  let writer: ReturnType<FakeArchive['client']> | undefined;
  const capture = new ArchiveCapture(
    journal,
    () => writer,
    new EventStream(),
    (snapshot) => observed.push(snapshot),
  );
  await capture.flush();
  expect(capture.errors.get(t.id)).toContain('archive setup');
  expect(observed.map((snapshot) => snapshot.sessionId)).toEqual([t.id]);

  writer = archive.client();
  archive.fail(true);
  capture.schedule(t.id);
  await capture.flush();
  expect(capture.errors.get(t.id)).toContain('retries');
  expect(observed).toHaveLength(2);
  expect(archive.listings()).toHaveLength(0);

  archive.fail(false);
  // What the 30-second retry does: reschedule every thread with an error.
  for (const id of capture.errors.keys()) capture.schedule(id);
  await capture.flush();
  expect(capture.errors.size).toBe(0);
  expect(conversational(latest(archive)).map((entry) => entry.text)).toEqual(['Remember this']);
  capture.close();
});

test('context retrieval searches the local Archive only for the bound project', async () => {
  const { archive, journal, t } = fixture();
  journal.beginTurn(t, 'turn-a', 'Review migration evidence');
  await archive.client().capture(captureThread(journal, archive.sourceId, t.id));
  let local: ReturnType<FakeArchive['client']> | undefined = archive.client();
  const source = new ArchiveContextSource(
    'archive-source',
    { projectId: 'project-a', budget: 2048 },
    undefined,
    () => local,
  );
  expect(await source.load()).toBe('');
  expect(await source.bind({ projectId: 'other' }).load()).toBe('');
  expect(archive.requests.filter((action) => action === 'search')).toHaveLength(0);
  let projectId: string | undefined;
  const owned = source.bind({
    get projectId() {
      return projectId;
    },
    threadId: 'thread-a',
  });
  expect(await owned.load()).toBe('');
  projectId = 'project-a';
  const evidence = JSON.parse(await owned.load({ focus: 'migration' }));
  expect(evidence.kind).toBe('historical-session-evidence');
  expect(evidence.records[0]).toMatchObject({ title: 'Test archive', revision: 1 });
  expect(JSON.stringify(evidence)).toContain('Review migration evidence');
  archive.fail(true);
  await expect(owned.load({ focus: 'migration' })).rejects.toThrow();
  local = undefined;
  expect(await owned.load({ focus: 'migration' })).toBe('');
});

test('public native commentary survives an interrupted response with its observation form', () => {
  const journal = new LocalSessionStore(':memory:');
  const t = thread();
  journal.saveThread(t);
  journal.beginTurn(t, 'turn-a', 'Work');
  const evidence = {
    schema: 1 as const,
    admissionId: 'admission-a',
    nativeOutcome: 'unknown' as const,
    owner: {
      threadId: t.id,
      projectId: 'project-a',
      messageId: 'turn-a',
      generation: 'g',
      dispatchId: 'd',
    },
  };
  journal.registerNative(t, evidence);
  journal.appendNative(t, {
    ...evidence,
    text: 'Partial answer',
    textKind: 'delta',
    textPhase: 'commentary',
    observedAt: 2,
  });
  try {
    const archived = captureThread(journal, crypto.randomUUID(), t.id);
    const partial = archived.entries.find((entry) => entry.kind === 'assistant');
    expect(partial?.text).toContain('Partial answer');
    expect(JSON.parse(partial!.text).form).toBe('delta');
    expect(partial?.turnId).toBe('turn-a');
  } finally {
    journal.close();
  }
});

test('viewer routes read status, set up the local Archive, then capture, list, read and search through it', async () => {
  const { archive, journal, t } = fixture();
  journal.beginTurn(t, 'turn-a', 'Routes fixture');
  let installed = false,
    ups = 0;
  const observed: string[] = [];
  const app = new Hono();
  const { capture } = registerArchiveRoutes(
    app,
    journal,
    new EventStream(),
    (snapshot) => observed.push(snapshot.sessionId),
    {
      connect: () => (installed ? archive.client() : undefined),
      up: async () => {
        ups++;
        installed = true;
      },
    },
  );
  cleanup.unshift(() => capture.close());
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const status = async () => (await app.request('/api/archives/status')).json();
  expect(await status()).toEqual({
    configured: false,
    reachable: false,
    url: process.env.ARCHIVE_URL,
  });
  await capture.flush();
  expect(observed).toEqual([t.id]);
  const before = (await (await app.request('/api/archives')).json()) as {
    archives: unknown[];
    captureErrors: Record<string, string>;
  };
  expect(before.archives).toEqual([]);
  expect(before.captureErrors[t.id]).toContain('archive setup');
  expect((await post('/api/archives/search', { query: '' })).status).toBe(503);

  const setup = await post('/api/archives/setup', {});
  expect(setup.status).toBe(200);
  expect(await setup.json()).toMatchObject({ configured: true, reachable: true, started: true });
  expect(
    ((await status()) as { integrations: { key: string }[] }).integrations.map((i) => i.key),
  ).toEqual(expect.arrayContaining(['github', 'linear']));
  await capture.flush();
  const listed = (await (await app.request('/api/archives')).json()) as {
    archives: { id: string; title: string }[];
    captureErrors: Record<string, string>;
    status: { reachable: boolean };
  };
  expect(listed.status.reachable).toBe(true);
  expect(listed.captureErrors).toEqual({});
  const [first] = listed.archives;
  expect(listed.archives.map((a) => a.title)).toEqual(['Test archive']);
  const read = (await (await app.request(`/api/archives/${first?.id}`)).json()) as {
    snapshot: ArchiveSnapshot;
  };
  expect(read.snapshot.sessionId).toBe(t.id);
  expect((await app.request(`/api/archives/${'0'.repeat(64)}`)).status).toBe(404);
  const searched = (await (
    await post('/api/archives/search', { query: 'Routes', projectId: 'project-a' })
  ).json()) as { archives: { archiveId: string }[] };
  expect(searched.archives.map((a) => a.archiveId)).toEqual([first?.id]);
  expect((await post('/api/archives/search', { ids: [] })).status).toBe(400);
  expect(await (await post('/api/archives/capture', {})).json()).toEqual({ queued: true });

  // Already running: setup reports status without starting it again.
  expect((await post('/api/archives/setup', {})).status).toBe(200);
  expect(ups).toBe(1);
});

test('a failed archive up is reported with the status', async () => {
  const { journal } = fixture();
  const app = new Hono();
  const { capture } = registerArchiveRoutes(app, journal, new EventStream(), undefined, {
    connect: () => undefined,
    up: async () => {
      throw Error('archive up failed; check that Docker is running.');
    },
  });
  cleanup.unshift(() => capture.close());
  const response = await app.request('/api/archives/setup', { method: 'POST' });
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({
    configured: false,
    reachable: false,
    started: false,
    error: 'archive up failed; check that Docker is running.',
  });
});

test('capture stamps what Foundry ran: the executor per turn, decision roles per phase, and the local actor', async () => {
  const journal = new LocalSessionStore(':memory:'),
    archive = startFakeArchive();
  const t = thread();
  journal.saveThread(t);
  journal.beginTurn(t, 'turn-a', 'Rename the column');
  const owner = (providerSessionKey: string) => ({
    threadId: t.id,
    projectId: 'project-a',
    messageId: 'turn-a',
    generation: 'g',
    dispatchId: 'd',
    providerSessionKey,
  });
  const executor = {
    schema: 1 as const,
    admissionId: 'executor',
    nativeOutcome: 'unknown' as const,
    owner: owner(t.id),
  };
  journal.registerNative(t, executor);
  journal.appendNative(t, {
    ...executor,
    toolName: 'Read',
    toolInput: { file_path: 'a.ts' },
    callId: 'c1',
    observedAt: 2,
  });
  journal.appendNative(t, { ...executor, toolName: 'Read', toolOutput: 'x', callId: 'c1' });
  const route = {
    schema: 1 as const,
    admissionId: 'route',
    nativeOutcome: 'unknown' as const,
    owner: owner(`${t.id}:aux:cartographer`),
  };
  journal.registerNative(t, route);
  journal.appendNative(t, { ...route, text: 'routing', observedAt: 3 });
  journal.completeTurn(
    t,
    'turn-a',
    'Renamed',
    {
      native: {
        ...executor,
        nativeOutcome: 'completed',
        configuration: {
          requestedModel: 'opus',
          observedModel: 'claude-opus-5-5',
          requestedEffort: 'high',
          turnBudgetEnforcement: 'unavailable',
          tokenBudget: 'unavailable',
          effortBudget: 'unavailable',
        },
      },
    },
    { id: 'trace-a', messageId: 'turn-a', startedAt: 1, root: {}, summary: {}, spans: [] },
  );
  const supplied = (served?: object) => ({
    status: 'supplied',
    phase: 'advice',
    providerId: 'decisions',
    messages: [],
    capturedAt: 1,
    ...(served ? { served } : {}),
  });
  const phase = (id: string, record: Record<string, unknown>) =>
    journal.appendPhase(t, {
      id,
      turnId: 'turn-a',
      dispatchId: 'd',
      phase: id as 'route' | 'advice',
      record,
    });
  phase('route', { routing: { request: supplied({ model: 'gpt-6-luna', effort: 'low' }) } });
  phase('advice', {
    participants: [
      { id: 'architecture', request: supplied({ model: 'gpt-6-luna', effort: 'low' }) },
      { id: 'security', request: supplied({ model: 'claude-opus-5-5' }) },
    ],
  });
  try {
    const snapshot = captureThread(journal, archive.sourceId, t.id);
    const entry = (sourceRef: string) => {
      const found = snapshot.entries.find((e) => e.sourceRef === sourceRef);
      if (!found) throw Error(`missing ${sourceRef}`);
      return { model: found.model, effort: found.effort, kind: found.kind };
    };
    const answer = snapshot.entries.find((e) => e.kind === 'assistant' && e.text === 'Renamed');
    expect(answer).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
    expect(snapshot.entries.find((e) => e.kind === 'user')).not.toHaveProperty('model');
    const call = snapshot.entries.find((e) => e.kind === 'tool-call');
    expect(call).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
    expect(snapshot.entries.find((e) => e.kind === 'tool-result')).not.toHaveProperty('model');
    // A decision role's native text never inherits the executor's model.
    const routing = snapshot.entries.find(
      (e) => e.kind === 'assistant' && e.text.includes('routing'),
    );
    expect(routing).not.toHaveProperty('model');
    expect(entry('phase:route')).toEqual({ model: 'gpt-6-luna', effort: 'low', kind: 'event' });
    // Mixed participants name no single model for the record.
    expect(entry('phase:advice').model).toBeUndefined();
    expect(snapshot.actor).toEqual({ kind: 'user', id: userInfo().username });
    await archive.client().capture(snapshot);
    expect((await archive.client().list())[0]?.models).toEqual(
      expect.arrayContaining([
        { model: 'claude-opus-5-5', effort: 'high', entries: 2 },
        { model: 'gpt-6-luna', effort: 'low', entries: 1 },
      ]),
    );
  } finally {
    archive.stop();
    journal.close();
  }
});
