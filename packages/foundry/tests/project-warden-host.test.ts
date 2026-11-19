// The per-project Warden host (the default for Claude decisions, `claude-project`): one Foundry-owned
// Claude Code process per project holds every Warden warm; every thread of the project asks it for
// advice; it is supervised (restart with backoff, blue/green past its bounds); while it does not serve,
// its Wardens are skipped, never sent to primed.

import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { ClaudeCodeSession, type PrimeSpec } from '@inixiative/agent-session';
import {
  EventStream,
  FileMemory,
  type LLMMessage,
  type LLMProvider,
} from '@inixiative/foundry-core';
import { composeProjectRoster, warmWardens, withChorusThread } from '../src/agents/chorus-thread';
import { createSourceResolver } from '../src/agents/thread-factory';
import { defaultProfileSource } from '../src/providers/default-profiles';
import {
  createPrimedDecisionHost,
  decisionHostsDirectory,
  isStageSession,
  isWardenSession,
  primedRequest,
  projectHostTarget,
} from '../src/providers/primed-decisions';
import {
  dispatcherCount,
  followProjectActivity,
  MAX_DISPATCHERS,
  type ProjectHostState,
  ProjectWardenHosts,
  type Roster,
} from '../src/providers/project-warden-hosts';
import { makeLoginQuotaPause } from '../src/providers/provider-limits';
import {
  PROJECT_HOST_DEFAULTS,
  resolveSubscriptionPolicy,
} from '../src/providers/subscription-policy';
import { type FoundryConfig, starterConfig } from '../src/viewer/config';
import { fakeClaudeTree } from './helpers/fake-claude-tree';
import { subscriptionStatusProcess } from './helpers/subscription-transport';

const cleanup: Array<() => unknown> = [];
const home = process.env.HOME;
const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  process.env.HOME = home;
  if (claudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
});
const tempDir = (name: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `foundry-${name}-`)));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const until = async (cond: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(5);
  return cond();
};

const spec = (role: string): PrimeSpec => ({
  key: `T1:aux:domain:${role}#x`,
  instructions: `be the ${role} warden`,
  context: `## Domain cache (${role})\nknowledge of ${role}\n`,
  hash: `h-${role}`,
});
const roster = (...roles: string[]): Roster => roles.map((r) => ({ spec: spec(r), standby: '' }));
/** The host serving a thread's Wardens, when one serves (never `starting`). */
const servingHost = (wardens: ProjectWardenHosts, threadId: string) => {
  const host = wardens.serving(threadId);
  if (host === 'starting') throw new Error(`${threadId}: host still starting`);
  return host;
};

/** A project-mode registry whose hosts run on the fake CLI: per-pid memory readings set by the test. */
function projectHosts(
  options: {
    noRoot?: boolean;
    maxRestarts?: number;
    idleMs?: number;
    wardensPerDispatcher?: number;
    maxRecyclesPerHour?: number;
    /** When the decision login's used-up usage resets (default: not used up). */
    quotaResetAt?: () => number | undefined;
  } = {},
) {
  const tree = fakeClaudeTree({ noRoot: options.noRoot });
  const rss = new Map<number, number>();
  const states: Array<ProjectHostState & { projectId: string }> = [];
  const wardens = new ProjectWardenHosts({
    model: 'claude-haiku-5-5',
    effort: 'low',
    timeoutMs: 3_000,
    projectOf: (threadId) => (threadId.startsWith('A') ? 'P' : undefined),
    projectHost: {
      ...PROJECT_HOST_DEFAULTS,
      setupDeadlineMs: options.noRoot ? 5_000 : 5_000,
      restartBackoffMs: 20,
      maxRestarts: options.maxRestarts ?? 5,
      ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
      ...(options.wardensPerDispatcher !== undefined
        ? { wardensPerDispatcher: options.wardensPerDispatcher }
        : {}),
      ...(options.maxRecyclesPerHour !== undefined
        ? { maxRecyclesPerHour: options.maxRecyclesPerHour }
        : {}),
    },
    healthIntervalMs: 10,
    rss: (pid) => rss.get(pid) ?? 100,
    onProject: (projectId, state) => states.push({ projectId, ...state }),
  });
  const quota = makeLoginQuotaPause({ fetchResetAt: async () => options.quotaResetAt?.() });
  cleanup.push(() => quota.close());
  wardens.bindLauncher(quota, async (_projectId, host) => {
    const session = new ClaudeCodeSession({
      spawn: tree.spawn,
      maxTurns: null,
      persistSession: false,
    });
    session.extend(host);
    const ended = new Promise<string>((resolve) => {
      session.onEvent((event) => {
        if (event.kind === 'session_end') resolve('ended');
      });
    });
    await session.start();
    return { pid: tree.processes.at(-1)!.pid, ended, stop: async () => session.kill() };
  });
  cleanup.push(() => wardens.close());
  return { tree, rss, states, wardens };
}

