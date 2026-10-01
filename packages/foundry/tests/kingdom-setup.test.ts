import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startArchiveServer } from '@inixiative/session-archive/server';
import { runArchiveSetup } from '../src/archives/setup';
import { kingdomStatus, pairKingdom } from '../src/providers/kingdom-cli';
import {
  beginKingdomPairing,
  completeKingdomPairing,
  disconnectKingdom,
  pollKingdomPairing,
  saveKingdomRuntime,
} from '../src/providers/kingdom-pairing';
import { kingdomRuntimeId } from '../src/providers/kingdom-runtime-connection';
import { inspectReadiness } from '../src/readiness';
import { ConfigStore } from '../src/viewer/config';

const P1 = 'd8deab98-d4a6-43d9-9e65-ae783e58ae42',
  P2 = '22222222-2222-4222-8222-222222222222',
  P3 = '33333333-3333-4333-8333-333333333333';
const viewerPort = process.env.VIEWER_PORT;
beforeAll(() => {
  // Never probe a real local viewer: point the running-viewer check at a closed port.
  const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  process.env.VIEWER_PORT = String(closed.port);
  closed.stop(true);
});
afterAll(() => {
  if (viewerPort === undefined) delete process.env.VIEWER_PORT;
  else process.env.VIEWER_PORT = viewerPort;
});

/** Kingdom's access + archive surface: pairing approves on first poll unless held; heartbeat trusts approved hashes. */
function mockKingdom(
  options: {
    expiresInMs?: number;
    hold?: boolean;
    connections?: unknown[];
    owner?: Record<string, string>;
  } = {},
) {
  const owner = options.owner ?? { ownerModel: 'User', userId: crypto.randomUUID() };
  const hashes = new Map<string, string>(),
    pairings = new Map<string, { hash: string; installationId: string }>();
  const calls: { action: string; body: any }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname,
        body = (await request.json().catch(() => ({}))) as any;
      const action = path.replace(/^\/api\/v1\//, '');
      calls.push({ action, body });
      if (action === 'access/pairRuntime') {
        const deviceCode = 'd'.repeat(40) + String(pairings.size).padStart(3, '0');
        pairings.set(deviceCode, { hash: body.keyHash, installationId: crypto.randomUUID() });
        return Response.json({
          data: {
            deviceCode,
            userCode: 'ABCDEF012345',
            interval: 1,
            expiresAt: new Date(Date.now() + (options.expiresInMs ?? 60000)).toISOString(),
            verificationUrl: `http://127.0.0.1:${server.port}/dashboard?connectFoundry=ABCDEF012345`,
          },
        });
      }
      if (action === 'access/pollRuntime') {
        const pairing = pairings.get(body.deviceCode);
        if (!pairing) return new Response('expired', { status: 404 });
        if (options.hold) return Response.json({ data: { status: 'pending' } });
        hashes.set(pairing.hash, pairing.installationId);
        return Response.json({
          data: { status: 'approved', installationId: pairing.installationId },
        });
      }
      const token = request.headers.get('authorization')?.replace('Bearer ', '') ?? '';
      const installationId = hashes.get(createHash('sha256').update(token).digest('hex'));
      if (!installationId) return new Response('revoked', { status: 401 });
      if (action === 'access/runtimeHeartbeat')
        return Response.json({
          data: {
            installationId,
            userId: null,
            owner,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        });
      if (action === 'archive/remote/connections')
        return Response.json({
          data: options.connections ?? [
            { id: 'conn-a', name: 'Team archive', groups: [], projectId: P1 },
            { id: 'conn-b', name: 'Other', groups: [], projectId: 'elsewhere' },
          ],
        });
      if (action === 'archive/remote/search' || action === 'archive/search')
        return Response.json({ data: { archives: [] } });
      return new Response('unknown', { status: 404 });
    },
  });
  return {
    server,
    url: `http://127.0.0.1:${server.port}`,
    calls,
    revokeAll: () => hashes.clear(),
    ownerKey: [
      owner.ownerModel,
      owner.userId ?? '',
      owner.organizationId ?? '',
      owner.spaceId ?? '',
    ].join(':'),
  };
}

async function configDirectory(projects: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-kingdom-setup-'));
  const store = new ConfigStore(dir);
  await store.load();
  await store.update((draft) => {
    for (const id of projects)
      draft.projects[id] = { id, path: `/tmp/${id}`, label: `Project ${id.slice(0, 4)}` };
  });
  return dir;
}

