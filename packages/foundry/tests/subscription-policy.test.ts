import { afterAll, afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAIN_THREAD_LABS,
  MODEL_REGISTRY,
  mainThreadLab,
  registryForViewer,
} from '../src/models/registry';
import { NativeAuthentication } from '../src/providers/native-authentication';
import { SubscriptionAuthentication } from '../src/providers/subscription-authentication';
import { resolveSubscriptionPolicy } from '../src/providers/subscription-policy';
import {
  defaultConfig,
  defaultProjectAgents,
  starterConfig,
  validateConfig,
} from '../src/viewer/config';
import { resolveProjectView } from '../src/viewer/config-resolve';
import { subscriptionStatusProcess } from './helpers/subscription-transport';
import { recordedClaudeTransport, recordedCodexStatus, settleRecordings } from './helpers/vcr';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(settleRecordings);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'subscription-policy-'));
  roots.push(root);
  const profile = (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { mode: 0o700 });
    return dir;
  };
  const c = defaultConfig();
  const worker = {
    id: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    runtime: 'claude' as 'claude' | 'codex',
    mode: 'native-profile' as const,
    profileDirectory: profile('worker'),
  };
  const decision = {
    ...worker,
    id: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    profileDirectory: profile('decision'),
  };
  c.nativeAuthentication = [worker, decision];
  c.defaults = {
    provider: 'claude-code',
    model: 'worker-model',
    nativeAuthenticationId: worker.id,
    classifierProvider: 'subscription-decisions',
    classifierModel: 'decision-model',
  };
  c.subscriptionOnly = {
    decisionSourceId: decision.id,
    model: 'decision-model',
    expectedObservedModel: 'decision-canonical',
    directory: profile('calls'),
    maxCalls: 50,
    maxQueued: 8,
    callTimeoutMs: 2000,
  };
  c.agents = defaultProjectAgents(
    'claude-code',
    'worker-model',
    'subscription-decisions',
    'decision-model',
  );
  c.projects = { project: { id: 'project', path: root, tags: [] } };
  return { c, root, worker, decision };
}

test('subscription policy resolves explicit models and sources without API access', () => {
  const f = fixture();
  expect(() => validateConfig(f.c)).not.toThrow();
  expect(resolveSubscriptionPolicy(f.c)).toMatchObject({
    worker: { id: f.worker.id },
    decision: { id: f.decision.id },
    policy: { model: 'decision-model' },
  });
});

for (const change of [
  'worker-api',
  'review-api',
  'review-model',
  'same-profile',
  'gateway',
  'codex-worker',
  'expert-tools',
  'claude-decision-model',
  'codex-observed-model',
  'claude-concurrency',
] as const)
  test(`subscription startup refuses ${change} before provider construction`, () => {
    const f = fixture();
    switch (change) {
      case 'worker-api':
        f.c.defaults.provider = 'openai';
        break;
      case 'review-api':
        f.c.learning = { review: { provider: 'openai' } };
        break;
      case 'review-model':
        f.c.learning = { review: { model: 'gpt-5.6-luna' } };
        break;
      case 'same-profile':
        f.decision.profileDirectory = f.worker.profileDirectory;
        break;
      case 'gateway':
        f.c.nativeAuthentication![1] = {
          id: f.decision.id,
          connectionId: f.decision.connectionId,
          runtime: 'claude',
          mode: 'gateway',
          baseUrl: 'https://example.com',
          credential: { type: 'environment', variable: 'SYNTHETIC_KEY' },
        };
        break;
      case 'codex-worker':
        f.c.nativeAuthentication![0].runtime = 'codex';
        break;
      case 'expert-tools':
        f.c.agents.router.tools = true;
        break;
      case 'claude-decision-model':
        delete f.c.subscriptionOnly!.model;
        break;
      case 'codex-observed-model':
        f.c.nativeAuthentication![1].runtime = 'codex';
        break;
      case 'claude-concurrency':
        f.c.subscriptionOnly!.maxConcurrent = 2;
        break;
    }
    expect(() => validateConfig(f.c)).toThrow();
  });

