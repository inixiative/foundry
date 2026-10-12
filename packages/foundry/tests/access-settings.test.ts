import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type {
  KingdomAccessClient,
  KingdomAccessSource,
} from '../src/providers/kingdom-access-client';
import { ConfigStore, defaultConfig } from '../src/viewer/config';
import { registerAccessRoutes } from '../src/viewer/routes/access';
import { heldSignet, mockKingdom, userOwner } from './helpers/kingdom-installation';

type AccessSettings = {
  sources: (KingdomAccessSource & { credentialStatus: 'available' | 'unavailable' })[];
  revision: string;
  applyMode: string;
};
type AccessCheck = {
  status: string;
  description: Awaited<ReturnType<KingdomAccessClient['describe']>>;
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-access-settings-'));
  const store = new ConfigStore(dir),
    config = defaultConfig(),
    projectId = crypto.randomUUID();
  config.projects[projectId] = { id: projectId, label: 'Team', path: dir };
  await store.save(config);
  const app = new Hono();
  registerAccessRoutes(app, store);
  const source = {
    id: crypto.randomUUID(),
    name: 'Team issues',
    url: 'http://127.0.0.1:1',
    credentialFile: join(dir, 'access.json'),
    integrationId: crypto.randomUUID(),
    signetId: crypto.randomUUID(),
    projectIds: [projectId],
  };
  const get = async () =>
    (await (await app.request('/api/access/sources')).json()) as AccessSettings;
  const put = (body: unknown) =>
    app.request(`/api/access/sources/${source.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    dir,
    store,
    config,
    projectId,
    app,
    source,
    get,
    put,
    async close() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('grant editing preserves unrelated settings, reports missing private files, and removes only the selected source', async () => {
  const f = await fixture();
  try {
    let settings = await f.get();
    expect(settings.sources).toEqual([]);
    expect((await f.put({ revision: settings.revision, source: f.source })).status).toBe(200);
    settings = await f.get();
    expect(settings.applyMode).toBe('restart');
    expect(settings.sources[0].credentialStatus).toBe('unavailable');
    const secret = `kingdom_${'x'.repeat(43)}`;
    await writeFile(
      f.source.credentialFile,
      JSON.stringify({ secret: `kingdom_${'y'.repeat(43)}` }),
      { mode: 0o600 },
    );
    expect((await f.get()).sources[0].credentialStatus).toBe('unavailable');
    await writeFile(
      f.source.credentialFile,
      JSON.stringify({
        url: f.source.url,
        signetId: f.source.signetId,
        enrollmentId: crypto.randomUUID(),
        lifecycle: 'ongoing',
        taskId: null,
        keyFile: join(f.dir, 'key.json'),
        renewalCredential: `signet_renew_${'r'.repeat(43)}`,
        accessToken: secret,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        renewalExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        idleExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        tokenType: 'DPoP',
      }),
      { mode: 0o600 },
    );
    const response = await f.app.request('/api/access/sources');
    expect(response.headers.get('cache-control')).toBe('no-store');
    settings = (await response.json()) as AccessSettings;
    expect(settings.sources[0].credentialStatus).toBe('available');
    expect(JSON.stringify(settings)).not.toContain(secret);
    expect((await f.store.load()).defaults).toEqual(f.config.defaults);
    const deleted = await f.app.request(`/api/access/sources/${f.source.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: settings.revision }),
    });
    expect(deleted.status).toBe(200);
    expect((await f.get()).sources).toEqual([]);
    expect((await f.store.load()).projects).toEqual(f.config.projects);
    expect(await readFile(f.source.credentialFile, 'utf8')).toContain(secret);
  } finally {
    await f.close();
  }
});

test('stale or competing saves cannot silently overwrite grants; invalid authority and inline secrets are rejected', async () => {
  const f = await fixture();
  try {
    const settings = await f.get();
    const results = await Promise.all([
      f.put({ revision: settings.revision, source: f.source }),
      f.put({ revision: settings.revision, source: { ...f.source, name: 'Other editor' } }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const current = await f.get();
    for (const source of [
      { ...f.source, projectIds: [] },
      { ...f.source, projectIds: [crypto.randomUUID()] },
      { ...f.source, secret: 'PRIVATE' },
      { ...f.source, url: 'https://user:password@example.com' },
    ]) {
      const response = await f.put({ revision: current.revision, source });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toMatch(/PRIVATE|password/);
    }
    expect((await f.get()).revision).toBe(current.revision);
    expect(
      (
        await f.app.request(`/api/access/sources/${f.source.id}`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ revision: settings.revision }),
        })
      ).status,
    ).toBe(409);
  } finally {
    await f.close();
  }
});

test('explicit checks use only the saved origin and enrolled Signet, expose metadata without executing or renewing', async () => {
  const f = await fixture();
  let calls = 0,
    rejected = false;
  const kingdom = mockKingdom({
    onSignet(action, body) {
      calls++;
      expect(action).toBe('describe');
      expect(body).toEqual({});
      if (rejected) return new Response('PRIVATE_TOKEN_FAILURE', { status: 401 });
      return {
        signetId: f.source.signetId,
        integrationId: f.source.integrationId,
        name: 'Team issues',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        provider: 'linear',
        lifecycle: 'ongoing',
        taskId: null,
        currentRevision: 1,
        remainingRequests: 3,
        operations: [
          {
            key: 'issues.read',
            name: 'Read issue',
            resources: [
              {
                id: crypto.randomUUID(),
                name: 'Issue',
                kind: 'issue',
                integrationId: f.source.integrationId,
              },
            ],
          },
        ],
      };
    },
  });
  try {
    const held = await heldSignet(kingdom, f.dir, userOwner());
    Object.assign(f.source, {
      url: kingdom.url,
      credentialFile: held.credentialFile,
      integrationId: held.integrationId,
      signetId: held.signetId,
    });
    await f.put({ revision: (await f.get()).revision, source: f.source });
    await f.get();
    expect(calls).toBe(0);
    const check = () =>
      f.app.request(`/api/access/sources/${f.source.id}/check`, {
        method: 'POST',
        body: JSON.stringify({ url: 'https://ignored.example' }),
      });
    const result = (await (await check()).json()) as AccessCheck;
    expect(result.status).toBe('available');
    expect(result.description.remainingRequests).toBe(3);
    expect(result.description.operations[0].resources).toHaveLength(1);
    rejected = true;
    const failed = (await (await check()).json()) as AccessCheck;
    expect(failed.status).toBe('needs-authentication');
    expect(JSON.stringify(failed)).not.toContain('PRIVATE');
    expect(calls).toBe(2);
  } finally {
    kingdom.stop();
    await f.close();
  }
});
