import './helpers/isolate-archive';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type AcpSpawn,
  AGY_COMPETING_ENV,
  GEMINI_CLI_COMPETING_ENV,
  NativeBindingMissingError,
} from '@inixiative/agent-session';
import {
  type NativeBridgeLease,
  SignalBus,
  SUBSCRIPTION_WORKER_MODELS,
  vendorOfProvider,
} from '@inixiative/foundry-core';
import { Hono } from 'hono';
import { captureThread } from '../src/archives/capture';
import { AGENT_CLIS, REQUIRED_AGENT_CLIS } from '../src/daemon/agent-clis';
import {
  SUBSCRIPTION_WORKERS,
  WORKER_NAMES,
  WORKER_SESSION_RUNTIMES,
  workerHostsFoundryTools,
} from '../src/models/registry';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { CODER_ROLE, defaultThreadRole } from '../src/prompts/instruction-settings';
import {
  defaultProfileDirectory,
  defaultProfileSource,
  profileEnvironment,
} from '../src/providers/default-profiles';
import {
  NativeAuthentication,
  withoutCompetingCredentials,
} from '../src/providers/native-authentication';
import { acpMcpServers } from '../src/providers/native-launch';
import { boundLaunchEnvironment } from '../src/providers/native-text-environment';
import { assertProfile } from '../src/providers/private-profile';
import { providerAccounts } from '../src/providers/provider-accounts';
import { providerLimits } from '../src/providers/provider-limits';
import {
  AcpSessionAdapter,
  type AcpWorkerKind,
  InMemoryExternalSessionStore,
} from '../src/providers/session-adapter';
import { SessionBackedProvider } from '../src/providers/session-backed';
import { SubscriptionAuthentication } from '../src/providers/subscription-authentication';
import {
  resolveSubscriptionPolicy,
  threadWorkerRequirement,
} from '../src/providers/subscription-policy';
import { inspectNativeClis } from '../src/readiness';
import { ConfigStore, defaultConfig, validateConfig } from '../src/viewer/config';
import { machineProcesses } from '../src/viewer/machine-processes';
import { registerModelRoutes } from '../src/viewer/routes/models';