test('a project host holds the roster before any thread; every thread of the project gets a held spare; another project has none', async () => {
  const { tree, wardens } = projectHosts();
  wardens.openProject('P', roster('locks', 'lens'));
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  expect(wardens.projectState('P')).toMatchObject({
    status: 'serving',
    expected: 2,
    held: 2,
    generation: 1,
    failures: 0,
  });
  // Two threads of P share the host; a thread of another project has none.
  const host = servingHost(wardens, 'A1');
  expect(host).toBeDefined();
  expect(wardens.serving('A2')).toBe(host);
  expect(wardens.serving('B1')).toBeUndefined();
  // A held spare holds no thread state: the standby is empty and the thread section rides the moment.
  const result = await host!.decide(
    { ...spec('locks'), key: 'A2:aux:domain:locks#y' },
    { standby: '', input: '\n## Your understanding\nA2 only\n## Message\nadd a lock' },
  );
  expect(result.prime).toBe('warm');
  expect(result.content).toBe('ANS:\n## Your understanding\nA2 only\n## Message\nadd a lock');
  expect(tree.memberPrompts.some((p) => p.includes('A2 only'))).toBe(false);
  // The same roster again changes nothing.
  wardens.openProject('P', roster('lens', 'locks'));
  expect(tree.processes.length).toBe(1);
  expect(wardens.serving('A1')).toBe(host);
  // A refreshed roster of the same size is held in place.
  wardens.openProject('P', roster('locks', 'naming'));
  expect(
    await until(() => wardens.projectState('P')?.held === 2 && host!.holding().expected === 2),
  ).toBe(true);
  expect(tree.processes.length).toBe(1);
  // A larger roster than the host was bounded for starts a new host, blue/green.
  wardens.openProject('P', roster('locks', 'naming', 'lens'));
  expect(await until(() => wardens.projectState('P')?.generation === 2)).toBe(true);
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  expect(wardens.projectState('P')).toMatchObject({ expected: 3, held: 3 });
  expect(await until(() => tree.processes[0]!.exited)).toBe(true);
});

test('dispatchers: one while the roster fits a slice, else the square root, never over 8 Wardens each or 24 dispatchers', () => {
  expect([1, 8, 9, 16, 32, 64, 75, 106, 400].map((size) => dispatcherCount(size, 8))).toEqual([
    1, 1, 3, 4, 6, 8, 10, 14, 24,
  ]);
  // A smaller slice setting makes more dispatchers, still capped.
  expect(dispatcherCount(5, 2)).toBe(3);
  expect(dispatcherCount(100, 1)).toBe(MAX_DISPATCHERS);
});

test('the roster is cut into slices of wardensPerDispatcher, each refilled by its own dispatcher', async () => {
  const { tree, wardens } = projectHosts({ wardensPerDispatcher: 2 });
  wardens.openProject('P', roster('a', 'b', 'c', 'd', 'e'));
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  expect(wardens.projectState('P')).toMatchObject({ expected: 5, held: 5 });
  // Five Wardens at two a slice: three dispatchers under the one root.
  expect(tree.started.filter((t) => t === 'foundry-root').length).toBe(1);
  expect(tree.started.filter((t) => t === 'foundry-dispatch').length).toBe(3);
});

test('a roster that grows while its host starts gets a host sized for it', async () => {
  const { wardens } = projectHosts();
  wardens.openProject('P', roster('locks'));
  wardens.openProject('P', roster('locks', 'lens', 'naming'));
  expect(await until(() => wardens.projectState('P')?.generation === 2)).toBe(true);
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  expect(wardens.projectState('P')).toMatchObject({ expected: 3, held: 3 });
  expect(wardens.projectState('P')!.resets).toEqual({ 'roster grew': 1 });
});

test('only while someone works in the project: activity opens its host, idleness closes it', async () => {
  const { tree, wardens } = projectHosts({ idleMs: 300 });
  const events = new EventStream();
  const opened: string[] = [];
  const activity = followProjectActivity({
    hosts: wardens,
    events,
    projectOf: (threadId) => (threadId === 'A1' ? 'P' : undefined),
    open: async (projectId) => {
      opened.push(projectId);
      wardens.openProject(projectId, roster('locks'));
    },
  });
  cleanup.push(() => activity.stop());
  // Nothing opens a host before the project is active.
  expect(wardens.openProjects()).toEqual([]);
  // A thread of another project, or none, opens nothing.
  events.push({ kind: 'session', event: { type: 'thread:added', threadId: 'B1', timestamp: 1 } });
  expect(opened).toEqual([]);
  // A thread of the project opened: its host opens, once.
  events.push({ kind: 'session', event: { type: 'thread:added', threadId: 'A1', timestamp: 1 } });
  events.push({ kind: 'journal', threadId: 'A1', projectId: 'P', turnId: 't1', timestamp: 2 });
  expect(opened).toEqual(['P']);
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  // Turns keep it open past the idle bound.
  for (let i = 0; i < 4; i++) {
    await Bun.sleep(150);
    events.push({ kind: 'journal', threadId: 'A1', projectId: 'P', turnId: `t${i}`, timestamp: 3 });
  }
  expect(wardens.openProjects()).toEqual(['P']);
  // No activity for the bound: the host closes, and nothing serves its Wardens.
  expect(await until(() => wardens.openProjects().length === 0, 2_000)).toBe(true);
  expect(wardens.serving('A1')).toBeUndefined();
  expect(await until(() => tree.processes[0]!.exited)).toBe(true);
  // The next turn opens it again.
  events.push({ kind: 'journal', threadId: 'A1', projectId: 'P', turnId: 't9', timestamp: 4 });
  expect(opened).toEqual(['P', 'P']);
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  // Idle again; a thread of it opened in the viewer (`activate`) opens it, once however many ask.
  expect(await until(() => wardens.openProjects().length === 0, 2_000)).toBe(true);
  await Promise.all([activity.activate('P'), activity.activate('P')]);
  expect(opened).toEqual(['P', 'P', 'P']);
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  // Activity on an open host only keeps it open.
  await activity.activate('P');
  expect(opened).toEqual(['P', 'P', 'P']);
});