test('shared pairing sends only the key hash, persists privately on approval and leaves nothing when verification fails', async () => {
  const kingdom = mockKingdom(),
    dir = await configDirectory();
  try {
    await expect(
      beginKingdomPairing({ url: kingdom.url, name: 'Test' }, dir, (async () =>
        Response.json({
          data: {
            deviceCode: 'd'.repeat(43),
            userCode: 'ABCDEF012345',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            verificationUrl: 'http://evil.example/approve',
          },
        })) as unknown as typeof fetch),
    ).rejects.toThrow();
    const pairing = await beginKingdomPairing({ url: kingdom.url, name: 'Test' }, dir);
    const sent = kingdom.calls.find((call) => call.action === 'access/pairRuntime')!.body;
    expect(sent).toEqual({
      name: 'Test',
      keyHash: createHash('sha256').update(pairing.secret).digest('hex'),
    });
    expect(pairing.secret).toStartWith('kingdom_runtime_');
    expect(pairing.interval).toBe(1);
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    const approved = await pollKingdomPairing(pairing);
    if (approved.status !== 'approved') throw Error('expected approval');

    const store = new ConfigStore(dir);
    const refused = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    await expect(
      completeKingdomPairing(store, dir, pairing, approved.installationId, { transport: refused }),
    ).rejects.toThrow();
    expect(await readdir(dir)).not.toContain(`kingdom-runtime-${approved.installationId}.json`);
    expect((await store.load()).kingdomRuntimes).toBeUndefined();

    const { id, settings } = await completeKingdomPairing(
      store,
      dir,
      pairing,
      approved.installationId,
    );
    expect((await lstat(settings.credentialFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(settings.credentialFile, 'utf8'))).toEqual({
      secret: pairing.secret,
    });
    const saved = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
    expect(saved.kingdomRuntimes).toEqual([
      {
        url: kingdom.url,
        owner: kingdom.ownerKey,
        installationId: approved.installationId,
        credentialFile: settings.credentialFile,
      },
    ]);
    expect(id).toBe(kingdomRuntimeId({ url: kingdom.url, owner: kingdom.ownerKey }));
    expect(JSON.stringify(saved)).not.toContain(pairing.secret);
    await expect(
      saveKingdomRuntime(store, { ...settings, installationId: crypto.randomUUID() }),
    ).rejects.toThrow('--replace');

    expect((await disconnectKingdom(store))?.installationId).toBe(approved.installationId);
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))).not.toHaveProperty(
      'kingdomRuntimes',
    );
    await expect(lstat(settings.credentialFile)).rejects.toThrow();
    expect(await disconnectKingdom(store)).toBeUndefined();
  } finally {
    kingdom.server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI pairing polls at Kingdom's interval, opens the approval page and persists like the viewer; replacing needs --replace", async () => {
  const kingdom = mockKingdom(),
    dir = await configDirectory();
  const lines: string[] = [],
    waits: number[] = [],
    opened: string[] = [];
  try {
    const result = await pairKingdom({
      configDir: dir,
      url: kingdom.url,
      name: 'CLI Foundry',
      log: (line) => lines.push(line),
      sleep: async (ms) => {
        waits.push(ms);
      },
      launch: (url) => opened.push(url),
    });
    expect(result).toMatchObject({
      status: 'connected',
      url: kingdom.url,
      owner: kingdom.ownerKey,
      restartViewer: false,
    });
    expect(waits).toEqual([1000]);
    expect(opened).toEqual([`${kingdom.url}/dashboard?connectFoundry=ABCDEF012345`]);
    expect(lines.join('\n')).toContain('ABCDEF012345');
    const saved = (await new ConfigStore(dir).load()).kingdomRuntimes!;
    expect(saved.map((runtime) => runtime.credentialFile)).toEqual([
      join(dir, `kingdom-runtime-${result.installationId}.json`),
    ]);
    expect(kingdom.calls.filter((call) => call.action === 'access/runtimeHeartbeat')).toHaveLength(
      1,
    );
    expect(await kingdomStatus(dir)).toEqual({
      status: 'connected',
      runtimes: [
        {
          id: result.id,
          url: kingdom.url,
          owner: kingdom.ownerKey,
          installationId: result.installationId,
          status: 'connected',
        },
      ],
    });
    // The same Kingdom + owner again is refused after approval and leaves no second credential.
    await expect(
      pairKingdom({
        configDir: dir,
        url: kingdom.url,
        open: false,
        log: () => {},
        sleep: async () => {},
      }),
    ).rejects.toThrow('--replace');
    expect((await readdir(dir)).filter((name) => name.startsWith('kingdom-runtime-'))).toEqual([
      `kingdom-runtime-${result.installationId}.json`,
    ]);
    const replaced = await pairKingdom({
      configDir: dir,
      replace: true,
      open: false,
      log: () => {},
      sleep: async () => {},
    });
    expect(replaced).toMatchObject({ id: result.id, url: kingdom.url });
    expect(replaced.installationId).not.toBe(result.installationId);
    expect((await readdir(dir)).filter((name) => name.startsWith('kingdom-runtime-'))).toEqual([
      `kingdom-runtime-${replaced.installationId}.json`,
    ]);
    kingdom.revokeAll();
    expect((await kingdomStatus(dir)).status).toBe('unavailable');
  } finally {
    kingdom.server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI pairing stops at expiry without writing a credential or binding', async () => {
  const kingdom = mockKingdom({ expiresInMs: 150, hold: true }),
    dir = await configDirectory();
  try {
    await expect(
      pairKingdom({
        configDir: dir,
        url: kingdom.url,
        open: false,
        log: () => {},
        sleep: () => Bun.sleep(60),
      }),
    ).rejects.toThrow('expired');
    expect(
      kingdom.calls.filter((call) => call.action === 'access/pollRuntime').length,
    ).toBeGreaterThan(0);
    expect((await readdir(dir)).filter((name) => name.startsWith('kingdom-runtime-'))).toEqual([]);
    expect((await new ConfigStore(dir).load()).kingdomRuntimes).toBeUndefined();
    expect(await kingdomStatus(dir)).toEqual({ status: 'disconnected', runtimes: [] });
  } finally {
    kingdom.server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-interactive setup pairs, connects matching Kingdom connections and direct Archives through verification, and doctor reports the state', async () => {
  const kingdom = mockKingdom(),
    dir = await configDirectory([P1, P2, P3]);
  const token = 'synthetic-direct-archive-token-0001';
  const hosted = startArchiveServer({ store: ':memory:', token, port: 0 });
  const archivesPath = join(dir, 'archives.json');
  await writeFile(
    archivesPath,
    JSON.stringify([
      {
        kind: 'archive',
        projectId: P3,
        url: 'https://existing.example/',
        tokenEnv: 'EXISTING_TOKEN',
      },
    ]),
    { mode: 0o600 },
  );
  process.env.FOUNDRY_TEST_ARCHIVE_TOKEN = token;
  try {
    const skipped = await runArchiveSetup({ configDir: dir, log: () => {} });
    expect(skipped.kingdom.status).toBe('disconnected');
    expect(skipped.projects).toEqual([
      {
        projectId: P1,
        status: 'skipped',
        reason: 'Kingdom is not connected and no --archive-url was given.',
      },
      {
        projectId: P2,
        status: 'skipped',
        reason: 'Kingdom is not connected and no --archive-url was given.',
      },
      { projectId: P3, status: 'configured' },
    ]);

    const result = await runArchiveSetup({
      configDir: dir,
      kingdomUrl: kingdom.url,
      name: 'Setup Foundry',
      open: false,
      sleep: async () => {},
      log: () => {},
      archiveUrl: hosted.server.url.href,
      archiveTokenEnv: 'FOUNDRY_TEST_ARCHIVE_TOKEN',
    });
    expect(result.kingdom.status).toBe('connected');
    expect(result.restartViewer).toBe(false);
    expect(result.projects).toEqual([
      { projectId: P1, status: 'connected' },
      { projectId: P2, status: 'connected' },
      { projectId: P3, status: 'configured' },
    ]);
    const saved = JSON.parse(await readFile(archivesPath, 'utf8'));
    expect(saved).toHaveLength(3);
    expect(saved.find((d: any) => d.projectId === P1)).toEqual({
      kind: 'kingdom',
      projectId: P1,
      url: `${kingdom.url}/`,
      connectionId: 'conn-a',
      credential: { type: 'kingdom-runtime', owner: kingdom.ownerKey },
    });
    const direct = saved.find((d: any) => d.projectId === P2);
    expect(direct).toMatchObject({
      kind: 'archive',
      url: hosted.server.url.href,
      credential: { type: 'managed' },
    });
    expect(JSON.stringify(saved)).not.toContain(token);
    expect(
      (await lstat(join(dir, 'credentials', `${direct.credential.id}.json`))).mode & 0o777,
    ).toBe(0o600);
    expect(kingdom.calls.filter((call) => call.action === 'archive/remote/search')).toHaveLength(1);

    const config = await new ConfigStore(dir).load();
    const live = await inspectReadiness(config, {
      configDir: dir,
      transport: fetch,
      environment: {},
      which: () => '/controlled/cli',
    });
    expect(live.kingdoms).toEqual([
      expect.objectContaining({ status: 'connected', url: kingdom.url, owner: kingdom.ownerKey }),
    ]);
    expect(live.archives).toEqual([
      { projectId: P1, status: 'configured', destinations: 1 },
      { projectId: P2, status: 'configured', destinations: 1 },
      { projectId: P3, status: 'verification-failing', destinations: 1 },
    ]);
    expect(
      live.issues
        .filter((item) => item.code.startsWith('archive') || item.code.startsWith('kingdom'))
        .map((item) => [item.scope, item.code]),
    ).toEqual([[P3, 'archive-destination-failing']]);
    const offline = await inspectReadiness(config, {
      configDir: dir,
      environment: {},
      which: () => '/controlled/cli',
    });
    expect(offline.kingdoms?.map((item) => item.status)).toEqual(['unverified']);
    expect(offline.archives?.every((item) => item.status === 'configured')).toBe(true);

    kingdom.revokeAll();
    const revoked = await inspectReadiness(config, {
      configDir: dir,
      transport: fetch,
      environment: {},
      which: () => '/controlled/cli',
    });
    expect(revoked.kingdoms?.map((item) => item.status)).toEqual(['unavailable']);
    expect(revoked.configurationReady).toBe(false);
    expect(revoked.issues.map((item) => item.code)).toContain('kingdom-unavailable');
    expect(revoked.archives?.find((item) => item.projectId === P1)?.status).toBe(
      'verification-failing',
    );
    expect(JSON.stringify(revoked)).not.toContain(token);
  } finally {
    delete process.env.FOUNDRY_TEST_ARCHIVE_TOKEN;
    kingdom.server.stop(true);
    await hosted.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('setup picks only the named connection and never guesses between several', async () => {
  const kingdom = mockKingdom({
      connections: [
        { id: 'one', projectId: P1 },
        { id: 'two', projectId: P1 },
      ],
    }),
    dir = await configDirectory([P1]);
  try {
    await pairKingdom({
      configDir: dir,
      url: kingdom.url,
      open: false,
      log: () => {},
      sleep: async () => {},
    });
    expect((await runArchiveSetup({ configDir: dir, log: () => {} })).projects).toEqual([
      {
        projectId: P1,
        status: 'skipped',
        reason: 'Several Kingdom connections carry this project; pass --connection.',
      },
    ]);
    expect(
      (await runArchiveSetup({ configDir: dir, connection: 'missing', log: () => {} })).projects[0]!
        .status,
    ).toBe('skipped');
    expect(
      (await runArchiveSetup({ configDir: dir, connection: 'two', log: () => {} })).projects,
    ).toEqual([{ projectId: P1, status: 'connected' }]);
    expect(JSON.parse(await readFile(join(dir, 'archives.json'), 'utf8'))[0].connectionId).toBe(
      'two',
    );
  } finally {
    kingdom.server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test('guided prompts offer matching connections, Kingdom storage, a direct server or skip', async () => {
  const kingdom = mockKingdom(),
    dir = await configDirectory([P1, P2]);
  const asked: string[][] = [];
  const answers = [0, 0];
  const prompts = {
    ask: async (_: string, fallback?: string) =>
      fallback === undefined ? '' : fallback.startsWith('http') ? kingdom.url : fallback,
    confirm: async () => true,
    secret: async () => '',
    choose: async (_: string, options: string[]) => {
      asked.push(options);
      return answers.shift()!;
    },
  };
  try {
    const result = await runArchiveSetup({
      configDir: dir,
      prompts,
      open: false,
      sleep: async () => {},
      log: () => {},
    });
    expect(result.kingdom.status).toBe('connected');
    expect(asked).toEqual([
      [
        'Kingdom connection: Team archive (conn-a)',
        'Kingdom-stored archives',
        'Direct Archive server (URL + token)',
        'Skip',
      ],
      ['Kingdom-stored archives', 'Direct Archive server (URL + token)', 'Skip'],
    ]);
    const saved = JSON.parse(await readFile(join(dir, 'archives.json'), 'utf8'));
    expect(saved.map((d: any) => [d.projectId, d.connectionId ?? null])).toEqual([
      [P1, 'conn-a'],
      [P2, null],
    ]);
  } finally {
    kingdom.server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test('archive setup and kingdom CLIs run the same flow non-interactively', async () => {
  const dir = await configDirectory([P1]);
  const run = async (script: string, args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, new URL(script, import.meta.url).pathname, ...args],
      {
        env: { PATH: process.env.PATH, VIEWER_PORT: process.env.VIEWER_PORT },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const stdout = await new Response(child.stdout).text();
    return { code: await child.exited, output: JSON.parse(stdout) };
  };
  try {
    const setup = await run('../src/archives/cli.ts', [
      'setup',
      '--yes',
      '--config',
      join(dir, 'archives.json'),
    ]);
    expect(setup.code).toBe(0);
    expect(setup.output).toEqual({
      kingdom: { status: 'disconnected' },
      projects: [
        {
          projectId: P1,
          status: 'skipped',
          reason: 'Kingdom is not connected and no --archive-url was given.',
        },
      ],
      restartViewer: false,
    });
    expect(await run('../src/providers/kingdom-cli.ts', ['status', '--config-dir', dir])).toEqual({
      code: 0,
      output: { status: 'disconnected', runtimes: [] },
    });
    expect(
      await run('../src/providers/kingdom-cli.ts', ['disconnect', '--config-dir', dir]),
    ).toEqual({ code: 0, output: { status: 'disconnected' } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pairing a second Kingdom keeps the first; --replace and disconnect touch only the chosen one', async () => {
  const a = mockKingdom(),
    b = mockKingdom(),
    dir = await configDirectory();
  const quiet = { open: false, log: () => {}, sleep: async () => {} };
  try {
    const first = await pairKingdom({ configDir: dir, url: a.url, ...quiet });
    const second = await pairKingdom({ configDir: dir, url: b.url, ...quiet });
    expect(first.id).not.toBe(second.id);
    const runtimes = async () => (await new ConfigStore(dir).load()).kingdomRuntimes ?? [];
    expect((await runtimes()).map((runtime) => [runtime.url, runtime.installationId])).toEqual([
      [a.url, first.installationId],
      [b.url, second.installationId],
    ]);
    expect((await kingdomStatus(dir)).runtimes.map((runtime) => runtime.status)).toEqual([
      'connected',
      'connected',
    ]);

    await expect(pairKingdom({ configDir: dir, replace: true, ...quiet })).rejects.toThrow(
      'Several Kingdoms',
    );
    const replaced = await pairKingdom({
      configDir: dir,
      replace: true,
      kingdom: first.id,
      ...quiet,
    });
    expect(replaced.id).toBe(first.id);
    const afterReplace = await runtimes();
    expect(afterReplace.map((runtime) => runtime.installationId)).toEqual([
      second.installationId,
      replaced.installationId,
    ]);
    expect(
      (await readdir(dir)).filter((name) => name.startsWith('kingdom-runtime-')).sort(),
    ).toEqual(
      [
        `kingdom-runtime-${second.installationId}.json`,
        `kingdom-runtime-${replaced.installationId}.json`,
      ].sort(),
    );

    b.revokeAll();
    const status = await kingdomStatus(dir);
    expect(status.status).toBe('unavailable');
    expect(status.runtimes.map((runtime) => [runtime.id, runtime.status])).toEqual([
      [second.id, 'unavailable'],
      [first.id, 'connected'],
    ]);

    const store = new ConfigStore(dir);
    await expect(disconnectKingdom(store)).rejects.toThrow('Several Kingdoms');
    expect((await disconnectKingdom(store, b.url))?.id).toBe(second.id);
    expect((await runtimes()).map((runtime) => runtime.installationId)).toEqual([
      replaced.installationId,
    ]);
    expect((await readdir(dir)).filter((name) => name.startsWith('kingdom-runtime-'))).toEqual([
      `kingdom-runtime-${replaced.installationId}.json`,
    ]);
  } finally {
    a.server.stop(true);
    b.server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test('archive setup publishes through the chosen Kingdom: required when several are paired, prompted when interactive', async () => {
  const a = mockKingdom(),
    b = mockKingdom({
      connections: [{ id: 'conn-b', name: 'B archive', groups: [], projectId: P1 }],
    });
  const dir = await configDirectory([P1, P2]);
  const quiet = { open: false, log: () => {}, sleep: async () => {} };
  try {
    const first = await pairKingdom({ configDir: dir, url: a.url, ...quiet });
    expect(
      (
        await runArchiveSetup({ configDir: dir, connection: 'kingdom', log: () => {} })
      ).projects.map((p) => p.status),
    ).toEqual(['connected', 'connected']);
    const second = await pairKingdom({ configDir: dir, url: b.url, ...quiet });
    await expect(runArchiveSetup({ configDir: dir, log: () => {} })).rejects.toThrow('--kingdom');

    // A project published through Kingdom A still needs a destination on Kingdom B.
    const result = await runArchiveSetup({ configDir: dir, kingdom: second.id, log: () => {} });
    expect(result.kingdom).toMatchObject({ status: 'connected', id: second.id, url: b.url });
    expect(result.projects).toEqual([
      { projectId: P1, status: 'connected' },
      { projectId: P2, status: 'skipped', reason: 'No Kingdom connection carries this project.' },
    ]);
    const saved = JSON.parse(await readFile(join(dir, 'archives.json'), 'utf8'));
    expect(
      saved.map((d: any) => [d.projectId, d.url, d.connectionId ?? null, d.credential.owner]),
    ).toEqual([
      [P1, `${a.url}/`, null, a.ownerKey],
      [P2, `${a.url}/`, null, a.ownerKey],
      [P1, `${b.url}/`, 'conn-b', b.ownerKey],
    ]);
    expect(
      (await runArchiveSetup({ configDir: dir, kingdom: b.url, log: () => {} })).projects[0],
    ).toEqual({ projectId: P1, status: 'configured' });
    expect(
      (await runArchiveSetup({ configDir: dir, kingdomUrl: a.url, log: () => {} })).projects.map(
        (p) => p.status,
      ),
    ).toEqual(['configured', 'configured']);

    const asked: string[][] = [];
    const prompts = {
      ask: async () => '',
      confirm: async () => false,
      secret: async () => '',
      choose: async (_: string, options: string[]) => {
        asked.push(options);
        return asked.length === 1 ? 1 : options.length - 1;
      },
    };
    const prompted = await runArchiveSetup({ configDir: dir, prompts, log: () => {} });
    expect(asked[0]).toEqual([
      `${a.url} as ${a.ownerKey} (${first.id}, connected)`,
      `${b.url} as ${b.ownerKey} (${second.id}, connected)`,
    ]);
    expect(prompted.kingdom.id).toBe(second.id);
    expect(prompted.projects).toEqual([
      { projectId: P1, status: 'configured' },
      { projectId: P2, status: 'skipped', reason: 'Skipped.' },
    ]);

    const config = await new ConfigStore(dir).load();
    const doctor = await inspectReadiness(config, {
      configDir: dir,
      transport: fetch,
      environment: {},
      which: () => '/controlled/cli',
    });
    expect(doctor.kingdoms?.map((item) => [item.id, item.status])).toEqual([
      [first.id, 'connected'],
      [second.id, 'connected'],
    ]);
    b.revokeAll();
    const degraded = await inspectReadiness(config, {
      configDir: dir,
      transport: fetch,
      environment: {},
      which: () => '/controlled/cli',
    });
    expect(degraded.kingdoms?.map((item) => [item.id, item.status])).toEqual([
      [first.id, 'connected'],
      [second.id, 'unavailable'],
    ]);
    expect(
      degraded.issues
        .filter((item) => item.code === 'kingdom-unavailable')
        .map((item) => item.scope),
    ).toEqual([`kingdom:${second.id}`]);
    expect(degraded.archives?.find((item) => item.projectId === P1)?.status).toBe(
      'verification-failing',
    );
    expect(degraded.archives?.find((item) => item.projectId === P2)?.status).toBe('configured');
    await disconnectKingdom(new ConfigStore(dir), second.id);
    const unpaired = await inspectReadiness(await new ConfigStore(dir).load(), {
      configDir: dir,
      environment: {},
      which: () => '/controlled/cli',
    });
    expect(unpaired.archives?.find((item) => item.projectId === P1)?.status).toBe(
      'verification-failing',
    );
  } finally {
    a.server.stop(true);
    b.server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
