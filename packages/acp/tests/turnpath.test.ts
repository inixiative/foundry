import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { client, type InitializeRequest } from '@agentclientprotocol/sdk';
import { newAcpCapability, readAcpLaunch, writeAcpLaunch } from '@inixiative/foundry/client';
import type { CreateSessionOpts } from '../../foundry/src/providers/session-adapter';
import { liveWatchFixture } from '../../foundry/tests/helpers/live-watch-fixture';
import { createFoundryAgent } from '../src/agent';
import { serveDaemon, spawnFoundryAcp, until } from './helpers/acp-host';

type ToolGate = NonNullable<CreateSessionOpts['toolGate']>;

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const INITIALIZE: InitializeRequest = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
  clientInfo: { name: 'Paseo', version: 'dev' },
};

type Fixture = Awaited<ReturnType<typeof liveWatchFixture>>;

async function fixture() {
  await mkdir(resolve('.foundry/qa'), { recursive: true });
  const dir = await mkdtemp(resolve('.foundry/qa/turnpath-'));
  const f = await liveWatchFixture(dir);
  cleanup.push(() => f.close());
  return { f, dir };
}

/** A daemon on a fixed port that can restart on the same port, as the launchd daemon does on 4500. */
function restartableDaemon(f: Fixture, dir: string) {
  let server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: f.viewer.fetch,
    websocket: f.viewer.websocket,
  });
  const port = server.port!;
  const launchPath = join(dir, 'acp-launch.json');
  writeAcpLaunch(launchPath, { port, capability: newAcpCapability() });
  cleanup.push(() => server.stop(true));
  return {
    launchPath,
    async restart() {
      server.stop(true);
      await Bun.sleep(100);
      server = Bun.serve({
        hostname: '127.0.0.1',
        port,
        fetch: f.viewer.fetch,
        websocket: f.viewer.websocket,
      });
    },
  };
}

function host(launchPath: string) {
  const h = spawnFoundryAcp(launchPath);
  cleanup.push(() => h.close());
  return h;
}

async function turn(
  h: ReturnType<typeof spawnFoundryAcp>,
  f: Fixture,
  sessionId: string,
  text: string,
) {
  const before = f.attempts.length;
  const prompt = h.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  await until(
    () => f.attempts.length === before + 1 && f.attempts[before]!.native.dispatch === 'attempted',
    `turn "${text}" dispatched`,
  );
  f.attempts[before]!.finish(false, 'done');
  expect(await prompt).toEqual({ stopReason: 'end_turn' });
}

test("a daemon restart on the same port re-applies the host's mode before the next turn", async () => {
  const { f, dir } = await fixture();
  const daemon = restartableDaemon(f, dir);
  const h = host(daemon.launchPath);
  await h.agent.request('initialize', INITIALIZE);
  const { sessionId } = await h.agent.request('session/new', {
    cwd: join(dir, 'P'),
    mcpServers: [],
  });
  await h.agent.request('session/set_mode', { sessionId, modeId: 'plan' });
  await turn(h, f, sessionId, 'first');
  expect(f.created.at(-1)).toMatchObject({ permissionMode: 'plan' });

  // The restarted daemon holds no launch settings.
  f.threadLaunch.clear(sessionId);
  await daemon.restart();
  await until(() => f.threadLaunch.get(sessionId).permissionMode === 'plan', 're-applied', 5_000);
  await turn(h, f, sessionId, 'after restart');
  expect(f.created.at(-1)).toMatchObject({ permissionMode: 'plan' });
});

test('an ACP thread whose host mode is unknown asks (default), never full access; a viewer thread keeps full access', async () => {
  const { f, dir } = await fixture();
  const daemon = restartableDaemon(f, dir);
  const h = host(daemon.launchPath);
  await h.agent.request('initialize', INITIALIZE);
  const { sessionId } = await h.agent.request('session/new', {
    cwd: join(dir, 'P'),
    mcpServers: [],
  });
  f.threadLaunch.clear(sessionId);
  expect(f.threadLaunch.forLaunch(sessionId).permissionMode).toBe('default');
  expect(f.threadLaunch.forLaunch(f.thread.id).permissionMode).toBeUndefined();
});