test('a host process that dies: routing leaves it at once, and a new host is started and serves', async () => {
  const { tree, wardens } = projectHosts();
  wardens.openProject('P', roster('locks'));
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  const dead = servingHost(wardens, 'A1');
  tree.processes[0]!.crash();
  // Routing leaves the dead host at once (the replacement may already serve: the double is fast).
  expect(await until(() => wardens.serving('A1') !== dead)).toBe(true);
  expect(dead!.serving()).toBe(false);
  // What routes now is nothing, a host still starting (held-only calls refuse), or a live host.
  const after = wardens.serving('A1');
  expect(after === undefined || after === 'starting' || after.serving()).toBe(true);
  expect(await until(() => wardens.projectState('P')?.generation === 2)).toBe(true);
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  expect(Object.keys(wardens.projectState('P')!.resets)[0]).toMatch(/^process ended/);
});

test('a host whose orphans pass its bound is replaced for that reason, read from its capacity', async () => {
  const { tree, wardens } = projectHosts();
  wardens.openProject('P', roster('locks'));
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  const first = servingHost(wardens, 'A1')!;
  // Each dispatcher that dies orphans its members; a used orphan stays held and its role is refilled.
  for (let i = 0; i < 12 && !first.snapshot().capacity?.orphanedOut; i++) {
    tree.processes[0]!.endDispatchers();
    await Bun.sleep(30);
    if (first.serving())
      await first.decide(spec('locks'), { input: `M${i}`, standby: '' }).catch(() => {});
  }
  expect(first.snapshot().capacity?.orphanedOut).toBe(true);
  expect(await until(() => wardens.projectState('P')?.generation === 2)).toBe(true);
  expect(wardens.projectState('P')!.resets).toEqual({ 'orphaned out': 1 });
});

test('a dispatcher past its context bound is churn, not an orphaned-out host: past the hourly bound the host is replaced for churn', async () => {
  const { tree, wardens } = projectHosts({ maxRecyclesPerHour: 1 });
  wardens.openProject('P', roster('locks'));
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  const first = servingHost(wardens, 'A1')!;
  for (let i = 0; i < 6 && wardens.projectState('P')?.generation === 1; i++) {
    tree.processes[0]!.fillDispatchers(PROJECT_HOST_DEFAULTS.recycleTokens + 1);
    await Bun.sleep(30);
  }
  expect(first.snapshot().capacity?.orphanedOut).toBe(false);
  expect(await until(() => wardens.projectState('P')?.generation === 2)).toBe(true);
  expect(wardens.projectState('P')!.resets).toEqual({ 'recycle churn': 1 });
});

test('memory: a fan-out peak over the bound is tolerated; sustained growth starts a replacement while the old host serves; the ceiling takes routing off at once', async () => {
  const { tree, rss, wardens } = projectHosts();
  wardens.openProject('P', roster('locks'));
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  const first = tree.processes[0]!;
  // Two reads over the bound, then back down: a peak, not growth.
  rss.set(first.pid, 2_000);
  await Bun.sleep(15);
  rss.set(first.pid, 900);
  await Bun.sleep(50);
  expect(wardens.projectState('P')!.generation).toBe(1);
  expect(wardens.projectState('P')!.peakRssMb).toBeGreaterThanOrEqual(2_000);
  // Held over the bound: a new host starts, and the old one serves until it does.
  rss.set(first.pid, 2_000);
  expect(await until(() => wardens.projectState('P')?.generation === 2)).toBe(true);
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  expect(wardens.projectState('P')!.resets).toEqual({ 'memory bound': 1 });
  expect(await until(() => first.exited)).toBe(true);
  // Past the ceiling: routing leaves the host on the read, before any replacement serves.
  const second = tree.processes[1]!;
  const growing = wardens.serving('A1');
  rss.set(second.pid, 5_000);
  expect(await until(() => wardens.serving('A1') !== growing, 1_000)).toBe(true);
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  expect(wardens.projectState('P')!.resets).toMatchObject({ 'memory ceiling': 1 });
  expect(await until(() => second.exited)).toBe(true);
});

