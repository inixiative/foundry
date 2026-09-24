import { expect, test } from 'bun:test';
import { EventStream } from '@inixiative/foundry-core';
import { LocalArchiveStore } from '@inixiative/session-archive/local';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { ArchiveCapture, captureThread } from '../src/archives/capture';
import { publishArchive } from '../src/archives/publish';
import { ArchiveContextSource } from '../src/archives/context-source';
import { startArchiveServer } from '@inixiative/session-archive/server';

const thread = () => ({ id: 'archive-thread', meta: { description: 'Test archive', projectId: 'project-a', tags: ['explicit'],
  status: 'idle' as const, createdAt: 1, lastActiveAt: 1 } });

test('Foundry publishes and retrieves evidence directly from a standalone Archive server', async () => {
  const token = 'foundry-standalone-archive-fixture-00000';
  process.env.ARCHIVE_DIRECT_TEST_TOKEN = token;
  const hosted = startArchiveServer({ store: ':memory:', token, port: 0 });
  const journal = new LocalSessionStore(':memory:'), local = new LocalArchiveStore(':memory:');
  try {
    const t = thread(); journal.saveThread(t); journal.beginTurn(t, 'turn-direct', 'Review migration evidence');
    const captured = local.capture(captureThread(journal, local.sourceId, t.id));
    await publishArchive(local, captured.id, { kind: 'archive', projectId: 'project-a', url: hosted.server.url.href,
      keepIds: [], tokenEnv: 'ARCHIVE_DIRECT_TEST_TOKEN' });
    const source = new ArchiveContextSource('direct', hosted.server.url.href, { kind: 'archive', projectId: 'project-a',
      tokenEnv: 'ARCHIVE_DIRECT_TEST_TOKEN', budget: 2048 });
    expect(await source.bind({ projectId: 'other' }).load()).toBe('');
    expect(await source.bind({ projectId: 'project-a' }).load({ focus: 'migration' })).toContain('Review migration evidence');
    process.env.ARCHIVE_DIRECT_TEST_TOKEN = 'revoked';
    await expect(source.bind({ projectId: 'project-a' }).load()).rejects.toThrow('401');
  } finally { delete process.env.ARCHIVE_DIRECT_TEST_TOKEN; journal.close(); local.close(); await hosted.close(); }
});
test('journal capture recovers all pages, retains partial turns, and refreshes on a durable event', () => {
  const journal = new LocalSessionStore(':memory:'), archives = new LocalArchiveStore(':memory:'), events = new EventStream();
  const t = thread();
  journal.saveThread(t);
  for (let i = 0; i < 510; i++) {
    journal.beginTurn(t, `turn-${i}`, `Question ${i}`);
    journal.completeTurn(t, `turn-${i}`, `Answer ${i}`, {}, { id: `trace-${i}`, messageId: `turn-${i}`, startedAt: 1, root: {}, summary: {}, spans: [] });
  }
  const capture = new ArchiveCapture(journal, archives, events);
  try {
    capture.flush();
    const first = archives.list()[0];
    expect(archives.read(first.id)?.snapshot.entries.filter(entry => entry.kind !== 'event')).toHaveLength(1020);
    journal.beginTurn(t, 'last-turn', 'Pending response');
    events.push({ kind: 'journal', threadId: t.id, turnId: 'last-turn', timestamp: Date.now() });
    capture.flush();
    expect(archives.read(first.id)?.snapshot.entries.filter(entry => entry.kind !== 'event')).toHaveLength(1021);
    expect(archives.read(first.id, 1)?.snapshot.entries.filter(entry => entry.kind !== 'event')).toHaveLength(1020);
    expect(capture.errors.size).toBe(0);
    expect(captureThread(journal, archives.sourceId, t.id).coverage.reasoning).toBe('unavailable');
  } finally { journal.close(); }
});