test("one host's cancel withdraws only its own turns' asks, never another host's on the same thread", async () => {
  const { f, dir } = await fixture();
  const daemon = serveDaemon(f.viewer);
  cleanup.push(() => daemon.stop());
  const a = host(daemon.launchPath);
  const b = host(daemon.launchPath);
  await a.agent.request('initialize', INITIALIZE);
  await b.agent.request('initialize', INITIALIZE);
  const cwd = join(dir, 'P');
  const { sessionId } = await b.agent.request('session/new', { cwd, mcpServers: [] });
  await a.agent.request('session/resume', { sessionId, cwd, mcpServers: [] });
  const before = f.attempts.length;
  const bPrompt = b.agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'B work' }],
  });
  await until(
    () => f.attempts.length === before + 1 && f.attempts[before]!.native.dispatch === 'attempted',
    'B dispatched',
  );
  const gate = f.created.at(-1)!.toolGate as ToolGate;
  const ask = gate({
    stage: 'permission',
    toolName: 'Bash',
    toolInput: { command: 'make' },
    callId: 'c1',
  });
  await until(() => b.permissions.length === 1 && a.permissions.length === 1, 'both hosts asked');
  // A queues a prompt behind B's turn, then cancels it.
  const aPrompt = a.agent
    .request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'A work' }] })
    .catch((error: unknown) => error);
  await Bun.sleep(300);
  await a.agent.notify('session/cancel', { sessionId });
  const decision = await Promise.race([ask, Bun.sleep(1_000).then(() => 'still pending')]);
  expect(decision).toBe('still pending');
  expect(f.actionQueue.pending()).toHaveLength(1);
  // B cancels its own turn: its ask is withdrawn.
  await b.agent.notify('session/cancel', { sessionId });
  expect(await ask).toMatchObject({ behavior: 'deny' });
  f.attempts[before]!.finish(false, 'done');
  await bPrompt.catch(() => {});
  await aPrompt;
});

test('a cancel while the prompt is still reaching the daemon stops it: nothing is sent', async () => {
  const { f, dir } = await fixture();
  const launchPath = join(dir, 'acp-launch.json');
  let daemon = serveDaemon(f.viewer, launchPath);
  cleanup.push(() => daemon.stop());
  let started: (() => void) | undefined;
  const agentApp = createFoundryAgent({
    launchPath,
    daemonWaitMs: 5_000,
    log: () => {},
    startDaemon: () =>
      new Promise<void>((resolveStart) => {
        started = resolveStart;
      }),
  });
  const connection = client({ name: 'test' })
    .onRequest('session/request_permission', () => new Promise(() => {}))
    .onNotification('session/update', () => {})
    .connect(agentApp);
  cleanup.push(() => connection.close());
  await connection.agent.request('initialize', INITIALIZE);
  const { sessionId } = await connection.agent.request('session/new', {
    cwd: join(dir, 'P'),
    mcpServers: [],
  });
  // The daemon goes down: the next prompt waits for it to start.
  daemon.stop();
  const before = f.attempts.length;
  const prompt = connection.agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'never sent' }],
  });
  await until(() => started, 'daemon start requested');
  await connection.agent.notify('session/cancel', { sessionId });
  daemon = serveDaemon(f.viewer, launchPath);
  started!();
  expect(await prompt).toEqual({ stopReason: 'cancelled' });
  await Bun.sleep(200);
  expect(f.attempts).toHaveLength(before);
  expect(f.viewer.localStore!.recentTurnIds(sessionId, 10)).toHaveLength(0);
});

test('session/load replays the history before a pending ask reaches the host', async () => {
  const { f, dir } = await fixture();
  const daemon = serveDaemon(f.viewer);
  cleanup.push(() => daemon.stop());
  const first = host(daemon.launchPath);
  await first.agent.request('initialize', INITIALIZE);
  const cwd = join(dir, 'P');
  const { sessionId } = await first.agent.request('session/new', { cwd, mcpServers: [] });
  await turn(first, f, sessionId, 'earlier');

  const before = f.attempts.length;
  const running = first.agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'now' }],
  });
  await until(
    () => f.attempts.length === before + 1 && f.attempts[before]!.native.dispatch === 'attempted',
    'dispatched',
  );
  const gate = f.created.at(-1)!.toolGate as ToolGate;
  const ask = gate({
    stage: 'permission',
    toolName: 'Bash',
    toolInput: { command: 'make' },
    callId: 'c1',
  });
  await until(() => f.actionQueue.pending().length === 1, 'ask pending');

  const second = host(daemon.launchPath);
  let seenAtAsk = -1;
  second.answerPermissions(async () => {
    seenAtAsk = second.updates(sessionId).length;
    return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
  });
  await second.agent.request('initialize', INITIALIZE);
  await second.agent.request('session/load', { sessionId, cwd, mcpServers: [] });
  const replayed = second.updates(sessionId).length;
  expect(replayed).toBeGreaterThan(0);
  expect(await ask).toEqual({ behavior: 'allow' });
  expect(seenAtAsk).toBeGreaterThanOrEqual(replayed);
  f.attempts[before]!.finish(false, 'done');
  await running;
});

