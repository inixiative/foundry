import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { client, type InitializeRequest } from '@agentclientprotocol/sdk';
import { newAcpCapability, writeAcpLaunch } from '@inixiative/foundry/client';
import {
  ContextStack,
  EventStream,
  Executor,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
import { ConfigStore, starterConfig } from '../../foundry/src/viewer/config';
import { createViewer } from '../../foundry/src/viewer/server';
import { createFoundryAgent } from '../src/agent';
import { promptText } from '../src/prompt';
import { serveDaemon } from './helpers/acp-host';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const INITIALIZE: InitializeRequest = {
  protocolVersion: 1,
  clientCapabilities: {},
  clientInfo: { name: 'test', version: '0' },
};

test('a daemon that is down is started, and initialize waits for it to answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-acp-start-'));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const launchPath = join(dir, 'acp-launch.json');
  const viewer = createViewer({
    harness: new Harness(new Thread('main', new ContextStack())),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
  });
  cleanup.push(async () => {
    await viewer.analyticsReady.catch(() => {});
    viewer.localStore?.close();
  });
  let starts = 0;
  const agentApp = createFoundryAgent({
    launchPath,
    daemonWaitMs: 5_000,
    log: () => {},
    // Stands in for launchd: the daemon comes up a moment later and publishes its launch file.
    startDaemon: async () => {
      starts++;
      setTimeout(() => {
        const daemon = serveDaemon(viewer, launchPath);
        cleanup.push(() => daemon.stop());
      }, 300);
    },
  });
  const connection = client({ name: 'test' }).connect(agentApp);
  cleanup.push(() => connection.close());
  const init = await connection.agent.request('initialize', INITIALIZE);
  expect(starts).toBe(1);
  expect(init.protocolVersion).toBe(1);
  // Already running: no second start.
  await connection.agent.request('initialize', INITIALIZE);
  expect(starts).toBe(1);
});

test('a daemon that never comes up fails initialize with the reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-acp-start-'));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const agentApp = createFoundryAgent({
    launchPath: join(dir, 'acp-launch.json'),
    daemonWaitMs: 400,
    log: () => {},
    startDaemon: async () => {},
  });
  const connection = client({ name: 'test' }).connect(agentApp);
  cleanup.push(() => connection.close());
  const error = await connection.agent.request('initialize', INITIALIZE).catch((e: Error) => e);
  expect(String((error as Error).message)).toContain('did not start');
});

test('prompt blocks flatten to one payload: text, file links as @ paths, embedded text fenced', () => {
  expect(
    promptText([
      { type: 'text', text: 'Fix it' },
      { type: 'resource_link', uri: 'file:///repo/src/a%20b.ts', name: 'a b.ts' },
      { type: 'resource_link', uri: 'https://example.com/spec', name: 'spec' },
      { type: 'resource', resource: { uri: 'file:///repo/notes.md', text: '# Notes' } },
      { type: 'image', data: '', mimeType: 'image/png' },
    ]),
  ).toBe(
    'Fix it\n\n@/repo/src/a b.ts\n\n@https://example.com/spec\n\n<resource uri="file:///repo/notes.md">\n# Notes\n</resource>\n\n[image content omitted]',
  );
});

/** A daemon whose executor holds every turn until released, served on loopback with its launch file. */
async function holdingDaemon(dir: string, launchPath: string, port = 0) {
  const started: string[] = [];
  const releases: Array<() => void> = [];
  const main = new Thread('main', new ContextStack());
  main.register(
    new Executor({
      id: 'worker',
      stack: main.stack,
      handler: async (_context, payload) => {
        started.push(String(payload));
        await new Promise<void>((resolve) => releases.push(resolve));
        return 'released';
      },
    }),
  );
  const harness = new Harness(main);
  harness.setDefaultExecutor('worker');
  // New threads (every ACP session is one) take their executor from settings.
  const config = starterConfig('controlled', 'controlled');
  config.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      provider: 'controlled',
      model: 'controlled',
      prompt: 'Hold',
      enabled: true,
      visibleLayers: [],
      peers: [],
      maxDepth: 1,
      temperature: 0,
    },
  };
  const configStore = new ConfigStore(dir);
  await configStore.save(config);
  const viewer = createViewer({
    harness,
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
    configStore,
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: viewer.fetch,
    websocket: viewer.websocket,
  });
  writeAcpLaunch(launchPath, { port: server.port!, capability: newAcpCapability() });
  let stopped = false;
  /** The daemon process goes away: its listener and sockets close; its turns are left as they were. */
  const halt = () => {
    if (stopped) return;
    stopped = true;
    server.stop(true);
    viewer.stopSocket();
  };
  cleanup.push(async () => {
    for (const release of releases) release();
    halt();
    await viewer.analyticsReady.catch(() => {});
    viewer.localStore?.close();
  });
  return { started, port: server.port!, halt };
}

async function connected(launchPath: string, daemonLostMs = 300) {
  const agentApp = createFoundryAgent({ launchPath, daemonLostMs, log: () => {} });
  const connection = client({ name: 'test' }).connect(agentApp);
  cleanup.push(() => connection.close());
  await connection.agent.request('initialize', INITIALIZE);
  return connection;
}

test('a turn whose daemon goes away fails once the daemon has been unreachable too long', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-acp-lost-'));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const launchPath = join(dir, 'acp-launch.json');
  const daemon = await holdingDaemon(join(dir, 'a'), launchPath);
  const connection = await connected(launchPath);
  const { sessionId } = await connection.agent.request('session/new', { cwd: dir, mcpServers: [] });
  const prompt = connection.agent
    .request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hold' }] })
    .catch((error: Error) => error);
  while (!daemon.started.length) await Bun.sleep(10);
  daemon.halt();
  const outcome = await prompt;
  expect(String((outcome as Error).message)).toContain('Lost the connection to the Foundry daemon');
});

test('a turn whose daemon restarted without its thread fails instead of hanging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-acp-restart-'));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const launchPath = join(dir, 'acp-launch.json');
  const first = await holdingDaemon(join(dir, 'a'), launchPath);
  const connection = await connected(launchPath, 10_000);
  const { sessionId } = await connection.agent.request('session/new', { cwd: dir, mcpServers: [] });
  const prompt = connection.agent
    .request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hold' }] })
    .catch((error: Error) => error);
  while (!first.started.length) await Bun.sleep(10);
  first.halt();
  // A fresh daemon on the same port with an empty journal: the session's thread is gone.
  await holdingDaemon(join(dir, 'b'), launchPath, first.port);
  const outcome = await prompt;
  expect(String((outcome as Error).message)).toContain('no longer holds this thread');
});
