import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NativeAuthentication,
  type NativeAuthenticationLaunch,
  type NativeAuthenticationSource,
} from '../src/providers/native-authentication';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'foundry-auth-'));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
const gateway = (
  runtime: 'claude' | 'codex',
  variable = 'FOUNDRY_TEST_AUTH_A',
): NativeAuthenticationSource => ({
  id: crypto.randomUUID(),
  connectionId: crypto.randomUUID(),
  runtime,
  mode: 'gateway',
  baseUrl: 'http://127.0.0.1:34567/v1',
  credential: { type: 'environment', variable },
});
const track = (launch: NativeAuthenticationLaunch) => {
  cleanups.push(() => launch.release());
  return launch;
};
const token = (name: string, value: string) => {
  const previous = process.env[name];
  process.env[name] = value;
  cleanups.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
};

describe('Foundry native authentication', () => {
  test('isolates concurrent gateway profiles and scrubs competing source credentials', async () => {
    const a = gateway('claude'),
      b = gateway('codex', 'FOUNDRY_TEST_AUTH_B');
    const auth = new NativeAuthentication({ directory: root(), sources: [a, b] });
    auth.select('thread-a', a.id);
    auth.select('thread-b', b.id);
    token('FOUNDRY_TEST_AUTH_A', 'synthetic-a');
    token('FOUNDRY_TEST_AUTH_B', 'synthetic-b');
    const [first, second] = (
      await Promise.all([auth.prepare('thread-a', 'claude'), auth.prepare('thread-b', 'codex')])
    ).map(track);
    const inherited = {
      ANTHROPIC_API_KEY: 'wrong',
      CLAUDE_CODE_OAUTH_TOKEN: 'wrong',
      CODEX_HOME: '/wrong',
      OPENAI_API_KEY: 'wrong',
      FOUNDRY_TEST_AUTH_A: 'synthetic-a',
      FOUNDRY_TEST_AUTH_B: 'synthetic-b',
      PATH: '/bin',
    };
    const left = first.launch(['claude'], inherited),
      right = second.launch(['codex', 'mcp-server'], inherited);
    expect(left.env.ANTHROPIC_AUTH_TOKEN).toBe('synthetic-a');
    expect(right.env.FOUNDRY_GATEWAY_TOKEN).toBe('synthetic-b');
    expect(left.env.CLAUDE_CONFIG_DIR).not.toBe(right.env.CODEX_HOME);
    expect(left.env.OPENAI_API_KEY).toBeUndefined();
    expect(right.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(left.env.FOUNDRY_TEST_AUTH_B).toBeUndefined();
    expect(right.env.FOUNDRY_TEST_AUTH_A).toBeUndefined();
    expect(left.argv).toEqual(['claude', '--setting-sources', 'user']);
    expect(JSON.stringify(left.argv)).not.toContain('synthetic-a');
    expect(readFileSync(join(right.env.CODEX_HOME!, 'config.toml'), 'utf8')).not.toContain(
      'synthetic-b',
    );
    expect(readFileSync(join(right.env.CODEX_HOME!, 'config.toml'), 'utf8')).toContain(
      'web_search = "disabled"',
    );
    expect(inherited.CODEX_HOME).toBe('/wrong');
    expect(process.env.FOUNDRY_TEST_AUTH_A).toBe('synthetic-a');
  });
  test('scopes resume identity to source and configuration, never an ambient native ID', async () => {
    const a = gateway('codex'),
      b = gateway('codex');
    const auth = new NativeAuthentication({
      directory: root(),
      sources: [a, b],
      defaultSourceId: a.id,
    });
    const first = track(await auth.prepare('same-thread', 'codex'));
    expect(first.bindingId).not.toBe('same-thread');
    expect(auth.bindingId('same-thread', 'codex')).toBe(first.bindingId);
    auth.select('same-thread', b.id);
    expect(() => first.check()).toThrow('binding changed');
    expect(auth.bindingId('same-thread', 'codex')).not.toBe(first.bindingId);
  });
  test('checks revocation and stops reuse of a released construction', async () => {
    const source = gateway('codex');
    const auth = new NativeAuthentication({
      directory: root(),
      sources: [source],
      defaultSourceId: source.id,
    });
    const launch = track(await auth.prepare('thread', 'codex'));
    auth.revoke(source.id);
    expect(() => launch.check()).toThrow('unavailable');
    expect(() => launch.launch(['codex'], {})).toThrow('unavailable');
    expect(() => auth.bindingId('thread', 'codex')).toThrow('unavailable');
  });
  test('claims native profiles exclusively across manager instances and releases after owner exit', async () => {
    const directory = root(),
      profile = join(directory, 'native');
    mkdirSync(profile, { mode: 0o700 });
    const source: NativeAuthenticationSource = {
      id: crypto.randomUUID(),
      connectionId: crypto.randomUUID(),
      runtime: 'claude',
      mode: 'native-profile',
      profileDirectory: profile,
    };
    const first = new NativeAuthentication({
      directory,
      sources: [source],
      defaultSourceId: source.id,
    });
    const second = new NativeAuthentication({
      directory,
      sources: [source],
      defaultSourceId: source.id,
    });
    const a = track(await first.prepare('a', 'claude')),
      b = track(await second.prepare('b', 'claude'));
    a.launch(['claude'], {});
    expect(() => b.launch(['claude'], {})).toThrow('in use');
    a.release();
    b.launch(['claude'], {});
    expect(() => a.launch(['claude'], {})).toThrow('released');
    expect(existsSync(join(profile, '.foundry-auth-lock'))).toBe(true);
    b.release();
    expect(existsSync(join(profile, '.foundry-auth-lock'))).toBe(false);
  });
  test("reclaims a crashed owner's lock only when the owner and its recorded native child are both dead", async () => {
    const directory = root(),
      profile = join(directory, 'native');
    mkdirSync(profile, { mode: 0o700 });
    const source: NativeAuthenticationSource = {
      id: crypto.randomUUID(),
      connectionId: crypto.randomUUID(),
      runtime: 'claude',
      mode: 'native-profile',
      profileDirectory: profile,
    };
    const auth = new NativeAuthentication({
      directory,
      sources: [source],
      defaultSourceId: source.id,
    });
    const lock = join(profile, '.foundry-auth-lock');
    const deadPid = () => {
      const child = Bun.spawnSync(['true']);
      return child.pid;
    };
    const live = Bun.spawn(['sleep', '30']);
    cleanups.push(() => live.kill());
    const crashed = (owner: object) => {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ id: 'crashed', ...owner }));
    };
    const attempt = async () =>
      track(await auth.prepare(crypto.randomUUID(), 'claude')).launch(['claude'], {});
    crashed({ pid: deadPid() });
    await expect(attempt()).rejects.toThrow('in use');
    rmSync(lock, { recursive: true });
    crashed({ pid: deadPid(), childPid: live.pid });
    await expect(attempt()).rejects.toThrow('in use');
    rmSync(lock, { recursive: true });
    crashed({ pid: deadPid(), childPid: deadPid() });
    const owner = track(await auth.prepare('thread', 'claude'));
    owner.launch(['claude'], {});
    owner.adopt!(live.pid);
    expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))).toMatchObject({
      pid: process.pid,
      childPid: live.pid,
      threadId: 'thread',
    });
  });
  test('refuses two processes for the same persisted gateway profile', async () => {
    const source = gateway('claude');
    token('FOUNDRY_TEST_AUTH_A', 'test-token');
    const auth = new NativeAuthentication({
      directory: root(),
      sources: [source],
      defaultSourceId: source.id,
    });
    const [a, b] = (
      await Promise.all([auth.prepare('same', 'claude'), auth.prepare('same', 'claude')])
    ).map(track);
    a.launch(['claude'], {});
    expect(() => b.launch(['claude'], {})).toThrow('in use');
    expect(() => a.launch(['claude'], {})).toThrow('already owns');
  });
  test('writes command renewal configuration without running or logging the helper', async () => {
    const source: NativeAuthenticationSource = {
      ...gateway('claude'),
      mode: 'gateway',
      baseUrl: 'https://gateway.example/v1',
      credential: {
        type: 'command',
        command: '/path with spaces/token',
        args: ['--binding', "a'b"],
        refreshIntervalMs: 120000,
      },
    };
    const auth = new NativeAuthentication({
      directory: root(),
      sources: [source],
      defaultSourceId: source.id,
    });
    const launch = track(await auth.prepare('thread', 'claude'));
    const launched = launch.launch(['claude'], { ANTHROPIC_AUTH_TOKEN: 'wrong' });
    const config = JSON.parse(
      readFileSync(join(launched.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8'),
    );
    expect(config.apiKeyHelper).toBe("'/path with spaces/token' '--binding' 'a'\"'\"'b'");
    expect(launched.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(launched.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS).toBe('120000');
  });
  test('fails closed on missing tokens and conflicting routing arguments', async () => {
    const source = gateway('codex', 'FOUNDRY_TEST_MISSING_TOKEN');
    const auth = new NativeAuthentication({
      directory: root(),
      sources: [source],
      defaultSourceId: source.id,
    });
    const launch = track(await auth.prepare('thread', 'codex'));
    expect(() => launch.launch(['codex'], {})).toThrow('unavailable');
    token('FOUNDRY_TEST_MISSING_TOKEN', 'test');
    expect(() => launch.launch(['codex', '-c', 'model_provider="other"'], {})).toThrow(
      'Conflicting',
    );
  });
  test('rejects non-UUID references and unsafe endpoints', () => {
    expect(
      () =>
        new NativeAuthentication({
          directory: root(),
          sources: [{ ...gateway('claude'), id: 'personal' }],
        }),
    ).toThrow('identity');
    expect(
      () =>
        new NativeAuthentication({
          directory: root(),
          sources: [
            {
              ...gateway('claude'),
              mode: 'gateway',
              baseUrl: 'http://remote.example',
              credential: { type: 'environment', variable: 'TOKEN' },
            },
          ],
        }),
    ).toThrow('HTTPS');
  });
});

test("competing preparation cannot overwrite a live owner's configuration", async () => {
  const { writeFileSync } = await import('node:fs');
  const source = gateway('claude');
  token('FOUNDRY_TEST_AUTH_A', 'test-token');
  const auth = new NativeAuthentication({
    directory: root(),
    sources: [source],
    defaultSourceId: source.id,
  });
  const a = track(await auth.prepare('thread', 'claude'));
  const native = a.launch(['claude'], {}),
    path = join(native.env.CLAUDE_CONFIG_DIR!, 'settings.json');
  writeFileSync(path, '{"owned":true}');
  const b = track(await auth.prepare('thread', 'claude'));
  expect(() => b.launch(['claude'], {})).toThrow('in use');
  expect(readFileSync(path, 'utf8')).toBe('{"owned":true}');
});

test('settings validate source assignments and reject inline secrets', async () => {
  const { validateConfig, defaultConfig } = await import('../src/viewer/config');
  const source = gateway('claude'),
    config = defaultConfig();
  config.defaults.provider = 'claude-code';
  config.nativeAuthentication = [source];
  config.apiTokens = true;
  config.nativeAuthenticationSelections = { thread: source.id };
  expect(() => validateConfig(config)).not.toThrow();
  config.nativeAuthenticationSelections.thread = crypto.randomUUID();
  expect(() => validateConfig(config)).toThrow('Unknown authentication source');
  const inline = { ...source, token: 'must-not-be-stored' };
  expect(() => new NativeAuthentication({ directory: root(), sources: [inline] })).toThrow(
    'only credential references',
  );
});

test('Codex rejects attached and quoted routing overrides before creating a profile', async () => {
  const source = gateway('codex'),
    directory = root();
  token('FOUNDRY_TEST_AUTH_A', 'synthetic');
  const auth = new NativeAuthentication({
    directory,
    sources: [source],
    defaultSourceId: source.id,
  });
  const launch = track(await auth.prepare('thread', 'codex'));
  for (const args of [
    ['--config=model_provider="other"'],
    ['-c=model_provider="other"'],
    ['-cmodel_provider="other"'],
    ['--profile=other'],
    ['-pother'],
    ['-p=other'],
    ['-c', '"model_provider"="other"'],
    ['--config', 'model_providers.other.base_url="https://other.example"'],
  ])
    expect(() => launch.launch(['codex', ...args], {})).toThrow('Conflicting');
  expect(existsSync(join(directory, source.id))).toBe(false);
  const owned = launch.launch(
    ['codex', '-c', 'sandbox_mode="read-only"', '--config=model_reasoning_effort="low"'],
    {},
  );
  expect(existsSync(join(owned.env.CODEX_HOME!, 'config.toml'))).toBe(true);
});

test('native profile onboarding refuses exposed directories, credential links and permission changes', async () => {
  const directory = root(),
    profile = join(directory, 'native');
  mkdirSync(profile, { mode: 0o755 });
  const source: NativeAuthenticationSource = {
    id: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    runtime: 'codex',
    mode: 'native-profile',
    profileDirectory: profile,
  };
  const auth = new NativeAuthentication({
    directory,
    sources: [source],
    defaultSourceId: source.id,
  });
  await expect(auth.prepare('thread', 'codex')).rejects.toThrow('private directory');
  chmodSync(profile, 0o700);
  const outside = join(directory, 'other-credential');
  writeFileSync(outside, 'synthetic', { mode: 0o600 });
  symlinkSync(outside, join(profile, 'auth.json'));
  await expect(auth.prepare('thread', 'codex')).rejects.toThrow('private regular files');
  rmSync(join(profile, 'auth.json'));
  const launch = track(await auth.prepare('thread', 'codex'));
  chmodSync(profile, 0o755);
  expect(() => launch.launch(['codex'], {})).toThrow('private directory');
  expect(existsSync(join(profile, '.foundry-auth-lock'))).toBe(false);
});

test('gateway setup refuses a symlink config and preserves its target', async () => {
  const source = gateway('codex'),
    directory = root();
  token('FOUNDRY_TEST_AUTH_A', 'synthetic');
  const auth = new NativeAuthentication({
    directory,
    sources: [source],
    defaultSourceId: source.id,
  });
  const first = track(await auth.prepare('thread', 'codex'));
  const launched = first.launch(['codex'], {});
  first.release();
  const config = join(launched.env.CODEX_HOME!, 'config.toml'),
    target = join(directory, 'unrelated');
  writeFileSync(target, 'keep', { mode: 0o600 });
  rmSync(config);
  symlinkSync(target, config);
  const second = track(await auth.prepare('thread', 'codex'));
  expect(() => second.launch(['codex'], {})).toThrow('private regular files');
  expect(readFileSync(target, 'utf8')).toBe('keep');
});

test("a private Codex home holds only the profile's login, linked so refreshes land in the profile", async () => {
  const directory = root(),
    profile = join(directory, 'native'),
    state = join(directory, 'state');
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(profile, 'auth.json'), '{"tokens":"first"}', { mode: 0o600 });
  writeFileSync(join(profile, 'AGENTS.md'), 'user instructions', { mode: 0o600 });
  writeFileSync(join(profile, 'config.toml'), 'model = "user-model"\n', { mode: 0o600 });
  mkdirSync(join(profile, 'memories'));
  const source: NativeAuthenticationSource = {
    id: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    runtime: 'codex',
    mode: 'native-profile',
    profileDirectory: profile,
  };
  const auth = new NativeAuthentication({
    directory: state,
    sources: [source],
    defaultSourceId: source.id,
    shared: true,
    privateHome: true,
  });
  const first = track(await auth.prepare('decisions', 'codex'));
  const { env } = first.launch(['codex', 'app-server'], { CODEX_HOME: '/elsewhere', PATH: '/bin' });
  const home = env.CODEX_HOME!;
  expect(home).toBe(join(state, source.id, 'codex-home'));
  expect(readdirSync(home).sort()).toEqual(['auth.json', 'config.toml']);
  expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(
    'cli_auth_credentials_store = "file"\n',
  );
  expect(readlinkSync(join(home, 'auth.json'))).toBe(join(realpathSync(profile), 'auth.json'));
  // The profile keeps the lock: the shared registration sits beside the one login.
  expect(readdirSync(join(profile, '.foundry-auth-shared'))).toHaveLength(1);
  // Codex rewrites auth.json in place (truncate, not rename): a refresh in the home is the profile's refresh, and back.
  writeFileSync(join(home, 'auth.json'), '{"tokens":"refreshed"}');
  expect(readFileSync(join(profile, 'auth.json'), 'utf8')).toBe('{"tokens":"refreshed"}');
  writeFileSync(join(profile, 'auth.json'), '{"tokens":"interactive"}');
  expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('{"tokens":"interactive"}');
  first.release();
  expect(existsSync(join(profile, '.foundry-auth-shared'))).toBe(false);
  // A replaced link or a stray copy is restored to the link on the next launch; what it pointed at is untouched.
  const outside = join(directory, 'outside');
  writeFileSync(outside, 'keep', { mode: 0o600 });
  rmSync(join(home, 'auth.json'));
  symlinkSync(outside, join(home, 'auth.json'));
  const second = track(await auth.prepare('decisions', 'codex'));
  second.launch(['codex', 'app-server'], {});
  expect(readlinkSync(join(home, 'auth.json'))).toBe(join(realpathSync(profile), 'auth.json'));
  expect(readFileSync(outside, 'utf8')).toBe('keep');
});

test('a private home is refused for Claude and gateway sources', () => {
  const claude: NativeAuthenticationSource = {
    id: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    runtime: 'claude',
    mode: 'native-profile',
    profileDirectory: '/tmp/claude',
  };
  for (const source of [claude, gateway('codex')])
    expect(
      () => new NativeAuthentication({ directory: root(), sources: [source], privateHome: true }),
    ).toThrow('private home requires Codex native profiles');
});
