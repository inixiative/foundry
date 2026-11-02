import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MuseUserInputRequest } from '@inixiative/agent-session';
import { ActionQueue, EventStream, type NativeEvidence } from '@inixiative/foundry-core';
import { captureThread } from '../src/archives/capture';
import {
  SUBSCRIPTION_WORKERS,
  WORKER_SESSION_RUNTIMES,
  workerArchiveRuntime,
  workerHostsFoundryTools,
} from '../src/models/registry';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { defaultProfileSource, profileEnvironment } from '../src/providers/default-profiles';
import {
  NativeAuthentication,
  type NativeAuthenticationProvider,
  withoutCompetingCredentials,
} from '../src/providers/native-authentication';
import { boundLaunchEnvironment } from '../src/providers/native-text-environment';
import { museSubscriptionStatus } from '../src/providers/native-text-provider';
import {
  InMemoryExternalSessionStore,
  MuseSessionAdapter,
  type MuseSessionAdapterConfig,
} from '../src/providers/session-adapter';
import { SessionBackedProvider } from '../src/providers/session-backed';
import { SubscriptionAuthentication } from '../src/providers/subscription-authentication';
import {
  resolveSubscriptionPolicy,
  threadWorkerRequirement,
} from '../src/providers/subscription-policy';
import { inspectNativeClis } from '../src/readiness';
import { nativeQuestions } from '../src/turns/native-questions';
import { NativeTurnRecorder } from '../src/turns/native-turns';
import { defaultConfig, type FoundryConfig } from '../src/viewer/config';
import { resolveThreadView } from '../src/viewer/config-resolve';
import { fakeMuse, SESSION_ID, TURN_ID } from './helpers/fake-muse';