test('a host that never sets up is retried with backoff, then fails: nothing serves its Wardens', async () => {
  const { tree, states, wardens } = projectHosts({ noRoot: true, maxRestarts: 2 });
  // The setup deadline is the setting's; no root ever starts, so the setup turn ends degraded.
  wardens.openProject('P', roster('locks'));
  expect(await until(() => wardens.projectState('P')?.status === 'failed', 15_000)).toBe(true);
  expect(tree.processes.length).toBe(2);
  expect(tree.processes.every((p) => p.exited)).toBe(true);
  expect(wardens.serving('A1')).toBeUndefined();
  expect(states.at(-1)!.reason).toMatch(/2 starts failed in a row/);
}, 20_000);

test('a start on a used-up login waits for the reset, counts no failure and keeps the Wardens skipped, not on stand-ins', async () => {
  let resetAt: number | undefined;
  const { tree, states, wardens } = projectHosts({
    noRoot: true,
    maxRestarts: 1,
    quotaResetAt: () => resetAt,
  });
  resetAt = Date.now() + 6_000;
  wardens.openProject('P', roster('locks'));
  expect(await until(() => wardens.projectState('P')?.quotaResetsAt !== undefined, 10_000)).toBe(
    true,
  );
  // One failure in a row would fail it for good (maxRestarts 1); a used-up login does not count.
  expect(wardens.projectState('P')).toMatchObject({
    status: 'starting',
    failures: 0,
    quotaResetsAt: resetAt,
  });
  expect(wardens.serving('A1')).toBe('starting');
  expect(states.at(-1)!.reason).toMatch(/usage used up/);
  expect(tree.processes.length).toBe(1);
  // At the reset it starts again; usage freed, the next failure counts as before.
  resetAt = undefined;
  expect(await until(() => wardens.projectState('P')?.status === 'failed', 15_000)).toBe(true);
  expect(tree.processes.length).toBe(2);
  expect(wardens.projectState('P')).toMatchObject({ failures: 1 });
  expect(wardens.projectState('P')!.quotaResetsAt).toBeUndefined();
}, 30_000);

test('serving: a starting host skips its Wardens (they catch up later); a failed, closed or replaced one does not', async () => {
  const { tree, rss, wardens } = projectHosts();
  // No host open, nothing opening: nothing serves.
  expect(wardens.serving('A1')).toBeUndefined();
  // The roster is being composed to open the host: starting.
  wardens.markOpening('P', true);
  expect(wardens.serving('A1')).toBe('starting');
  wardens.markOpening('P', false);
  expect(wardens.serving('A1')).toBeUndefined();
  // Starting: still starting until it serves, then the host.
  wardens.openProject('P', roster('locks', 'lens'));
  expect(wardens.projectState('P')!.status).toBe('starting');
  expect(wardens.serving('A1')).toBe('starting');
  expect(wardens.serving('B1')).toBeUndefined();
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  const host = servingHost(wardens, 'A1');
  expect(host).toBeDefined();
  // A replacement starting beside the serving host does not take its Wardens off.
  rss.set(tree.processes[0]!.pid, 2_000);
  expect(await until(() => wardens.projectState('P')?.generation === 2)).toBe(true);
  expect(wardens.serving('A1')).not.toBe('starting');
  expect(wardens.serving('A1')).toBeDefined();
});

test('routing: a project host takes every Warden call (advice, guards, reviews, later stages); other roles stay primed', () => {
  const host = { serving: () => true } as unknown;
  const project = { serving: () => host } as unknown as ProjectWardenHosts;
  expect(projectHostTarget(project, 'A1:aux:domain:locks')).toBe(host as never);
  expect(projectHostTarget(project, 'A1:aux:review:g1:domain:locks')).toBe(host as never);
  expect(projectHostTarget(project, 'A1:aux:domain:locks:stage:1')).toBe(host as never);
  expect(projectHostTarget(project, 'A1:aux:agent:worker')).toBeUndefined();
  expect(projectHostTarget(project, 'A1:aux:naming')).toBeUndefined();
  // A host starting, failed or closed serves no Warden call: advice, guard, review and a later stage
  // are refused unsent, never sent to primed (Aron, 2026-11-18: "when the layers are down, they just skip").
  for (const serving of ['starting', undefined]) {
    const none = { serving: () => serving } as unknown as ProjectWardenHosts;
    expect(projectHostTarget(none, 'A1:aux:domain:locks')).toBe('not-serving');
    expect(projectHostTarget(none, 'A1:aux:review:g1:domain:locks')).toBe('not-serving');
    expect(projectHostTarget(none, 'A1:aux:domain:locks:stage:1')).toBe('not-serving');
    expect(projectHostTarget(none, 'A1:aux:naming')).toBeUndefined();
  }
});

