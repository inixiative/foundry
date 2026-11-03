import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CompletionOpts,
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  type LLMProvider,
  type NativeEvidence,
  type ThreadMeta,
} from '@inixiative/foundry-core';
import { ProjectRegistry } from '../src/agents/project';
import { createMainThread, ThreadFactory, WorkerRefusedError } from '../src/agents/thread-factory';
import { LocalSessionStore, UNSTAMPED_RECORD } from '../src/persistence/local-session-store';
import { InSessionWardens, inSessionThreadSetup } from '../src/providers/in-session-wardens';
import {
  ClaudeCodeSessionAdapter,
  CodexSessionAdapter,
  FileExternalSessionStore,
} from '../src/providers/session-adapter';
import { SessionBackedProvider } from '../src/providers/session-backed';
import {
  resolveSubscriptionPolicy,
  type SubscriptionResolution,
  threadWorkerRequirement,
} from '../src/providers/subscription-policy';
import { recordPlan } from '../src/tools/thread-record';
import {
  JOURNAL_HISTORY_CHARS,
  journalHistory,
  WORKER_SWITCH_PHASE,
  workerHistoryBudget,
} from '../src/turns/journal-history';
import {
  ConfigStore,
  defaultAgents,
  defaultConfig,
  type FoundryConfig,
  validateConfig,
} from '../src/viewer/config';
import { resolveThreadView } from '../src/viewer/config-resolve';
import { createViewer } from '../src/viewer/server';
import { ViewerThreadDirectory } from '../src/viewer/thread-directory';
import { claudeCli } from './helpers/claude-cli';
import { until } from './helpers/live-watch-fixture';
import { appServerTransport } from './helpers/subscription-transport';