test('session/close is advertised; closing a probe session archives its empty thread, a used one is kept', async () => {
  const { f, dir } = await fixture();
  const daemon = serveDaemon(f.viewer);
  cleanup.push(() => daemon.stop());
  const h = host(daemon.launchPath);
  const init = await h.agent.request('initialize', INITIALIZE);
  expect(init.agentCapabilities?.sessionCapabilities?.close).toEqual({});
  const cwd = join(dir, 'P');

  const probe = await h.agent.request('session/new', { cwd, mcpServers: [] });
  expect(await h.agent.request('session/close', { sessionId: probe.sessionId })).toEqual({});
  await until(
    async () => (await f.viewer.app.request(`/api/threads/${probe.sessionId}`)).ok,
    'thread still readable',
  );
  const archived = (await (
    await f.viewer.app.request(`/api/threads/${probe.sessionId}`)
  ).json()) as { meta: { status: string } };
  expect(archived.meta.status).toBe('archived');
  // A closed session is no longer this host's.
  await expect(
    h.agent.request('session/prompt', {
      sessionId: probe.sessionId,
      prompt: [{ type: 'text', text: 'x' }],
    }),
  ).rejects.toThrow();

  const used = await h.agent.request('session/new', { cwd, mcpServers: [] });
  await turn(h, f, used.sessionId, 'work');
  await h.agent.request('session/close', { sessionId: used.sessionId });
  const kept = (await (await f.viewer.app.request(`/api/threads/${used.sessionId}`)).json()) as {
    meta: { status: string };
  };
  expect(kept.meta.status).not.toBe('archived');
});

test('a launch file whose daemon is gone, or whose port another process answers, is never trusted', async () => {
  const { f } = await fixture();
  const dir = mkdtempSync(join(tmpdir(), 'foundry-acp-stale-'));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const launchPath = join(dir, 'acp-launch.json');
  const daemon = serveDaemon(f.viewer, launchPath);
  cleanup.push(() => daemon.stop());
  const { endpoint, capability } = readAcpLaunch(launchPath);
  const port = Number(new URL(endpoint).port);
  const connect = async () => {
    const agentApp = createFoundryAgent({ launchPath, log: () => {} });
    const connection = client({ name: 'test' }).connect(agentApp);
    cleanup.push(() => connection.close());
    return connection.agent.request('initialize', INITIALIZE);
  };

  // The daemon that wrote it exited.
  const gone = Bun.spawn(['true']);
  await gone.exited;
  writeAcpLaunch(launchPath, { port, capability, pid: gone.pid });
  await expect(connect()).rejects.toThrow(/stale launch file/);

  // A live process that is not the listener on that port.
  const other = Bun.spawn(['sleep', '30']);
  cleanup.push(() => other.kill());
  writeAcpLaunch(launchPath, { port, capability, pid: other.pid });
  await expect(connect()).rejects.toThrow(/not the daemon/);

  // The daemon's own file: trusted.
  writeAcpLaunch(launchPath, { port, capability });
  expect((await connect()).protocolVersion).toBe(1);
});

test('structural rules appearing on a warm thread relaunch its session, so an adapter that cannot gate before use is re-checked', async () => {
  const { f, dir } = await fixture();
  const daemon = serveDaemon(f.viewer);
  cleanup.push(() => daemon.stop());
  const h = host(daemon.launchPath);
  await h.agent.request('initialize', INITIALIZE);
  const { sessionId } = await h.agent.request('session/new', {
    cwd: join(dir, 'P'),
    mcpServers: [],
  });
  await turn(h, f, sessionId, 'first');
  expect(f.created.at(-1)).toMatchObject({ structuralRules: false });
  const sessionsBefore = f.sessions.length;
  const store = f.viewer.configStore;
  await store.save({ ...store.config, toolRules: { protectedPaths: ['.env'] } });
  await turn(h, f, sessionId, 'second');
  expect(f.sessions.length).toBe(sessionsBefore + 1);
  expect(f.created.at(-1)).toMatchObject({ structuralRules: true });
});
