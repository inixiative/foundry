import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
import {
  DataStreamClient,
  FoundryClient,
  FoundryHttpError,
  newAcpCapability,
  readAcpLaunch,
  writeAcpLaunch,
} from '../src/client';
import { createViewer } from '../src/viewer/server';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-acp-launch-'));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}

test('the launch file is written private and read back; anything else is refused', () => {
  const dir = tempDir();
  const path = join(dir, 'nested', 'acp-launch.json');
  const capability = newAcpCapability();
  const written = writeAcpLaunch(path, { port: 45_123, capability });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readAcpLaunch(path)).toEqual(written);
  expect(written).toMatchObject({ version: 1, endpoint: 'http://127.0.0.1:45123', capability });

  chmodSync(path, 0o644);
  expect(() => readAcpLaunch(path)).toThrow('mode must be 0600');
  chmodSync(path, 0o600);

  const link = join(dir, 'link.json');
  symlinkSync(path, link);
  expect(() => readAcpLaunch(link)).toThrow('symlink');

  const remote = join(dir, 'remote.json');
  writeFileSync(
    remote,
    JSON.stringify({ version: 1, endpoint: 'http://example.com:1', capability }),
    { mode: 0o600 },
  );
  expect(() => readAcpLaunch(remote)).toThrow('loopback');
  // Errors never echo the file's contents.
  try {
    readAcpLaunch(remote);
  } catch (error) {
    expect((error as Error).message).not.toContain(capability);
  }
});

/** A viewer served on an ephemeral loopback port with a tunnel token, as the daemon runs while tunnelled. */
function tunnelled() {
  const dir = tempDir();
  const capability = newAcpCapability();
  const viewer = createViewer({
    harness: new Harness(new Thread('main', new ContextStack())),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
    tunnel: { port: 0, token: 'T'.repeat(40), configDir: dir },
    acpCapability: capability,
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: viewer.fetch,
    websocket: viewer.websocket,
  });
  cleanup.push(async () => {
    server.stop(true);
    viewer.stopSocket();
    await viewer.analyticsReady.catch(() => {});
    viewer.localStore?.close();
  });
  return { endpoint: `http://127.0.0.1:${server.port}`, capability, viewer };
}

test('while tunnelled, the API accepts the ACP capability as a bearer and nothing weaker', async () => {
  const t = tunnelled();
  expect(
    (await new FoundryClient({ endpoint: t.endpoint, capability: t.capability }).thread('main'))
      .threadId,
  ).toBe('main');
  const anonymous = await new FoundryClient({ endpoint: t.endpoint })
    .thread('main')
    .catch((error) => error);
  expect(anonymous).toBeInstanceOf(FoundryHttpError);
  expect((anonymous as FoundryHttpError).status).toBe(401);
  const wrong = await new FoundryClient({ endpoint: t.endpoint, capability: newAcpCapability() })
    .thread('main')
    .catch((error) => error);
  expect((wrong as FoundryHttpError).status).toBe(401);
});

test('while tunnelled, the data-stream socket upgrades only with the capability', async () => {
  const t = tunnelled();
  const authorized = new DataStreamClient({ endpoint: t.endpoint, capability: t.capability });
  cleanup.push(() => authorized.dispose());
  let snapshot: unknown;
  await authorized.open('threads', { snapshot: (payload) => (snapshot = payload), append() {} });
  expect(snapshot).toMatchObject({ projectId: null });

  const refused = new DataStreamClient({ endpoint: t.endpoint });
  cleanup.push(() => refused.dispose());
  await expect(refused.connect()).rejects.toThrow();
});

test('the ACP capability is refused through the tunnel: a public Host or proxy headers', async () => {
  const t = tunnelled();
  const request = (url: string, headers: Record<string, string> = {}) =>
    t.viewer.app.request(url, { headers: { authorization: `Bearer ${t.capability}`, ...headers } });
  expect((await request('http://127.0.0.1:4500/api/threads/main')).status).toBe(200);
  expect((await request('https://foundry-x.trycloudflare.com/api/threads/main')).status).toBe(401);
  expect((await request('https://foundry-x.trycloudflare.com/api/settings')).status).toBe(401);
  expect(
    (await request('http://127.0.0.1:4500/api/threads/main', { 'x-forwarded-for': '203.0.113.9' }))
      .status,
  ).toBe(401);
  expect(
    (await request('http://localhost:4500/api/threads/main', { 'cf-connecting-ip': '203.0.113.9' }))
      .status,
  ).toBe(401);
});
