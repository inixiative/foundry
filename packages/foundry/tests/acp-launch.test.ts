import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
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
  readAcpLaunch,
  removeAcpLaunch,
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
  const written = writeAcpLaunch(path, { port: 45_123 });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readAcpLaunch(path)).toEqual(written);
  expect(written).toMatchObject({ version: 1, endpoint: 'http://127.0.0.1:45123' });

  chmodSync(path, 0o644);
  expect(() => readAcpLaunch(path)).toThrow('mode must be 0600');
  chmodSync(path, 0o600);

  const link = join(dir, 'link.json');
  symlinkSync(path, link);
  expect(() => readAcpLaunch(link)).toThrow('symlink');

  const remote = join(dir, 'remote.json');
  writeFileSync(remote, JSON.stringify({ version: 1, endpoint: 'http://example.com:1' }), {
    mode: 0o600,
  });
  expect(() => readAcpLaunch(remote)).toThrow('loopback');
});

/** A viewer served on an ephemeral loopback port with a tunnel token, as the daemon runs while tunnelled. */
function tunnelled() {
  const dir = tempDir();
  const viewer = createViewer({
    harness: new Harness(new Thread('main', new ContextStack())),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
    tunnel: { port: 0, token: 'T'.repeat(40), configDir: dir },
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
  return { endpoint: `http://127.0.0.1:${server.port}`, viewer };
}

test('while tunnelled, a direct loopback client reaches the API and the data-stream socket', async () => {
  const t = tunnelled();
  expect((await new FoundryClient({ endpoint: t.endpoint }).thread('main')).threadId).toBe('main');
  const streams = new DataStreamClient({ endpoint: t.endpoint });
  cleanup.push(() => streams.dispose());
  let snapshot: unknown;
  await streams.open('threads', { snapshot: (payload) => (snapshot = payload), append() {} });
  expect(snapshot).toMatchObject({ projectId: null });
});

test('tunnel traffic still needs the token: a public Host or proxy headers', async () => {
  const t = tunnelled();
  const request = (url: string, headers: Record<string, string> = {}) =>
    t.viewer.app.request(url, { headers });
  expect((await request('http://127.0.0.1:4500/api/threads/main')).status).toBe(200);
  expect((await request('https://foundry-x.trycloudflare.com/api/threads/main')).status).toBe(401);
  expect((await request('https://foundry-x.loca.lt/api/settings')).status).toBe(401);
  expect(
    (await request('http://127.0.0.1:4500/api/threads/main', { 'x-forwarded-for': '203.0.113.9' }))
      .status,
  ).toBe(401);
  expect(
    (await request('http://localhost:4500/api/threads/main', { 'cf-connecting-ip': '203.0.113.9' }))
      .status,
  ).toBe(401);
  expect(
    (
      await request('https://foundry-x.loca.lt/api/threads/main', {
        authorization: `Bearer ${'T'.repeat(40)}`,
      })
    ).status,
  ).toBe(200);
});

test('an absolute-form request line naming loopback cannot pose as this machine', async () => {
  const t = tunnelled();
  const port = Number(new URL(t.endpoint).port);
  const status = (request: string) =>
    new Promise<string>((resolve) => {
      let reply = '';
      const socket = connect(port, '127.0.0.1', () => socket.write(request));
      socket.on('data', (chunk) => {
        reply += chunk;
      });
      socket.on('close', () => resolve(reply.split(' ')[1] ?? ''));
    });
  // Bun builds the URL from Host, so a tunnelled request keeps its public host.
  expect(
    await status(
      'GET http://127.0.0.1/api/threads/main HTTP/1.1\r\nHost: foundry-x.loca.lt\r\nConnection: close\r\n\r\n',
    ),
  ).toBe('401');
  expect(
    await status('GET /api/threads/main HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'),
  ).toBe('200');
});

test("the daemon removes its launch file at shutdown, but never a newer daemon's", () => {
  const path = join(tempDir(), 'acp-launch.json');
  writeAcpLaunch(path, { port: 4999, pid: 4242 });
  removeAcpLaunch(path, process.pid);
  expect(readAcpLaunch(path).pid).toBe(4242);
  removeAcpLaunch(path, 4242);
  expect(() => readAcpLaunch(path)).toThrow();
  // Already gone: nothing to do.
  removeAcpLaunch(path, 4242);
});