test('lanes: a later stage on another model gets its own hosts, opened, touched and closed with the decision ones', async () => {
  const { wardens } = projectHosts();
  expect(wardens.lane('claude-haiku-5-5', 'low')).toBe(wardens);
  const sonnet = wardens.lane('claude-sonnet-5-5', 'low');
  expect(sonnet).not.toBe(wardens);
  expect(wardens.lane('claude-sonnet-5-5', 'low')).toBe(sonnet);
  expect(sonnet.config.model).toBe('claude-sonnet-5-5');
  expect(wardens.lanes()).toEqual([sonnet]);
  wardens.markOpening('P', true);
  expect(sonnet.serving('A1')).toBe('starting');
  wardens.markOpening('P', false);
  sonnet.openProject('P', roster('locks'));
  wardens.openProject('P', roster('locks'));
  expect(Object.keys(wardens.snapshot().projects).sort()).toEqual([
    'P',
    'P (claude-sonnet-5-5 at low)',
  ]);
  expect(sonnet.projectState('P')?.lane).toBe('claude-sonnet-5-5 at low');
  await wardens.closeProject('P');
  expect(sonnet.projectState('P')).toBeUndefined();
});

test('settings: Claude decisions resolve to project Wardens with the host defaults, by default or named; projectHost is refused on primed Wardens', () => {
  const root = tempDir('policy');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', '.credentials.json'), '{}');
  process.env.HOME = root;
  const config = starterConfig('claude-code', 'sonnet');
  mkdirSync(join(root, 'receipts'), { mode: 0o700 });
  config.subscriptionOnly = {
    decisionRuntime: 'claude-project',
    directory: join(root, 'receipts'),
    projectHost: { sparesPerWarden: 2 },
  };
  const resolved = resolveSubscriptionPolicy(config, { cwd: root })!;
  expect(resolved.decision.runtime).toBe('claude');
  expect(resolved.policy.wardens).toBe('project');
  expect(resolved.policy.projectHost).toEqual({ ...PROJECT_HOST_DEFAULTS, sparesPerWarden: 2 });
  // No runtime named: Claude decisions, project Wardens.
  config.subscriptionOnly = { directory: join(root, 'receipts'), projectHost: { maxRssMb: 2_048 } };
  const unnamed = resolveSubscriptionPolicy(config, { cwd: root })!;
  expect(unnamed.policy.wardens).toBe('project');
  expect(unnamed.policy.projectHost?.maxRssMb).toBe(2_048);
  config.subscriptionOnly = { decisionRuntime: 'claude', projectHost: { maxRssMb: 2_048 } };
  expect(() => resolveSubscriptionPolicy(config, { cwd: root })).toThrow(
    /projectHost applies only to project Warden hosts/,
  );
});

test('a project host that fails to launch leaves no folder in the hosts directory', async () => {
  const root = tempDir('primed-project-fail');
  mkdirSync(join(root, '.claude'), { mode: 0o755 });
  writeFileSync(join(root, '.claude', '.credentials.json'), '{}', { mode: 0o600 });
  process.env.HOME = root;
  delete process.env.CLAUDE_CONFIG_DIR;
  const directory = join(root, 'receipts');
  mkdirSync(directory, { mode: 0o700 });
  const wardens = new ProjectWardenHosts({
    model: 'claude-haiku-5-5',
    effort: 'low',
    timeoutMs: 3_000,
    projectOf: () => 'P',
    projectHost: { ...PROJECT_HOST_DEFAULTS, setupDeadlineMs: 2_000, maxRestarts: 0 },
    rss: () => 100,
  });
  let launches = 0;
  // A failed launch reads the login's quota: a stub, so the real login is never probed and
  // provider-limits' shared cache is never filled for later test files.
  const quota = makeLoginQuotaPause({ fetchResetAt: async () => undefined });
  cleanup.push(() => quota.close());
  const primed = createPrimedDecisionHost({
    source: defaultProfileSource('claude'),
    directory,
    model: 'claude-haiku-5-5',
    effort: 'low',
    maxConcurrent: 1,
    callTimeoutMs: 3_000,
    spawn: () => {
      launches++;
      throw Error('no CLI here');
    },
    statusSpawn: () => subscriptionStatusProcess(true),
    quota,
    projectHosts: wardens,
  });
  cleanup.push(async () => {
    await wardens.close();
    await primed.close();
  });
  const workspace = join(decisionHostsDirectory(), `primed-${primed.hostId}`);
  wardens.openProject('P', [
    {
      spec: { key: 'T0:aux:domain:locks', instructions: 'LOCKS WARDEN', context: 'x' },
      standby: '',
    },
  ]);
  expect(await wardens.projectReady('P', 3_000)).toBe(false);
  expect(launches).toBeGreaterThan(0);
  expect(readdirSync(workspace).filter((name) => name.startsWith('project-'))).toEqual([]);
});

