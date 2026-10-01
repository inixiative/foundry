import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localArchiveUrl } from '../src/archives/local';
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
import { startFakeArchive } from './helpers/fake-archive';

const P1 = 'd8deab98-d4a6-43d9-9e65-ae783e58ae42';
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

/** Kingdom's access surface: pairing approves on first poll unless held; heartbeat trusts approved hashes. */
function mockKingdom(
  options: { expiresInMs?: number; hold?: boolean; owner?: Record<string, string> } = {},
) {
  const owner = options.owner ?? { ownerModel: 'User', userId: crypto.randomUUID() };
  const hashes = new Map<string, string>(),
    pairings = new Map<string, { hash: string; installationId: string }>();
  const calls: { action: string; body: any }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request): Promise<Response> {
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

test('archive setup starts the local Archive only when it is not answering', async () => {
  const archive = startFakeArchive();
  let installed = false,
    ups = 0;
  const lines: string[] = [];
  const options = {
    connect: () => (installed ? archive.client() : undefined),
    up: async () => {
      ups++;
      installed = true;
    },
    log: (line: string) => lines.push(line),
  };
  const declining = {
    ask: async () => '',
    choose: async () => 0,
    confirm: async () => false,
    secret: async () => '',
  };
  try {
    expect(await runArchiveSetup({ ...options, prompts: declining })).toEqual({
      configured: false,
      reachable: false,
      url: localArchiveUrl(),
      started: false,
    });
    expect(ups).toBe(0);
    const started = await runArchiveSetup(options);
    expect(started).toMatchObject({ configured: true, reachable: true, started: true });
    expect(started.integrations?.map((integration) => integration.key)).toContain('github');
    expect(lines.at(-1)).toContain('Hosted Archives connect through Kingdom');
    expect(await runArchiveSetup(options)).toMatchObject({ reachable: true, started: false });
    expect(ups).toBe(1);
    expect(
      await runArchiveSetup({
        ...options,
        connect: () => undefined,
        up: async () => {
          throw Error('archive up failed; check that Docker is running.');
        },
      }),
    ).toMatchObject({
      reachable: false,
      started: false,
      error: 'archive up failed; check that Docker is running.',
    });
  } finally {
    archive.stop();
  }
});

test('archive setup and kingdom CLIs run non-interactively; other archive commands are the Archive CLI', async () => {
  const dir = await configDirectory([P1]);
  const archive = startFakeArchive();
  const run = async (script: string, args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, new URL(script, import.meta.url).pathname, ...args],
      {
        env: {
          PATH: process.env.PATH,
          VIEWER_PORT: process.env.VIEWER_PORT,
          ARCHIVE_URL: archive.url,
          ARCHIVE_TOKEN: archive.token,
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const stdout = await new Response(child.stdout).text();
    return { code: await child.exited, stdout };
  };
  try {
    const setup = await run('../src/archives/cli.ts', ['setup', '--yes']);
    expect(setup.code).toBe(0);
    expect(JSON.parse(setup.stdout)).toMatchObject({
      configured: true,
      reachable: true,
      url: archive.url,
      started: false,
    });
    const help = await run('../src/archives/cli.ts', ['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('up | down');
    const kingdom = async (args: string[]) => {
      const result = await run('../src/providers/kingdom-cli.ts', args);
      return { code: result.code, output: JSON.parse(result.stdout) };
    };
    expect(await kingdom(['status', '--config-dir', dir])).toEqual({
      code: 0,
      output: { status: 'disconnected', runtimes: [] },
    });
    expect(await kingdom(['disconnect', '--config-dir', dir])).toEqual({
      code: 0,
      output: { status: 'disconnected' },
    });
  } finally {
    archive.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('doctor checks every paired Kingdom and the local Archive', async () => {
  const a = mockKingdom(),
    b = mockKingdom(),
    archive = startFakeArchive();
  const dir = await configDirectory([P1]);
  const quiet = { open: false, log: () => {}, sleep: async () => {} };
  const inspect = async (options: Partial<Parameters<typeof inspectReadiness>[1]> = {}) =>
    inspectReadiness(await new ConfigStore(dir).load(), {
      environment: {},
      which: () => '/controlled/cli',
      ...options,
    });
  try {
    const first = await pairKingdom({ configDir: dir, url: a.url, ...quiet });
    const second = await pairKingdom({ configDir: dir, url: b.url, ...quiet });
    const live = await inspect({ transport: fetch, archive: () => archive.client() });
    expect(live.kingdoms).toEqual([
      expect.objectContaining({ id: first.id, status: 'connected', url: a.url, owner: a.ownerKey }),
      expect.objectContaining({ id: second.id, status: 'connected', url: b.url }),
    ]);
    expect(live.archive).toEqual({ status: 'reachable', url: localArchiveUrl() });
    expect(live.issues.filter((item) => /^(archive|kingdom)/.test(item.code))).toEqual([]);

    const offline = await inspect({ archive: () => archive.client() });
    expect(offline.kingdoms?.map((item) => item.status)).toEqual(['unverified', 'unverified']);
    expect(offline.archive?.status).toBe('unverified');

    b.revokeAll();
    archive.fail(true);
    const degraded = await inspect({ transport: fetch, archive: () => archive.client() });
    expect(degraded.kingdoms?.map((item) => [item.id, item.status])).toEqual([
      [first.id, 'connected'],
      [second.id, 'unavailable'],
    ]);
    expect(degraded.configurationReady).toBe(false);
    expect(
      degraded.issues
        .filter((item) => /^(archive|kingdom)/.test(item.code))
        .map((item) => [item.scope, item.code]),
    ).toEqual([
      [`kingdom:${second.id}`, 'kingdom-unavailable'],
      ['archive', 'archive-unreachable'],
    ]);
    expect(degraded.archive?.status).toBe('unreachable');

    const unset = await inspect({ archive: () => undefined });
    expect(unset.archive?.status).toBe('not-set-up');
    expect(unset.issues.map((item) => item.code)).toContain('archive-not-set-up');
    expect(unset.issues.find((item) => item.code === 'archive-not-set-up')?.severity).toBe(
      'warning',
    );
    expect((await inspect()).archive).toBeUndefined();
  } finally {
    a.server.stop(true);
    b.server.stop(true);
    archive.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
