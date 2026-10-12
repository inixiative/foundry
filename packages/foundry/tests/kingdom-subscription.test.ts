import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { kingdomInstallationPaths } from '../src/providers/kingdom-installation-connection';
import {
  KingdomSubscriptionAuthentication,
  limitReading,
  ProjectCapacityAuthentication,
} from '../src/providers/kingdom-subscription-authentication';
import {
  kingdomLogin,
  maskedOutput,
  selectOwner,
  setProjectCapacity,
} from '../src/providers/kingdom-subscription-login';
import { subscriptionStatus } from '../src/providers/native-text-provider';
import { ConfigStore, starterConfig } from '../src/viewer/config';
import { heldSignet, mockKingdom, ownerOf } from './helpers/kingdom-installation';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const temporary = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foundry-subscription-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

const setupToken = `sk-ant-oat01-${'a'.repeat(40)}`;

async function kingdomWithLogin(runtime: 'claude' | 'codex') {
  const directory = await temporary();
  const owner = `OrganizationUser:${crypto.randomUUID()}:${crypto.randomUUID()}:`;
  const bindingId = crypto.randomUUID(),
    loginId = crypto.randomUUID(),
    capacityId = crypto.randomUUID();
  const calls: { action: string; body: Record<string, unknown> }[] = [];
  const kingdom = mockKingdom({
    onSignet: (action, body, presented) => {
      calls.push({ action, body });
      if (action === 'resolveRun')
        return {
          id: bindingId,
          owner: presented.owner,
          signetEnrollmentId: presented.enrollmentId,
          runId: body.runId,
          integrationId: loginId,
          capacityId,
          model: body.selection.model,
          effort: body.selection.effort,
          runtime,
          authentication: 'subscription',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          gatewayPath: '/api/v1/access/releaseSubscription',
        };
      if (action === 'releaseSubscription')
        return {
          bindingId,
          integrationId: loginId,
          capacityId,
          executionId: crypto.randomUUID(),
          runtime,
          accessToken: runtime === 'claude' ? setupToken : 'chatgpt-access-token',
          idToken: runtime === 'codex' ? 'chatgpt-id-token' : null,
          accountId: runtime === 'codex' ? 'account-1' : null,
          expiresAt: null,
        };
      return { capacityId };
    },
  });
  cleanups.push(async () => kingdom.stop());
  const { credentialFile, keyFile, integrationId } = await heldSignet(kingdom, directory, owner);
  const projectId = crypto.randomUUID();
  const auth = new KingdomSubscriptionAuthentication({
    directory: join(directory, 'subscriptions'),
    capacity: async () => ({
      url: kingdom.url,
      credentialFile,
      projectId,
      model: 'claude-opus-5-5',
      effort: 'high',
    }),
  });
  return {
    directory,
    auth,
    calls,
    loginId,
    projectId,
    bindingId,
    kingdom,
    owner,
    keyFile,
    integrationId,
  };
}