test('publication carries one explicit destination and only acknowledges a committed matching snapshot', async () => {
  const journal = new LocalSessionStore(':memory:'), archives = new LocalArchiveStore(':memory:');
  const t = thread(); journal.saveThread(t); journal.beginTurn(t, 'turn-a', 'Publish fixture');
  const captured = archives.capture(captureThread(journal, archives.sourceId, t.id));
  const destination = { projectId: 'project-a', url: 'https://example.invalid/', kastleId: crypto.randomUUID(), keepIds: [], tokenEnv: 'ARCHIVE_TEST_TOKEN' };
  process.env.ARCHIVE_TEST_TOKEN = 'kastle_runtime_fixture';
  const calls: any[] = [];
  const transport = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return Response.json({ data: { digest: captured.digest } });
  }) as typeof fetch;
  try {
    await publishArchive(archives, captured.id, destination, transport);
    expect(calls[0].url).toBe('https://example.invalid/api/v1/archive/ingest');
    expect(calls[0].init.redirect).toBe('error');
    expect(JSON.parse(calls[0].init.body).kastleId).toBe(destination.kastleId);
    expect((await publishArchive(archives, captured.id, destination, transport)).unchanged).toBe(true);
    expect(calls).toHaveLength(1);
    await publishArchive(archives, captured.id, { ...destination, keepIds: [crypto.randomUUID()] }, transport);
    expect(calls).toHaveLength(2);
    await expect(publishArchive(archives, captured.id, { ...destination, projectId: 'other' }, transport)).rejects.toThrow('outside');
    await expect(publishArchive(archives, captured.id, { ...destination, url: 'http://remote.invalid' }, transport)).rejects.toThrow('HTTPS');
    await expect(publishArchive(archives, captured.id, { ...destination, kastleId: crypto.randomUUID() },
      (async () => Response.json({ error: 'denied' }, { status: 403 })) as typeof fetch)).rejects.toThrow('403');
  } finally { delete process.env.ARCHIVE_TEST_TOKEN; archives.close(); journal.close(); }
});

test('context retrieval is bound to a local project and does not reuse an earlier successful authorization', async () => {
  process.env.ARCHIVE_CONTEXT_TEST_TOKEN = 'kastle_runtime_fixture';
  let calls = 0;
  const source = new ArchiveContextSource('archive-source', 'https://example.invalid/', { projectId: 'project-a',
    kastleId: crypto.randomUUID(), tokenEnv: 'ARCHIVE_CONTEXT_TEST_TOKEN', budget: 2048 }, undefined, (async () => {
      calls++;
      return calls === 1 ? Response.json({ data: { archives: [{ archiveId: crypto.randomUUID(), revision: 1, digest: 'digest', title: 'Archive',
        chunks: [{ entryId: 'entry', sourceRef: 'message:entry', start: 0, end: 7, text: 'History' }] }] } })
        : Response.json({}, { status: 401 });
    }) as typeof fetch);
  try {
    expect(await source.load()).toBe('');
    expect(await source.bind({ projectId: 'other' }).load()).toBe('');
    expect(calls).toBe(0);
    let projectId: string | undefined;
    const owned = source.bind({ get projectId() { return projectId; }, threadId: 'thread-a' });
    expect(await owned.load()).toBe('');
    projectId = 'project-a';
    expect(await owned.load({ focus: 'history' })).toContain('History');
    await expect(owned.load({ focus: 'history' })).rejects.toThrow('401');
  } finally { delete process.env.ARCHIVE_CONTEXT_TEST_TOKEN; }
});

test('public native commentary survives an interrupted response with its observation form', () => {
  const journal = new LocalSessionStore(':memory:');
  const t = thread(); journal.saveThread(t); journal.beginTurn(t, 'turn-a', 'Work');
  const evidence = { schema: 1 as const, admissionId: 'admission-a', nativeOutcome: 'unknown' as const,
    owner: { threadId: t.id, projectId: 'project-a', messageId: 'turn-a', generation: 'g', dispatchId: 'd' } };
  journal.registerNative(t, evidence);
  journal.appendNative(t, { ...evidence, text: 'Partial answer', textKind: 'delta', textPhase: 'commentary', observedAt: 2 });
  try {
    const archived = captureThread(journal, crypto.randomUUID(), t.id);
    const partial = archived.entries.find(entry => entry.kind === 'assistant');
    expect(partial?.text).toContain('Partial answer');
    expect(JSON.parse(partial!.text).form).toBe('delta');
    expect(partial?.turnId).toBe('turn-a');
  } finally { journal.close(); }
});

