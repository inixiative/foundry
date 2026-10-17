import './helpers/isolate-archive';
import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectReadiness } from '../src/readiness';
import { ConfigStore, defaultConfig } from '../src/viewer/config';
import { writeRegions } from './helpers/regions';

function team() {
  const config = defaultConfig();
  config.apiTokens = true; // OpenAI experts on the OpenAI decision provider
  config.defaults = {
    ...config.defaults,
    classifierProvider: 'openai',
    classifierModel: 'gpt-5.6-luna',
  };
  config.agents.worker = {
    id: 'worker',
    kind: 'executor',
    prompt: 'PRIVATE_WORKER',
    visibleLayers: [],
    peers: [],
    maxDepth: 1,
    enabled: true,
  };
  // The project's one Warden is its region `docs` (settings declare none).
  const project = mkdtempSync(join(tmpdir(), 'foundry-readiness-project-'));
  writeRegions(project, [{ id: 'docs', knowledge: '# Docs\n\nPRIVATE_CORPUS\n' }]);
  config.projects.P = { id: 'P', path: project };
  return config;
}
const local = { environment: { OPENAI_API_KEY: 'PRIVATE_KEY' }, which: () => '/controlled/cli' };
test('readiness resolves effective experts without dispatch, loading corpus or exposing secrets', async () => {
  const config = team(),
    before = JSON.stringify(config);
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      () => {
        throw Error('No network allowed');
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    const report = await inspectReadiness(config, local);
    expect(report.configurationReady).toBe(true);
    expect(report.liveAccess).toBe('unverified');
    expect(report.profiles).toContainEqual(
      expect.objectContaining({
        scope: 'P',
        agentId: 'docs',
        role: 'domain-advising',
        domain: 'docs',
      }),
    );
    expect(report.chorus?.find((c) => c.scope === 'P')).toMatchObject({
      on: true,
      regions: [{ id: 'docs' }],
    });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_');
    expect(JSON.stringify(config)).toBe(before);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
test('readiness refuses a hand-named Warden in settings and catches unavailable providers', async () => {
  const config = team();
  config.projects.P!.agents = {
    expert: {
      id: 'expert',
      kind: 'domain-librarian',
      flowRole: 'domain-advising',
      domain: 'docs',
      prompt: 'PRIVATE_EXPERT',
      visibleLayers: [],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
  };
  let report = await inspectReadiness(config, local);
  expect(report.configurationReady).toBe(false);
  // Settings declare no Wardens: the settings are refused outright.
  expect(report.issues.some((item) => item.code === 'invalid-configuration')).toBe(true);
  delete config.projects.P!.agents;
  config.agents.worker!.provider = 'anthropic';
  report = await inspectReadiness(config, {
    ...local,
    environment: { ...local.environment, ANTHROPIC_API_KEY: 'PRIVATE_SECOND' },
  });
  expect(report.issues.some((item) => item.code === 'provider-not-constructed')).toBe(true);
});
test('readiness distinguishes missing native binaries and API credentials', async () => {
  const config = team();
  // An API-key profile beside the native default: one of each is missing.
  config.agents.worker!.provider = 'openai';
  config.agents.worker!.model = 'configured-model';
  const report = await inspectReadiness(config, { environment: {}, which: () => null });
  expect(report.configurationReady).toBe(false);
  expect(report.issues.some((item) => item.code === 'native-cli-missing')).toBe(true);
  expect(report.issues.some((item) => item.code === 'provider-credential-missing')).toBe(true);
  expect(report.issues.some((item) => item.code === 'provider-not-constructed')).toBe(false);
});
test('readiness reports each enabled native CLI it found, and says how to fix one it did not', async () => {
  const config = defaultConfig();
  const report = await inspectReadiness(config, {
    environment: {},
    which: (cli) => (cli === 'claude' ? '/controlled/claude' : null),
  });
  expect(report.nativeClis).toEqual([
    { cli: 'claude', provider: 'claude-code', used: true, binary: '/controlled/claude' },
    { cli: 'codex', provider: 'codex', used: false, binary: null },
  ]);
  expect(report.issues.filter((item) => item.code === 'native-cli-missing')).toEqual([
    {
      severity: 'warning',
      scope: 'global',
      code: 'native-cli-missing',
      message:
        'Codex is enabled but no codex CLI was found on PATH or in an app bundle; install Codex or disable it.',
    },
  ]);

  config.defaults = { ...config.defaults, provider: 'codex', model: 'gpt-5.6-luna' };
  const main = await inspectReadiness(config, { environment: {}, which: () => null });
  expect(
    main.issues.filter((item) => item.code === 'native-cli-missing').map((i) => i.severity),
  ).toEqual(['error', 'error']);
  expect(main.configurationReady).toBe(false);
});
test('Kingdom inspection enforces the same private-file schema as launch and never claims live access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foundry-readiness-'));
  try {
    const file = join(directory, 'signet.json'),
      secret = `kingdom_${'a'.repeat(43)}`;
    const signet = {
      url: 'http://127.0.0.1:1',
      signetId: crypto.randomUUID(),
      enrollmentId: crypto.randomUUID(),
      lifecycle: 'ongoing',
      taskId: null,
      keyFile: join(directory, 'installation-key.json'),
      renewalCredential: `signet_renew_${'r'.repeat(43)}`,
      accessToken: secret,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      renewalExpiresAt: new Date(Date.now() + 60000).toISOString(),
      idleExpiresAt: new Date(Date.now() + 60000).toISOString(),
      tokenType: 'DPoP',
    };
    const config = team(),
      id = `User:${crypto.randomUUID()}::`;
    config.kingdomInference = [
      {
        id,
        url: 'http://127.0.0.1:1',
        credentialFile: file,
        selection: { model: 'exact-model', effort: 'low' },
      },
    ];
    config.defaults.kingdomOwnerKey = id;
    config.apiTokens = true;
    await writeFile(file, JSON.stringify(signet), { mode: 0o600 });
    const before = await readFile(file, 'utf8'),
      inventory = await readdir(directory);
    const report = await inspectReadiness(config, local);
    expect(report.configurationReady).toBe(true);
    expect(report.issues.some((item) => item.code === 'kingdom-access-unverified')).toBe(true);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(directory)).toEqual(inventory);
    await writeFile(file, JSON.stringify({ ...signet, unexpected: true }));
    expect((await inspectReadiness(config, local)).configurationReady).toBe(false);
    config.projects.P!.defaults = { kingdomOwnerKey: `Organization::${crypto.randomUUID()}:` };
    expect(
      (await inspectReadiness(config, local)).issues.some(
        (item) => item.code === 'project-authentication-override',
      ),
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('doctor handles missing settings without creating a directory or starting services', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foundry-doctor-'));
  try {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, '../src/doctor.ts'), join(directory, 'absent')],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).issues[0].code).toBe('settings-unavailable');
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('readiness refuses wrong-runtime sources and missing or non-executable helpers without invoking them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foundry-helper-check-'));
  try {
    const config = team(),
      sourceId = crypto.randomUUID(),
      helper = join(directory, 'helper');
    config.nativeAuthentication = [
      {
        id: sourceId,
        integrationId: crypto.randomUUID(),
        runtime: 'codex',
        mode: 'gateway',
        baseUrl: 'http://127.0.0.1:1',
        credential: { type: 'command', command: helper },
      },
    ];
    config.defaults.nativeAuthenticationId = sourceId;
    config.apiTokens = true;
    const missing = await inspectReadiness(config, local);
    expect(missing.issues.some((item) => item.code === 'native-runtime-mismatch')).toBe(true);
    expect(missing.issues.some((item) => item.code === 'gateway-helper-unavailable')).toBe(true);
    config.nativeAuthentication[0]!.runtime = 'claude';
    await writeFile(helper, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
    expect((await inspectReadiness(config, local)).configurationReady).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keyless providers read as ready: a local Ollama has no credential to be missing', async () => {
  const config = defaultConfig();
  // A local API provider is the apiTokens path. Main threads run on the five labs, so Ollama decides.
  config.apiTokens = true;
  config.defaults = {
    provider: 'meta',
    model: 'muse-spark-1.3',
    classifierProvider: 'ollama',
    classifierModel: 'llama3.2:3b',
  };
  const report = await inspectReadiness(config, {
    environment: { MODEL_API_KEY: 'synthetic' },
    which: () => null,
  });
  expect(report.issues.some((item) => item.code === 'provider-credential-missing')).toBe(false);
  // Claude Code and Codex are enabled but launch nothing here: their missing CLIs are warnings.
  expect(
    report.issues.filter((item) => item.code === 'native-cli-missing').map((i) => i.severity),
  ).toEqual(['warning', 'warning']);
  expect(report.issues.some((item) => item.severity === 'error')).toBe(false);

  config.defaults = { provider: 'claude-code', model: 'fable' };
  const subscription = await inspectReadiness(config, {
    environment: {},
    which: () => '/controlled/cli',
  });
  expect(subscription.issues.some((item) => item.code === 'provider-credential-missing')).toBe(
    false,
  );

  config.defaults = {
    provider: 'openai',
    model: 'gpt-5.6-luna',
    classifierProvider: 'openai',
    classifierModel: 'gpt-5.6-luna',
  };
  const keyed = await inspectReadiness(config, { environment: {}, which: () => '/controlled/cli' });
  expect(keyed.issues.some((item) => item.code === 'provider-credential-missing')).toBe(true);
});

test('a native profile on API tokens needs the configured decision provider key, not an OpenAI one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foundry-native-profile-'));
  try {
    const config = defaultConfig(),
      sourceId = crypto.randomUUID();
    config.apiTokens = true;
    config.defaults = { provider: 'claude-code', model: 'fable' };
    config.nativeAuthentication = [
      {
        id: sourceId,
        integrationId: crypto.randomUUID(),
        runtime: 'claude',
        mode: 'native-profile',
        profileDirectory: directory,
      },
    ];
    config.defaults.nativeAuthenticationId = sourceId;
    const codes = async (environment: Record<string, string>) =>
      (await inspectReadiness(config, { environment, which: () => '/controlled/cli' })).issues.map(
        (item) => item.code,
      );
    expect(await codes({ OPENAI_API_KEY: 'synthetic' })).toContain(
      'native-profile-decision-provider',
    );
    expect(await codes({ ANTHROPIC_API_KEY: 'synthetic' })).not.toContain(
      'native-profile-decision-provider',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