// Decision roles saved on another provider or model run on the subscription decision profile.
for (const change of ['classifier-api', 'project-api', 'agent-model', 'project-model'] as const)
  test(`subscription mode routes ${change} to subscription decisions`, () => {
    const f = fixture();
    switch (change) {
      case 'classifier-api':
        f.c.agents.classifier.provider = 'openai';
        break;
      case 'project-api':
        f.c.projects.project.agents = { router: { provider: 'openai' } };
        break;
      case 'agent-model':
        f.c.agents.router.model = 'gpt-5.6-luna';
        break;
      case 'project-model':
        f.c.projects.project.defaults = { classifierModel: 'gpt-5.6-luna' };
        break;
    }
    expect(() => validateConfig(f.c)).not.toThrow();
    const resolved = resolveSubscriptionPolicy(f.c)!;
    const view = resolveProjectView(resolved.config, 'project')!.config;
    for (const agent of [view.agents.classifier, view.agents.router])
      expect(agent).toMatchObject({ provider: 'subscription-decisions', model: 'decision-model' });
    expect(view.defaults).toMatchObject({
      classifierProvider: 'subscription-decisions',
      classifierModel: 'decision-model',
    });
  });

test('an explicit Codex decision profile runs Codex decisions beside the Claude worker', () => {
  const f = fixture();
  f.c.nativeAuthentication![1].runtime = 'codex';
  delete f.c.subscriptionOnly!.expectedObservedModel;
  expect(resolveSubscriptionPolicy(f.c)).toMatchObject({
    worker: { runtime: 'claude' },
    decision: { id: f.decision.id, runtime: 'codex' },
    policy: { model: 'decision-model' },
  });
});

test('different IDs or aliases cannot share the warm worker profile', () => {
  const f = fixture();
  const alias = join(f.root, 'alias');
  symlinkSync(f.root, alias);
  f.decision.profileDirectory = join(alias, 'worker');
  expect(() => resolveSubscriptionPolicy(f.c)).toThrow('separate private profile');
});