/**
 * FEAT-006: the Muse Code worker. Muse runs through agent-session's MuseSession on the user's own
 * Muse login; these tests run it against a scripted MSP host (the live turn is a cassette in
 * vcr-scenarios.test.ts).
 */

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A HOME holding the user's own Muse login (`~/.config/muse/auth.json`), as `muse login` leaves it. */
function museHome() {
  const root = mkdtempSync(join(tmpdir(), 'muse-worker-'));
  mkdirSync(join(root, '.config', 'muse'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, '.config', 'muse', 'auth.json'), '{}', { mode: 0o600 });
  writeFileSync(join(root, '.config', 'muse', 'settings.json'), '{}', { mode: 0o644 });
  mkdirSync(join(root, '.claude'), { mode: 0o755 });
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = root;
  delete process.env.XDG_CONFIG_HOME;
  cleanup.push(() => {
    process.env.HOME = saved.HOME;
    if (saved.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** `muse usage --json` on a signed-in Everyday Usage login (no account details: Foundry reads only the tier). */
const usage =
  (tier: string | null, code = 0) =>
  () => {
    const body = JSON.stringify({ schemaVersion: 1, allowance: tier ? { tier } : null });
    return {
      stdout: new Response(body).body!,
      stderr: new Response('').body!,
      exited: Promise.resolve(code),
      kill() {},
    } as unknown as ReturnType<
      NonNullable<ConstructorParameters<typeof SubscriptionAuthentication>[2]>
    >;
  };

/** The host answers each turn with one message, as agent-session's text host does. */
function answering(fake: ReturnType<typeof fakeMuse>, text = 'ok') {
  fake.handlers['turn/start'] = (p) => {
    queueMicrotask(() => {
      fake.notify('turn/started', { turnId: TURN_ID });
      fake.notify('item/completed', {
        item: {
          itemId: 'm1',
          kind: 'agentMessage',
          turnId: TURN_ID,
          revision: 1,
          status: 'completed',
          text,
        },
      });
      fake.notify('turn/completed', { turnId: TURN_ID, terminal: 'completed' });
    });
    return {
      commandId: p.commandId,
      disposition: 'started',
      startedNewTurn: true,
      status: 'accepted',
      turnId: TURN_ID,
    };
  };
}

/** A Muse adapter on the user's own login, against a scripted host. */
function museAdapter(
  options: {
    store?: InMemoryExternalSessionStore;
    queue?: ActionQueue;
    tier?: string | null;
    root?: string;
  } = {},
) {
  const root = options.root ?? museHome();
  const fake = fakeMuse();
  const store = options.store ?? new InMemoryExternalSessionStore();
  const authentication = new SubscriptionAuthentication(
    join(root, 'runtime-profiles'),
    defaultProfileSource('muse'),
    usage(options.tier === undefined ? 'Muse Code Everyday Usage' : options.tier),
  );
  const adapter = new MuseSessionAdapter({
    store,
    authentication,
    defaults: { model: 'muse-wonder-1.0' },
    environment: boundLaunchEnvironment,
    questions: (threadId) => nativeQuestions(options.queue, threadId),
    connect: fake.connect,
  });
  cleanup.push(() => adapter.releaseAll());
  return { root, fake, store, adapter };
}

test('the muse worker: registry, its session bucket, and its default model', () => {
  expect(SUBSCRIPTION_WORKERS.muse).toBe('muse');
  expect(WORKER_SESSION_RUNTIMES.muse).toBe('muse-serve');
  expect(new MuseSessionAdapter({ store: new InMemoryExternalSessionStore() }).runtime).toBe(
    WORKER_SESSION_RUNTIMES.muse,
  );
  // agent-session's MuseSession offers no session MCP: no Foundry bridge, no tools note.
  expect(workerHostsFoundryTools('muse')).toBe(false);
  expect(workerHostsFoundryTools('codex')).toBe(true);
  expect(workerArchiveRuntime('muse')).toEqual({
    provider: 'meta',
    accessPath: 'subscription',
    evidence: 'harness',
  });
  expect(workerArchiveRuntime('claude-code')).toBeUndefined();
});

test('a Muse launch loses Meta metered keys and Muse billing switches, and never self-updates', () => {
  const env = withoutCompetingCredentials(
    {
      PATH: '/bin',
      META_API_KEY: 'k',
      LLM_API_KEY: 'k',
      MODEL_API_KEY: 'k',
      LLAMA_API_KEY: 'k',
      OPENROUTER_API_KEY: 'k',
      TBH_AUTH_BASE_URL: 'https://elsewhere.example',
      TBH_MINT_BASE_URL: 'https://elsewhere.example',
      MUSE_MODEL: 'other',
      MUSE_EXPERIMENTAL_ACP: '1',
      MUSE_CONTRIBUTOR_MODE: 'on',
      MUSE_DISABLE_APPROVAL_JUDGE: '1',
      MUSE_PERMISSION_PROFILE_FAIL_OPEN: '1',
      ANTHROPIC_API_KEY: 'k',
      XDG_CONFIG_HOME: '/home/user/.config',
    },
    'muse',
  );
  expect(env).toEqual({
    PATH: '/bin',
    XDG_CONFIG_HOME: '/home/user/.config',
    MUSE_NO_AUTO_UPDATE: '1',
  });
  // Claude and Codex launches keep Meta's variables: they bill nothing there.
  expect(withoutCompetingCredentials({ META_API_KEY: 'k' })).toEqual({ META_API_KEY: 'k' });
});

test("a Muse login is the user's own: the default profile, never a gateway or another directory", () => {
  const root = museHome();
  expect(defaultProfileSource('muse').profileDirectory).toBe(join(root, '.config', 'muse'));
  expect(profileEnvironment('muse', join(root, '.config', 'muse'))).toEqual({});
  expect(() => profileEnvironment('muse', join(root, 'elsewhere'))).toThrow(
    'other Muse profiles are not supported yet',
  );
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  expect(defaultProfileSource('muse').profileDirectory).toBe(join(root, 'xdg', 'muse'));
  delete process.env.XDG_CONFIG_HOME;
  expect(
    () =>
      new NativeAuthentication({
        directory: root,
        sources: [
          {
            id: crypto.randomUUID(),
            integrationId: crypto.randomUUID(),
            runtime: 'muse',
            mode: 'gateway',
            baseUrl: 'https://gateway.example',
            credential: { type: 'environment', variable: 'TOKEN' },
          },
        ],
      }),
  ).toThrow('Muse has no gateway mode');
});

test('the Muse login check reads only the allowance tier of `muse usage --json`', async () => {
  const run = (tier: string | null, code = 0) => museSubscriptionStatus(usage(tier, code)());
  expect(await run('Muse Code Everyday Usage')).toBe(true);
  expect(await run(null)).toBe(false);
  expect(await run('Muse Code Everyday Usage', 1)).toBe(false);
});

/** A config with Meta's subscription mode on, so the muse worker is offered. */
function museConfig(): FoundryConfig {
  const c = defaultConfig();
  c.vendors = { ...c.vendors, meta: { enabled: true, subscription: { enabled: true } } };
  return c;
}

test('policy: muse runs main threads on its login or a Kingdom pool; never decisions', () => {
  const root = museHome();
  const c = museConfig();
  c.projects = {
    local: { id: 'local', path: root, tags: [] },
    pooled: {
      id: 'pooled',
      path: root,
      tags: [],
      capacity: 'kingdom',
      defaults: { provider: 'codex', model: 'gpt-6-astra' },
    },
  };
  const resolved = resolveSubscriptionPolicy(c, { startup: true, cwd: root })!;
  expect(resolved.offered).toContain('muse');
  expect(resolved.workers.muse).toMatchObject({
    runtime: 'muse',
    profileDirectory: join(root, '.config', 'muse'),
  });
  const local = resolveThreadView(resolved.config, { projectId: 'local' }).config;
  expect(threadWorkerRequirement(resolved, local, 'muse', 'local')).toBeUndefined();
  const pooled = resolveThreadView(resolved.config, { projectId: 'pooled' }).config;
  // A pooled Muse thread runs on the pool (Kingdom refuses it there if the pool holds no Muse login).
  expect(threadWorkerRequirement(resolved, pooled, 'muse', 'pooled')).toBeUndefined();
  // A Kingdom project may default to Muse, and needs no Muse login on this machine.
  c.projects.pooled!.defaults = { provider: 'muse', model: 'muse-wonder-1.0' };
  rmSync(join(root, '.config', 'muse', 'auth.json'));
  expect(resolveSubscriptionPolicy(c, { cwd: root })!.offered).toContain('muse');
  // Decisions never run on Muse.
  const decisions = museConfig();
  const login = { ...defaultProfileSource('muse'), id: crypto.randomUUID() };
  decisions.nativeAuthentication = [login];
  decisions.subscriptionOnly = { decisionSourceId: login.id };
  expect(() => resolveSubscriptionPolicy(decisions, { cwd: root })).toThrow(
    'Muse Code runs main threads only',
  );
});

test('launch: full access is unrestricted and unsandboxed; the child gets only the bound environment', async () => {
  const { fake, adapter } = museAdapter();
  const prior = { ...process.env };
  Object.assign(process.env, {
    META_API_KEY: 'meta-key',
    OPENROUTER_API_KEY: 'r',
    MUSE_MODEL: 'x',
  });
  cleanup.push(() => {
    for (const key of ['META_API_KEY', 'OPENROUTER_API_KEY', 'MUSE_MODEL'])
      if (prior[key] === undefined) delete process.env[key];
  });
  const session = await adapter.createSession({
    threadId: 'main',
    cwd: '/workspace',
    toolGate: () => ({ behavior: 'allow' }),
  });
  await session.start();
  answering(fake);
  await session.send('hi');
  const launch = fake.launches[0]!;
  expect(launch.args).toEqual(['serve', '--trust-workspace', '--disable-sandbox']);
  expect(launch.env.MUSE_NO_AUTO_UPDATE).toBe('1');
  for (const key of ['META_API_KEY', 'OPENROUTER_API_KEY', 'MUSE_MODEL'])
    expect(launch.env[key]).toBeUndefined();
  // Only the allowlist reaches it (no API keys, no stray daemon variables).
  expect(Object.keys(launch.env).every((key) => key in boundLaunchEnvironment(launch.env))).toBe(
    true,
  );
  expect(await fake.waitFor('session/start')).toMatchObject({
    approvalMode: 'allowAll',
    permissionProfile: ':unrestricted',
    modelId: 'muse-wonder-1.0',
  });
});

/** A launch whose login provider counts the failures it is asked to confirm. */
function failureCountingAdapter(connect?: MuseSessionAdapterConfig['connect'], rejected = false) {
  museHome();
  const fake = fakeMuse();
  const failed: string[] = [];
  const released: string[] = [];
  const authentication: NativeAuthenticationProvider = {
    bindingId: (threadId) => threadId,
    prepare: async (threadId) => ({
      bindingId: threadId,
      sourceId: 'pool-login',
      integrationId: 'pool-login',
      mode: 'kingdom-subscription',
      check() {},
      launch: (argv, env) => ({ argv, env }),
      release() {
        released.push(threadId);
      },
      loginFailed: async () => {
        failed.push(threadId);
        return rejected;
      },
    }),
  };
  const adapter = new MuseSessionAdapter({
    store: new InMemoryExternalSessionStore(),
    authentication,
    connect: connect ?? fake.connect,
  });
  cleanup.push(() => adapter.releaseAll());
  return { fake, adapter, failed, released };
}

/** The host ends each turn with `terminal` (and, failed, Muse's auth error). */
function ending(fake: ReturnType<typeof fakeMuse>, terminal: 'failed' | 'cancelled') {
  fake.handlers['turn/start'] = (p) => {
    queueMicrotask(() => {
      fake.notify('turn/started', { turnId: TURN_ID });
      fake.notify('turn/completed', {
        turnId: TURN_ID,
        terminal,
        ...(terminal === 'failed'
          ? { error: { kind: 'authRequired', message: 'sign in', retryable: false } }
          : {}),
      });
    });
    return {
      commandId: p.commandId,
      disposition: 'started',
      startedNewTurn: true,
      status: 'accepted',
      turnId: TURN_ID,
    };
  };
}

test('a failed turn asks the login provider to confirm a rejected login', async () => {
  const { fake, adapter, failed } = failureCountingAdapter();
  const session = await adapter.createSession({ threadId: 'main', cwd: '/workspace' });
  await session.start();
  ending(fake, 'failed');
  await session.send('hi').catch(() => undefined);
  expect(failed).toEqual(['main']);
});

test('a confirmed rejected login ends the session, so the next turn launches on another login', async () => {
  const { fake, adapter, failed, released } = failureCountingAdapter(undefined, true);
  const session = await adapter.createSession({ threadId: 'main', cwd: '/workspace' });
  await session.start();
  ending(fake, 'failed');
  await session.send('hi').catch(() => undefined);
  const deadline = Date.now() + 5000;
  while (!released.length && Date.now() < deadline) await Bun.sleep(10);
  expect(failed).toEqual(['main']);
  expect(released).toEqual(['main']);
});

test('a cancelled turn is not a login failure', async () => {
  const { fake, adapter, failed } = failureCountingAdapter();
  const session = await adapter.createSession({ threadId: 'main', cwd: '/workspace' });
  await session.start();
  ending(fake, 'cancelled');
  await session.send('hi').catch(() => undefined);
  expect(failed).toEqual([]);
});

test('a host that will not start asks the login provider to confirm too', async () => {
  const { adapter, failed } = failureCountingAdapter(async () => {
    throw Error('muse serve did not initialize');
  });
  const session = await adapter.createSession({ threadId: 'main', cwd: '/workspace' });
  await expect(session.start()).rejects.toThrow('did not initialize');
  expect(failed).toEqual(['main']);
});

test('launch: a gated host mode asks a person, never Muse’s AI reviewer', async () => {
  const { fake, adapter } = museAdapter();
  const session = await adapter.createSession({
    threadId: 'main',
    cwd: '/workspace',
    permissionMode: 'default',
    toolGate: () => ({ behavior: 'deny', message: 'no' }),
  });
  await session.start();
  answering(fake);
  await session.send('hi');
  expect(fake.launches[0]!.args).toEqual(['serve', '--trust-workspace']);
  expect(await fake.waitFor('session/start')).toMatchObject({
    approvalMode: 'promptUnmatched',
    permissionProfile: ':ask-me',
  });
});

test('refused at launch: structural rules (no pre-use stage) and text-only sessions', async () => {
  const { adapter } = museAdapter();
  await expect(
    adapter.createSession({ threadId: 'main', cwd: '/w', structuralRules: true }),
  ).rejects.toThrow('Muse Code cannot apply them before a tool runs');
  await expect(
    adapter.createSession({ threadId: 'main:aux:x', cwd: '/w', tools: false }),
  ).rejects.toThrow('Muse Code runs main threads only');
});

test('no login (no allowance tier): the thread is refused, with no fallback', async () => {
  const { adapter } = museAdapter({ tier: null });
  await expect(adapter.createSession({ threadId: 'main', cwd: '/w' })).rejects.toThrow(
    'no API fallback',
  );
});

test('the binding: a fresh session saves its Muse session id; the next launch resumes it', async () => {
  const store = new InMemoryExternalSessionStore();
  const first = museAdapter({ store });
  const session = await first.adapter.createSession({ threadId: 'main', cwd: '/workspace' });
  await session.start();
  answering(first.fake);
  expect((await session.send('hi')).content).toBe('ok');
  const binding = first.adapter.describeConstruction(session)!.bindingId;
  expect(await store.load(binding, 'muse-serve')).toBe(SESSION_ID);
  expect(await first.adapter.getExternalSessionId('main')).toBe(SESSION_ID);
  await first.adapter.releaseAll();

  const second = museAdapter({ store, root: first.root });
  const resumed = await second.adapter.createSession({ threadId: 'main', cwd: '/workspace' });
  expect(second.adapter.describeConstruction(resumed)!.resumedBinding).toBe(SESSION_ID);
});

test("questions go to the thread's person on Foundry's prompt queue; a rejection cancels them", async () => {
  const queue = new ActionQueue();
  const ask = nativeQuestions(queue, 'main', 5_000)!;
  const controller = new AbortController();
  const request = (questions: MuseUserInputRequest['questions']): MuseUserInputRequest => ({
    userInputId: 'u1',
    turnId: TURN_ID,
    toolName: 'ask_user',
    questions,
    signal: controller.signal,
  });
  const single = {
    id: 'q1',
    header: 'Proceed',
    question: 'Proceed with the migration?',
    options: [{ label: 'Yes' }, { label: 'No', description: 'stop here' }],
    selection: { mode: 'single' },
  };
  const answered = ask(request([single]));
  await Bun.sleep(0);
  const [prompt] = queue.pending();
  expect(prompt).toMatchObject({
    kind: 'choice',
    threadId: 'main',
    meta: { question: true, questionId: 'q1', userInputId: 'u1' },
  });
  expect(prompt!.options!.map((option) => option.label)).toEqual(['Yes', 'No']);
  queue.resolve(prompt!.id, 'option-1', { note: 'not today' });
  expect(await answered).toEqual([{ questionId: 'q1', selectedLabel: 'No', note: 'not today' }]);

  const multiple = {
    id: 'q2',
    header: 'Targets',
    question: 'Which environments?',
    options: [{ label: 'staging' }, { label: 'prod' }],
    selection: { mode: 'multiple', minSelections: 1, maxSelections: 2 },
  };
  const picked = ask(request([multiple]));
  await Bun.sleep(0);
  queue.resolve(queue.pending()[0]!.id, 'approve', { input: 'Staging, prod' });
  expect(await picked).toEqual([{ questionId: 'q2', selectedLabels: ['staging', 'prod'] }]);

  const declined = ask(request([single]));
  await Bun.sleep(0);
  queue.resolve(queue.pending()[0]!.id, 'reject');
  expect(await declined).toBeUndefined();
  // No queue: nobody can answer, so agent-session cancels the question with a reason.
  expect(nativeQuestions(undefined, 'main')).toBeUndefined();
});

test('a question Muse asks mid-turn is answered through the adapter', async () => {
  const queue = new ActionQueue();
  queue.onPrompt((prompt) => queueMicrotask(() => queue.resolve(prompt.id, 'option-0')));
  const { fake, adapter } = museAdapter({ queue });
  const session = await adapter.createSession({ threadId: 'main', cwd: '/workspace' });
  await session.start();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  fake.handlers['turn/start'] = (p) => {
    void (async () => {
      fake.notify('turn/started', { turnId: TURN_ID });
      await held;
      fake.notify('turn/completed', { turnId: TURN_ID, terminal: 'completed' });
    })();
    return {
      commandId: p.commandId,
      disposition: 'started',
      startedNewTurn: true,
      status: 'accepted',
      turnId: TURN_ID,
    };
  };
  const send = session.send('ask me');
  await fake.waitFor('turn/start');
  fake.notify('userInput/requested', {
    userInputId: 'u1',
    turnId: TURN_ID,
    itemId: 'item-u1',
    toolCallId: 'call-u1',
    toolName: 'ask_user',
    questions: [
      {
        id: 'q1',
        header: 'Proceed',
        question: 'Proceed?',
        options: [{ label: 'Yes' }, { label: 'No' }],
        selection: { mode: 'single' },
      },
    ],
  });
  expect(await fake.waitFor('userInput/answer')).toMatchObject({
    userInputId: 'u1',
    answers: [{ questionId: 'q1', selectedLabel: 'Yes' }],
  });
  release();
  await send;
});

test("a turn Muse starts itself lands on its thread's journal and live stream", () => {
  const store = new LocalSessionStore(':memory:');
  cleanup.push(() => store.close());
  const thread = {
    id: 'main',
    meta: {
      description: 'muse thread',
      tags: [],
      status: 'idle' as const,
      worker: 'muse',
      createdAt: 1,
      lastActiveAt: 1,
    },
  };
  store.saveThread(thread);
  const events = new EventStream();
  const pushed: unknown[] = [];
  events.subscribe?.((event: unknown) => pushed.push(event));
  const arrived: string[] = [];
  const recorder = new NativeTurnRecorder({
    store,
    thread: (id) => (id === 'main' ? thread : undefined),
    events,
    arrived: (_thread, turnId, outcome) => arrived.push(`${turnId}:${outcome}`),
  });
  const evidence = (fields: Partial<NativeEvidence>): NativeEvidence => ({
    schema: 1,
    nativeOutcome: 'unknown',
    turnId: 'cron-turn-1',
    correlation: 'native-turn',
    ...fields,
  });
  const task = { taskId: 'cron-turn-1' };
  recorder.observe('main', evidence({ kind: 'task' }), {
    ...task,
    phase: 'started',
    taskType: 'muse-turn',
  });
  recorder.observe('main', evidence({ kind: 'task' }), {
    ...task,
    phase: 'updated',
    taskType: 'muse-cron',
    description: 'cron job job-7',
  });
  recorder.observe('main', evidence({ kind: 'text', text: 'The build is green.' }));
  recorder.observe('main', evidence({ kind: 'task' }), {
    ...task,
    phase: 'ended',
    taskType: 'muse-cron',
    status: 'completed',
    summary: 'The build is green.',
  });
  const records = store.archiveRecords('main');
  expect(records.turns).toHaveLength(1);
  expect(records.turns[0]!.status).toBe('completed');
  expect(records.messages.map((m) => [m.actor, m.content])).toEqual([
    ['user', 'The agent started this turn itself, woken by cron job job-7.'],
    ['agent', 'The build is green.'],
  ]);
  expect(records.native.some((n) => n.text === 'The build is green.')).toBe(true);
  expect(arrived).toEqual([`${records.turns[0]!.id}:completed`]);

  // A turn Muse dropped before it ran leaves nothing.
  recorder.observe('main', evidence({ kind: 'task', turnId: 'cron-turn-2' }), {
    taskId: 'cron-turn-2',
    phase: 'ended',
    taskType: 'muse-turn',
    status: 'unqueued',
  });
  expect(store.archiveRecords('main').turns).toHaveLength(1);
});

test('Archive: a Muse thread is captured as meta on a subscription, so it stays personal', () => {
  const store = new LocalSessionStore(':memory:');
  cleanup.push(() => store.close());
  const meta = {
    description: 'muse thread',
    tags: [],
    status: 'idle' as const,
    createdAt: 1,
    lastActiveAt: 1,
  };
  store.saveThread({ id: 'muse-thread', meta: { ...meta, worker: 'muse' } });
  store.saveThread({ id: 'claude-thread', meta: { ...meta, worker: 'claude-code' } });
  expect(captureThread(store, crypto.randomUUID(), 'muse-thread').runtime).toEqual({
    provider: 'meta',
    accessPath: 'subscription',
    evidence: 'harness',
  });
  expect(captureThread(store, crypto.randomUUID(), 'claude-thread').runtime).toBeUndefined();
});

test('readiness: an enabled Muse needs the CLI on the pinned version, signed in', async () => {
  const c = museConfig();
  const { nativeClis, issues } = await inspectNativeClis(c, {
    which: (binary) => `/usr/local/bin/${binary}`,
    loginStatus: async (cli) => (cli === 'muse' ? false : undefined),
  });
  expect(nativeClis.find((native) => native.cli === 'muse')).toMatchObject({
    provider: 'muse',
    binary: '/usr/local/bin/muse',
  });
  expect(issues.map((item) => item.code)).toEqual(
    expect.arrayContaining(['native-cli-version', 'native-login-missing']),
  );
});

test('through the provider: a turn Muse starts between sends is journalled, and one left open closes when the session ends', async () => {
  const { fake, adapter } = museAdapter();
  answering(fake);
  const store = new LocalSessionStore(':memory:');
  cleanup.push(() => store.close());
  const thread = {
    id: 'main',
    meta: {
      description: 'muse thread',
      tags: [],
      status: 'idle' as const,
      worker: 'muse',
      createdAt: 1,
      lastActiveAt: 1,
    },
  };
  store.saveThread(thread);
  const recorder = new NativeTurnRecorder({
    store,
    thread: (id) => (id === 'main' ? thread : undefined),
  });
  const provider = new SessionBackedProvider({
    id: 'muse',
    adapter,
    defaultModel: 'muse-wonder-1.0',
    defaultCwd: '/workspace',
  });
  provider.observeNativeTurns((threadId, evidence, task) =>
    recorder.observe(threadId, evidence, task),
  );
  const tasks: string[] = [];
  provider.observeTasks((_threadId, task) => tasks.push(`${task.taskType}:${task.phase}`));
  expect(
    (
      await provider.complete([{ role: 'user', content: 'hi' }], {
        threadId: 'main',
        cwd: '/workspace',
      })
    ).content,
  ).toBe('ok');

  // A cron firing between sends: a whole turn of its own.
  const cron = (turnId: string, end: boolean) => {
    fake.notify('turn/started', { turnId, commandId: turnId });
    fake.notify('item/completed', {
      item: {
        itemId: `${turnId}-fire`,
        kind: 'scheduledFire',
        turnId,
        revision: 1,
        status: 'completed',
        jobId: 'job-7',
      },
    });
    fake.notify('item/completed', {
      item: {
        itemId: `${turnId}-msg`,
        kind: 'agentMessage',
        turnId,
        revision: 1,
        status: 'completed',
        text: 'The build is green.',
      },
    });
    if (end) fake.notify('turn/completed', { turnId, terminal: 'completed' });
  };
  cron('cron-turn-1', true);
  // A second one the host never finishes before the session ends.
  cron('cron-turn-2', false);
  await Bun.sleep(20);
  let turns = store.archiveRecords('main').turns.filter((turn) => turn.id.startsWith('turn_'));
  expect(turns.map((turn) => turn.status).sort()).toEqual(['active', 'completed']);
  expect(tasks).toContain('muse-cron:ended');
  await adapter.releaseAll();
  await Bun.sleep(5);
  turns = store.archiveRecords('main').turns.filter((turn) => turn.id.startsWith('turn_'));
  expect(turns.map((turn) => turn.status).sort()).toEqual(['completed', 'failed']);
});
