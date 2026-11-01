import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CompletionOpts,
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  type LLMProvider,
  type ThreadMeta,
} from '@inixiative/foundry-core';
import { ProjectRegistry } from '../src/agents/project';
import { ThreadFactory, WorkerRefusedError } from '../src/agents/thread-factory';
import { LocalSessionStore } from '../src/persistence/local-session-store';
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
} from '../src/viewer/config';
import { resolveThreadView } from '../src/viewer/config-resolve';
import { createViewer } from '../src/viewer/server';
import { ViewerThreadDirectory } from '../src/viewer/thread-directory';

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
      workerRequirement: (view, worker) => threadWorkerRequirement(resolved, view, worker),
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
async function viewer() {
  const f = fixture();
  const dir = temporary('thread-worker-viewer-');
  const store = new ConfigStore(dir);
  await store.save(f.saved);
  const factory = f.factory();
  const registry = new ProjectRegistry();
  registry.loadFromConfigs(f.resolution.config.projects);
  const main = factory.create('main', { projectId: 'claude' });
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
  return { f, served, call, factory };
}

test('POST /api/threads takes a worker; a refused one is a 400 with the reason', async () => {
  const { call } = await viewer();
  const created = await call('POST', '/api/threads', { projectId: 'claude', worker: 'codex' });
  expect(created.status).toBe(201);
  expect((created.body.meta as ThreadMeta).worker).toBe('codex');
  const launch = await call('GET', `/api/threads/${created.body.threadId}/launch`);
  expect(launch.body).toMatchObject({ worker: 'codex', provider: 'codex', model: 'gpt-6-astra' });
  expect((launch.body.options as { workers: unknown }).workers).toEqual([
    { id: 'claude-code', label: expect.any(String), default: true },
    { id: 'codex', label: expect.any(String), default: false },
  ]);
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

test('a Codex local member joins a Claude host', async () => {
  const { call } = await viewer();
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
});

/** The config the fixture saves validates as settings would. */
test('the fixture is a valid saved configuration', () => {
  const config: FoundryConfig = fixture().saved;
  expect(config.projects.codex?.defaults?.provider).toBe('codex');
});