test('native worker requires subscription status and strips paid credentials while preserving tools', async () => {
  const f = fixture();
  const denied = new SubscriptionAuthentication(f.root, f.worker, () =>
    subscriptionStatusProcess(false),
  );
  await expect(denied.prepare('worker', 'claude')).rejects.toThrow('no API fallback');
  // The real `claude auth status --json` on the subscription login.
  const auth = new SubscriptionAuthentication(
    f.root,
    f.worker,
    recordedClaudeTransport({ status: ['subscribed'] }).statusSpawn,
  );
  const launch = await auth.prepare('worker', 'claude');
  const command = launch.launch(['claude', '--model', 'worker-model'], {
    PATH: process.env.PATH,
    OPENAI_API_KEY: 'synthetic-paid-key',
    ANTHROPIC_API_KEY: 'synthetic-paid-key',
    CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-other-account',
  });
  try {
    expect(command.env.OPENAI_API_KEY).toBeUndefined();
    expect(command.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(command.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(command.env.CLAUDE_CONFIG_DIR).toBe(realpathSync(f.worker.profileDirectory));
    expect(command.argv.slice(-2)).toEqual(['--setting-sources', '']);
    expect(command.argv).not.toContain('--tools');
    const second = await auth.prepare('another-worker', 'claude');
    expect(() => second.launch(['claude'], {})).toThrow('in use');
  } finally {
    launch.release();
  }
  const override = await auth.prepare('worker', 'claude');
  expect(() => override.launch(['claude', '--fallback-model=paid-model'], {})).toThrow('override');
}, 30_000);

test('full subscription startup reaches viewer with no API provider requests or native model launch', async () => {
  const f = fixture(),
    configDir = join(f.root, '.foundry');
  mkdirSync(configDir, { mode: 0o700 });
  f.c.layers = {
    system: {
      id: 'system',
      prompt: 'Test system',
      sourceIds: ['system'],
      enabled: true,
      staleness: 0,
    },
  };
  f.c.sources = {
    system: {
      id: 'system',
      label: 'System',
      type: 'inline',
      uri: 'Test instructions',
      enabled: true,
    },
  };
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(f.c), { mode: 0o600 });
  const probe = join(f.root, 'network-attempt'),
    preload = join(f.root, 'deny-network.ts');
  writeFileSync(
    preload,
    `import {writeFileSync} from 'node:fs'; globalThis.fetch = (() => {writeFileSync(${JSON.stringify(probe)}, 'attempted'); throw Error('External requests forbidden in startup test');}) as typeof fetch;`,
    { mode: 0o600 },
  );
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'].map((key) => [key, process.env[key]]),
  );
  const child = Bun.spawn(
    [process.execPath, '--preload', preload, new URL('../src/start.ts', import.meta.url).pathname],
    {
      cwd: f.root,
      env: {
        ...env,
        VIEWER_PORT: '0',
        FOUNDRY_STARTUP_SELF_TEST: '0',
        OPENAI_API_KEY: 'synthetic-never-send',
        ANTHROPIC_API_KEY: 'synthetic-never-send',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  let output = '';
  const read = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output += new TextDecoder().decode(chunk);
  };
  const stdout = read(child.stdout),
    stderr = read(child.stderr);
  try {
    for (let attempt = 0; !output.includes('Ready. Send messages'); attempt++) {
      if (attempt >= 100 || child.exitCode !== null)
        throw Error(`Subscription startup did not become ready: ${output}`);
      await Bun.sleep(25);
    }
    const port = output.match(/Foundry Viewer running at http:\/\/localhost:(\d+)/)?.[1];
    expect(port).toBeDefined();
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
    expect(output).toContain('subscription-decisions');
    expect(output).toContain('Provider self-test skipped');
    expect(existsSync(probe)).toBe(false);
    expect(existsSync(join(f.worker.profileDirectory, '.foundry-auth-lock'))).toBe(false);
    expect(existsSync(join(f.decision.profileDirectory, '.foundry-auth-lock'))).toBe(false);
  } finally {
    child.kill('SIGINT');
    await child.exited;
    await Promise.all([stdout, stderr]);
  }
}, 5000);

for (const throwsOnKill of [false, true])
  test(`unknown status exit closes admission (kill throws: ${throwsOnKill})`, async () => {
    const f = fixture();
    let launches = 0,
      kills = 0,
      settle!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      settle = resolve;
    });
    const auth = new SubscriptionAuthentication(
      f.root,
      f.worker,
      () => {
        launches++;
        return {
          ...subscriptionStatusProcess(),
          exited,
          kill() {
            kills++;
            if (throwsOnKill) throw Error('Controlled termination failure');
          },
        };
      },
      2_000,
    );
    try {
      const shared = await Promise.allSettled([
        auth.prepare('first', 'claude'),
        auth.prepare('concurrent', 'claude'),
      ]);
      for (const outcome of shared)
        expect(outcome.status === 'rejected' && String(outcome.reason)).toContain(
          'no API fallback',
        );
      await expect(auth.prepare('later', 'claude')).rejects.toThrow('no API fallback');
      expect(launches).toBe(1);
      expect(kills).toBe(1);
      expect(existsSync(join(f.worker.profileDirectory, '.foundry-auth-lock'))).toBe(false);
    } finally {
      settle(143);
    }
  }, 8000);

test('concurrent worker launches share one subscription status check and reuse the verified result', async () => {
  const f = fixture();
  const status = recordedClaudeTransport({ status: ['subscribed'] });
  const auth = new SubscriptionAuthentication(f.root, f.worker, status.statusSpawn);
  const [first, second] = await Promise.all([
    auth.prepare('thread-a', 'claude'),
    auth.prepare('thread-b', 'claude'),
  ]);
  const third = await auth.prepare('thread-c', 'claude');
  expect(status.statusChecks).toBe(1);
  for (const launch of [first, second, third]) launch.release();
}, 30_000);

/** The fixture with Codex as the main thread: GPT-6 Astra on the Codex worker profile. */
function codexMain() {
  const f = fixture();
  f.worker.runtime = 'codex';
  f.decision.runtime = 'codex';
  delete f.c.subscriptionOnly!.expectedObservedModel;
  f.c.defaults.provider = 'codex';
  f.c.defaults.model = 'gpt-6-astra';
  f.c.agents = defaultProjectAgents(
    'codex',
    'gpt-6-astra',
    'subscription-decisions',
    'decision-model',
  );
  return f;
}