test('a Kingdom-capacity Claude thread runs on the released login, in memory, in one config dir per integration', async () => {
  const { directory, auth, calls, loginId, projectId } = await kingdomWithLogin('claude');
  const launch = await auth.prepare('thread-1', 'claude');
  expect(calls.map((call) => call.action)).toEqual(['resolveRun', 'releaseSubscription']);
  expect(calls[0]!.body.selection).toEqual({
    model: 'claude-opus-5-5',
    effort: 'high',
    authentication: 'subscription',
    runtime: 'claude',
    projectId,
  });
  expect(launch.bindingId).toBe(`thread-1:kingdom:${loginId}`);
  expect(launch.model).toBeUndefined();
  const child = launch.launch(['claude', '-p'], {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'inherited-api-key',
    CLAUDE_CODE_OAUTH_TOKEN: 'inherited-token',
    CLAUDE_CONFIG_DIR: '/somewhere/else',
  });
  expect(child.env).toMatchObject({
    PATH: '/usr/bin',
    CLAUDE_CONFIG_DIR: join(directory, 'subscriptions', loginId, 'claude'),
    CLAUDE_CODE_OAUTH_TOKEN: setupToken,
  });
  expect(child.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(child.argv).toEqual(['claude', '-p', '--setting-sources', '']);
  expect(() => launch.launch(['claude'], {})).toThrow('already owns a process');
  for (const file of await readdir(directory, { recursive: true })) {
    const path = join(directory, String(file));
    if (!String(file).endsWith('.json')) continue;
    expect(await readFile(path, 'utf8')).not.toContain(setupToken);
  }
  launch.release();
  expect(() => launch.check()).toThrow('released');

  const again = await auth.prepare('thread-1', 'claude');
  expect(calls.map((call) => call.action)).toEqual([
    'resolveRun',
    'releaseSubscription',
    'releaseSubscription',
  ]);
  expect(() => again.launch(['claude', '--settings', '{}'], {})).toThrow('override refused');
});

test('limit readings from the native session go back to Kingdom for the run', async () => {
  const { auth, calls, bindingId } = await kingdomWithLogin('claude');
  const launch = await auth.prepare('thread-1', 'claude');
  const resetsAt = Date.now() + 3_600_000;
  launch.observeLimits?.({
    runtime: 'claude',
    source: 'stream',
    observedAt: Date.now(),
    blocked: true,
    windows: [
      { id: 'five_hour', usedPercent: 100, resetsAt },
      { id: 'seven_day', usedPercent: 40 },
    ],
  });
  const deadline = Date.now() + 5000;
  while (!calls.some((call) => call.action === 'reportSubscriptionLimits')) {
    if (Date.now() > deadline) throw Error('limits were not reported');
    await Bun.sleep(10);
  }
  const report = calls.find((call) => call.action === 'reportSubscriptionLimits')!.body;
  expect(report.bindingId).toBe(bindingId);
  expect(report.reading).toMatchObject({
    rateLimited: true,
    windows: [
      { id: 'five_hour', usedPercent: 100, resetsAt },
      { id: 'seven_day', usedPercent: 40, resetsAt: null },
    ],
  });
  expect(limitReading({ runtime: 'claude', source: 'poll', observedAt: 0, windows: [] })).toEqual({
    rateLimited: false,
    retryAfterMs: null,
    windows: [],
  });
});

test('a Kingdom-capacity Codex thread gets the access token without the refresh token, removed on release', async () => {
  const { directory, auth, loginId } = await kingdomWithLogin('codex');
  const launch = await auth.prepare('thread-1', 'codex');
  const child = launch.launch(['codex', 'app-server'], { OPENAI_API_KEY: 'inherited' });
  const home = join(directory, 'subscriptions', loginId, 'codex');
  expect(child.env.CODEX_HOME).toBe(home);
  expect(child.env.OPENAI_API_KEY).toBeUndefined();
  const login = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
  expect(login.tokens).toEqual({
    id_token: 'chatgpt-id-token',
    access_token: 'chatgpt-access-token',
    refresh_token: '',
    account_id: 'account-1',
  });
  expect(() => launch.launch(['codex', '-c', 'model_provider="x"'], {})).toThrow();
  launch.release();
  expect(existsSync(join(home, 'auth.json'))).toBe(false);
});

test('threads of a kingdom project route to Kingdom; every other thread keeps the local login', async () => {
  const { auth, calls } = await kingdomWithLogin('claude');
  const routed = new ProjectCapacityAuthentication({
    kingdom: auth,
    usesKingdom: (threadId) => threadId.startsWith('kingdom-'),
  });
  const local = await routed.prepare('local-thread', 'claude');
  expect(local.bindingId).toBe('local-thread');
  expect(local.launch(['claude'], { CLAUDE_CONFIG_DIR: '/mine' }).env.CLAUDE_CONFIG_DIR).toBe(
    '/mine',
  );
  expect(calls).toHaveLength(0);
  expect(await routed.resolveBindingId('kingdom-thread', 'claude')).toContain(':kingdom:');
  expect((await routed.prepare('kingdom-thread', 'claude')).mode).toBe('kingdom-subscription');
});

test('kingdom login hands the native login to the chosen owner and leaves nothing on disk', async () => {
  const { directory, kingdom, owner, keyFile, integrationId } = await kingdomWithLogin('claude');
  const configDir = join(directory, 'config');
  const store = new ConfigStore(configDir);
  const config = starterConfig('claude-code', 'fable');
  const { keyFile: installationKey } = kingdomInstallationPaths(configDir, kingdom.url);
  await mkdir(dirname(installationKey), { recursive: true, mode: 0o700 });
  await copyFile(keyFile, installationKey);
  await chmod(installationKey, 0o600);
  config.kingdomIntegrations = [
    { url: kingdom.url, integrationId, owner, signetId: crypto.randomUUID() },
  ];
  await store.save(config);
  let loginDirectory = '';
  const stored = await kingdomLogin({
    configDir,
    runtime: 'codex',
    store,
    owner: ownerOf(owner).organizationId!,
    login: async (_runtime, temporaryDirectory) => {
      loginDirectory = temporaryDirectory;
      return { accessToken: 'access', refreshToken: 'refresh', idToken: 'id' };
    },
  });
  expect(stored.status).toBe('stored');
  expect(kingdom.logins).toEqual([
    {
      integrationId,
      runtime: 'codex',
      accessToken: 'access',
      refreshToken: 'refresh',
      idToken: 'id',
    },
  ]);
  expect(existsSync(loginDirectory)).toBe(false);
  expect(() => selectOwner(config.kingdomIntegrations, crypto.randomUUID())).toThrow(
    'No paired Kingdom owner',
  );
});

test('a project switches between local and Kingdom capacity, and Kingdom capacity must name its Signet', async () => {
  const { directory, kingdom, owner, integrationId } = await kingdomWithLogin('claude');
  const store = new ConfigStore(join(directory, 'config'));
  const config = starterConfig('claude-code', 'fable');
  config.kingdomIntegrations = [
    { url: kingdom.url, integrationId, owner, signetId: crypto.randomUUID() },
  ];
  const projectId = crypto.randomUUID();
  config.projects = { [projectId]: { id: projectId, path: directory } };
  await store.save(config);
  const signetId = crypto.randomUUID();
  const updated = await setProjectCapacity(store, projectId, {
    source: 'kingdom',
    kingdom: kingdom.url,
    signetId,
  });
  expect(updated.projects[projectId]).toMatchObject({
    capacity: 'kingdom',
    kingdomCapacity: { kingdom: kingdom.url, signetId },
  });
  await expect(
    setProjectCapacity(store, projectId, {
      source: 'kingdom',
      kingdom: 'https://elsewhere.example',
      signetId,
    }),
  ).rejects.toThrow();
  const local = await setProjectCapacity(store, projectId, { source: 'local' });
  expect(local.projects[projectId]!.capacity).toBe('local');
  expect(local.projects[projectId]!.kingdomCapacity).toBeUndefined();
});

test('a setup-token login passes the subscription status check; an API key does not', async () => {
  const status = (authMethod: string) => ({
    exited: Promise.resolve(0),
    stdout: new Response(JSON.stringify({ loggedIn: true, authMethod })).body!,
    stderr: new Response('').body!,
    kill() {},
  });
  expect(await subscriptionStatus(status('oauth_token'))).toBe(true);
  expect(await subscriptionStatus(status('claude.ai'))).toBe(true);
  expect(await subscriptionStatus(status('api_key'))).toBe(false);
});

test('the setup-token Claude prints is captured but never echoed, even split by terminal codes', async () => {
  const written: string[] = [];
  const raw = `Visit the link\r\nYour token: ${setupToken.slice(0, 20)}\x1b[1m${setupToken.slice(20)}\x1b[0m\r\nDone`;
  const captured = await maskedOutput(new Response(raw).body!, (text) => written.push(text));
  expect(captured).toBe(setupToken);
  expect(written.join('')).not.toContain(setupToken.slice(14));
  expect(written.join('')).toContain('[token captured]');
});
