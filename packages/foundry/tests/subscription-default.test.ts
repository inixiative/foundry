import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { regionRoleId } from '../src/agents/region-roster';
import { defaultProfileSource } from '../src/providers/default-profiles';
import { NativeAuthentication } from '../src/providers/native-authentication';
import {
  ClaudeCodeSessionAdapter,
  InMemoryExternalSessionStore,
} from '../src/providers/session-adapter';
import {
  PROJECT_HOST_DEFAULTS,
  resolveSubscriptionPolicy,
} from '../src/providers/subscription-policy';
import { ConfigStore, defaultConfig, starterConfig, validateConfig } from '../src/viewer/config';
import { resolveProjectView } from '../src/viewer/config-resolve';
import { writeRegions } from './helpers/regions';
import { subscriptionTransport } from './helpers/subscription-transport';

const roots: string[] = [];
const home = process.env.HOME;
afterEach(async () => {
  process.env.HOME = home;
  await Bun.sleep(10);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** A temporary HOME holding the user's own login locations, shared (0755) like a real ~/.claude. */
function userHome() {
  const root = mkdtempSync(join(tmpdir(), 'subscription-default-'));
  roots.push(root);
  for (const name of ['.claude', '.codex']) mkdirSync(join(root, name), { mode: 0o755 });
  writeFileSync(join(root, '.claude', 'settings.json'), '{}', { mode: 0o644 });
  writeFileSync(join(root, '.codex', 'auth.json'), '{}', { mode: 0o600 });
  process.env.HOME = root;
  return root;
}

test("a fresh configuration is subscription-only: Claude worker and Claude Haiku 5.5 decisions on the user's own login", () => {
  const root = userHome(),
    cwd = join(root, 'project');
  mkdirSync(cwd);
  const config = defaultConfig();
  expect(config.apiTokens).toBeUndefined();
  expect(() => validateConfig(config)).not.toThrow();
  const resolved = resolveSubscriptionPolicy(config, { startup: true, cwd })!;
  expect(resolved.workers['claude-code']).toMatchObject({
    runtime: 'claude',
    mode: 'native-profile',
    profileDirectory: join(root, '.claude'),
  });
  // Worker and decisions share the one Claude login.
  expect(resolved.workers['claude-code']).toEqual(resolved.decision);
  expect(resolved.policy).toEqual({
    model: 'claude-haiku-5-5',
    directory: join(cwd, '.foundry', 'decision-receipts'),
    maxCalls: 10000,
    maxQueued: 512,
    maxQueuedPerThread: 256,
    maxConcurrent: 16,
    callTimeoutMs: 60000,
    effort: 'low',
    // Wardens are held in project hosts (Aron, 2026-11-03).
    projectHost: PROJECT_HOST_DEFAULTS,
  });
  expect(statSync(resolved.policy.directory).mode & 0o777).toBe(0o700);
  expect(resolved.config.defaults).toMatchObject({
    provider: 'claude-code',
    decisionProvider: 'subscription-decisions',
    decisionModel: 'claude-haiku-5-5',
  });
});

test("a project's region Wardens run on the subscription decision model: an enabled chorus loads under subscription-only", () => {
  const root = userHome(),
    project = join(root, 'project');
  mkdirSync(project);
  writeRegions(project, [{ id: 'locks' }]);
  const config = defaultConfig();
  config.projects.P = { id: 'P', path: project };
  // Before 2026-10-18 a generated Warden carried no provider or model, so the policy refused the
  // whole settings file once a repository enabled its chorus.
  const resolved = resolveSubscriptionPolicy(config, { cwd: project })!;
  expect(
    resolveProjectView(resolved.config, 'P')!.config.agents[regionRoleId('locks')],
  ).toMatchObject({
    kind: 'warden',
    provider: 'subscription-decisions',
    model: 'claude-haiku-5-5',
  });
});

test('decisions run on the Claude login only: a Codex login or a Codex model is refused as the decision source', () => {
  const root = userHome(),
    config = defaultConfig();
  config.nativeAuthentication = [
    {
      ...defaultProfileSource('codex'),
      id: Bun.randomUUIDv7(),
      integrationId: Bun.randomUUIDv7(),
    },
  ];
  config.subscriptionOnly = { decisionSourceId: config.nativeAuthentication[0]!.id };
  expect(() => resolveSubscriptionPolicy(config, { cwd: root })).toThrow(
    'subscriptionOnly.decisionSourceId must be a Claude login',
  );
  // A Codex model recorded as the decision model is refused, never sent to the Claude login.
  config.subscriptionOnly = {};
  config.defaults.decisionProvider = 'subscription-decisions';
  config.defaults.decisionModel = 'gpt-5.6-luna';
  expect(() => resolveSubscriptionPolicy(config, { cwd: root })).toThrow(
    'Decision model gpt-5.6-luna is a codex model; decisions run on Claude',
  );
});

test("the user's default profiles are referenced in place but their credential files must stay private", () => {
  const root = userHome();
  writeFileSync(join(root, '.claude', '.credentials.json'), '{}', { mode: 0o644 });
  expect(() => resolveSubscriptionPolicy(defaultConfig(), { startup: true, cwd: root })).toThrow(
    'claude subscription profile unavailable',
  );
  chmodSync(join(root, '.claude', '.credentials.json'), 0o600);
  rmSync(join(root, '.claude'), { recursive: true });
  expect(() => resolveSubscriptionPolicy(defaultConfig(), { startup: true, cwd: root })).toThrow(
    'claude subscription profile unavailable',
  );
  // Saving settings does not depend on this machine's logins.
  expect(() => validateConfig(defaultConfig())).not.toThrow();
});

test('API tokens are an explicit, exclusive opt-in', () => {
  userHome();
  const api = starterConfig('anthropic', 'claude-sonnet-5');
  expect(api.apiTokens).toBe(true);
  expect(resolveSubscriptionPolicy(api)).toBeUndefined();
  const opted = defaultConfig();
  opted.apiTokens = true;
  expect(resolveSubscriptionPolicy(opted)).toBeUndefined();
  opted.subscriptionOnly = { maxCalls: 5 };
  expect(() => validateConfig(opted)).toThrow('exclusive');
  const worker = defaultConfig();
  worker.defaults.provider = 'anthropic';
  expect(() => validateConfig(worker)).toThrow('set apiTokens: true');
  const invalid = defaultConfig();
  (invalid as { apiTokens?: unknown }).apiTokens = 'yes';
  expect(() => validateConfig(invalid)).toThrow('apiTokens');
});

test('the settings API opts in to API tokens and back out explicitly', async () => {
  const root = userHome(),
    store = new ConfigStore(join(root, '.foundry'));
  await store.load();
  await expect(
    store.patch('defaults', { provider: 'gemini', model: 'gemini-3.1-flash' }),
  ).rejects.toThrow('set apiTokens: true');
  expect((await store.patch('apiTokens', { enabled: true })).apiTokens).toBe(true);
  expect(
    (await store.patch('defaults', { provider: 'gemini', model: 'gemini-3.1-flash' })).defaults
      .provider,
  ).toBe('gemini');
  await expect(store.patch('apiTokens', { enabled: false })).rejects.toThrow('set apiTokens: true');
  await store.patch('defaults', { provider: 'claude-code', model: 'fable' });
  expect((await store.patch('apiTokens', { enabled: false })).apiTokens).toBeUndefined();
});

test('saved decision defaults run on subscription decisions without rewriting the saved configuration', () => {
  userHome();
  const config = defaultConfig();
  config.defaults = {
    provider: 'claude-code',
    model: 'opus',
    decisionProvider: 'gemini',
    decisionModel: 'gemini-3.1-flash-lite-preview',
  };
  config.agents.artificer = {
    id: 'artificer',
    kind: 'executor',
    prompt: '',
    provider: 'claude-code',
    model: 'opus',
    tools: true,
    enabled: true,
  };
  const before = JSON.stringify(config);
  expect(() => validateConfig(config)).not.toThrow();
  const resolved = resolveSubscriptionPolicy(config)!;
  expect(JSON.stringify(config)).toBe(before);
  expect(resolved.config.defaults).toMatchObject({
    decisionProvider: 'subscription-decisions',
    decisionModel: 'claude-haiku-5-5',
  });
  expect(resolved.config.agents.artificer).toMatchObject({
    provider: 'claude-code',
    model: 'opus',
  });
});

test('default profiles are selected by omission, so the child never overrides CLAUDE_CONFIG_DIR or CODEX_HOME', async () => {
  const root = userHome();
  for (const runtime of ['claude', 'codex'] as const) {
    const source = defaultProfileSource(runtime);
    const auth = new NativeAuthentication({
      directory: join(root, 'auth'),
      sources: [source],
      defaultSourceId: source.id,
    });
    const launch = await auth.prepare('worker', runtime);
    const command = launch.launch([runtime], {
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/elsewhere',
      CODEX_HOME: '/elsewhere',
      OPENAI_API_KEY: 'synthetic-paid-key',
    });
    try {
      expect(command.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(command.env.CODEX_HOME).toBeUndefined();
      expect(command.env.OPENAI_API_KEY).toBeUndefined();
      // One Foundry owner per login; the user's own interactive sessions do not take this lock.
      expect(existsSync(join(source.profileDirectory, '.foundry-auth-lock'))).toBe(true);
    } finally {
      launch.release();
    }
    expect(existsSync(join(source.profileDirectory, '.foundry-auth-lock'))).toBe(false);
  }
});

async function startFoundry(root: string, extra: Record<string, string> = {}) {
  const probe = join(root, 'network-attempt'),
    preload = join(root, 'deny-network.ts');
  writeFileSync(
    preload,
    `import {writeFileSync} from 'node:fs'; globalThis.fetch = (() => {writeFileSync(${JSON.stringify(probe)}, 'attempted'); throw Error('External requests forbidden in startup test');}) as typeof fetch;`,
    { mode: 0o600 },
  );
  const env = Object.fromEntries(
    ['PATH', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'].map((key) => [key, process.env[key]]),
  );
  // The starter project's conventions source reads <project>/docs.
  const cwd = join(root, 'project');
  mkdirSync(join(cwd, 'docs'), { recursive: true });
  const child = Bun.spawn(
    [process.execPath, '--preload', preload, new URL('../src/start.ts', import.meta.url).pathname],
    {
      cwd,
      env: {
        ...env,
        HOME: root,
        VIEWER_PORT: '0',
        FOUNDRY_STARTUP_SELF_TEST: '0',
        OPENAI_API_KEY: 'synthetic-never-send',
        ANTHROPIC_API_KEY: 'synthetic-never-send',
        GEMINI_API_KEY: 'synthetic-never-send',
        ...extra,
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
  const streams = Promise.all([read(child.stdout), read(child.stderr)]);
  return {
    child,
    cwd,
    probe,
    get output() {
      return output;
    },
    async stop() {
      child.kill('SIGINT');
      await child.exited;
      await streams;
    },
  };
}

test('a fresh install starts subscription-only with no settings, API provider or network request', async () => {
  const root = userHome();
  const foundry = await startFoundry(root);
  try {
    for (let attempt = 0; !foundry.output.includes('Ready. Send messages'); attempt++) {
      if (attempt >= 200 || foundry.child.exitCode !== null)
        throw Error(`Fresh subscription startup did not become ready: ${foundry.output}`);
      await Bun.sleep(25);
    }
    expect(foundry.output).toContain(
      `Subscription-only: workers claude-code (${join(root, '.claude')}), codex (${join(root, '.codex')}), decisions claude claude-haiku-5-5 (${join(root, '.claude')}); no API providers`,
    );
    // Every usable worker's adapter is built at start; building one spawns nothing.
    expect(foundry.output).toContain('Session adapters: claude-code, codex-app-server');
    expect(foundry.output).toContain('Librarian (subscription-decisions)');
    expect(foundry.output).not.toContain('openai-decisions');
    expect(foundry.output).not.toContain('Decision roles use subscription decisions');
    const port = foundry.output.match(/Foundry Viewer running at http:\/\/localhost:(\d+)/)?.[1];
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
    const saved = JSON.parse(readFileSync(join(foundry.cwd, '.foundry', 'settings.json'), 'utf8'));
    expect(saved.apiTokens).toBeUndefined();
    expect(saved.defaults).toMatchObject({
      provider: 'claude-code',
      decisionProvider: 'subscription-decisions',
      decisionModel: 'claude-haiku-5-5',
    });
    expect(existsSync(foundry.probe)).toBe(false);
    expect(statSync(join(foundry.cwd, '.foundry', 'decision-receipts')).mode & 0o777).toBe(0o700);
  } finally {
    await foundry.stop();
  }
}, 10000);

test('API tokens opted in without a key refuse startup instead of falling back to subscriptions', async () => {
  const root = userHome(),
    config = defaultConfig();
  config.apiTokens = true;
  mkdirSync(join(root, 'project', '.foundry'), { recursive: true });
  writeFileSync(join(root, 'project', '.foundry', 'settings.json'), JSON.stringify(config), {
    mode: 0o600,
  });
  const foundry = await startFoundry(root, { ANTHROPIC_API_KEY: '' });
  const code = await foundry.child.exited;
  await foundry.stop();
  expect(code).not.toBe(0);
  expect(foundry.output).toContain(
    'Foundry decisions require ANTHROPIC_API_KEY for anthropic/claude-haiku-5-5',
  );
  expect(foundry.output).not.toContain('Subscription-only');
}, 10000);

test("shutdown stops live worker processes so the user's profile lock is released", async () => {
  const root = userHome(),
    source = defaultProfileSource('claude'),
    worker = subscriptionTransport();
  const adapter = new ClaudeCodeSessionAdapter({
    store: new InMemoryExternalSessionStore(),
    authentication: new NativeAuthentication({
      directory: join(root, 'auth'),
      sources: [source],
      defaultSourceId: source.id,
    }),
    defaults: { spawn: worker.spawn },
  });
  const session = await adapter.createSession({ threadId: 'main', cwd: root });
  await session.start();
  expect(existsSync(join(root, '.claude', '.foundry-auth-lock'))).toBe(true);

  await adapter.releaseAll();
  expect(worker.launches[0]!.exited).toBe(true);
  expect(existsSync(join(root, '.claude', '.foundry-auth-lock'))).toBe(false);
});