test('the decision host launches the project host on the decision login: its own flags, no CLAUDE.md, no session on disk; advice splits at the stable prefix', async () => {
  const root = tempDir('primed-project');
  mkdirSync(join(root, '.claude'), { mode: 0o755 });
  writeFileSync(join(root, '.claude', '.credentials.json'), '{}', { mode: 0o600 });
  process.env.HOME = root;
  delete process.env.CLAUDE_CONFIG_DIR;
  const directory = join(root, 'receipts');
  mkdirSync(directory, { mode: 0o700 });
  const tree = fakeClaudeTree();
  const wardens = new ProjectWardenHosts({
    model: 'claude-haiku-5-5',
    effort: 'low',
    timeoutMs: 3_000,
    projectOf: () => 'P',
    projectHost: { ...PROJECT_HOST_DEFAULTS, setupDeadlineMs: 5_000 },
    rss: () => 100,
  });
  const primed = createPrimedDecisionHost({
    source: defaultProfileSource('claude'),
    directory,
    model: 'claude-haiku-5-5',
    effort: 'low',
    maxConcurrent: 1,
    callTimeoutMs: 3_000,
    spawn: tree.spawn,
    statusSpawn: () => subscriptionStatusProcess(true),
    projectHosts: wardens,
  });
  cleanup.push(async () => {
    await wardens.close();
    await primed.close();
  });
  const cache = '## Domain cache (locks)\nuse createLock\n';
  const messages = (thread: string): LLMMessage[] => [
    { role: 'system', content: 'LOCKS WARDEN' },
    {
      role: 'user',
      content: `${cache}\n## Your understanding of this thread\n${thread} knows\n\n## Message\nadd a lock`,
    },
  ];
  const { spec: held } = primedRequest(
    messages('T0'),
    { stablePrefix: cache },
    'T0:aux:domain:locks',
  );
  const newRun = (maxCalls: number) =>
    primed.createRun({
      source: defaultProfileSource('claude'),
      directory,
      runId: crypto.randomUUID(),
      model: 'claude-haiku-5-5',
      maxCalls,
    });
  // The host is on its way: a held-only Warden (a user message's advice) is refused unsent
  // (`not-held`), never started cold, and the turn does not wait for the host.
  wardens.markOpening('P', true);
  const early = newRun(1);
  const at = Date.now();
  await expect(
    early.provider.complete(messages('T7'), {
      threadId: 'T7:aux:domain:locks',
      stablePrefix: cache,
      heldOnly: true,
    }),
  ).rejects.toThrow();
  expect(Date.now() - at).toBeLessThan(1_000);
  expect(early.snapshot().calls[0]).toMatchObject({
    failure: 'not-held',
    reason: 'not-held',
    valid: false,
  });
  expect(tree.processes.length).toBe(0);
  wardens.markOpening('P', false);
  // No host serving: a Warden call that is not held-only (a guard, a brief, a Retry) and a review are
  // refused unsent as well, never run on primed (Aron, 2026-11-18: "it should not be handling warden
  // calls at all").
  for (const threadId of ['T7:aux:domain:locks', 'T7:aux:review:g1:domain:locks']) {
    const unserved = newRun(1);
    await expect(
      unserved.provider.complete(messages('T7'), { threadId, stablePrefix: cache }),
    ).rejects.toThrow();
    expect(unserved.snapshot().calls[0]).toMatchObject({
      failure: 'not-held',
      reason: 'not-held',
      valid: false,
    });
  }
  expect(tree.processes.length).toBe(0);
  wardens.openProject('P', [{ spec: held, standby: '' }]);
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  const launch = tree.processes[0]!;
  // The host works in a folder made for it, empty and outside any git work tree, never below the
  // receipts (R-2026-11-19-07): Claude Code's git snapshot at each Warden start finds no repository.
  const hostDirectory = launch.cwd!;
  expect(dirname(dirname(hostDirectory))).toBe(decisionHostsDirectory());
  expect(basename(hostDirectory)).toMatch(/^project-[0-9a-f]{12}-[0-9a-f]{8}$/);
  expect(hostDirectory.startsWith(directory)).toBe(false);
  expect(readdirSync(hostDirectory)).toEqual([]);
  expect(
    Bun.spawnSync(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: hostDirectory }).exitCode,
  ).not.toBe(0);
  expect(launch.argv).toContain('--no-session-persistence');
  expect(launch.argv).toContain('--disable-slash-commands');
  expect(launch.argv).toContain('--strict-mcp-config');
  expect(launch.argv[launch.argv.indexOf('--effort') + 1]).toBe('low');
  expect(launch.argv.slice(-2)).toEqual(['--setting-sources', '']);
  expect(launch.argv).toContain('--exclude-dynamic-system-prompt-sections');
  expect(launch.env).toMatchObject({
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
  });
  // The host's own subagent cap survives the credential strip: one Warden, one dispatcher, a guard
  // and a cold review member per concurrent turn → 10 over the default.
  expect(launch.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe(
    String((Number(process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS) || 20) + 10),
  );
  expect(
    Object.entries(launch.env).flatMap(([key, value]) =>
      value && /API_KEY|AUTH_TOKEN|BASE_URL/.test(key) ? [key] : [],
    ),
  ).toEqual([]);
  const run = newRun(2);
  const answer = await run.provider.complete(messages('T7'), {
    threadId: 'T7:aux:domain:locks',
    stablePrefix: cache,
  });
  expect(answer.content).toBe(
    'ANS:\n## Your understanding of this thread\nT7 knows\n\n## Message\nadd a lock',
  );
  expect(run.snapshot().calls[0]).toMatchObject({
    prime: 'warm',
    valid: true,
    // The host's capacity as the call went out: nothing queued for a slot, no orphans.
    hostCapacity: { awaitingSlot: 0, orphans: 0, orphanedOut: false },
  });
  // A call that takes no held call (a debug reason asked after the decision) runs on its own:
  // it never claims the spare the next decision needs.
  await run.provider.complete(messages('T7'), {
    threadId: 'T7:aux:domain:locks',
    stablePrefix: cache,
    takesNoHeldCall: true,
  });
  expect(run.snapshot().calls[1]).toMatchObject({ valid: true, prime: 'cold' });
  // The held text is the composed Warden and its knowledge; no thread's state.
  const holding = tree.memberPrompts[0]!;
  expect(holding).toContain('LOCKS WARDEN');
  expect(holding).toContain('use createLock');
  expect(holding).not.toContain('knows');
  // A held-only Warden the serving host holds no spare for is refused unsent too: no cold start on the host.
  const other = '## Domain cache (naming)\nname it fully\n';
  const unheld = newRun(1);
  await expect(
    unheld.provider.complete(
      [
        { role: 'system', content: 'NAMING WARDEN' },
        { role: 'user', content: `${other}\n## Message\nadd a lock` },
      ],
      { threadId: 'T7:aux:domain:naming', stablePrefix: other, heldOnly: true },
    ),
  ).rejects.toThrow();
  expect(unheld.snapshot().calls[0]).toMatchObject({
    failure: 'not-held',
    reason: 'not-held',
    valid: false,
  });
  expect(tree.memberPrompts.some((p) => p.includes('NAMING WARDEN'))).toBe(false);
});

