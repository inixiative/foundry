import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { kingdomLimitReadingSchema } from '../src/providers/kingdom-client';
import { kingdomInstallationPaths } from '../src/providers/kingdom-installation-connection';
import {
  KingdomSubscriptionAuthentication,
  limitReading,
  ProjectCapacityAuthentication,
  projectCapacity,
} from '../src/providers/kingdom-subscription-authentication';
import {
  kingdomLogin,
  maskedOutput,
  museDeviceLogin,
  selectOwner,
  setKingdomProject,
  setProjectCapacity,
} from '../src/providers/kingdom-subscription-login';
import { subscriptionStatus } from '../src/providers/native-text-provider';
import { ConfigStore, capacityKingdomProject, starterConfig } from '../src/viewer/config';
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
/** An opaque Muse bearer, as Meta's device sign-in returns it (no refresh token, no expiry). */
const museToken = `muse-${'m'.repeat(40)}`;

async function kingdomWithLogin(
  runtime: 'claude' | 'codex' | 'muse',
  userClaudeDirectory?: string,
  userCodexDirectory?: string,
  muse: {
    userConfigDirectory?: string;
    museStatus?: ConstructorParameters<typeof KingdomSubscriptionAuthentication>[0]['museStatus'];
    warn?: (message: string) => void;
  } = {},
) {
  const directory = await temporary();
  const owner = `OrganizationUser:${crypto.randomUUID()}:${crypto.randomUUID()}:`;
  const bindingId = crypto.randomUUID(),
    loginId = crypto.randomUUID(),
    capacityId = crypto.randomUUID();
  const calls: { action: string; body: Record<string, unknown> }[] = [];
  const executionIds: string[] = [];
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
      if (action === 'releaseSubscription') {
        const executionId = crypto.randomUUID();
        executionIds.push(executionId);
        return {
          bindingId,
          integrationId: loginId,
          capacityId,
          executionId,
          runtime,
          accessToken:
            runtime === 'claude'
              ? setupToken
              : runtime === 'codex'
                ? 'chatgpt-access-token'
                : museToken,
          idToken: runtime === 'codex' ? 'chatgpt-id-token' : null,
          accountId: runtime === 'codex' ? 'account-1' : null,
          expiresAt: null,
          credentialVersion: 3,
        };
      }
      if (action === 'reportCredentialRejected') return { integrationId: loginId, recorded: true };
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
    ...(userClaudeDirectory ? { userClaudeDirectory } : {}),
    ...(userCodexDirectory ? { userCodexDirectory } : {}),
    ...muse,
  });
  return {
    executionIds,
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

test('a pool main thread loads the user’s own setup into the login’s home, under the guard', async () => {
  const user = await mkdtemp(join(tmpdir(), 'kingdom-user-claude-'));
  cleanups.push(() => rm(user, { recursive: true, force: true }));
  await mkdir(join(user, 'commands'));
  await Bun.write(
    join(user, 'settings.json'),
    JSON.stringify({ apiKeyHelper: 'echo paid', env: { AWS_PROFILE: 'p' } }),
  );
  const { directory, auth, loginId } = await kingdomWithLogin('claude', user);
  const home = join(directory, 'subscriptions', loginId, 'claude');
  const launch = await auth.prepare('thread-1', 'claude');
  const child = launch.launch(['claude', '-p'], {}, { sources: 'user', cwd: directory });
  expect(child.argv.slice(0, 4)).toEqual(['claude', '-p', '--setting-sources', 'user']);
  expect(child.argv[4]).toBe('--settings');
  const guard = JSON.parse(child.argv[5]!);
  expect(guard.apiKeyHelper).toBe('');
  expect(guard.env.AWS_PROFILE).toBe('');
  expect(child.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(setupToken);
  expect(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')).apiKeyHelper).toBe(
    'echo paid',
  );
  expect(existsSync(join(home, 'commands'))).toBe(true);
  launch.release();
});

test('a pool Codex main thread runs on its own home with the user’s allowlisted setup', async () => {
  const user = await mkdtemp(join(tmpdir(), 'kingdom-user-codex-'));
  cleanups.push(() => rm(user, { recursive: true, force: true }));
  await mkdir(join(user, 'skills'));
  await Bun.write(
    join(user, 'config.toml'),
    'model_provider = "evil"\n[mcp_servers.repl]\ncommand = "/bin/repl"\n',
  );
  const { directory, auth, loginId } = await kingdomWithLogin('codex', undefined, user);
  const main = await auth.prepare('thread-1', 'codex');
  const child = main.launch(['codex', 'app-server'], {}, { sources: 'user', cwd: directory });
  const home = join(directory, 'subscriptions', loginId, 'codex-user');
  expect(child.env.CODEX_HOME).toBe(home);
  const config = await readFile(join(home, 'config.toml'), 'utf8');
  expect(config).toContain('cli_auth_credentials_store = "file"');
  expect(config).toContain('mcp_servers');
  expect(config).not.toContain('evil');
  expect(existsSync(join(home, 'skills'))).toBe(true);
  expect(existsSync(join(home, 'auth.json'))).toBe(true);
  main.release();
  // The last holder takes the login's tokens with it.
  expect(existsSync(join(home, 'auth.json'))).toBe(false);
  const plain = await auth.prepare('thread-2', 'codex');
  expect(plain.launch(['codex', 'app-server'], {}).env.CODEX_HOME).toBe(
    join(directory, 'subscriptions', loginId, 'codex'),
  );
  plain.release();
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

test("a Kingdom project's Codex thread whose pool has no Codex login is refused with Kingdom's reason, never run locally", async () => {
  const directory = await temporary();
  const owner = `OrganizationUser:${crypto.randomUUID()}:${crypto.randomUUID()}:`;
  const asked: Array<{ runtime: string; model: string }> = [];
  // The pool holds only a Claude login: Kingdom refuses a Codex run.
  const kingdom = mockKingdom({
    onSignet: (action, body) => {
      if (action === 'resolveRun')
        asked.push({ runtime: body.selection.runtime, model: body.selection.model });
      return Response.json({ error: 'No authorized capacity matches' }, { status: 409 });
    },
  });
  cleanups.push(async () => kingdom.stop());
  const { credentialFile, signetId } = await heldSignet(kingdom, directory, owner);
  const config = starterConfig('claude-code', 'fable');
  config.kingdomIntegrations = [
    { url: kingdom.url, owner, integrationId: crypto.randomUUID(), signetId },
  ];
  config.projects = {
    pooled: {
      id: 'pooled',
      path: directory,
      tags: [],
      capacity: 'kingdom',
      kingdomCapacity: { kingdom: kingdom.url, signetId },
    },
  };
  let local = 0;
  // The daemon's wiring: one capacity router for every worker, the thread's own model.
  const route = projectCapacity({
    foundryDir: directory,
    config: () => config,
    meta: (threadId) =>
      threadId === 'codex-thread' ? { projectId: 'pooled', worker: 'codex' } : undefined,
    credentialFile: async () => credentialFile,
  });
  const routed = route({
    bindingId: (threadId) => threadId,
    prepare: async () => {
      local++;
      throw Error('the local login must not be used');
    },
  });
  await expect(routed.prepare('codex-thread', 'codex')).rejects.toThrow(
    'No authorized capacity matches',
  );
  expect(asked).toEqual([{ runtime: 'codex', model: 'gpt-6-astra' }]);
  expect(local).toBe(0);
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

test('a Foundry project links to one Kingdom project; a Kingdom-capacity login bills it on the same Kingdom', async () => {
  const { directory, kingdom, owner, integrationId } = await kingdomWithLogin('claude');
  const store = new ConfigStore(join(directory, 'config'));
  const config = starterConfig('claude-code', 'fable');
  config.kingdomIntegrations = [
    { url: kingdom.url, integrationId, owner, signetId: crypto.randomUUID() },
  ];
  const projectId = crypto.randomUUID();
  config.projects = { [projectId]: { id: projectId, path: directory } };
  await store.save(config);
  const kingdomProjectId = crypto.randomUUID();
  await setProjectCapacity(store, projectId, {
    source: 'kingdom',
    kingdom: kingdom.url,
    signetId: crypto.randomUUID(),
  });
  const linked = await setKingdomProject(store, projectId, {
    kingdom: kingdom.url,
    projectId: kingdomProjectId,
  });
  expect(linked.projects[projectId]!.kingdomProject).toEqual({
    kingdom: kingdom.url,
    projectId: kingdomProjectId,
  });
  expect(capacityKingdomProject(linked, linked.projects[projectId]!)).toBe(kingdomProjectId);
  // The old place for it is refused by name, with the fix.
  await expect(
    store.update((draft) => {
      (draft.projects[projectId]!.kingdomCapacity as unknown as Record<string, unknown>).projectId =
        kingdomProjectId;
    }),
  ).rejects.toThrow('kingdomCapacity.projectId is gone');
  await expect(
    setKingdomProject(store, projectId, {
      kingdom: 'https://elsewhere.example',
      projectId: kingdomProjectId,
    }),
  ).rejects.toThrow();
  const unlinked = await setKingdomProject(store, projectId, null);
  expect(unlinked.projects[projectId]!.kingdomProject).toBeUndefined();
  expect(capacityKingdomProject(unlinked, unlinked.projects[projectId]!)).toBeUndefined();
});

/** The user's own config home: git config, a gh login, and their Muse login and settings. */
async function userConfigHome() {
  const home = await temporary();
  await mkdir(join(home, 'git'));
  await Bun.write(join(home, 'git', 'config'), '[user]\n\tname = me\n');
  await mkdir(join(home, 'muse'), { recursive: true });
  await Bun.write(join(home, 'muse', 'auth.json'), '{"the":"user’s own login"}');
  await Bun.write(join(home, 'muse', 'settings.json'), '{"schema_version":1}');
  await Bun.write(join(home, 'muse', 'trust.json'), '{"trusted":[]}');
  await Bun.write(join(home, 'muse', '.auth.json.lock'), '');
  await mkdir(join(home, 'muse', 'skills'));
  return home;
}

/** `muse usage --json` exiting `code` with `stderr`. */
const museUsage = (code: number, stderr: string, seen?: Record<string, string | undefined>[]) =>
  ((environment: Record<string, string | undefined>) => {
    seen?.push(environment);
    return {
      stdout: new Response('').body!,
      stderr: new Response(stderr).body!,
      exited: Promise.resolve(code),
      kill() {},
    };
  }) as unknown as ConstructorParameters<typeof KingdomSubscriptionAuthentication>[0]['museStatus'];

test('a Kingdom-capacity Muse thread runs on its own config home: the released login, the user’s config linked in', async () => {
  const user = await userConfigHome();
  const { directory, auth, loginId, calls } = await kingdomWithLogin('muse', undefined, undefined, {
    userConfigDirectory: user,
  });
  const launch = await auth.prepare('thread-1', 'muse');
  expect(calls[0]!.body.selection).toMatchObject({ runtime: 'muse' });
  const child = launch.launch(['muse', 'serve'], {
    PATH: '/usr/bin',
    META_API_KEY: 'metered',
    XDG_CONFIG_HOME: '/somewhere/else',
    XDG_DATA_HOME: '/my/data',
  });
  const home = join(directory, 'subscriptions', loginId, 'muse', 'muse-config');
  expect(child.argv).toEqual(['muse', 'serve']);
  expect(child.env).toMatchObject({
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: '/my/data',
    MUSE_NO_AUTO_UPDATE: '1',
  });
  expect(child.env.META_API_KEY).toBeUndefined();
  const login = join(home, 'muse', 'auth.json');
  expect(JSON.parse(await readFile(login, 'utf8'))).toEqual({
    schema_version: 1,
    providers: {
      meta: {
        mechanism: 'oauth',
        storage: 'file',
        obtained_via: 'device_code',
        api_base_url: 'https://api.meta.ai/v1',
        access_token: museToken,
      },
    },
  });
  expect((await stat(login)).mode & 0o777).toBe(0o600);
  // The user's other config is reached by link; their Muse settings by private copy; their login never.
  expect(await readlink(join(home, 'git'))).toBe(join(user, 'git'));
  expect(await readFile(join(home, 'git', 'config'), 'utf8')).toContain('name = me');
  expect((await lstat(join(home, 'muse', 'settings.json'))).isSymbolicLink()).toBe(false);
  expect(await readFile(join(home, 'muse', 'settings.json'), 'utf8')).toBe('{"schema_version":1}');
  expect(await readlink(join(home, 'muse', 'skills'))).toBe(join(user, 'muse', 'skills'));
  // A file Muse writes is a private copy, never a link into the user's own.
  expect((await lstat(join(home, 'muse', 'trust.json'))).isSymbolicLink()).toBe(false);
  expect(await readFile(join(home, 'muse', 'trust.json'), 'utf8')).toBe('{"trusted":[]}');
  expect(existsSync(join(home, 'muse', '.auth.json.lock'))).toBe(false);
  expect(await readFile(join(user, 'muse', 'auth.json'), 'utf8')).toBe(
    '{"the":"user’s own login"}',
  );
  // The CLI adds its subscription key to the file; a second holder on the same token keeps it.
  await Bun.write(
    login,
    JSON.stringify({
      ...JSON.parse(await readFile(login, 'utf8')),
      providers: {
        meta: { ...JSON.parse(await readFile(login, 'utf8')).providers.meta, api_key: 'k' },
      },
    }),
  );
  await chmod(login, 0o600);
  const second = await auth.prepare('thread-2', 'muse');
  second.launch(['muse', 'serve'], {});
  expect(JSON.parse(await readFile(login, 'utf8')).providers.meta.api_key).toBe('k');
  // An entry the user removed loses its link at the next launch.
  await rm(join(user, 'git'), { recursive: true });
  launch.release();
  expect(existsSync(login)).toBe(true);
  second.release();
  expect(existsSync(login)).toBe(false);
  const third = await auth.prepare('thread-3', 'muse');
  third.launch(['muse', 'serve'], {});
  expect(existsSync(join(home, 'git'))).toBe(false);
  third.release();
});

test('a rejected Muse login is confirmed with `muse usage` in its own home, then reported once', async () => {
  const user = await userConfigHome();
  const seen: Record<string, string | undefined>[] = [];
  const warnings: string[] = [];
  const { directory, auth, calls, executionIds, loginId } = await kingdomWithLogin(
    'muse',
    undefined,
    undefined,
    {
      userConfigDirectory: user,
      museStatus: museUsage(1, 'muse usage: usage refresh failed (credential_rejected)\n', seen),
      warn: (message) => warnings.push(message),
    },
  );
  const launch = await auth.prepare('thread-1', 'muse');
  launch.launch(['muse', 'serve'], {});
  const home = join(directory, 'subscriptions', loginId, 'muse', 'muse-config');
  // Another thread now runs on a newer token in the shared home: the check must not rewrite it.
  const shared = join(home, 'muse', 'auth.json');
  const newer = (await readFile(shared, 'utf8')).replace(museToken, 'newer-token');
  await Bun.write(shared, newer);
  expect(await launch.loginFailed?.()).toBe(true);
  expect(await launch.loginFailed?.()).toBe(true);
  expect(await readFile(shared, 'utf8')).toBe(newer);
  expect(seen).toHaveLength(1);
  // Checked in a throwaway config home beside the login's, removed afterwards.
  const checked = seen[0]!.XDG_CONFIG_HOME!;
  expect(checked.startsWith(join(directory, 'subscriptions', loginId, 'muse', 'check-'))).toBe(
    true,
  );
  expect(existsSync(checked)).toBe(false);
  expect(seen[0]!.MUSE_NO_AUTO_UPDATE).toBe('1');
  const reports = calls.filter((call) => call.action === 'reportCredentialRejected');
  expect(reports.map((call) => call.body)).toEqual([
    { executionId: executionIds[0], credentialVersion: 3 },
  ]);
  expect(warnings.join('\n')).toContain('bun run kingdom login muse');
  expect(warnings.join('\n')).not.toContain(museToken);
  // The next launch resolves again, so Kingdom can choose another login in the pool.
  launch.release();
  await auth.prepare('thread-1', 'muse');
  expect(calls.filter((call) => call.action === 'resolveRun')).toHaveLength(2);
});

test('a Muse failure that is not a rejected login is never reported, and is not re-checked at once', async () => {
  const user = await userConfigHome();
  const seen: Record<string, string | undefined>[] = [];
  const { auth, calls, directory, loginId } = await kingdomWithLogin('muse', undefined, undefined, {
    userConfigDirectory: user,
    museStatus: museUsage(1, 'muse usage: network unreachable\n', seen),
  });
  const launch = await auth.prepare('thread-1', 'muse');
  // Checked even for a launch that never ran: the check has its own config home.
  expect(await launch.loginFailed?.()).toBe(false);
  expect(await launch.loginFailed?.()).toBe(false);
  expect(seen).toHaveLength(1);
  expect(calls.some((call) => call.action === 'reportCredentialRejected')).toBe(false);
  expect(
    existsSync(
      join(directory, 'subscriptions', loginId, 'muse', 'muse-config', 'muse', 'auth.json'),
    ),
  ).toBe(false);
});

test('a Muse pool with no login left says which login Meta rejected', async () => {
  const directory = await temporary();
  const user = await userConfigHome();
  const owner = `User:${crypto.randomUUID()}::`;
  const loginId = crypto.randomUUID();
  let resolves = 0;
  const kingdom = mockKingdom({
    onSignet: (action, body, presented) => {
      if (action === 'resolveRun') {
        if (++resolves > 1)
          return Response.json({ error: 'No authorized capacity matches' }, { status: 409 });
        return {
          id: crypto.randomUUID(),
          owner: presented.owner,
          signetEnrollmentId: presented.enrollmentId,
          runId: body.runId,
          integrationId: loginId,
          capacityId: crypto.randomUUID(),
          model: body.selection.model,
          effort: body.selection.effort,
          runtime: 'muse',
          authentication: 'subscription',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          gatewayPath: '/api/v1/access/releaseSubscription',
        };
      }
      if (action === 'releaseSubscription')
        return {
          bindingId: body.bindingId,
          integrationId: loginId,
          capacityId: crypto.randomUUID(),
          executionId: crypto.randomUUID(),
          runtime: 'muse',
          accessToken: museToken,
          idToken: null,
          accountId: null,
          expiresAt: null,
          credentialVersion: 1,
        };
      return { integrationId: loginId, recorded: true };
    },
  });
  cleanups.push(async () => kingdom.stop());
  const { credentialFile } = await heldSignet(kingdom, directory, owner);
  const auth = new KingdomSubscriptionAuthentication({
    directory: join(directory, 'subscriptions'),
    capacity: async () => ({
      url: kingdom.url,
      credentialFile,
      model: 'muse-wonder-1.0',
      effort: 'default',
    }),
    userConfigDirectory: user,
    museStatus: museUsage(1, 'usage refresh failed (credential_rejected)'),
    warn: () => {},
  });
  const launch = await auth.prepare('thread-1', 'muse');
  await launch.loginFailed?.();
  await expect(auth.prepare('thread-1', 'muse')).rejects.toThrow(
    `No authorized capacity matches. Meta rejected this pool's Muse Code login (${loginId})`,
  );
});

test('a Muse limit reading reaches Kingdom as windows only (its strict reading has no tier or plan)', () => {
  const reading = limitReading({
    runtime: 'muse',
    source: 'stream',
    observedAt: 0,
    blocked: false,
    windows: [
      { id: 'window', usedPercent: 16, resetsAt: 1_000, windowMinutes: 300 },
      { id: 'weekly', usedPercent: 4, windowMinutes: 10_080 },
    ],
    ...({ plan: 'Muse Code Everyday Usage', tier: 2, reachedType: 'quota' } as object),
  } as Parameters<typeof limitReading>[0]);
  expect(kingdomLimitReadingSchema.parse(reading)).toEqual({
    rateLimited: false,
    retryAfterMs: null,
    windows: [
      { id: 'window', usedPercent: 16, resetsAt: 1_000 },
      { id: 'weekly', usedPercent: 4, resetsAt: null },
    ],
  });
});

test('kingdom login muse signs in with Meta’s device flow and hands the token to Kingdom', async () => {
  const { directory, kingdom, owner, keyFile, integrationId } = await kingdomWithLogin('muse');
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
  const stored = await kingdomLogin({
    configDir,
    runtime: 'muse',
    store,
    login: async (runtime) => {
      expect(runtime).toBe('muse');
      return { accessToken: museToken };
    },
  });
  expect(stored.status).toBe('stored');
  expect(kingdom.logins).toEqual([{ integrationId, runtime: 'muse', accessToken: museToken }]);
});

/** Meta's device endpoints, scripted: the start, then each poll's answer in turn. */
function deviceFlow(polls: Array<{ status: number; body: unknown }>, start?: Partial<Response>) {
  const requests: { url: string; form: URLSearchParams; redirect?: RequestInit['redirect'] }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      form: new URLSearchParams(String(init?.body)),
      redirect: init?.redirect,
    });
    if (String(input).endsWith('/oidc/device/authorization/'))
      return start
        ? new Response(null, { status: start.status ?? 500 })
        : Response.json({
            device_code: 'device-1',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://auth.meta.com/device',
            verification_uri_complete: 'http://auth.meta.com/device?code=ABCD-EFGH',
            expires_in: 600,
            interval: 2,
          });
    const next = polls.shift() ?? { status: 400, body: { error: 'expired_token' } };
    return Response.json(next.body, { status: next.status });
  }) as typeof fetch;
  return { fetcher, requests };
}

test('Muse device sign-in: shows the page and code, waits, slows down when asked, and never prints the token', async () => {
  const { fetcher, requests } = deviceFlow([
    { status: 400, body: { error: 'authorization_pending' } },
    { status: 400, body: { error: 'slow_down' } },
    { status: 200, body: { access_token: museToken, token_type: 'Bearer' } },
  ]);
  const written: string[] = [];
  const opened: string[] = [];
  const waits: number[] = [];
  const login = await museDeviceLogin({
    fetch: fetcher,
    write: (text) => written.push(text),
    open: (url) => opened.push(url),
    sleep: async (ms) => waits.push(ms),
    now: () => 0,
  });
  expect(login).toEqual({ accessToken: museToken });
  expect(requests[0]!.url).toBe('https://auth.meta.com/oidc/device/authorization/');
  expect(requests[0]!.form.get('client_id')).toBe('1031625952748946');
  expect(requests[1]!.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
  expect(requests[1]!.form.get('device_code')).toBe('device-1');
  expect(requests.every((request) => request.redirect === 'manual')).toBe(true);
  // The http page is upgraded to https, as the launcher does.
  expect(opened).toEqual(['https://auth.meta.com/device?code=ABCD-EFGH']);
  expect(written.join('')).toContain('ABCD-EFGH');
  expect(written.join('')).not.toContain(museToken);
  expect(waits).toEqual([2000, 2000, 7000]);
});

test('Muse device sign-in fails plainly on denial, expiry, an unstarted flow or a redirect', async () => {
  const quiet = { write: () => {}, open: () => {}, sleep: async () => {}, now: () => 0 };
  await expect(
    museDeviceLogin({
      ...quiet,
      fetch: deviceFlow([{ status: 400, body: { error: 'access_denied' } }]).fetcher,
    }),
  ).rejects.toThrow('was denied');
  await expect(
    museDeviceLogin({
      ...quiet,
      fetch: deviceFlow([{ status: 400, body: { error: 'expired_token' } }]).fetcher,
    }),
  ).rejects.toThrow('expired');
  let clock = 0;
  await expect(
    museDeviceLogin({
      ...quiet,
      now: () => clock,
      sleep: async () => {
        clock += 3_600_000;
      },
      fetch: deviceFlow([]).fetcher,
    }),
  ).rejects.toThrow('expired before it was approved');
  await expect(
    museDeviceLogin({ ...quiet, fetch: deviceFlow([], { status: 404 }).fetcher }),
  ).rejects.toThrow('not available yet');
  await expect(
    museDeviceLogin({ ...quiet, fetch: deviceFlow([], { status: 302 }).fetcher }),
  ).rejects.toThrow('redirected');
});
