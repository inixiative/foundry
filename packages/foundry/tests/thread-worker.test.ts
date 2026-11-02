import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
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
  resolveSubscriptionPolicy,
  type SubscriptionResolution,
  threadWorkerRequirement,
} from '../src/providers/subscription-policy';
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
import { until } from './helpers/live-watch-fixture';

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

test("PATCH /api/threads/:id changes the worker only before the thread's first turn; 409 after", async () => {
  const { call, served } = await viewer();
  const created = await call('POST', '/api/threads', { projectId: 'claude' });
  const id = created.body.threadId as string;
  expect((created.body.meta as ThreadMeta).worker).toBe('claude-code');
  const moved = await call('PATCH', `/api/threads/${id}`, { worker: 'codex' });
  expect(moved.status).toBe(200);
  expect((moved.body.meta as ThreadMeta).worker).toBe('codex');
  expect((await call('GET', `/api/threads/${id}/launch`)).body).toMatchObject({
    worker: 'codex',
    provider: 'codex',
  });
  served.localStore!.beginTurn({ id, meta: moved.body.meta as ThreadMeta }, 'turn-1', 'hello');
  const late = await call('PATCH', `/api/threads/${id}`, { worker: 'claude-code' });
  expect(late.status).toBe(409);
  expect(late.body.error).toContain('its worker is fixed');
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