test('an upload with a lost acknowledgment is replayed before newer captured content', async () => {
  const journal = new LocalSessionStore(':memory:'), archives = new LocalArchiveStore(':memory:');
  const t = thread(); journal.saveThread(t); journal.beginTurn(t, 'turn-a', 'First');
  const first = archives.capture(captureThread(journal, archives.sourceId, t.id));
  const destination = { projectId: 'project-a', url: 'https://example.invalid/', kastleId: crypto.randomUUID(), keepIds: [], tokenEnv: 'ARCHIVE_RETRY_TEST_TOKEN' };
  process.env.ARCHIVE_RETRY_TEST_TOKEN = 'kastle_runtime_fixture';
  let lost = true, head: string | null = null;
  const received: string[] = [];
  const { snapshotDigest } = await import('@inixiative/session-archive');
  const transport = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string), hash = snapshotDigest(body.snapshot);
    received.push(hash);
    if (head !== hash && body.previousDigest !== head) return Response.json({}, { status: 409 });
    head = hash;
    if (lost) { lost = false; throw new Error('Response lost after server commit'); }
    return Response.json({ data: { digest: hash } });
  }) as typeof fetch;
  try {
    await expect(publishArchive(archives, first.id, destination, transport)).rejects.toThrow('Response lost');
    const newer = archives.capture({ ...archives.read(first.id)!.snapshot, title: 'Later', capturedAt: Date.now() + 1 });
    await publishArchive(archives, first.id, destination, transport);
    expect(received).toEqual([first.digest, first.digest, newer.digest]);
    expect(head).toBe(newer.digest);
    expect((await publishArchive(archives, first.id, destination, transport)).unchanged).toBe(true);
  } finally { delete process.env.ARCHIVE_RETRY_TEST_TOKEN; archives.close(); journal.close(); }
});

test('viewer connection setup verifies access, reloads publishing routes and retrieves scoped context', async () => {
  const { Hono } = await import('hono');
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { registerArchiveRoutes } = await import('../src/archives/routes');
  const dir=mkdtempSync(join(tmpdir(),'foundry-archive-connect-'));
  const hosted=startArchiveServer({store:':memory:',token:'synthetic-foundry-connection-token-000',port:0});
  const journal=new LocalSessionStore(':memory:');
  process.env.ARCHIVE_CONNECT_VIEWER_TOKEN='incorrect';
  const app=new Hono();const registered=registerArchiveRoutes(app,journal,new EventStream(),dir);
  const post=(path:string,body:unknown)=>app.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const destination={kind:'archive',projectId:'project-a',url:hosted.server.url.href,tokenEnv:'ARCHIVE_CONNECT_VIEWER_TOKEN',keepIds:[]};
  try{
    expect((await post('/api/archives/connect',destination)).status).toBe(400);
    expect(existsSync(join(dir,'archives.json'))).toBe(false);
    process.env.ARCHIVE_CONNECT_VIEWER_TOKEN='synthetic-foundry-connection-token-000';
    expect((await post('/api/archives/connect',destination)).status).toBe(200);
    expect((await app.request('/api/archives/connections')).status).toBe(200);
    expect((await post('/api/archives/context',{projectId:'foreign',url:destination.url,query:''})).status).toBe(404);
    expect((await post('/api/archives/context',{projectId:'project-a',url:destination.url,query:''})).status).toBe(200);
  }finally{journal.close();registered.store.close();await hosted.close();delete process.env.ARCHIVE_CONNECT_VIEWER_TOKEN;rmSync(dir,{recursive:true,force:true})}
});