// -- Composition: what a thread of the project sends is what the project host holds -------------

/**
 * A git project whose repository enables a two-region chorus. A region's role file (at
 * `.foundry/roles/region/<region id>/`) overlays its
 * instructions at the root, and a worktree carries its own (an unmerged edit).
 */
function project(): string {
  const dir = tempDir('project-host');
  mkdirSync(join(dir, '.git'));
  write(join(dir, '.foundry', 'project.json'), JSON.stringify({ chorus: { enabled: true } }));
  write(join(dir, 'CLAUDE.md'), 'ROOT_CLAUDE_MD\n');
  write(
    join(dir, '.foundry', 'roles', 'region', 'lens-model', 'instructions.md'),
    'ROOT_ROLE_FILE\n',
  );
  write(join(dir, '.foundry', 'warden-brief.md'), 'ROOT_WARDEN_BRIEF\n');
  const worktree = join(dir, '.worktrees', 'feat');
  write(join(worktree, '.git'), 'gitdir: ../../.git/worktrees/feat\n');
  write(join(worktree, 'CLAUDE.md'), 'WORKTREE_CLAUDE_MD\n');
  write(
    join(worktree, '.foundry', 'roles', 'region', 'lens-model', 'instructions.md'),
    'WORKTREE_ROLE_FILE\n',
  );
  write(join(worktree, '.foundry', 'warden-brief.md'), 'WORKTREE_WARDEN_BRIEF\n');
  for (const id of ['concurrency-locks', 'lens-model']) {
    write(
      join(dir, '.foundry', 'regions', id, 'region.json'),
      JSON.stringify({ id, title: id, routing: `Is this about ${id}?`, concepts: [id] }),
    );
    write(join(dir, '.foundry', 'regions', id, 'knowledge.md'), `# ${id}\n\nKNOWLEDGE_${id}\n`);
  }
  return dir;
}

function config(path: string, runtime: 'claude' | 'claude-project'): FoundryConfig {
  const c = starterConfig('central', 'central-model');
  c.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      prompt: '',
      provider: 'central',
      model: 'central-model',
      enabled: true,
    },
  };
  c.defaults.decisionProvider = 'flow';
  c.layers = {};
  c.sources = {};
  c.projects.P = { id: 'P', path };
  c.subscriptionOnly = { decisionRuntime: runtime };
  return c;
}

/** What a thread at `cwd` would hold per Warden: its pre-start, recorded. */
async function threadHeld(c: FoundryConfig, cwd: string): Promise<Map<string, PrimeSpec>> {
  const held = new Map<string, PrimeSpec>();
  const recording: LLMProvider = {
    id: 'flow',
    complete: async () => ({ model: 'none', content: 'NO_COMMENT' }),
    prestart: (messages, opts) => {
      const key = opts.threadId!;
      if (!isWardenSession(key) || isStageSession(key)) return;
      const domain = /:aux:domain:(.+)$/.exec(key)![1]!;
      if (!held.has(domain)) held.set(domain, primedRequest(messages, opts, key).spec);
    },
  };
  await withChorusThread(
    {
      config: c,
      projectId: 'P',
      cwd,
      decisions: recording,
      agentProvider: (id) => ({ id, complete: async () => ({ model: 'none', content: '' }) }),
      resolveSource: createSourceResolver({ memory: new FileMemory(join(tempDir('mem'), 'm')) }),
    },
    async ({ live }) => warmWardens(live),
  );
  return held;
}

