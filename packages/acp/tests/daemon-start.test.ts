import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { client, type InitializeRequest } from '@agentclientprotocol/sdk';
import {
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
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
