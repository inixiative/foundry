import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localArchiveUrl } from '../src/archives/local';
import { runArchiveSetup } from '../src/archives/setup';
import { kingdomStatus, pairKingdom } from '../src/providers/kingdom-cli';
import {
  kingdomInstallationPaths,
  kingdomIntegrationId,
} from '../src/providers/kingdom-installation-connection';
import {
  disconnectKingdom,
  pairKingdomIntegration,
  saveKingdomIntegration,
} from '../src/providers/kingdom-pairing';
import { inspectReadiness } from '../src/readiness';
import { ConfigStore } from '../src/viewer/config';
import { startFakeArchive } from './helpers/fake-archive';
import { type MockKingdom, mockKingdom, userOwner } from './helpers/kingdom-installation';

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

/** The Signet files this Foundry holds for one Kingdom. */
const signetFiles = async (dir: string, kingdom: MockKingdom) => {
  const { directory } = kingdomInstallationPaths(dir, kingdom.url);
  if (!existsSync(directory)) return [];
  return (await readdir(directory)).filter((name) => name.startsWith('signet-')).sort();
};
const quiet = { open: false, log: () => {} };

test('shared pairing collects the Signet privately once the owner is confirmed, and disconnect keeps nothing', async () => {
  const kingdom = mockKingdom(),
    dir = await configDirectory(),
    owner = userOwner();
  const store = new ConfigStore(dir);
  try {
    await expect(
      pairKingdomIntegration(store, dir, {
        url: kingdom.url,
        name: 'Test',
        replace: '000000000000',
        onReview: () => {},
      }),
    ).rejects.toThrow('not paired at that address');
    const reviews: string[] = [];
    const { id, settings } = await pairKingdomIntegration(store, dir, {
      url: kingdom.url,
      name: 'Test',
      viewerToken: 't'.repeat(48),
      onReview: (review) => {
        reviews.push(review.reviewCode, review.review);
        kingdom.approve(owner);
      },
    });
    expect(reviews[1]).toBe(`${kingdom.url}/dashboard?reviewSignet=${reviews[0]}`);
    expect(kingdom.calls).toContain('registerInstallation');
    expect(kingdom.calls).toContain('collectSignet');
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    const file = join(
      kingdomInstallationPaths(dir, kingdom.url).directory,
      `signet-${settings.signetId}.json`,
    );
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
    expect(saved.kingdomIntegrations).toEqual([
      {
        url: kingdom.url,
        owner,
        integrationId: settings.integrationId,
        signetId: settings.signetId,
      },
    ]);
    expect(id).toBe(kingdomIntegrationId({ url: kingdom.url, owner }));
    expect(JSON.stringify(saved)).not.toContain(
      JSON.parse(await readFile(file, 'utf8')).accessToken,
    );
    expect(kingdom.credentials).toEqual([
      { integrationId: settings.integrationId, token: 't'.repeat(48) },
    ]);
    await expect(
      saveKingdomIntegration(store, dir, { ...settings, signetId: crypto.randomUUID() }),
    ).rejects.toThrow('--replace');

    expect((await disconnectKingdom(store, dir))?.integrationId).toBe(settings.integrationId);
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))).not.toHaveProperty(
      'kingdomIntegrations',
    );
    expect(existsSync(file)).toBe(false);
    expect(await disconnectKingdom(store, dir)).toBeUndefined();
  } finally {
    kingdom.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI pairing shows the review code, opens the review page and persists like the viewer; the same owner again needs --replace', async () => {
  const owner = userOwner(),
    kingdom = mockKingdom({ autoApprove: owner }),
    dir = await configDirectory();
  const lines: string[] = [],
    opened: string[] = [];
  try {
    const result = await pairKingdom({
      configDir: dir,
      url: kingdom.url,
      name: 'CLI Foundry',
      log: (line) => lines.push(line),
      launch: (url) => opened.push(url),
    });
    expect(result).toMatchObject({
      status: 'connected',
      url: kingdom.url,
      owner,
      restartViewer: false,
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toStartWith(`${kingdom.url}/dashboard?reviewSignet=`);
    expect(lines.join('\n')).toContain(opened[0]!.split('=')[1]!);
    expect((await new ConfigStore(dir).load()).kingdomIntegrations).toEqual([
      { url: kingdom.url, owner, integrationId: result.integrationId, signetId: result.signetId },
    ]);
    expect(await kingdomStatus(dir)).toEqual({
      status: 'connected',
      integrations: [
        {
          id: result.id,
          url: kingdom.url,
          owner,
          integrationId: result.integrationId,
          signetId: result.signetId,
          status: 'connected',
        },
      ],
    });
    // The same Kingdom + owner again is refused before anything is collected.
    await expect(pairKingdom({ configDir: dir, url: kingdom.url, ...quiet })).rejects.toThrow(
      '--replace',
    );
    expect(await signetFiles(dir, kingdom)).toEqual([`signet-${result.signetId}.json`]);
    const replaced = await pairKingdom({ configDir: dir, replace: true, ...quiet });
    expect(replaced).toMatchObject({ id: result.id, url: kingdom.url });
    expect(replaced.signetId).not.toBe(result.signetId);
    expect(await signetFiles(dir, kingdom)).toEqual([`signet-${replaced.signetId}.json`]);
    kingdom.list(replaced.signetId, false);
    expect((await kingdomStatus(dir)).status).toBe('unavailable');
  } finally {
    kingdom.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI pairing stops when Kingdom declines, without a Signet or binding', async () => {
  const kingdom = mockKingdom(),
    dir = await configDirectory();
  try {
    await expect(
      pairKingdom({
        configDir: dir,
        url: kingdom.url,
        open: false,
        log: (line) => {
          if (line.startsWith('Waiting')) kingdom.decline();
        },
      }),
    ).rejects.toThrow('declined');
    expect(await signetFiles(dir, kingdom)).toEqual([]);
    expect((await new ConfigStore(dir).load()).kingdomIntegrations).toBeUndefined();
    expect(await kingdomStatus(dir)).toEqual({ status: 'disconnected', integrations: [] });
  } finally {
    kingdom.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('pairing a second Kingdom keeps the first; --replace and disconnect touch only the chosen one', async () => {
  const a = mockKingdom({ autoApprove: userOwner() }),
    b = mockKingdom({ autoApprove: userOwner() }),
    dir = await configDirectory();
  try {
    const first = await pairKingdom({ configDir: dir, url: a.url, ...quiet });
    const second = await pairKingdom({ configDir: dir, url: b.url, ...quiet });
    expect(first.id).not.toBe(second.id);
    const integrations = async () => (await new ConfigStore(dir).load()).kingdomIntegrations ?? [];
    expect((await integrations()).map((item) => [item.url, item.signetId])).toEqual([
      [a.url, first.signetId],
      [b.url, second.signetId],
    ]);
    expect((await kingdomStatus(dir)).integrations.map((item) => item.status)).toEqual([
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
    expect((await integrations()).map((item) => item.signetId)).toEqual([
      second.signetId,
      replaced.signetId,
    ]);
    expect(await signetFiles(dir, a)).toEqual([`signet-${replaced.signetId}.json`]);
    expect(await signetFiles(dir, b)).toEqual([`signet-${second.signetId}.json`]);

    b.list(second.signetId, false);
    const status = await kingdomStatus(dir);
    expect(status.status).toBe('unavailable');
    expect(status.integrations.map((item) => [item.id, item.status])).toEqual([
      [second.id, 'unavailable'],
      [first.id, 'connected'],
    ]);

    const store = new ConfigStore(dir);
    await expect(disconnectKingdom(store, dir)).rejects.toThrow('Several Kingdoms');
    expect((await disconnectKingdom(store, dir, b.url))?.id).toBe(second.id);
    expect((await integrations()).map((item) => item.signetId)).toEqual([replaced.signetId]);
    expect(await signetFiles(dir, b)).toEqual([]);
    expect(await signetFiles(dir, a)).toEqual([`signet-${replaced.signetId}.json`]);
  } finally {
    a.stop();
    b.stop();
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
      output: { status: 'disconnected', integrations: [] },
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
  const a = mockKingdom({ autoApprove: userOwner() }),
    b = mockKingdom({ autoApprove: userOwner() }),
    archive = startFakeArchive();
  const dir = await configDirectory([P1]);
  const inspect = async (options: Partial<Parameters<typeof inspectReadiness>[1]> = {}) =>
    inspectReadiness(await new ConfigStore(dir).load(), {
      environment: {},
      which: () => '/controlled/cli',
      configDir: dir,
      ...options,
    });
  try {
    const first = await pairKingdom({ configDir: dir, url: a.url, ...quiet });
    const second = await pairKingdom({ configDir: dir, url: b.url, ...quiet });
    const live = await inspect({ transport: fetch, archive: () => archive.client() });
    expect(live.kingdoms).toEqual([
      expect.objectContaining({
        id: first.id,
        status: 'connected',
        url: a.url,
        owner: first.owner,
      }),
      expect.objectContaining({ id: second.id, status: 'connected', url: b.url }),
    ]);
    expect(live.archive).toEqual({ status: 'reachable', url: localArchiveUrl() });
    expect(live.issues.filter((item) => /^(archive|kingdom)/.test(item.code))).toEqual([]);

    const offline = await inspect({ archive: () => archive.client() });
    expect(offline.kingdoms?.map((item) => item.status)).toEqual(['unverified', 'unverified']);
    expect(offline.archive?.status).toBe('unverified');

    b.list(second.signetId, false);
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

    await rm(join(kingdomInstallationPaths(dir, a.url).directory, `signet-${first.signetId}.json`));
    expect(
      (await inspect()).issues.find((item) => item.scope === `kingdom:${first.id}`)?.code,
    ).toBe('kingdom-credential-unavailable');

    const unset = await inspect({ archive: () => undefined });
    expect(unset.archive?.status).toBe('not-set-up');
    expect(unset.issues.map((item) => item.code)).toContain('archive-not-set-up');
    expect(unset.issues.find((item) => item.code === 'archive-not-set-up')?.severity).toBe(
      'warning',
    );
    expect((await inspect()).archive).toBeUndefined();
  } finally {
    a.stop();
    b.stop();
    archive.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