const FAKE_ACP_SERVER =
  process.env.FAKE_ACP_SERVER ?? resolve(import.meta.dir, 'helpers/fake-acp-server.ts');

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function tempHome(dirs: string[] = ['.claude', '.gemini']) {
  const root = mkdtempSync(join(tmpdir(), 'acp-worker-home-'));
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  cleanup.push(() => {
    process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** Spawns `fake-acp-server.ts` instead of the real CLI while recording the command and child env. */
function fakeAcpSpawn(extraEnv: Record<string, string> = {}) {
  const launches: Array<{
    cmd: readonly string[];
    cwd: string;
    env: Record<string, string | undefined>;
  }> = [];
  const spawn: AcpSpawn = (cmd, options) => {
    launches.push({ cmd: [...cmd], cwd: options.cwd, env: { ...options.env } });
    return Bun.spawn([process.execPath, FAKE_ACP_SERVER], {
      cwd: options.cwd,
      env: { ...options.env, ...extraEnv },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }) as unknown as ReturnType<AcpSpawn>;
  };
  return { spawn, launches };
}

function fakeBridge(
  threadId: string,
  name = 'foundry',
): NativeBridgeLease & { closed: () => number } {
  let closeCalls = 0;
  return {
    id: `lease-${threadId}`,
    name,
    owner: { threadId, generation: 'gen-1' },
    configurationHash: '0'.repeat(64),
    launch: {
      claudeJson: JSON.stringify({
        mcpServers: {
          [name]: { command: 'bun', args: ['/fake/mcp/proxy.ts', '/fake/launch.json'] },
        },
      }),
    },
    check() {},
    register() {},
    observe() {},
    evidence() {
      return [];
    },
    async close() {
      closeCalls++;
    },
    status() {
      return {
        closed: closeCalls > 0,
        pendingCleanups: 0,
        cleanupFailures: 0,
        evictedRecords: 0,
      };
    },
    closed: () => closeCalls,
  };
}

describe('ACP worker registry, profiles and environment hygiene', () => {
  test('registers agy and gemini-cli in SUBSCRIPTION_WORKERS, labels, runtimes and AGENT_CLIS', () => {
    expect(SUBSCRIPTION_WORKERS.agy).toBe('agy');
    expect(SUBSCRIPTION_WORKERS['gemini-cli']).toBe('gemini');
    expect(WORKER_NAMES.agy).toBe('Antigravity');
    expect(WORKER_NAMES['gemini-cli']).toBe('Gemini CLI');
    expect(WORKER_SESSION_RUNTIMES.agy).toBe('acp:agy');
    expect(WORKER_SESSION_RUNTIMES['gemini-cli']).toBe('acp:gemini');
    expect(SUBSCRIPTION_WORKER_MODELS.agy).toBe('gemini-4-neon');
    expect(SUBSCRIPTION_WORKER_MODELS['gemini-cli']).toBe('gemini-3.8-flash');
    expect(workerHostsFoundryTools('agy')).toBe(true);
    expect(workerHostsFoundryTools('gemini-cli')).toBe(true);
    expect(AGENT_CLIS).toContain('agy');
    expect(AGENT_CLIS).toContain('gemini');
    expect(REQUIRED_AGENT_CLIS).toEqual(['claude', 'codex']);
    expect(defaultThreadRole(undefined, 'agy')).toBe(CODER_ROLE);
    expect(defaultThreadRole(undefined, 'gemini-cli')).toBe(CODER_ROLE);
  });

  test('withoutCompetingCredentials strips every key in AGY_COMPETING_ENV and GEMINI_CLI_COMPETING_ENV', () => {
    const inherited: Record<string, string | undefined> = {
      PATH: '/usr/bin',
      HOME: '/Users/tester',
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-openai',
      CUSTOM_KEEP: 'ok',
    };
    for (const key of new Set([...AGY_COMPETING_ENV, ...GEMINI_CLI_COMPETING_ENV]))
      inherited[key] = `secret-${key}`;

    for (const runtime of ['agy', 'gemini'] as const) {
      const cleaned = withoutCompetingCredentials(inherited, runtime);
      for (const key of AGY_COMPETING_ENV) expect(cleaned[key]).toBeUndefined();
      for (const key of GEMINI_CLI_COMPETING_ENV) expect(cleaned[key]).toBeUndefined();
      expect(cleaned.ANTHROPIC_API_KEY).toBeUndefined();
      expect(cleaned.OPENAI_API_KEY).toBeUndefined();
      expect(cleaned.PATH).toBe('/usr/bin');
      expect(cleaned.HOME).toBe('/Users/tester');
      expect(cleaned.CUSTOM_KEEP).toBe('ok');
    }

    // Claude launches do not strip Google keys unintentionally via the Google list.
    const claudeEnv = withoutCompetingCredentials(inherited, 'claude');
    expect(claudeEnv.GEMINI_API_KEY).toBe('secret-GEMINI_API_KEY');
  });

  test('default profiles, keychain-friendly agy assertion, and single-profile / no-gateway rules', () => {
    const root = tempHome(['.claude']);
    expect(defaultProfileDirectory('agy')).toBe(join(root, '.gemini', 'antigravity-cli'));
    expect(defaultProfileDirectory('gemini')).toBe(join(root, '.gemini'));

    // Antigravity uses OS keychain so a missing ~/.gemini/antigravity-cli directory is allowed.
    expect(() => assertProfile(defaultProfileDirectory('agy'), 'agy')).not.toThrow();
    // Gemini CLI requires ~/.gemini to exist.
    expect(() => assertProfile(defaultProfileDirectory('gemini'), 'gemini')).toThrow();
    mkdirSync(join(root, '.gemini'), { mode: 0o700 });
    expect(() => assertProfile(defaultProfileDirectory('gemini'), 'gemini')).not.toThrow();

    // A symlink at ~/.gemini/antigravity-cli is still refused.
    const decoy = join(root, 'decoy');
    mkdirSync(decoy, { mode: 0o700 });
    symlinkSync(decoy, join(root, '.gemini', 'antigravity-cli'));
    expect(() => assertProfile(defaultProfileDirectory('agy'), 'agy')).toThrow('not a symlink');

    // A symlinked ~/.gemini parent is also refused even when antigravity-cli does not exist yet.
    const rootWithSymlinkParent = tempHome(['.claude']);
    const externalDir = join(rootWithSymlinkParent, 'external-gemini');
    mkdirSync(externalDir, { mode: 0o700 });
    symlinkSync(externalDir, join(rootWithSymlinkParent, '.gemini'));
    expect(() => assertProfile(defaultProfileDirectory('agy'), 'agy')).toThrow('not a symlink');
    process.env.HOME = root;

    // Non-default profiles and gateway mode are refused for both runtimes.
    const other = join(root, 'other-profile');
    mkdirSync(other, { mode: 0o700 });
    expect(() => profileEnvironment('agy', other)).toThrow('Antigravity');
    expect(() => profileEnvironment('gemini', other)).toThrow('Gemini CLI');
    expect(() => assertProfile(other, 'agy')).toThrow('Antigravity');
    expect(() => assertProfile(other, 'gemini')).toThrow('Gemini CLI');
    expect(profileEnvironment('agy', defaultProfileDirectory('agy'))).toEqual({});
    expect(profileEnvironment('gemini', defaultProfileDirectory('gemini'))).toEqual({});

    for (const runtime of ['agy', 'gemini'] as const) {
      expect(
        () =>
          new NativeAuthentication({
            directory: join(root, 'auth'),
            sources: [
              {
                id: Bun.randomUUIDv7(),
                integrationId: Bun.randomUUIDv7(),
                runtime,
                mode: 'gateway',
                baseUrl: 'https://gateway.example',
                credential: { type: 'environment', variable: 'GW_TOKEN' },
              },
            ],
          }),
      ).toThrow('no gateway mode');
    }
  });

  test('providerAccounts, providerLimits, readiness, model routes, machineProcesses and capture handle agy and gemini-cli', async () => {
    const root = tempHome(['.claude', '.gemini']);
    const config = defaultConfig();
    for (const id of ['agy', 'gemini-cli'] as const) {
      const { vendor, mode } = vendorOfProvider(id)!;
      config.vendors[vendor.id] = {
        ...config.vendors[vendor.id],
        enabled: true,
        [mode]: { enabled: true },
      };
    }

    const accounts = Object.fromEntries(
      providerAccounts(config, {
        which: (cmd) => (cmd === 'agy' || cmd === 'claude' ? `/usr/local/bin/${cmd}` : null),
        environment: {},
      }).map((a) => [a.provider, a]),
    );
    expect(accounts.agy).toMatchObject({
      provider: 'agy',
      source: 'login',
      ready: true,
      uses: ['main thread'],
    });
    expect(accounts['gemini-cli']).toMatchObject({
      provider: 'gemini-cli',
      source: 'login',
      ready: false,
      issue: 'The gemini CLI is not on PATH',
    });

    // Default limit probes return unavailable cleanly for agy and gemini-cli.
    const limits = await providerLimits([accounts.agy!, accounts['gemini-cli']!]);
    expect(limits).toEqual([
      { provider: 'agy', state: 'unavailable' },
      { provider: 'gemini-cli', state: 'unavailable' },
    ]);

    // Readiness checks both CLIs when their vendors are enabled.
    const cliReport = await inspectNativeClis(config, {
      which: (cmd) => (cmd === 'claude' || cmd === 'agy' ? `/usr/local/bin/${cmd}` : null),
    });
    expect(cliReport.nativeClis.find((c) => c.cli === 'agy')).toMatchObject({
      provider: 'agy',
      binary: '/usr/local/bin/agy',
    });
    expect(
      cliReport.issues.some(
        (i) => i.code === 'native-cli-missing' && i.message.includes('Gemini CLI'),
      ),
    ).toBe(true);

    // Subscription policy offers both workers and refuses them as decision sources.
    const resolution = resolveSubscriptionPolicy(config, { startup: true, cwd: root })!;
    expect(resolution.offered).toContain('agy');
    expect(resolution.offered).toContain('gemini-cli');
    expect(resolution.workers.agy).toBeDefined();
    expect(resolution.workers['gemini-cli']).toBeDefined();
    expect(threadWorkerRequirement(resolution, config, 'agy')).toBeUndefined();
    expect(threadWorkerRequirement(resolution, config, 'gemini-cli')).toBeUndefined();

    // Model routes allow setting agy / gemini-cli as default, and refuse them as decision models.
    const configPath = join(root, 'settings.json');
    const store = new ConfigStore(configPath);
    await store.load();
    await store.update((draft) => {
      draft.vendors.google = {
        enabled: true,
        subscription: { enabled: true },
        api: { enabled: true },
      };
      draft.vendors['google-code-assist'] = { enabled: true, subscription: { enabled: true } };
    });
    const app = new Hono();
    registerModelRoutes(app, store);
    const setDefault = await app.request('/api/models/default', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'agy', model: 'gemini-4-neon' }),
    });
    expect(setDefault.status).toBe(200);
    expect(((await setDefault.json()) as { default: unknown }).default).toEqual({
      provider: 'agy',
      model: 'gemini-4-neon',
    });
    const setDecisionAgy = await app.request('/api/models/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'agy', model: 'gemini-4-hydrogen' }),
    });
    expect(setDecisionAgy.status).toBe(400);
    expect(((await setDecisionAgy.json()) as { error: string }).error).toContain(
      'Antigravity runs main threads only',
    );
    const setDecisionGemini = await app.request('/api/models/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini-cli', model: 'gemini-3.5-flash-lite' }),
    });
    expect(setDecisionGemini.status).toBe(400);
    expect(((await setDecisionGemini.json()) as { error: string }).error).toContain(
      'Gemini CLI runs main threads only',
    );

    // machineProcesses recognizes agy and gemini ACP subprocesses.
    const tree = machineProcesses(
      [
        { pid: 100, ppid: 1, rssKb: 10240, cpu: 0.1, ageSeconds: 100, command: 'bun src/start.ts' },
        {
          pid: 101,
          ppid: 100,
          rssKb: 20480,
          cpu: 1.2,
          ageSeconds: 10,
          command: '/usr/local/bin/agy acp --stdio --dangerously-skip-permissions',
        },
        {
          pid: 102,
          ppid: 100,
          rssKb: 15360,
          cpu: 0.5,
          ageSeconds: 8,
          command: '/usr/local/bin/gemini --acp --approval-mode yolo --model gemini-3.8-flash',
        },
      ],
      100,
    )!;
    expect(tree.children.map((c) => ({ role: c.role, label: c.label, model: c.model }))).toEqual([
      { role: 'session', label: 'Antigravity ACP session', model: undefined },
      { role: 'session', label: 'Gemini CLI ACP session', model: 'gemini-3.8-flash' },
    ]);

    // Archive capture handles agy and gemini-cli threads cleanly.
    const journal = new LocalSessionStore(':memory:');
    cleanup.push(() => journal.close());
    journal.saveThread({
      id: 't-agy',
      meta: {
        description: 'agy thread',
        tags: [],
        status: 'idle',
        createdAt: 1,
        lastActiveAt: 1,
        worker: 'agy',
      },
    });
    expect(captureThread(journal, Bun.randomUUIDv7(), 't-agy').runtime).toBeUndefined();

    // validateConfig refuses non-decision subscription workers as decisionProvider even with apiTokens: true.
    for (const provider of ['agy', 'gemini-cli', 'muse'] as const) {
      const apiCfg = defaultConfig();
      apiCfg.apiTokens = true;
      apiCfg.defaults.decisionProvider = provider;
      expect(() => validateConfig(apiCfg)).toThrow('runs main threads only');
    }

    // validateConfig refuses Kingdom capacity on projects defaulting to agy or gemini-cli.
    for (const worker of ['agy', 'gemini-cli'] as const) {
      const kingdomCfg = defaultConfig();
      const { vendor, mode } = vendorOfProvider(worker)!;
      kingdomCfg.vendors[vendor.id] = {
        ...kingdomCfg.vendors[vendor.id],
        enabled: true,
        [mode]: { enabled: true },
      };
      const integrationId = Bun.randomUUIDv7();
      kingdomCfg.kingdomIntegrations = [
        {
          url: 'https://kingdom.example',
          integrationId,
          owner: `Organization::${Bun.randomUUIDv7()}:`,
          signetId: Bun.randomUUIDv7(),
        },
      ];
      kingdomCfg.projects.p = {
        id: 'p',
        path: root,
        capacity: 'kingdom',
        kingdomCapacity: { kingdom: 'https://kingdom.example', signetId: Bun.randomUUIDv7() },
        defaults: { provider: worker, model: SUBSCRIPTION_WORKER_MODELS[worker] },
      };
      expect(() => validateConfig(kingdomCfg)).toThrow(
        'Kingdom capacity requires a Claude Code, Codex or Muse Code default worker',
      );
    }

    // acpMcpServers distinguishes bridge collisions from plain client MCP collisions.
    expect(() =>
      acpMcpServers(undefined, [
        { name: 'dup', command: 'echo', args: [], env: [] },
        { name: 'dup', command: 'echo', args: [], env: [] },
      ]),
    ).toThrow('MCP server name collision: dup');
    expect(() =>
      acpMcpServers(fakeBridge('t-1', 'foundry'), [
        { name: 'foundry', command: 'echo', args: [], env: [] },
      ]),
    ).toThrow('Native bridge server name collision: foundry');
  });
});