test('Codex is a subscription main thread: GPT-6 Astra on the Codex login, no API tokens', () => {
  const f = codexMain();
  expect(f.c.apiTokens).toBeUndefined();
  expect(() => validateConfig(f.c)).not.toThrow();
  expect(resolveSubscriptionPolicy(f.c)).toMatchObject({
    workerProvider: 'codex',
    worker: { id: f.worker.id, runtime: 'codex' },
    decision: { id: f.decision.id, runtime: 'codex' },
    config: { defaults: { provider: 'codex', model: 'gpt-6-astra' } },
  });
  // A shared Codex login: the worker and decisions may use the same profile.
  f.decision.profileDirectory = f.worker.profileDirectory;
  expect(() => resolveSubscriptionPolicy(f.c)).not.toThrow();
  // The worker profile must match the worker harness.
  f.worker.runtime = 'claude';
  expect(() => resolveSubscriptionPolicy(f.c)).toThrow('runs on a codex profile');
});

test("a fresh Codex main thread defaults to the user's own ~/.codex login", () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-main-'));
  roots.push(root);
  mkdirSync(join(root, '.codex'), { mode: 0o755 });
  writeFileSync(join(root, '.codex', 'auth.json'), '{}', { mode: 0o600 });
  const home = process.env.HOME;
  process.env.HOME = root;
  try {
    const c = defaultConfig();
    c.defaults.provider = 'codex';
    c.defaults.model = 'gpt-6-astra';
    const resolved = resolveSubscriptionPolicy(c, { startup: true, cwd: root })!;
    expect(resolved.worker).toMatchObject({
      runtime: 'codex',
      profileDirectory: join(root, '.codex'),
    });
    expect(resolved.decision.profileDirectory).toBe(join(root, '.codex'));
  } finally {
    process.env.HOME = home;
  }
});

test('a Codex executor must be the Codex worker in subscription mode', () => {
  const f = codexMain();
  f.c.agents.artificer!.provider = 'claude-code';
  expect(() => validateConfig(f.c)).toThrow('provider, model or tool override refused');
});

test('main threads run on the five labs: Anthropic, OpenAI, Google, Meta and xAI', () => {
  expect([...MAIN_THREAD_LABS]).toEqual(['anthropic', 'openai', 'google', 'meta', 'xai']);
  const mainThreadProviders = Object.keys(MODEL_REGISTRY).filter((id) => mainThreadLab(id));
  expect(mainThreadProviders.sort()).toEqual(
    ['anthropic', 'claude-code', 'codex', 'gemini', 'meta', 'openai', 'xai'].sort(),
  );
  const main = (provider: string, apiTokens: boolean) => {
    const c = defaultConfig();
    c.defaults.provider = provider;
    c.defaults.model = MODEL_REGISTRY[provider]!.models[0]!.id;
    if (apiTokens) {
      c.apiTokens = true;
      delete c.defaults.classifierProvider;
      delete c.defaults.classifierModel;
    }
    return () => validateConfig(c);
  };
  // Subscription harnesses need no API tokens.
  for (const provider of ['claude-code', 'codex']) expect(main(provider, false)).not.toThrow();
  // API providers name what they need: API tokens and their key, or the lab's harness.
  for (const [provider, needs] of [
    ['anthropic', 'ANTHROPIC_API_KEY, or use claude-code'],
    ['openai', 'OPENAI_API_KEY, or use codex'],
    ['gemini', 'GEMINI_API_KEY; Foundry has no google subscription harness yet'],
    ['meta', 'MODEL_API_KEY; Foundry has no meta subscription harness yet'],
    ['xai', 'XAI_API_KEY; Foundry has no xai subscription harness yet'],
  ] as const) {
    expect(main(provider, false)).toThrow(`set apiTokens: true and ${needs}`);
    expect(main(provider, true)).not.toThrow();
  }
  // Other labs, gateways and local hosts do not run main threads, even with API tokens.
  for (const provider of ['deepseek', 'qwen', 'mistral', 'openrouter', 'ollama'])
    expect(main(provider, true)).toThrow('cannot run a main thread');
  // Unregistered ids are adapters supplied in code (tests, Oracle); the registry cannot classify them.
  const custom = defaultConfig();
  custom.apiTokens = true;
  delete custom.defaults.classifierProvider;
  delete custom.defaults.classifierModel;
  custom.defaults.provider = 'controlled';
  expect(() => validateConfig(custom)).not.toThrow();
  custom.apiTokens = undefined;
  expect(() => validateConfig(custom)).toThrow('Subscription-only mode');
  // An executor agent is a main thread too.
  const executor = defaultConfig();
  executor.apiTokens = true;
  executor.agents = defaultProjectAgents('anthropic', 'claude-opus-5', 'openai', 'gpt-6-luna');
  executor.agents.artificer!.provider = 'deepseek';
  expect(() => validateConfig(executor)).toThrow('deepseek cannot run a main thread');
});

