// The per-project Warden host (subscriptionOnly.decisionRuntime claude-project): one Foundry-owned
// Claude Code process per project holds every Warden warm; every thread of the project asks it for
// advice; it is supervised (restart with backoff, blue/green past its bounds) and fails open to primed.

import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ClaudeCodeSession, type PrimeSpec } from '@inixiative/agent-session';
import {
  EventStream,
  FileMemory,
  type LLMMessage,
  type LLMProvider,
} from '@inixiative/foundry-core';
import { composeProjectRoster, warmWardens, withChorusThread } from '../src/agents/chorus-thread';
import { createSourceResolver } from '../src/agents/thread-factory';
import { DECISION_PRIORITY } from '../src/providers/decision-priority';
import { defaultProfileSource } from '../src/providers/default-profiles';
import {
  followProjectActivity,
  InSessionWardens,
  type ProjectHostState,
  type Roster,
} from '../src/providers/in-session-wardens';
import {
  createPrimedDecisionHost,
  inSessionTarget,
  isStageSession,
  isWardenSession,
  primedRequest,
} from '../src/providers/primed-decisions';
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

/** A project-mode registry whose hosts run on the fake CLI: per-pid memory readings set by the test. */
function projectHosts(options: { noRoot?: boolean; maxRestarts?: number; idleMs?: number } = {}) {
  const tree = fakeClaudeTree({ noRoot: options.noRoot });
  const rss = new Map<number, number>();
  const states: Array<ProjectHostState & { projectId: string }> = [];
  const wardens = new InSessionWardens({
    mode: 'project',
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
    },
    healthIntervalMs: 10,
    rss: (pid) => rss.get(pid) ?? 100,
    onProject: (projectId, state) => states.push({ projectId, ...state }),
  });
  wardens.bindLauncher(async (_projectId, host) => {
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

test('a project host holds the roster before any thread; every thread of the project gets a held spare; another project goes primed', async () => {
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
  const host = wardens.serving('A1');
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
  // The same roster again changes nothing; threads never pre-start or release the project host.
  wardens.openProject('P', roster('lens', 'locks'));
  wardens.prestart('A1', roster('other'));
  await wardens.release('A1');
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
  followProjectActivity({
    hosts: wardens,
    events,
    projectOf: (threadId) => (threadId === 'A1' ? 'P' : undefined),
    open: async (projectId) => {
      opened.push(projectId);
      wardens.openProject(projectId, roster('locks'));
    },
  });
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
  // No activity for the bound: the host closes, and routing falls back to primed.
  expect(await until(() => wardens.openProjects().length === 0, 2_000)).toBe(true);
  expect(wardens.serving('A1')).toBeUndefined();
  expect(await until(() => tree.processes[0]!.exited)).toBe(true);
  // The next turn opens it again.
  events.push({ kind: 'journal', threadId: 'A1', projectId: 'P', turnId: 't9', timestamp: 4 });
  expect(opened).toEqual(['P', 'P']);
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
});

test('a host process that dies: routing falls back at once, and a new host is started and serves', async () => {
  const { tree, wardens } = projectHosts();
  wardens.openProject('P', roster('locks'));
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  const dead = wardens.serving('A1');
  tree.processes[0]!.crash();
  // Routing leaves the dead host at once (the replacement may already serve: the double is fast).
  expect(await until(() => wardens.serving('A1') !== dead)).toBe(true);
  expect(dead!.serving()).toBe(false);
  expect(await until(() => wardens.projectState('P')?.generation === 2)).toBe(true);
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  expect(Object.keys(wardens.projectState('P')!.resets)[0]).toMatch(/^process ended/);
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

test('a host that never sets up is retried with backoff, then the project stays on primed Wardens', async () => {
  const { tree, states, wardens } = projectHosts({ noRoot: true, maxRestarts: 2 });
  // The setup deadline is the setting's; no root ever starts, so the setup turn ends degraded.
  wardens.openProject('P', roster('locks'));
  expect(await until(() => wardens.projectState('P')?.status === 'failed', 15_000)).toBe(true);
  expect(tree.processes.length).toBe(2);
  expect(tree.processes.every((p) => p.exited)).toBe(true);
  expect(wardens.serving('A1')).toBeUndefined();
  expect(states.at(-1)!.reason).toMatch(/2 starts failed in a row/);
}, 20_000);

test('routing: a project host takes advice only; guards, reviews and later stages stay primed, as thread mode keeps guards', () => {
  const host = { serving: () => true } as unknown;
  const project = {
    mode: 'project',
    serving: () => host,
  } as unknown as InSessionWardens;
  const thread = { mode: 'thread', serving: () => host } as unknown as InSessionWardens;
  expect(inSessionTarget(project, 'A1:aux:domain:locks')).toBe(host as never);
  expect(
    inSessionTarget(project, 'A1:aux:domain:locks', { priority: DECISION_PRIORITY.turn }),
  ).toBe(host as never);
  expect(
    inSessionTarget(project, 'A1:aux:domain:locks', { priority: DECISION_PRIORITY.guard }),
  ).toBeUndefined();
  expect(inSessionTarget(project, 'A1:aux:review:g1:domain:locks')).toBeUndefined();
  expect(inSessionTarget(project, 'A1:aux:domain:locks:stage:1')).toBeUndefined();
  expect(inSessionTarget(project, 'A1:aux:cartographer')).toBeUndefined();
  expect(
    inSessionTarget(thread, 'A1:aux:domain:locks', { priority: DECISION_PRIORITY.guard }),
  ).toBe(host as never);
});

test('settings: claude-project resolves to project Wardens with the host defaults; projectHost is refused on another runtime', () => {
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
  config.subscriptionOnly = { decisionRuntime: 'claude', projectHost: { maxRssMb: 2_048 } };
  expect(() => resolveSubscriptionPolicy(config, { cwd: root })).toThrow(
    /projectHost applies only to decisionRuntime claude-project/,
  );
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
  const wardens = new InSessionWardens({
    mode: 'project',
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
    inSession: wardens,
  });
  cleanup.push(async () => {
    await wardens.close();
    await primed.close();
  });
  // Threads never pre-start or release a project host.
  expect(primed.prestart).toBeUndefined();
  expect(primed.releaseThread).toBeUndefined();
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
  wardens.openProject('P', [{ spec: held, standby: '' }]);
  expect(await wardens.projectReady('P', 5_000)).toBe(true);
  const launch = tree.processes[0]!;
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
  expect(Object.keys(launch.env).filter((key) => /API_KEY|AUTH_TOKEN/.test(key))).toEqual([]);
  const run = primed.createRun({
    source: defaultProfileSource('claude'),
    directory,
    runId: crypto.randomUUID(),
    model: 'claude-haiku-5-5',
    maxCalls: 2,
  });
  const answer = await run.provider.complete(messages('T7'), {
    threadId: 'T7:aux:domain:locks',
    stablePrefix: cache,
  });
  expect(answer.content).toBe(
    'ANS:\n## Your understanding of this thread\nT7 knows\n\n## Message\nadd a lock',
  );
  expect(run.snapshot().calls[0]).toMatchObject({ prime: 'warm', valid: true });
  // The held text is the composed Warden and its knowledge; no thread's state.
  const holding = tree.memberPrompts[0]!;
  expect(holding).toContain('LOCKS WARDEN');
  expect(holding).toContain('use createLock');
  expect(holding).not.toContain('knows');
});

// -- Composition: what a thread of the project sends is what the project host holds -------------

/**
 * A git project whose repository enables a two-region chorus. A region's role file overlays its
 * instructions at the root, and a worktree carries its own (an unmerged edit).
 */
function project(): string {
  const dir = tempDir('project-host');
  mkdirSync(join(dir, '.git'));
  write(join(dir, '.foundry', 'project.json'), JSON.stringify({ chorus: { enabled: true } }));
  write(join(dir, 'CLAUDE.md'), 'ROOT_CLAUDE_MD\n');
  write(join(dir, '.foundry', 'roles', 'lens-model', 'instructions.md'), 'ROOT_ROLE_FILE\n');
  write(join(dir, '.foundry', 'warden-brief.md'), 'ROOT_WARDEN_BRIEF\n');
  const worktree = join(dir, '.worktrees', 'feat');
  write(join(worktree, '.git'), 'gitdir: ../../.git/worktrees/feat\n');
  write(join(worktree, 'CLAUDE.md'), 'WORKTREE_CLAUDE_MD\n');
  write(
    join(worktree, '.foundry', 'roles', 'lens-model', 'instructions.md'),
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
      prompt: 'WORKER',
      provider: 'central',
      model: 'central-model',
      visibleLayers: [],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
  };
  c.defaults.classifierProvider = 'flow';
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
  const hosts = { mode: 'project', serving: () => host } as unknown as InSessionWardens;
  const calls: Array<{ routed: boolean; held: boolean }> = [];
  const recording: LLMProvider = {
    id: 'flow',
    complete: async (messages, opts = {}) => {
      const key = opts.threadId ?? '';
      if (isWardenSession(key) && !isStageSession(key))
        calls.push({
          routed: inSessionTarget(hosts, key, opts) === host,
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