describe.each<AcpWorkerKind>(['agy', 'gemini'])('AcpSessionAdapter (%s)', (kind) => {
  const providerId = kind === 'agy' ? 'agy' : 'gemini-cli';
  const expectedRuntime = `acp:${kind}`;

  test('streams turns, persists externalSessionId, passes MCP bridge + host servers + model/effort, and resumes', async () => {
    const root = tempHome(['.claude', '.gemini']);
    const store = new InMemoryExternalSessionStore();
    const { spawn, launches } = fakeAcpSpawn({ FAKE_ACP_KNOWN_SESSIONS: 'acp-sess-1' });
    const auth = new SubscriptionAuthentication(
      join(root, 'runtime-profiles'),
      defaultProfileSource(kind),
    );
    const signals = new SignalBus();
    const adapter = new AcpSessionAdapter({
      kind,
      store,
      authentication: auth,
      defaults: { model: 'gemini-3.1-pro', effort: 'high' },
      environment: boundLaunchEnvironment,
      signals,
      spawn,
    });
    cleanup.push(() => adapter.releaseAll());
    expect(adapter.runtime).toBe(expectedRuntime);

    const bridge = fakeBridge('thread-1');
    const session = await adapter.createSession({
      threadId: 'thread-1',
      cwd: root,
      nativeBridge: bridge,
      mcpServers: [
        {
          type: 'http',
          name: 'docs',
          url: 'https://docs.example/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer tok' }],
        },
      ],
    });
    await session.start();

    expect(launches).toHaveLength(1);
    if (kind === 'agy') {
      expect(launches[0]!.cmd).toEqual(['agy', 'acp', '--stdio', '--dangerously-skip-permissions']);
    } else {
      expect(launches[0]!.cmd).toEqual([
        'gemini',
        '--acp',
        '--approval-mode',
        'yolo',
        '--model',
        'gemini-3.1-pro',
      ]);
    }
    expect(await adapter.getExternalSessionId('thread-1')).toBe('acp-sess-1');
    expect(adapter.describeConstruction(session)).toMatchObject({
      resumedBinding: null,
      requestedEffort: 'high',
    });

    const inspect = await session.send('inspect-launch');
    const launchState = JSON.parse(inspect.content) as {
      model: string;
      effort: string;
      mcpServers: Array<{ name: string; command?: string; type?: string }>;
    };
    expect(launchState.model).toBe('gemini-3.1-pro');
    expect(launchState.effort).toBe('high');
    expect(launchState.mcpServers.map((s) => s.name)).toEqual(['foundry', 'docs']);

    const turn = await session.send('hello');
    expect(turn.content).toBe('Hello world: hello');
    // fake-acp-server reports inputTokens: 100, cachedReadTokens: 20, outputTokens: 50
    // -> AcpSession normalizes uncached input = 80, cacheRead = 20, output = 50.
    expect(turn.tokens?.input).toBe(80);
    expect(turn.tokens?.cacheRead).toBe(20);
    expect(turn.tokens?.output).toBe(50);

    // Release closes child, releases auth lock, and closes the native bridge lease.
    expect(await adapter.releaseIdleSession(session)).toBe('released');
    expect(bridge.closed()).toBeGreaterThanOrEqual(1);

    // Second session resumes the stored ACP session id via session/load, and SessionBackedProvider drives it.
    const resumed = await adapter.createSession({ threadId: 'thread-1', cwd: root });
    expect(adapter.describeConstruction(resumed)?.resumedBinding).toBe('acp-sess-1');
    await resumed.start();
    expect(resumed.externalSessionId).toBe('acp-sess-1');
    expect(await adapter.releaseIdleSession(resumed)).toBe('released');

    const provider = new SessionBackedProvider({
      id: providerId,
      adapter,
      defaultModel: 'gemini-3.1-pro',
      defaultCwd: root,
    });
    const completed = await provider.complete([{ role: 'user', content: 'via provider' }], {
      threadId: 'thread-provider',
      cwd: root,
    });
    expect(completed.content).toContain('Hello world:');
    expect(completed.content).toContain('via provider');
    await adapter.releaseAll();
  });

  test('strips competing Google/Gemini API env vars and supports gated ToolGate + interruptNative', async () => {
    const root = tempHome(['.claude', '.gemini']);
    const savedKey = process.env.GEMINI_API_KEY;
    const savedGoogleKey = process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = 'should-not-leak';
    process.env.GOOGLE_API_KEY = 'also-should-not-leak';
    cleanup.push(() => {
      if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedKey;
      if (savedGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = savedGoogleKey;
    });

    const store = new InMemoryExternalSessionStore();
    const { spawn } = fakeAcpSpawn();
    const auth = new SubscriptionAuthentication(
      join(root, 'runtime-profiles'),
      defaultProfileSource(kind),
    );
    const adapter = new AcpSessionAdapter({
      kind,
      store,
      authentication: auth,
      environment: boundLaunchEnvironment,
      spawn,
    });
    cleanup.push(() => adapter.releaseAll());

    const gatedTools: string[] = [];
    const session = await adapter.createSession({
      threadId: 'thread-gated',
      cwd: root,
      permissionMode: 'default',
      toolGate: async (req) => {
        gatedTools.push(req.toolName);
        return { behavior: 'deny', message: 'denied by test gate' };
      },
    });
    await session.start();

    const envRes = await session.send('env-check');
    const envJson = JSON.parse(envRes.content) as Record<string, string | null>;
    expect(envJson.GEMINI_API_KEY).toBeNull();
    expect(envJson.GOOGLE_API_KEY).toBeNull();
    expect(envJson.GOOGLE_APPLICATION_CREDENTIALS).toBeNull();
    expect(envJson.GOOGLE_GENAI_USE_VERTEXAI).toBeNull();
    expect(envJson.GEMINI_CLI_AUTH_OVERRIDE).toBeNull();

    const permRes = await session.send('ask-permission');
    expect(gatedTools).toEqual(['shell']);
    expect(permRes.content).toBe('selected:reject_once');

    // Interrupt an in-flight turn cleanly via session/cancel.
    const held = session.send('hold');
    await Bun.sleep(40);
    const outcome = await session.interruptNative!({ timeoutMs: 3_000 });
    expect(outcome).toBe('acknowledged');
    const cancelled = await held;
    expect(cancelled.terminal?.subtype).toBe('cancelled');

    expect(await adapter.releaseIdleSession(session)).toBe('released');
  });

  test('refuses text-only mode, structural rules, MCP name collisions, and propagates NativeBindingMissingError', async () => {
    const root = tempHome(['.claude', '.gemini']);
    const store = new InMemoryExternalSessionStore();
    const { spawn } = fakeAcpSpawn({ FAKE_ACP_KNOWN_SESSIONS: 'only-this-one' });
    const adapter = new AcpSessionAdapter({ kind, store, spawn });
    cleanup.push(() => adapter.releaseAll());

    await expect(
      adapter.createSession({ threadId: 't-text', cwd: root, tools: false }),
    ).rejects.toThrow('main threads only');

    await expect(
      adapter.createSession({ threadId: 't-rules', cwd: root, structuralRules: true }),
    ).rejects.toThrow('Structural tool rules');

    await expect(
      adapter.createSession({
        threadId: 't-collide',
        cwd: root,
        nativeBridge: fakeBridge('t-collide', 'foundry'),
        mcpServers: [{ name: 'foundry', command: 'echo', args: [], env: [] }],
      }),
    ).rejects.toThrow('collision');

    // Missing session on resume throws NativeBindingMissingError so provider can reseed.
    await store.save('t-stale', expectedRuntime, 'gone-session');
    const stale = await adapter.createSession({ threadId: 't-stale', cwd: root });
    await expect(stale.start()).rejects.toBeInstanceOf(NativeBindingMissingError);

    // End-to-end revival with SubscriptionAuthentication: stale binding releases the auth lock,
    // clears the stale binding, starts a fresh session, and completes the turn cleanly.
    const authStore = new InMemoryExternalSessionStore();
    const auth = new SubscriptionAuthentication(
      join(root, 'runtime-profiles-revive'),
      defaultProfileSource(kind),
    );
    const reviveSpawn = fakeAcpSpawn({ FAKE_ACP_KNOWN_SESSIONS: 'only-this-one' });
    const authAdapter = new AcpSessionAdapter({
      kind,
      store: authStore,
      authentication: auth,
      environment: boundLaunchEnvironment,
      spawn: reviveSpawn.spawn,
    });
    cleanup.push(() => authAdapter.releaseAll());
    await authStore.save(auth.bindingId('t-revive', kind), expectedRuntime, 'gone-session');
    const provider = new SessionBackedProvider({
      id: providerId,
      adapter: authAdapter,
      defaultModel: 'gemini-3.1-pro',
      defaultCwd: root,
    });
    const revived = await provider.complete([{ role: 'user', content: 'after stale binding' }], {
      threadId: 't-revive',
      cwd: root,
    });
    expect(revived.content).toContain('after stale binding');
    expect(reviveSpawn.launches).toHaveLength(2);
    expect(await authAdapter.getExternalSessionId('t-revive')).toBe('acp-sess-1');
    await authAdapter.releaseAll();
  });
});
