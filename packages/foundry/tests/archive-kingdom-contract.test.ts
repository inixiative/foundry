import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { EventStream } from '@inixiative/foundry-core';
import { LocalArchiveStore } from '@inixiative/session-archive/local';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { captureThread } from '../src/archives/capture';
import { archiveDestinationSchema } from '../src/archives/config';
import { archiveContextSchema } from '../src/archives/context-source';
import { publishArchive, verifyArchiveDestination } from '../src/archives/publish';
import { registerArchiveRoutes } from '../src/archives/routes';
import { FoundryCredentials } from '../src/providers/credentials';
import { writePrivateJson } from '../src/providers/kastle-credential-file';

const secret = 'kastle_runtime_' + 'b'.repeat(43);
const spaceId = '33333333-3333-4333-8333-333333333333';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-kingdom-archive-'));
  const credentialFile = join(dir, 'runtime.json');
  await writePrivateJson(credentialFile, { secret });
  const credentials = new FoundryCredentials(dir, () => ({
    url: 'https://kingdom.example',
    installationId: crypto.randomUUID(),
    credentialFile,
  }));
  const journal = new LocalSessionStore(':memory:'),
    store = new LocalArchiveStore(':memory:');
  const t = {
    id: 'kingdom-contract',
    meta: { description: 'Contract', projectId: 'project-a', tags: [], status: 'idle' as const, createdAt: 1, lastActiveAt: 1 },
  };
  journal.saveThread(t);
  journal.beginTurn(t, 'turn-a', 'Kingdom wire contract');
  const archive = store.capture(captureThread(journal, store.sourceId, t.id));
  const calls: { url: string; body: any; authorization: string }[] = [];
  const transport = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, authorization: init.headers.authorization });
    if (String(url).endsWith('/connections'))
      return Response.json({ data: [{ id: 'hosted', name: 'Hosted', groups: [], projectId: 'project-a' }] });
    if (String(url).endsWith('/search')) return Response.json({ data: { archives: [] } });
    return Response.json({ data: { digest: archive.digest } });
  }) as typeof fetch;
  const close = () => {
    journal.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, credentials, store, archive, calls, transport, close };
}

test('Kingdom storage sends owner fields without Kastle or Keep identifiers', async () => {
  const f = await fixture();
  const destination = archiveDestinationSchema.parse({
    kind: 'kingdom',
    url: 'https://kingdom.example/',
    projectId: 'project-a',
    ownerModel: 'Space',
    spaceId,
    credential: { type: 'kingdom-runtime' },
  });
  try {
    await verifyArchiveDestination(destination, f.credentials, f.transport);
    await publishArchive(f.store, f.archive.id, destination, f.transport, f.credentials);
    expect(f.calls.map(({ url, body }) => ({ url, body }))).toEqual([
      {
        url: 'https://kingdom.example/api/v1/archive/search',
        body: { query: '', budget: 16, limit: 1, ownerModel: 'Space', spaceId },
      },
      {
        url: 'https://kingdom.example/api/v1/archive/ingest',
        body: { ownerModel: 'Space', spaceId, previousDigest: null, snapshot: f.store.read(f.archive.id)!.snapshot },
      },
    ]);
    expect(f.calls.every((call) => call.authorization === `Bearer ${secret}`)).toBe(true);
  } finally {
    f.close();
  }
});

test('Kingdom forwarding routes through remote actions with the connection identifier', async () => {
  const f = await fixture();
  const destination = archiveDestinationSchema.parse({
    kind: 'kingdom',
    url: 'https://kingdom.example/',
    projectId: 'project-a',
    connectionId: 'hosted',
    credential: { type: 'kingdom-runtime' },
  });
  try {
    await verifyArchiveDestination(destination, f.credentials, f.transport);
    await publishArchive(f.store, f.archive.id, destination, f.transport, f.credentials);
    expect(f.calls.map(({ url, body }) => ({ url, body }))).toEqual([
      { url: 'https://kingdom.example/api/v1/archive/remote/connections', body: {} },
      {
        url: 'https://kingdom.example/api/v1/archive/remote/search',
        body: { query: '', budget: 16, limit: 1, connectionId: 'hosted' },
      },
      {
        url: 'https://kingdom.example/api/v1/archive/remote/ingest',
        body: { connectionId: 'hosted', previousDigest: null, snapshot: f.store.read(f.archive.id)!.snapshot },
      },
    ]);
    await expect(
      verifyArchiveDestination({ ...destination, projectId: 'other' }, f.credentials, f.transport),
    ).rejects.toThrow('not configured');
  } finally {
    f.close();
  }
});

test('legacy Kastle destinations are rejected and surfaced without crashing the viewer', async () => {
  const f = await fixture();
  const legacy = {
    kind: 'kingdom',
    url: 'https://kingdom.example/',
    projectId: 'project-a',
    kastleId: crypto.randomUUID(),
    keepIds: [],
    credential: { type: 'kingdom-runtime' },
  };
  const journal = new LocalSessionStore(':memory:');
  try {
    expect(archiveDestinationSchema.safeParse(legacy).success).toBe(false);
    expect(archiveDestinationSchema.safeParse({ ...legacy, kind: undefined }).success).toBe(false);
    expect(archiveDestinationSchema.safeParse({ ...legacy, kastleId: undefined }).success).toBe(false);
    expect(
      archiveDestinationSchema.safeParse({ kind: 'archive', url: legacy.url, projectId: 'project-a', tokenEnv: 'ARCHIVE_TOKEN', keepIds: [] })
        .success,
    ).toBe(true);
    expect(
      archiveContextSchema.safeParse({ kind: 'kingdom', projectId: 'project-a', kastleId: legacy.kastleId, tokenEnv: 'ARCHIVE_TOKEN' })
        .success,
    ).toBe(false);
    await expect(publishArchive(f.store, f.archive.id, legacy as any, f.transport, f.credentials)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);

    writeFileSync(join(f.dir, 'archives.json'), JSON.stringify([legacy]));
    const app = new Hono();
    const registered = registerArchiveRoutes(app, journal, new EventStream(), f.dir);
    try {
      const listed = await (await app.request('/api/archives/connections')).json();
      expect(listed.connections).toEqual([]);
      expect(listed.configurationError).toContain('kastleId');
      expect((await (await app.request('/api/archives')).json()).configurationError).toContain('kastleId');
    } finally {
      registered.store.close();
    }
  } finally {
    journal.close();
    f.close();
  }
});
