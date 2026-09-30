import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStream } from '@inixiative/foundry-core';
import { startArchiveServer } from '@inixiative/session-archive/server';
import { Hono } from 'hono';
import { captureThread } from '../src/archives/capture';
import { ArchiveContextSource } from '../src/archives/context-source';
import { archiveRequest, kingdomFields, publishArchive } from '../src/archives/publish';
import { registerArchiveRoutes } from '../src/archives/routes';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { FoundryCredentials } from '../src/providers/credentials';
import { writePrivateJson } from '../src/providers/kingdom-credential-file';

/** A zero-argument fetch stub; `typeof fetch` also carries Bun's `preconnect`. */
const stubFetch = (respond: () => Promise<Response>): typeof fetch =>
  Object.assign(respond, { preconnect: fetch.preconnect });

const temporary = () => mkdtempSync(join(tmpdir(), 'foundry-credentials-'));
const scope = { service: 'archive', url: 'https://archive.example/', projectId: 'personal' };
test('managed credentials enforce scope, private files, rotation and revocation without environment variables', async () => {
  const dir = temporary();
  const credentials = new FoundryCredentials(dir);
  try {
    const ref = await credentials.save(scope, 'synthetic-first');
    if (ref.type !== 'managed') throw Error();
    const path = join(dir, 'credentials', `${ref.id}.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'credentials')).mode & 0o777).toBe(0o700);
    expect(await credentials.resolve(ref, scope)).toBe('synthetic-first');
    for (const other of [
      { ...scope, projectId: 'userevidence' },
      { ...scope, url: 'https://other.example/' },
      { ...scope, service: 'inference' },
    ])
      await expect(credentials.resolve(ref, other)).rejects.toThrow('scope');
    await writePrivateJson(path, { scope, secret: 'synthetic-rotated' });
    expect(await credentials.resolve(ref, scope)).toBe('synthetic-rotated');
    chmodSync(path, 0o644);
    await expect(credentials.resolve(ref, scope)).rejects.toThrow('private');
    chmodSync(path, 0o600);
    await credentials.remove(ref);
    await expect(credentials.resolve(ref, scope)).rejects.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native Kingdom credentials stay on the enrolled origin and fail when the server revokes access', async () => {
  const dir = temporary();
  const credentialFile = join(dir, 'runtime.json');
  const installationId = crypto.randomUUID();
  const secret = 'kingdom_runtime_' + 'a'.repeat(43);
  await writePrivateJson(credentialFile, { secret });
  const credentials = new FoundryCredentials(dir, () => ({
    url: 'https://kingdom.example',
    installationId,
    credentialFile,
  }));
  const destination = {
    kind: 'kingdom' as const,
    url: 'https://kingdom.example/',
    projectId: 'inixiative',
    connectionId: 'inixiative',
    credential: { type: 'kingdom-runtime' as const },
  };
  let calls = 0;
  const transport = (async (url: any, init: any) => {
    calls++;
    expect(String(url)).toBe('https://kingdom.example/api/v1/archive/remote/search');
    expect(init.headers.authorization).toBe(`Bearer ${secret}`);
    expect(JSON.parse(init.body).connectionId).toBe('inixiative');
    return calls === 1
      ? Response.json({ data: { archives: [] } })
      : Response.json({}, { status: 401 });
  }) as typeof fetch;
  try {
    await expect(
      archiveRequest(
        { ...destination, url: 'https://attacker.example/' },
        'search',
        {},
        transport,
        credentials,
      ),
    ).rejects.toThrow('scope');
    expect(calls).toBe(0);
    await archiveRequest(destination, 'search', kingdomFields(destination), transport, credentials);
    await expect(
      archiveRequest(destination, 'search', kingdomFields(destination), transport, credentials),
    ).rejects.toThrow('401');
    await expect(credentials.resolve({ type: 'kingdom-runtime' }, scope)).rejects.toThrow('scope');
    const identity = await credentials.kingdomIdentity(
      stubFetch(async () =>
        Response.json({
          data: { installationId, expiresAt: new Date(Date.now() + 60000).toISOString() },
        }),
      ),
    );
    expect(identity).toEqual({ url: 'https://kingdom.example' });
    await expect(
      credentials.kingdomIdentity(
        stubFetch(async () =>
          Response.json({
            data: {
              installationId: crypto.randomUUID(),
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            },
          }),
        ),
      ),
    ).rejects.toThrow('mismatch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('viewer stores only a credential reference and uses it for publication and context across restart', async () => {
  const dir = temporary(),
    secret = 'synthetic-managed-archive-secret-000';
  const hosted = startArchiveServer({ store: ':memory:', token: secret, port: 0 });
  const journal = new LocalSessionStore(':memory:'),
    app = new Hono();
  const registered = registerArchiveRoutes(app, journal, new EventStream(), dir);
  const post = (body: unknown) =>
    app.request('/api/archives/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const destination = { kind: 'archive', url: hosted.server.url.href, projectId: 'personal' };
  try {
    expect((await post({ ...destination, secret: 'incorrect' })).status).toBe(400);
    expect(readdirSync(join(dir, 'credentials'))).toHaveLength(0);
    const result = await post({ ...destination, secret });
    expect(result.status).toBe(200);
    expect(await result.text()).not.toContain(secret);
    const config = readFileSync(join(dir, 'archives.json'), 'utf8');
    expect(config).not.toContain(secret);
    expect(config).not.toContain('tokenEnv');
    const [saved] = JSON.parse(config);
    const t = {
      id: 'managed-test',
      meta: {
        description: 'Native credential evidence',
        projectId: 'personal',
        tags: [],
        status: 'idle' as const,
        createdAt: 1,
        lastActiveAt: 1,
      },
    };
    journal.saveThread(t);
    journal.beginTurn(t, 'turn', 'Managed credential roundtrip');
    const archive = registered.store.capture(
      captureThread(journal, registered.store.sourceId, t.id),
    );
    const credentials = new FoundryCredentials(dir);
    await publishArchive(registered.store, archive.id, saved, fetch, credentials);
    const source = new ArchiveContextSource(
      'managed',
      saved.url,
      { kind: 'archive', projectId: 'personal', credential: saved.credential, budget: 2048 },
      undefined,
      fetch,
      new FoundryCredentials(dir),
    );
    expect(await source.bind({ projectId: 'personal' }).load()).toContain(
      'Managed credential roundtrip',
    );
    expect(await source.bind({ projectId: 'userevidence' }).load()).toBe('');
    const cli = Bun.spawn(
      [
        process.execPath,
        new URL('../src/archives/cli.ts', import.meta.url).pathname,
        'search',
        '--remote',
        '--config',
        join(dir, 'archives.json'),
        '--query',
        'Managed credential',
      ],
      { env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' },
    );
    const cliOutput = await new Response(cli.stdout).text();
    expect(await cli.exited).toBe(0);
    expect(cliOutput).toContain('Managed credential roundtrip');
    expect(cliOutput).not.toContain(secret);

    expect(await (await app.request('/api/archives/connections')).text()).not.toContain(secret);
    await credentials.remove(saved.credential);
    await expect(source.bind({ projectId: 'personal' }).load()).rejects.toThrow();
  } finally {
    journal.close();
    registered.store.close();
    await hosted.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