const isolatedHome = () => {
  const dir = tempDir('home');
  process.env.HOME = dir;
  process.env.CLAUDE_CONFIG_DIR = join(dir, '.claude');
};
const nothing: LLMProvider = { id: 'flow', complete: async () => ({ model: 'none', content: '' }) };

test('claude-project: the roster is every region Warden composed at the project root, and a worktree thread holds exactly it', async () => {
  isolatedHome();
  const dir = project();
  const c = config(dir, 'claude-project');
  const roster = await composeProjectRoster({
    config: c,
    projectId: 'P',
    decisions: nothing,
    resolveSource: createSourceResolver({ memory: new FileMemory(join(tempDir('mem'), 'm')) }),
  });
  expect(roster.map((e) => e.domain).sort()).toEqual(['concurrency-locks', 'lens-model']);
  for (const { spec: held } of roster) {
    // Wardens never get CLAUDE.md: the charter, the warden brief and the region. The brief is the
    // registered checkout's, whatever branch a worktree thread is on.
    expect(held.instructions).not.toContain('CLAUDE_MD');
    expect(held.instructions).toContain('ROOT_WARDEN_BRIEF');
    expect(held.instructions).not.toContain('WORKTREE_WARDEN_BRIEF');
    expect(held.context).toContain('KNOWLEDGE_');
  }
  const lens = roster.find((e) => e.domain === 'lens-model')!.spec;
  expect(lens.instructions).toContain('ROOT_ROLE_FILE');
  expect(lens.instructions).not.toContain('WORKTREE_ROLE_FILE');
  const fromWorktree = await threadHeld(c, join(dir, '.worktrees', 'feat'));
  for (const { domain, spec: held } of roster)
    expect(fromWorktree.get(domain)!.hash).toBe(held.hash);
});

test('other runtimes keep composing at the thread: a worktree thread reads its own role file', async () => {
  isolatedHome();
  const dir = project();
  const fromWorktree = await threadHeld(config(dir, 'claude'), join(dir, '.worktrees', 'feat'));
  expect(fromWorktree.get('lens-model')!.instructions).toContain('WORKTREE_ROLE_FILE');
});

test('claude-project: a handoff brief (flow.brief) asks every Warden through the advice path, routed to the project host', async () => {
  isolatedHome();
  const dir = project();
  const c = config(dir, 'claude-project');
  const roster = await composeProjectRoster({
    config: c,
    projectId: 'P',
    decisions: nothing,
    resolveSource: createSourceResolver({ memory: new FileMemory(join(tempDir('mem'), 'm')) }),
  });
  const held = new Set(roster.map((e) => e.spec.hash));
  const host = { serving: () => true } as unknown;
  const hosts = { serving: () => host } as unknown as ProjectWardenHosts;
  const calls: Array<{ routed: boolean; held: boolean }> = [];
  const recording: LLMProvider = {
    id: 'flow',
    complete: async (messages, opts = {}) => {
      const key = opts.threadId ?? '';
      if (isWardenSession(key) && !isStageSession(key))
        calls.push({
          routed: projectHostTarget(hosts, key) === host,
          held: held.has(primedRequest(messages, opts, key).spec.hash),
        });
      return { model: 'none', content: 'NO_COMMENT' };
    },
  };
  await withChorusThread(
    {
      config: c,
      projectId: 'P',
      cwd: join(dir, '.worktrees', 'feat'),
      decisions: recording,
      agentProvider: (id) => ({ id, complete: async () => ({ model: 'none', content: '' }) }),
      resolveSource: createSourceResolver({ memory: new FileMemory(join(tempDir('mem'), 'm')) }),
    },
    async ({ live }) => {
      await warmWardens(live);
      await live.flowOrchestrator.brief({
        childThreadId: 'child',
        handoffId: 'h1',
        description: 'add the lock',
        prompt: 'Add a lock around the sync job.',
      });
    },
  );
  expect(calls.length).toBe(2);
  expect(calls.every((c) => c.routed)).toBe(true);
  // The handoff's charter is the advice charter: the brief is served by a held spare.
  expect(calls.every((c) => c.held)).toBe(true);
});

test("claude-project: a later stage on another model is recorded with its model, so it is held by that model's lane", async () => {
  isolatedHome();
  const dir = project();
  const stages: Array<string | undefined> = [];
  const roster = await composeProjectRoster({
    config: config(dir, 'claude-project'),
    projectId: 'P',
    decisions: nothing,
    stageHost: (model, effort) => {
      stages.push(model);
      return model === 'claude-sonnet-5-5' && effort === 'low'
        ? { ...nothing, id: 'sonnet' }
        : null;
    },
    resolveSource: createSourceResolver({ memory: new FileMemory(join(tempDir('mem'), 'm')) }),
  });
  expect(stages).toContain('claude-sonnet-5-5');
  const first = roster.filter((e) => !e.stage);
  const later = roster.filter((e) => e.stage);
  expect(first.map((e) => e.domain).sort()).toEqual(['concurrency-locks', 'lens-model']);
  expect(later.map((e) => e.domain).sort()).toEqual(['concurrency-locks', 'lens-model']);
  for (const entry of later)
    expect(entry.stage).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' });
});