/**
 * FEAT-007: a project has a default subscription worker, and any thread may run on another worker
 * the user has a login for. The worker is stored on the thread and never changed silently.
 */

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function temporary(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A provider standing in for one worker's native session: it records the models it is asked for. */
function workerProvider(id: string) {
  const models: string[] = [];
  const provider: LLMProvider = {
    id,
    async complete(_messages, opts?: CompletionOpts) {
      models.push(opts?.model ?? '');
      return { content: `${id} answered`, model: opts?.model ?? '' };
    },
  };
  return { provider, models };
}

/** A Claude-default project and a Codex-default one, each worker on its own configured login. */
function fixture() {
  const root = temporary('thread-worker-');
  const login = (runtime: 'claude' | 'codex') => {
    const profileDirectory = join(root, runtime);
    mkdirSync(profileDirectory, { mode: 0o700 });
    return {
      id: crypto.randomUUID(),
      integrationId: crypto.randomUUID(),
      runtime,
      mode: 'native-profile' as const,
      profileDirectory,
    };
  };
  const saved = defaultConfig();
  saved.agents = defaultAgents();
  saved.nativeAuthentication = [login('claude'), login('codex')];
  saved.projects = {
    claude: { id: 'claude', path: root, tags: [] },
    codex: {
      id: 'codex',
      path: root,
      tags: [],
      defaults: { provider: 'codex', model: 'gpt-6-astra' },
    },
  };
  const resolution = resolveSubscriptionPolicy(saved)!;
  const claude = workerProvider('claude-code'),
    codex = workerProvider('codex');
  const providers = new Map<string, LLMProvider>([
    ['claude-code', claude.provider],
    ['codex', codex.provider],
  ]);
  const factory = (resolved: SubscriptionResolution | undefined = resolution) =>
    new ThreadFactory({
      stack: new ContextStack(),
      agents: new Map(),
      configuration: {
        config: resolved?.config ?? saved,
        layers: { sourceResolver: () => null },
        agents: { provider: claude.provider, providers },
      },
      workerRequirement: (view, worker, projectId) =>
        threadWorkerRequirement(resolved, view, worker, projectId),
    });
  return { root, saved, resolution, claude, codex, factory };
}

const answer = async (thread: { dispatch(agent: string, payload: string): Promise<unknown> }) =>
  thread.dispatch('executor', 'hello');

test("a codex thread in a Claude project runs on the Codex worker's provider and model", async () => {
  const f = fixture();
  const factory = f.factory();
  const host = factory.create('host', { projectId: 'claude' });
  const member = factory.create('member', { projectId: 'claude', worker: 'codex' });
  expect(host.meta.worker).toBe('claude-code');
  expect(member.meta.worker).toBe('codex');
  await answer(host);
  await answer(member);
  expect(f.claude.models).toEqual(['fable']);
  expect(f.codex.models).toEqual(['gpt-6-astra']);
  // A Codex-default project's threads run on Codex unless one chooses Claude.
  expect(factory.create('c', { projectId: 'codex' }).meta.worker).toBe('codex');
  const chosen = factory.create('d', { projectId: 'codex', worker: 'claude-code' });
  await answer(chosen);
  expect(f.claude.models.at(-1)).toBe('fable');
});

test("a thread keeps its worker across restart, reopen and an edit of its project's default", async () => {
  const f = fixture();
  const factory = f.factory();
  const main = factory.create('main', { projectId: 'claude' });
  const registry = new ProjectRegistry();
  registry.loadFromConfigs(f.resolution.config.projects);
  registry.get('claude')!.addThread(main);
  const directory = new ViewerThreadDirectory(main, registry, factory);
  const meta = (worker?: string): ThreadMeta => ({
    description: '',
    tags: [],
    status: 'idle',
    projectId: 'claude',
    createdAt: 1,
    lastActiveAt: 1,
    ...(worker ? { worker } : {}),
  });
  // Restart: the stored record names its worker; one that names none is never given a default.
  const warnings = directory.restore([
    { id: 'codex-thread', meta: meta('codex') },
    { id: 'unstamped', meta: meta() },
  ]);
  expect(warnings).toEqual([
    'Stored thread unstamped retained on disk: its record names no worker',
  ]);
  const restored = directory.get('codex-thread')!;
  expect(restored.meta.worker).toBe('codex');
  await answer(restored);
  expect(f.codex.models).toEqual(['gpt-6-astra']);
  // Reopen: archived, then rebuilt on the same worker.
  restored.archive();
  const reopened = directory.reopen('codex-thread')!;
  expect(reopened).not.toBe(restored);
  expect(reopened.meta.worker).toBe('codex');
  await answer(reopened);
  expect(f.codex.models).toHaveLength(2);
  // The project's default moves to Codex: a Claude thread stays on Claude.
  const claudeThread = factory.create('claude-thread', { projectId: 'claude' });
  const edited = structuredClone(f.saved);
  edited.projects.claude!.defaults = { provider: 'codex', model: 'gpt-6-astra' };
  await factory.reconfigure(resolveSubscriptionPolicy(edited)!.config);
  expect(claudeThread.meta.worker).toBe('claude-code');
  await answer(claudeThread);
  expect(f.claude.models.at(-1)).toBe('fable');
  // A new thread there takes the new default.
  expect(factory.create('later', { projectId: 'claude' }).meta.worker).toBe('codex');
});

test('a changed worker is refused on save once the thread has run a turn; removing it always is', () => {
  const store = new LocalSessionStore(':memory:');
  cleanup.push(() => store.close());
  const thread = {
    id: 't',
    meta: {
      description: '',
      tags: [],
      status: 'idle',
      createdAt: 1,
      lastActiveAt: 1,
      worker: 'claude-code',
    } as ThreadMeta,
  };
  store.saveThread(thread);
  // Before its first turn no native session holds it: the worker may still change.
  thread.meta.worker = 'codex';
  store.saveThread(thread);
  store.beginTurn(thread, 'turn-1', 'hello');
  thread.meta.worker = 'claude-code';
  expect(() => store.saveThread(thread)).toThrow('cannot change after its first turn');
  thread.meta.worker = undefined;
  expect(() => store.saveThread(thread)).toThrow('cannot be removed');
});

test('no login, its vendor off, or apiTokens: the thread is refused with the reason, never another worker', () => {
  const f = fixture();
  const view = resolveThreadView(f.resolution.config, { projectId: 'claude' }).config;
  expect(threadWorkerRequirement(f.resolution, view, 'codex')).toBeUndefined();
  // Vendor off.
  const off = { ...view, vendors: { ...view.vendors, openai: { enabled: false } } };
  expect(threadWorkerRequirement(f.resolution, off, 'codex')).toContain('is off');
  // No login on this machine.
  const noLogin: SubscriptionResolution = {
    ...f.resolution,
    workers: { 'claude-code': f.resolution.workers['claude-code']! },
    unavailable: { codex: 'codex subscription profile unavailable at /nowhere' },
  };
  expect(threadWorkerRequirement(noLogin, view, 'codex')).toContain('has no usable login');
  const factory = f.factory(noLogin);
  expect(() => factory.create('t', { projectId: 'claude', worker: 'codex' })).toThrow(
    WorkerRefusedError,
  );
  // Not a subscription worker: never an API provider.
  expect(threadWorkerRequirement(f.resolution, view, 'openai')).toContain(
    'not a subscription worker',
  );
  // apiTokens: only the default provider.
  const api = { ...view, apiTokens: true };
  expect(threadWorkerRequirement(undefined, api, 'claude-code')).toBeUndefined();
  expect(threadWorkerRequirement(undefined, api, 'codex')).toContain('apiTokens');
});

test("an executor model the thread's worker does not run gives way, and the view says so", () => {
  const f = fixture();
  const config = structuredClone(f.resolution.config);
  config.agents.executor!.model = 'opus';
  const claude = resolveThreadView(config, { projectId: 'claude', worker: 'claude-code' });
  expect(claude.config.agents.executor!.model).toBe('opus');
  expect(claude.setAside).toEqual([]);
  const codex = resolveThreadView(config, { projectId: 'claude', worker: 'codex' });
  expect(codex.config.defaults).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' });
  expect(codex.config.agents.executor!.model).toBeUndefined();
  expect(codex.setAside).toEqual([{ agent: 'executor', model: 'opus' }]);
});

test('under claude-in-session only Claude Code threads set up; Codex threads never show as setting up', async () => {
  const wardens = new InSessionWardens({ model: 'claude-haiku-5-5', timeoutMs: 1_000 });
  cleanup.push(() => wardens.close());
  const opened: string[] = [];
  const workers: Record<string, string> = { claude: 'claude-code', codex: 'codex' };
  const setup = inSessionThreadSetup({
    wardens,
    provider: {
      open: async (threadId) => {
        opened.push(threadId);
      },
    },
    worker: (threadId) => workers[threadId],
    onSetup: () => {},
  });
  expect(setup.applies('claude')).toBe(true);
  expect(setup.applies('codex')).toBe(false);
  expect(setup.pending('claude')).toBe(true);
  expect(setup.pending('codex')).toBe(false);
  await setup.open('codex', {});
  expect(opened).toEqual([]);
  await setup.open('claude', {});
  expect(opened).toEqual(['claude']);
});

/** The viewer over a configured factory, as the daemon serves it. */
async function viewer(
  extra: Partial<Parameters<typeof createViewer>[0]> = {},
  mainWorker?: string,
) {
  const f = fixture();
  const dir = temporary('thread-worker-viewer-');
  const store = new ConfigStore(dir);
  await store.save(f.saved);
  const factory = f.factory();
  const registry = new ProjectRegistry();
  registry.loadFromConfigs(f.resolution.config.projects);
  const main = factory.create('main', {
    projectId: 'claude',
    ...(mainWorker ? { worker: mainWorker } : {}),
  });
  registry.get('claude')!.addThread(main);
  const harness = new Harness(main);
  harness.setDefaultExecutor('executor');
  const served = createViewer({
    harness,
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
    configStore: store,
    threadFactory: factory,
    projectRegistry: registry,
    ...extra,
  });
  cleanup.push(async () => {
    await served.analyticsReady.catch(() => {});
    served.localStore?.close();
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await served.app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { f, served, call, factory, main };
}

test('POST /api/threads takes a worker; a refused one is a 400 with the reason', async () => {
  const { call } = await viewer();
  const created = await call('POST', '/api/threads', { projectId: 'claude', worker: 'codex' });
  expect(created.status).toBe(201);
  expect((created.body.meta as ThreadMeta).worker).toBe('codex');
  const launch = await call('GET', `/api/threads/${created.body.threadId}/launch`);
  expect(launch.body).toMatchObject({ worker: 'codex', provider: 'codex', model: 'gpt-6-astra' });
  // Each worker carries its own models and default model, so a worker and its model go together.
  const workers = (launch.body.options as { workers: Array<Record<string, unknown>> }).workers;
  expect(workers).toEqual([
    expect.objectContaining({ id: 'claude-code', label: expect.any(String), default: true }),
    expect.objectContaining({ id: 'codex', label: expect.any(String), default: false }),
  ]);
  const codex = workers[1] as { defaultModel: string; models: Array<{ id: string }> };
  expect(codex.models.map((m) => m.id)).toContain(codex.defaultModel);
  const refused = await call('POST', '/api/threads', { projectId: 'claude', worker: 'openai' });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain('not a subscription worker');
});

test('PATCH /api/threads/:id changes the worker; after the first turn behind a recorded switch, never mid-turn', async () => {
  const { call, served } = await viewer();
  const created = await call('POST', '/api/threads', { projectId: 'claude' });
  const id = created.body.threadId as string;
  expect((created.body.meta as ThreadMeta).worker).toBe('claude-code');
  // Before the first turn: the thread is rebuilt on the new worker, with nothing to mark.
  const moved = await call('PATCH', `/api/threads/${id}`, { worker: 'codex' });
  expect(moved.status).toBe(200);
  expect((moved.body.meta as ThreadMeta).worker).toBe('codex');
  expect((await call('GET', `/api/threads/${id}/launch`)).body).toMatchObject({
    worker: 'codex',
    provider: 'codex',
    started: false,
    switches: [],
  });
  const store = served.localStore!;
  const record = { id, meta: moved.body.meta as ThreadMeta };
  store.beginTurn(record, 'turn-1', 'hello');
  store.completeTurn(
    record,
    'turn-1',
    'hi there',
    {},
    {
      id: 'trace-1',
      messageId: 'turn-1',
      startedAt: 1,
      root: {},
      summary: {},
      spans: [],
    },
  );
  // After it: the switch is journalled first ("continued on"), and only then is the worker saved.
  const late = await call('PATCH', `/api/threads/${id}`, { worker: 'claude-code' });
  expect(late.status).toBe(200);
  expect((late.body.meta as ThreadMeta).worker).toBe('claude-code');
  const launch = (await call('GET', `/api/threads/${id}/launch`)).body;
  expect(launch).toMatchObject({ worker: 'claude-code', started: true });
  expect(launch.switches).toEqual([
    expect.objectContaining({ from: 'codex', to: 'claude-code', at: expect.any(Number) }),
  ]);
  expect(store.threadMeta(id)?.worker).toBe('claude-code');
  // The store refuses a change after the first turn that no marker names.
  expect(() =>
    store.saveThread({ id, meta: { ...store.threadMeta(id)!, worker: 'codex' } } as never),
  ).toThrow('without a recorded switch');
  // The main thread runs on its project's default.
  expect((await call('PATCH', '/api/threads/main', { worker: 'codex' })).status).toBe(409);
});

test('a Codex local member joins a Claude host and runs its turns on Codex', async () => {
  const { call, served, f } = await viewer();
  const member = await call('POST', '/api/threads', {
    id: 'codex-member',
    projectId: 'claude',
    worker: 'codex',
  });
  expect(member.status).toBe(201);
  const joined = await call('POST', '/api/threads/main/conversation/locals', {
    threadId: 'codex-member',
    displayName: 'Codex',
  });
  expect(joined.status).toBe(200);
  // A send to it wakes it: its turn runs on the Codex worker's provider and model.
  expect(served.conversations!.send('main', 'Codex', 'Codex, take a look')).toBe('Sent to Codex.');
  await until(() => f.codex.models.length === 1, 'the Codex member woken');
  expect(f.codex.models).toEqual(['gpt-6-astra']);
  expect(f.claude.models).toEqual([]);
});

test('the fixture is a valid saved configuration', () => {
  const config: FoundryConfig = fixture().saved;
  expect(() => validateConfig(config)).not.toThrow();
  expect(config.projects.codex?.defaults?.provider).toBe('codex');
});

test('main keeps its stored worker; a stored main record without one stops startup', () => {
  const dir = temporary('thread-worker-main-');
  const path = join(dir, 'sessions.sqlite');
  expect(LocalSessionStore.storedWorker(path, 'main')).toBeUndefined();
  const record = (worker?: string) => ({
    id: 'main',
    meta: {
      description: '',
      tags: [],
      status: 'idle',
      createdAt: 1,
      lastActiveAt: 1,
      ...(worker ? { worker } : {}),
    } as ThreadMeta,
  });
  let store = new LocalSessionStore(path);
  store.saveThread(record());
  // A save never stamps an unstamped record: the live main on the current default would clobber it.
  expect(() => store.saveThread(record('claude-code'))).toThrow(UNSTAMPED_RECORD);
  store.close();
  expect(() => LocalSessionStore.storedWorker(path, 'main')).toThrow(UNSTAMPED_RECORD);
  rmSync(path, { force: true });
  store = new LocalSessionStore(path);
  store.saveThread(record('codex'));
  store.close();
  // A journal closed cleanly leaves no -wal or -shm; startup still reads it.
  for (const suffix of ['-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  expect(LocalSessionStore.storedWorker(path, 'main')).toBe('codex');
  // Reading never writes: no -wal appears.
  expect(existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0).toBe(false);
});

test('main on a worker it can no longer run on is refused, naming the main thread, its worker and the fix', () => {
  const f = fixture();
  const noCodex: SubscriptionResolution = {
    ...f.resolution,
    workers: { 'claude-code': f.resolution.workers['claude-code']! },
  };
  expect(() =>
    createMainThread(f.factory(noCodex), { projectId: 'claude', worker: 'codex' }),
  ).toThrow(/The main thread runs on codex and cannot start: .*Make codex usable again/);
});

test("a Kingdom project's default worker needs no login on this machine; its threads may run on it", () => {
  const root = temporary('thread-worker-kingdom-');
  mkdirSync(join(root, '.claude'), { mode: 0o755 });
  const home = process.env.HOME;
  process.env.HOME = root;
  try {
    const c = defaultConfig();
    c.projects = {
      pooled: {
        id: 'pooled',
        path: root,
        tags: [],
        capacity: 'kingdom',
        defaults: { provider: 'codex', model: 'gpt-6-astra' },
      },
    };
    const resolved = resolveSubscriptionPolicy(c, { startup: true, cwd: root })!;
    expect(resolved.workers.codex).toBeUndefined();
    expect(resolved.offered).toContain('codex');
    const view = resolveThreadView(resolved.config, { projectId: 'pooled' }).config;
    expect(threadWorkerRequirement(resolved, view, 'codex', 'pooled')).toBeUndefined();
    // A thread run on this machine still needs the login.
    expect(threadWorkerRequirement(resolved, resolved.config, 'codex')).toContain(
      'has no usable login',
    );
  } finally {
    process.env.HOME = home;
  }
});

test("a fork carries its source's worker", async () => {
  const { call } = await viewer({});
  const source = await call('POST', '/api/threads', { projectId: 'claude', worker: 'codex' });
  const fork = await call('POST', `/api/threads/${source.body.threadId}/fork`, { atSeq: 0 });
  expect(fork.status).toBe(201);
  expect((fork.body.meta as ThreadMeta).worker).toBe('codex');
});

for (const worker of ['claude-code', 'codex'] as const)
  test(`under claude-in-session, a ${worker} thread's subagent ${worker === 'codex' ? 'sends no in-session guard signal' : 'is guarded in-session'}; the child carries its worker`, async () => {
    let sink!: (threadId: string, evidence: NativeEvidence) => void;
    const { served, main } = await viewer(
      {
        subagentSources: [
          {
            observeSubagents(observe) {
              sink = observe;
              return () => {};
            },
          },
        ],
        threadSetup: {
          applies: (threadId) => served.directory.get(threadId)?.meta.worker === 'claude-code',
          open: async () => {},
          pending: () => false,
          onSetup: () => {},
        },
      },
      worker,
    );
    const observed: string[] = [];
    main.signals.on('tool_observation', async () => {
      observed.push('tool');
    });
    served.localStore!.beginTurn(main, 'turn-1', 'Explore');
    const base = { schema: 1 as const, nativeOutcome: 'unknown' as const };
    sink('main', {
      ...base,
      kind: 'subagent',
      subagent: { phase: 'started', taskId: 'task-1', toolUseId: 'toolu_spawn', prompt: 'Look' },
    });
    sink('main', {
      ...base,
      kind: 'tool_use',
      parentToolUseId: 'toolu_spawn',
      callId: 'toolu_w',
      toolName: 'Write',
      toolInput: { file_path: 'a.ts' },
    });
    sink('main', {
      ...base,
      kind: 'tool_result',
      parentToolUseId: 'toolu_spawn',
      callId: 'toolu_w',
      toolOutput: 'written',
      toolError: false,
    });
    await Bun.sleep(20);
    expect(observed).toEqual(worker === 'codex' ? [] : ['tool']);
    const child = served.directory.all().find((t) => t.meta.parentThreadId === 'main')!;
    expect(child.meta.worker).toBe(worker);
  });

test('a turn sent while a worker change closes the old in-session host lands on the rebuilt thread', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { call, served, f } = await viewer({
    threadSetup: {
      applies: () => false,
      open: async () => {},
      pending: () => false,
      release: () => gate,
      onSetup: () => {},
    },
  });
  const created = await call('POST', '/api/threads', { projectId: 'claude' });
  const id = created.body.threadId as string;
  const patch = call('PATCH', `/api/threads/${id}`, { worker: 'codex' });
  await until(() => served.directory.get(id)?.meta.worker === 'codex', 'rebuilt on codex');
  // The old host is still closing: a turn sent now runs on the live, rebuilt thread.
  const sent = await call('POST', '/api/messages', { threadId: id, message: 'hello' });
  expect(sent.status).toBe(200);
  expect(f.codex.models).toEqual(['gpt-6-astra']);
  release();
  expect((await patch).status).toBe(200);
  const thread = served.directory.get(id)!;
  expect(thread.disposed).toBe(false);
  expect(thread.meta.worker).toBe('codex');
});

test('startup gives stored records from before FEAT-007 the worker they ran on, once', () => {
  const dir = temporary('thread-worker-stamp-');
  const path = join(dir, 'sessions.sqlite');
  const store = new LocalSessionStore(path);
  const record = (id: string, extra: Partial<ThreadMeta> = {}) => ({
    id,
    meta: {
      description: '',
      tags: [],
      status: 'idle',
      createdAt: 1,
      lastActiveAt: 1,
      ...extra,
    } as ThreadMeta,
  });
  store.saveThread(record('main'));
  store.saveThread(record('on-codex', { projectId: 'p' }));
  store.saveThread(record('never-ran', { projectId: 'p' }));
  store.saveThread(
    record('child', {
      parentThreadId: 'on-codex',
      spawn: { observed: true } as ThreadMeta['spawn'],
    }),
  );
  store.saveThread(record('both'));
  store.saveThread(record('stamped', { worker: 'codex' }));
  store.close();
  const sources = {
    bindings: {
      'claude-code': { main: 'claude-main', 'main:aux:domain:x': 'aux', both: 'b1' },
      'codex-app-server': { 'on-codex:kingdom:login': 'codex-1', both: 'b2' },
    },
    runtimeWorker: new Map([
      ['claude-code', 'claude-code'],
      ['codex-app-server', 'codex'],
    ]),
    projectDefault: (projectId: string | undefined) =>
      projectId === 'p' ? 'codex' : 'claude-code',
  };
  const first = LocalSessionStore.stampWorkers(path, sources);
  expect(Object.fromEntries(first.stamped.map(({ id, worker }) => [id, worker]))).toEqual({
    main: 'claude-code', // its own binding; an auxiliary's never counts
    'on-codex': 'codex', // an auth-suffixed binding is still its own
    'never-ran': 'codex', // no native session to disagree: the project default
    child: 'codex', // an observed child runs in its parent
  });
  // Bound under two runtimes: left alone, so reading it fails loudly rather than guessing.
  expect(first.ambiguous).toEqual(['both']);
  expect(() => LocalSessionStore.storedWorker(path, 'both')).toThrow(UNSTAMPED_RECORD);
  expect(LocalSessionStore.storedWorker(path, 'main')).toBe('claude-code');
  expect(LocalSessionStore.storedWorker(path, 'stamped')).toBe('codex');
  // Once: a second startup stamps nothing.
  expect(LocalSessionStore.stampWorkers(path, sources).stamped).toEqual([]);
});

test('startup stamping reads every binding shape, and never guesses an unknown runtime or an orphan', () => {
  const dir = temporary('thread-worker-stamp-shapes-');
  const path = join(dir, 'sessions.sqlite');
  const store = new LocalSessionStore(path);
  const record = (id: string, extra: Partial<ThreadMeta> = {}) => ({
    id,
    meta: {
      description: '',
      tags: [],
      status: 'idle',
      createdAt: 1,
      lastActiveAt: 1,
      ...extra,
    } as ThreadMeta,
  });
  for (const id of ['authed', 'aux-only', 'elsewhere']) store.saveThread(record(id));
  store.saveThread(
    record('orphan', {
      parentThreadId: 'gone',
      spawn: { observed: true } as ThreadMeta['spawn'],
    }),
  );
  store.close();
  const first = LocalSessionStore.stampWorkers(path, {
    bindings: {
      'codex-app-server': { 'authed:auth:source-1:abc123': 'codex-1' },
      // An auxiliary's own binding, with its profile suffix, never names its thread's worker.
      'claude-code': { 'aux-only:aux:domain:x:profile:text-only-v1': 'aux' },
      // A runtime no worker owns: not guessed.
      'some-new-runtime': { elsewhere: 'x' },
    },
    runtimeWorker: new Map([
      ['claude-code', 'claude-code'],
      ['codex-app-server', 'codex'],
    ]),
    projectDefault: () => 'claude-code',
  });
  expect(Object.fromEntries(first.stamped.map(({ id, worker }) => [id, worker]))).toEqual({
    authed: 'codex',
    'aux-only': 'claude-code',
    // Its parent's record is gone: its own bindings (none) and project default decide.
    orphan: 'claude-code',
  });
  expect(first.ambiguous).toEqual(['elsewhere']);
});

test('a project offers its workers, each with its own models and default model', async () => {
  const { call } = await viewer();
  const listed = await call('GET', '/api/projects/claude/workers');
  expect(listed.status).toBe(200);
  const workers = listed.body.workers as Array<{
    id: string;
    default: boolean;
    defaultModel: string;
    models: Array<{ id: string }>;
  }>;
  expect(workers.find((w) => w.default)?.id).toBe('claude-code');
  for (const worker of workers)
    expect(worker.models.map((m) => m.id)).toContain(worker.defaultModel);
  expect((await call('GET', '/api/projects/missing/workers')).status).toBe(404);
});

test('a new thread starts on a chosen model and effort; each must be one its worker and model take', async () => {
  const { call } = await viewer();
  const created = await call('POST', '/api/threads', {
    projectId: 'claude',
    worker: 'codex',
    model: 'gpt-6-sol',
    effort: 'ultra',
  });
  expect(created.status).toBe(201);
  const launch = await call('GET', `/api/threads/${created.body.threadId}/launch`);
  expect(launch.body).toMatchObject({
    worker: 'codex',
    model: 'gpt-6-sol',
    modelOverride: 'gpt-6-sol',
    effort: 'ultra',
    workerLock: null,
  });
  // A model of another worker, or an effort the model doesn't take, is refused before anything is built.
  const wrongModel = await call('POST', '/api/threads', {
    projectId: 'claude',
    model: 'gpt-6-sol',
  });
  expect(wrongModel.status).toBe(400);
  expect(wrongModel.body.error).toContain('not a claude-code model');
  const wrongEffort = await call('POST', '/api/threads', {
    projectId: 'claude',
    model: 'haiku',
    effort: 'max',
  });
  expect(wrongEffort.status).toBe(400);
  expect(wrongEffort.body.error).toContain('takes effort low, medium, high');
  expect((await call('POST', '/api/threads', { projectId: 'claude', effort: 'loud' })).status).toBe(
    400,
  );
});

test('the launch view always names an effort, says when the worker is fixed, and lists who is unavailable', async () => {
  const { call, served } = await viewer();
  // An empty Claude home: no effortLevel of the user's, so the model's own default.
  const claudeHome = temporary('claude-home-');
  const priorHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  cleanup.push(() => {
    if (priorHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = priorHome;
  });
  const created = await call('POST', '/api/threads', { projectId: 'claude' });
  const id = created.body.threadId as string;
  const view = (await call('GET', `/api/threads/${id}/launch`)).body as Record<string, unknown> & {
    options: {
      workers: Array<{
        id: string;
        models: Array<{ id: string; efforts: string[]; defaultEffort: string }>;
      }>;
      unavailableWorkers: Array<{ id: string; label: string; reason: string }>;
    };
  };
  // No effort chosen: the header still names the one it runs at, the user's Claude settings'
  // effortLevel (a main thread loads them), else the model's own default.
  expect(view.effort).toBeNull();
  expect(view.effortDefault).toBe('high');
  writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ effortLevel: 'medium' }));
  expect((await call('GET', `/api/threads/${id}/launch`)).body.effortDefault).toBe('medium');
  expect(view.workerLock).toBeNull();
  const haiku = view.options.workers[0]!.models.find((m) => m.id === 'haiku')!;
  expect(haiku).toMatchObject({ efforts: ['low', 'medium', 'high'], defaultEffort: 'high' });
  // Muse has no login in this fixture: it is not offered, and the view says why.
  expect(view.options.workers.map((w) => w.id)).not.toContain('muse');
  expect(view.options.unavailableWorkers).toEqual([
    { id: 'muse', label: expect.any(String), reason: expect.any(String) },
  ]);
  // An effort the model doesn't take is refused; a model change drops a chosen effort it doesn't take.
  expect((await call('PATCH', `/api/threads/${id}/launch`, { effort: 'max' })).status).toBe(200);
  const narrowed = await call('PATCH', `/api/threads/${id}/launch`, { model: 'haiku' });
  expect(narrowed.body).toMatchObject({ model: 'haiku', effort: null, effortDefault: 'medium' });
  const refused = await call('PATCH', `/api/threads/${id}/launch`, { effort: 'max' });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain('takes effort low, medium, high');
  // After its first turn the worker can still change (a switch carries the conversation over).
  served.localStore!.beginTurn({ id, meta: created.body.meta as ThreadMeta }, 'turn-1', 'hello');
  expect((await call('GET', `/api/threads/${id}/launch`)).body).toMatchObject({
    workerLock: null,
    started: true,
    switches: [],
  });
  // The global scope's workers, for a new thread outside every project.
  const global = await call('GET', '/api/workers');
  expect(global.status).toBe(200);
  expect((global.body.workers as Array<{ default: boolean }>).some((w) => w.default)).toBe(true);
});

test("the picker's default model is the project's own, and a refused worker with an effort is a 400", async () => {
  const { call, f } = await viewer();
  const saved = await call('PATCH', '/api/settings/projects', {
    claude: { id: 'claude', path: f.root, tags: [], defaults: { model: 'sonnet' } },
  });
  expect(saved.status).toBe(200);
  const workers = (await call('GET', '/api/projects/claude/workers')).body.workers as Array<{
    id: string;
    defaultModel: string;
  }>;
  // The project's default worker starts on the project's model; another worker on its own default.
  expect(workers.find((w) => w.id === 'claude-code')?.defaultModel).toBe('sonnet');
  expect(workers.find((w) => w.id === 'codex')?.defaultModel).toBe('gpt-6-astra');
  const refused = await call('POST', '/api/threads', {
    projectId: 'claude',
    worker: 'openai',
    effort: 'high',
  });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain('not a subscription worker');
});

/** Real Claude and Codex providers over controlled CLIs (recorded behaviour), sharing one binding file. */
function switchingWorkers(dir: string, journal: () => LocalSessionStore) {
  const bindings = new FileExternalSessionStore(join(dir, 'sessions.json'));
  const cli = claudeCli(new Set());
  const server = appServerTransport({ threadId: 'codex-thread-1', response: 'codex answered' });
  const history = (worker: string) => (threadId: string, turnId?: string) =>
    journalHistory(journal(), threadId, turnId, workerHistoryBudget(worker));
  const claudeAdapter = new ClaudeCodeSessionAdapter({
    store: bindings,
    contextBudget: false,
    defaults: { spawn: (argv) => cli.spawn(argv) },
  });
  const codexAdapter = new CodexSessionAdapter({
    store: bindings,
    defaults: { spawn: server.spawn },
  });
  const claude = new SessionBackedProvider({
    id: 'claude-code',
    adapter: claudeAdapter,
    defaultModel: 'haiku',
    defaultCwd: dir,
    history: history('claude-code'),
  });
  const codex = new SessionBackedProvider({
    id: 'codex',
    adapter: codexAdapter,
    defaultModel: 'controlled-model',
    defaultCwd: dir,
    history: history('codex'),
  });
  cleanup.push(() => claudeAdapter.releaseAll());
  cleanup.push(() => codexAdapter.releaseAll());
  const workerSessions = {
    binding: (worker: string, threadId: string) =>
      (worker === 'codex' ? codex : claude).bindingOf(threadId),
    retire: (worker: string, threadId: string) =>
      (worker === 'codex' ? codex : claude).retireThread(threadId),
  };
  return { cli, server, claude, codex, claudeAdapter, codexAdapter, workerSessions };
}

test('a thread switches Claude Code → Codex mid-conversation: a fresh Codex session seeded from the journal, behind a "continued on" marker, and back again fresh', async () => {
  const dir = temporary('worker-switch-');
  let store: LocalSessionStore | undefined;
  const w = switchingWorkers(dir, () => store!);
  const { call, served } = await viewer({ workerSessions: w.workerSessions });
  store = served.localStore!;
  const created = await call('POST', '/api/threads', { projectId: 'claude' });
  const id = created.body.threadId as string;
  // Turns are journalled against the thread as stored now (its worker changes below).
  const said = (turnId: string, user: string, answer: string) => {
    const record = { id, meta: store!.threadMeta(id)! };
    store!.beginTurn(record, turnId, user);
    store!.completeTurn(
      record,
      turnId,
      answer,
      {},
      {
        id: `trace-${turnId}`,
        messageId: turnId,
        startedAt: 1,
        root: {},
        summary: {},
        spans: [],
      },
    );
  };
  said('turn-1', 'Find me a staff role in Lisbon.', 'Watching for staff roles in Lisbon.');
  said('turn-2', 'Only remote-friendly ones.', 'Noted: remote-friendly only.');
  served.records.update(id, (thread) =>
    recordPlan(thread, {
      outcomes: [{ text: 'Lisbon roles tracked', status: 'doing' }],
      strategy: [{ text: 'Watch the boards daily' }],
    }),
  );
  // The thread ran on Claude Code: it holds a native session there.
  await w.claude.complete([{ role: 'user', content: 'Only remote-friendly ones.' }], {
    threadId: id,
  });
  await Bun.sleep(20);
  expect(await w.claudeAdapter.getExternalSessionId(id)).toBe('claude-session-1');

  const switched = await call('PATCH', `/api/threads/${id}`, { worker: 'codex' });
  expect(switched.status).toBe(200);
  expect((switched.body.meta as ThreadMeta).worker).toBe('codex');
  // The binding: the Claude session ended and is forgotten, so nothing resumes it; it stays on record.
  expect(await w.claudeAdapter.getExternalSessionId(id)).toBeNull();
  const [marker] = store.phasesOf(id, WORKER_SWITCH_PHASE);
  expect(marker!.record).toEqual({
    from: 'claude-code',
    to: 'codex',
    fromLabel: 'Claude Code',
    toLabel: 'Codex',
    fromSession: 'claude-session-1',
  });
  expect(store.threadMeta(id)?.worker).toBe('codex');
  // The transcript's marker.
  const launch = (await call('GET', `/api/threads/${id}/launch`)).body;
  expect(launch.switches).toEqual([
    expect.objectContaining({ from: 'claude-code', to: 'codex', toLabel: 'Codex' }),
  ]);

  // The next turn starts a fresh Codex thread, seeded once.
  await w.codex.complete([{ role: 'user', content: 'Anything new?' }], { threadId: id });
  said('turn-3', 'Anything new?', 'codex answered');
  expect(w.server.requests.map((r) => r.method).filter((m) => m.startsWith('thread/'))).toEqual([
    'thread/start',
  ]);
  const seed = w.server.turns[0]!;
  expect(seed).toContain('# The conversation so far');
  expect(seed).toContain('This thread moved from Claude Code to Codex mid-conversation');
  expect(seed).toContain('did not carry over');
  expect(seed).not.toContain('left out to fit');
  expect(seed.indexOf('Find me a staff role in Lisbon.')).toBeLessThan(
    seed.indexOf('Only remote-friendly ones.'),
  );
  expect(seed).toContain('## User\nOnly remote-friendly ones.');
  expect(seed).toContain('## Continued on Codex from here (it ran on Claude Code before)');
  expect(seed.indexOf('Noted: remote-friendly only.')).toBeLessThan(
    seed.indexOf('## Continued on Codex'),
  );
  expect(seed).toContain("# The thread's plan");
  expect(seed).toContain('[doing] Lisbon roles tracked');
  expect(seed).toContain('Anything new?');
  await Bun.sleep(20);
  expect(await w.codexAdapter.getExternalSessionId(id)).toBe('codex-thread-1');
  // A later fresh seed on Codex (its rollout gone) keeps the marker but doesn't say it just moved.
  const later = journalHistory(store, id, undefined, workerHistoryBudget('codex'))!;
  expect(later).toContain('## Continued on Codex from here');
  expect(later).toContain('could not be resumed');
  expect(later).not.toContain('mid-conversation');

  // Back to Claude Code: another fresh, seeded session, never the stale claude-session-1.
  expect((await call('PATCH', `/api/threads/${id}`, { worker: 'claude-code' })).status).toBe(200);
  expect(await w.codexAdapter.getExternalSessionId(id)).toBeNull();
  expect(store.phasesOf(id, WORKER_SWITCH_PHASE).map((row) => row.record.fromSession)).toEqual([
    'claude-session-1',
    'codex-thread-1',
  ]);
  await w.claude.complete([{ role: 'user', content: 'and now?' }], { threadId: id });
  const back = w.cli.launches.at(-1)!;
  expect(w.cli.launches).toHaveLength(2);
  expect(back.argv).not.toContain('--resume');
  expect(back.turns[0]).toContain('This thread moved from Codex to Claude Code mid-conversation');
  expect(back.turns[0]).toContain('## Continued on Codex from here');
  expect(back.turns[0]).toContain('## Continued on Claude Code from here');
});

test("a seed's budget is a tenth of the worker's smallest context window", () => {
  for (const worker of ['claude-code', 'codex', 'muse']) {
    const budget = workerHistoryBudget(worker);
    expect(budget).toBeGreaterThanOrEqual(JOURNAL_HISTORY_CHARS);
    expect(budget % 1).toBe(0);
  }
  expect(workerHistoryBudget('no-such-worker')).toBe(JOURNAL_HISTORY_CHARS);
});

test('a worker switch waits while a turn runs: the route says so, and the old session is never torn down under a call', async () => {
  const { call, served } = await viewer();
  const created = await call('POST', '/api/threads', { projectId: 'claude' });
  const id = created.body.threadId as string;
  served.records.update(id, (thread) => {
    thread.meta.status = 'active';
  });
  const busy = await call('PATCH', `/api/threads/${id}`, { worker: 'codex' });
  expect(busy.status).toBe(409);
  expect(busy.body.error).toContain('a turn is running or queued');
  expect((await call('GET', `/api/threads/${id}/launch`)).body.workerLock).toContain(
    'a turn is running',
  );

  const dir = temporary('worker-switch-busy-');
  const server = appServerTransport({ threadId: 'codex-busy', hang: true });
  const adapter = new CodexSessionAdapter({
    store: new FileExternalSessionStore(join(dir, 'sessions.json')),
    defaults: { spawn: server.spawn },
  });
  cleanup.push(() => adapter.releaseAll());
  const provider = new SessionBackedProvider({
    id: 'codex',
    adapter,
    defaultModel: 'controlled-model',
    defaultCwd: dir,
  });
  void provider
    .complete([{ role: 'user', content: 'long job' }], { threadId: 'busy' })
    .catch(() => {});
  await until(() => server.turns.length > 0, 'the long job is running');
  expect(await provider.retireThread('busy')).toBe(false);
  expect(server.launches[0]!.exited).toBe(false);
});