test('the Codex worker requires a ChatGPT login and runs on a private home sharing the login with decisions', async () => {
  const f = codexMain();
  const apiKeyLogin = new SubscriptionAuthentication(f.root, f.worker, () => ({
    stdout: new ReadableStream({ start: (c) => c.close() }),
    stderr: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('Logged in using an API key - sk-***\n'));
        c.close();
      },
    }),
    exited: Promise.resolve(0),
    kill() {},
  }));
  await expect(apiKeyLogin.prepare('main', 'codex')).rejects.toThrow('no API fallback');
  // The real `codex login status` on the account's ChatGPT login.
  const status = recordedCodexStatus(['chatgpt']);
  const auth = new SubscriptionAuthentication(f.root, f.worker, status.statusSpawn);
  await expect(auth.prepare('main', 'claude')).rejects.toThrow('runtime mismatch');
  // Decisions hold the same login while main threads run.
  const decisions = new NativeAuthentication({
    directory: join(f.root, 'decisions'),
    sources: [f.worker],
    defaultSourceId: f.worker.id,
    shared: true,
    privateHome: true,
  });
  const decision = await decisions.prepare('decisions', 'codex');
  decision.launch(['codex', 'app-server'], {});
  const [first, second] = await Promise.all([
    auth.prepare('main', 'codex'),
    auth.prepare('second-thread', 'codex'),
  ]);
  try {
    const command = first.launch(['codex', 'app-server', '-c', 'approval_policy="never"'], {
      PATH: process.env.PATH,
      OPENAI_API_KEY: 'synthetic-paid-key',
      CODEX_API_KEY: 'synthetic-paid-key',
      ANTHROPIC_API_KEY: 'synthetic-paid-key',
    });
    second.launch(['codex', 'app-server'], { PATH: process.env.PATH });
    expect(status.statusChecks).toBe(1);
    expect(command.env.OPENAI_API_KEY).toBeUndefined();
    expect(command.env.CODEX_API_KEY).toBeUndefined();
    expect(command.env.ANTHROPIC_API_KEY).toBeUndefined();
    const home = join(f.root, f.worker.id, 'codex-home');
    expect(command.env.CODEX_HOME).toBe(home);
    expect(readlinkSync(join(home, 'auth.json'))).toBe(
      join(realpathSync(f.worker.profileDirectory), 'auth.json'),
    );
    expect(command.argv).toEqual(['codex', 'app-server', '-c', 'approval_policy="never"']);
    expect(existsSync(join(f.worker.profileDirectory, '.foundry-auth-lock'))).toBe(false);
    // An exclusive (Claude-style) holder cannot take the shared login.
    const exclusive = new NativeAuthentication({
      directory: join(f.root, 'exclusive'),
      sources: [f.worker],
      defaultSourceId: f.worker.id,
    });
    const blocked = await exclusive.prepare('exclusive', 'codex');
    expect(() => blocked.launch(['codex'], {})).toThrow('in use');
  } finally {
    first.release();
    second.release();
    decision.release();
  }
}, 30_000);

test('a Codex starter stays subscription-only and the viewer says what each main thread needs', () => {
  const codex = starterConfig('codex', 'gpt-6-astra');
  expect(codex.apiTokens).toBeUndefined();
  expect(() => validateConfig(codex)).not.toThrow();
  expect(starterConfig('gemini', 'gemini-3.8-flash').apiTokens).toBe(true);
  const viewer = Object.fromEntries(
    registryForViewer().providers.map((provider) => [provider.id, provider]),
  );
  expect(viewer.codex).toMatchObject({ lab: 'openai', mainThread: { requirement: null } });
  expect(viewer['claude-code']).toMatchObject({
    lab: 'anthropic',
    mainThread: { requirement: null },
  });
  expect(viewer.gemini!.mainThread!.requirement).toContain(
    'set apiTokens: true and GEMINI_API_KEY',
  );
  expect(viewer.xai!.lab).toBe('xai');
  expect(viewer.deepseek!.mainThread).toBeNull();
  expect(viewer.openrouter).toMatchObject({ lab: null, mainThread: null });
});
