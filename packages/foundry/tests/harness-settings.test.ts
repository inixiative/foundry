import { afterAll, afterEach, expect, test } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeSettingsFiles,
  codexUserConfig,
  harnessSettingSources,
  shareCodexUserSetup,
  shareUserSetup,
  subscriptionSettingsGuard,
} from '../src/providers/harness-settings';
import { SubscriptionAuthentication } from '../src/providers/subscription-authentication';
import { subscriptionStatusProcess } from './helpers/subscription-transport';
import { recordedCodexStatus, settleRecordings } from './helpers/vcr';

afterAll(settleRecordings);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-settings-'));
  roots.push(root);
  return root;
};
const json = (path: string, value: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

test('project settings load only inside a registered project', () => {
  const root = scratch();
  const project = join(root, 'repo');
  mkdirSync(join(project, '.worktrees', 'feature'), { recursive: true });
  mkdirSync(join(root, 'repo-other'));
  mkdirSync(join(root, 'elsewhere'));
  expect(harnessSettingSources(project, [project])).toBe('user,project,local');
  expect(harnessSettingSources(join(project, '.worktrees', 'feature'), [project])).toBe(
    'user,project,local',
  );
  // A sibling sharing the name's prefix is not inside it.
  expect(harnessSettingSources(join(root, 'repo-other'), [project])).toBe('user');
  expect(harnessSettingSources(join(root, 'elsewhere'), [project])).toBe('user');
  expect(harnessSettingSources(project, [])).toBe('user');
});

test('the files read are the config dir’s, plus the project’s under project sources', () => {
  expect(claudeSettingsFiles('/home/.claude', { sources: 'user', cwd: '/repo' })).toEqual([
    '/home/.claude/settings.json',
  ]);
  expect(
    claudeSettingsFiles('/home/.claude', { sources: 'user,project,local', cwd: '/repo' }),
  ).toEqual([
    '/home/.claude/settings.json',
    '/repo/.claude/settings.json',
    '/repo/.claude/settings.local.json',
  ]);
});

test('the guard blanks every credential a loaded file sets, and the core ones always', () => {
  const root = scratch();
  const user = join(root, 'settings.json');
  const project = join(root, 'repo', '.claude', 'settings.json');
  json(user, {
    apiKeyHelper: 'echo key',
    env: { AWS_PROFILE: 'work', ANTHROPIC_MODEL: 'x', BASH_DEFAULT_TIMEOUT_MS: '9000' },
  });
  json(project, { env: { NODE_EXTRA_CA_CERTS: '/ca.pem', ANTHROPIC_BEDROCK_BASE_URL: 'u' } });
  writeFileSync(join(root, 'broken.json'), '{not json');
  const guard = JSON.parse(
    subscriptionSettingsGuard([user, project, join(root, 'broken.json'), join(root, 'missing')]),
  );
  expect(guard.apiKeyHelper).toBe('');
  expect(guard.awsAuthRefresh).toBe('');
  expect(guard.awsCredentialExport).toBe('');
  // What the files set is blanked...
  for (const key of ['ANTHROPIC_MODEL', 'AWS_PROFILE', 'NODE_EXTRA_CA_CERTS'])
    expect(guard.env[key]).toBe('');
  // ...and every provider switch and credential is blanked whatever the files say, because
  // Claude re-reads settings mid-session.
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
    'CLAUDE_CODE_USE_GATEWAY',
    'CLAUDE_CODE_USE_MANTLE',
  ])
    expect(guard.env[key]).toBe('');
  // A proxy is blanked only when a loaded file sets it.
  expect(guard.env.HTTPS_PROXY).toBeUndefined();
  json(user, { env: { HTTPS_PROXY: 'http://p' } });
  expect(JSON.parse(subscriptionSettingsGuard([user])).env.HTTPS_PROXY).toBe('');
  // The user's ordinary settings are untouched.
  expect(guard.env.BASH_DEFAULT_TIMEOUT_MS).toBeUndefined();
});

test('a settings file that sets the subscription token is refused, not blanked', () => {
  const root = scratch();
  const file = join(root, 'settings.json');
  json(file, { env: { CLAUDE_CODE_OAUTH_TOKEN: 'someone-else' } });
  expect(() => subscriptionSettingsGuard([file])).toThrow('CLAUDE_CODE_OAUTH_TOKEN');
});

test('a Foundry-owned login home gets the user’s setup: settings copied private, folders linked', () => {
  const root = scratch();
  const user = join(root, 'user');
  const home = join(root, 'home');
  mkdirSync(join(user, 'commands'), { recursive: true });
  mkdirSync(join(user, 'skills'));
  mkdirSync(home, { mode: 0o700 });
  json(join(user, 'settings.json'), { permissions: { allow: ['Bash(ls:*)'] } });
  shareUserSetup(home, user);
  const copy = join(home, 'settings.json');
  expect(lstatSync(copy).isSymbolicLink()).toBe(false);
  expect(statSync(copy).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(copy, 'utf8'))).toEqual({
    permissions: { allow: ['Bash(ls:*)'] },
  });
  expect(readlinkSync(join(home, 'commands'))).toBe(join(user, 'commands'));
  expect(readlinkSync(join(home, 'skills'))).toBe(join(user, 'skills'));
  expect(() => lstatSync(join(home, 'agents'))).toThrow();
  // Again, unchanged: nothing is rewritten; a folder the user removed loses its link.
  const before = statSync(copy).mtimeMs;
  rmSync(join(user, 'skills'), { recursive: true });
  shareUserSetup(home, user);
  expect(statSync(copy).mtimeMs).toBe(before);
  expect(() => lstatSync(join(home, 'skills'))).toThrow();
  // No user settings: the copy goes.
  rmSync(join(user, 'settings.json'));
  shareUserSetup(home, user);
  expect(() => lstatSync(copy)).toThrow();
  // A real folder where a link goes is moved aside, kept, and the link goes in.
  mkdirSync(join(home, 'agents', 'store'), { recursive: true });
  writeFileSync(join(home, 'agents', 'store', 'cache.json'), '{}');
  mkdirSync(join(user, 'agents'));
  shareUserSetup(home, user);
  expect(readlinkSync(join(home, 'agents'))).toBe(join(user, 'agents'));
  const kept = readdirSync(home).filter((name) => name.startsWith('agents.before-foundry-'));
  expect(kept).toHaveLength(1);
  expect(readFileSync(join(home, kept[0]!, 'store', 'cache.json'), 'utf8')).toBe('{}');
  // Claude's own plugin state stays its own: plugins are never linked.
  mkdirSync(join(user, 'plugins'));
  mkdirSync(join(home, 'plugins'));
  shareUserSetup(home, user);
  expect(lstatSync(join(home, 'plugins')).isSymbolicLink()).toBe(false);
  // No temporary links are left behind.
  expect(readdirSync(home).filter((name) => name.startsWith('.'))).toEqual([]);
});

test('a link the user pointed elsewhere is put back to their folder', () => {
  const root = scratch();
  const user = join(root, 'user');
  const home = join(root, 'home');
  mkdirSync(join(user, 'commands'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  symlinkSync(root, join(home, 'commands'));
  shareUserSetup(home, user);
  expect(readlinkSync(join(home, 'commands'))).toBe(join(user, 'commands'));
});

test('a main thread on the subscription loads the user’s settings under the guard; others load none', async () => {
  const root = scratch();
  const profile = join(root, 'profile');
  mkdirSync(profile, { mode: 0o700 });
  const repo = join(root, 'repo');
  json(join(repo, '.claude', 'settings.json'), { env: { ANTHROPIC_BASE_URL: 'http://x' } });
  const auth = new SubscriptionAuthentication(
    root,
    {
      id: crypto.randomUUID(),
      integrationId: crypto.randomUUID(),
      runtime: 'claude',
      mode: 'native-profile',
      profileDirectory: profile,
    },
    () => subscriptionStatusProcess(true),
  );
  const main = await auth.prepare('main', 'claude');
  const launched = main.launch(['claude'], {}, { sources: 'user,project,local', cwd: repo });
  main.release();
  const at = launched.argv.indexOf('--setting-sources');
  expect(launched.argv[at + 1]).toBe('user,project,local');
  expect(launched.argv[at + 2]).toBe('--settings');
  const guard = JSON.parse(launched.argv[at + 3]!);
  expect(guard.env.ANTHROPIC_BASE_URL).toBe('');
  expect(guard.apiKeyHelper).toBe('');

  const plain = await auth.prepare('aux', 'claude');
  expect(plain.launch(['claude'], {}).argv.slice(-2)).toEqual(['--setting-sources', '']);
  plain.release();
  // A caller still cannot pass its own settings.
  const caller = await auth.prepare('caller', 'claude');
  expect(() =>
    caller.launch(['claude', '--settings', '{}'], {}, { sources: 'user', cwd: repo }),
  ).toThrow('override refused');
});

test('composition.harnessSettings takes only "load" or "off"', async () => {
  const { validateCompositionSettings } = await import('../src/prompts/instruction-settings');
  expect(() => validateCompositionSettings({ harnessSettings: 'load' }, [])).not.toThrow();
  expect(() => validateCompositionSettings({ harnessSettings: 'off' }, [])).not.toThrow();
  expect(() =>
    validateCompositionSettings({ harnessSettings: 'on' as unknown as 'load' }, []),
  ).toThrow('composition.harnessSettings must be "load" or "off"');
});

test('a Codex main thread takes only the allowlisted part of the user’s config.toml', () => {
  const root = scratch();
  writeFileSync(
    join(root, 'config.toml'),
    [
      'model = "gpt-paid"',
      'model_provider = "evil"',
      '"profile" = "sneaky"',
      'chatgpt_base_url = "http://evil"',
      'cli_auth_credentials_store = "keyring"',
      'notify = ["/bin/echo", "done"]',
      '[model_providers.evil]',
      'base_url = "http://evil"',
      '[profiles.sneaky]',
      'model_provider = "evil"',
      '[projects."/repo"]',
      'trust_level = "trusted"',
      '[memories]',
      'use_memories = true',
      '[mcp_servers.repl]',
      'command = "/bin/repl"',
      'args = ["--a", "b c"]',
      'startup_timeout_sec = 120',
      '[mcp_servers.repl.env]',
      'QUOTE = "say \\"hi\\""',
      '[plugins."documents@openai-primary-runtime"]',
      'enabled = true',
      '[features]',
      'memories = true',
    ].join('\n'),
  );
  const text = codexUserConfig(root);
  const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  // `features` stays out: flags there turn on memories, paid tiers and other identities.
  expect(Object.keys(parsed).sort()).toEqual(['mcp_servers', 'notify', 'plugins']);
  expect(parsed.mcp_servers).toEqual({
    repl: {
      command: '/bin/repl',
      args: ['--a', 'b c'],
      startup_timeout_sec: 120,
      env: { QUOTE: 'say "hi"' },
    },
  });
  expect(parsed.plugins).toEqual({ 'documents@openai-primary-runtime': { enabled: true } });
  for (const word of ['evil', 'gpt-paid', 'sneaky', 'keyring', 'trusted', 'use_memories'])
    expect(text).not.toContain(word);
  // No config, or an unreadable one, gives nothing.
  expect(codexUserConfig(join(root, 'missing'))).toBe('');
  writeFileSync(join(root, 'config.toml'), 'not = = toml');
  expect(codexUserConfig(root)).toBe('');
});

test('a Codex MCP server never gets the user’s own Codex home or login from their config', () => {
  const root = scratch();
  writeFileSync(
    join(root, 'config.toml'),
    [
      '[mcp_servers.node_repl]',
      'command = "/bin/repl"',
      '[mcp_servers.node_repl.env]',
      'CODEX_HOME = "/Users/me/.codex"',
      'CODEX_CLI_PATH = "/bin/codex"',
      'OPENAI_API_KEY = "sk-paid"',
      'BROWSER_USE_TINYSKY_ENABLED = "1"',
    ].join('\n'),
  );
  const parsed = Bun.TOML.parse(codexUserConfig(root)) as {
    mcp_servers: { node_repl: { env: Record<string, string> } };
  };
  expect(parsed.mcp_servers.node_repl.env).toEqual({ BROWSER_USE_TINYSKY_ENABLED: '1' });
});

test('a Codex config value that can’t be written back unchanged is left out, not altered', () => {
  const root = scratch();
  writeFileSync(
    join(root, 'config.toml'),
    [
      '[tools]',
      'limit = inf',
      'floor = -inf',
      'odd = nan',
      '[hooks]',
      'when = 1979-05-27T07:32:00Z',
      '[skills]',
      'enabled = true',
    ].join('\n'),
  );
  const text = codexUserConfig(root);
  const parsed = Bun.TOML.parse(text) as Record<string, Record<string, unknown>>;
  expect(parsed.tools!.limit).toBe(Number.POSITIVE_INFINITY);
  expect(parsed.tools!.floor).toBe(Number.NEGATIVE_INFINITY);
  expect(Number.isNaN(parsed.tools!.odd)).toBe(true);
  expect(parsed.skills).toEqual({ enabled: true });
  // Bun reads a TOML date as a Temporal value that can't be written back, so `hooks` is
  // dropped whole rather than rewritten.
  expect(parsed.hooks).toBeUndefined();
});

test('a Codex home gets the user’s skills, rules and prompts by link', () => {
  const root = scratch();
  const user = join(root, 'codex');
  const home = join(root, 'home');
  mkdirSync(join(user, 'skills'), { recursive: true });
  mkdirSync(join(user, 'rules'));
  mkdirSync(home, { mode: 0o700 });
  shareCodexUserSetup(home, user);
  expect(readlinkSync(join(home, 'skills'))).toBe(join(user, 'skills'));
  expect(readlinkSync(join(home, 'rules'))).toBe(join(user, 'rules'));
  expect(() => lstatSync(join(home, 'prompts'))).toThrow();
  // Never the user's AGENTS.md, memories or sessions.
  for (const name of ['AGENTS.md', 'memories', 'sessions'])
    expect(() => lstatSync(join(home, name))).toThrow();
});

test('a Codex main thread on the subscription runs on its own home with the user’s setup; others on the plain one', async () => {
  const root = scratch();
  const profile = join(root, 'codex-profile');
  mkdirSync(join(profile, 'skills'), { recursive: true, mode: 0o700 });
  writeFileSync(join(profile, 'auth.json'), '{}', { mode: 0o600 });
  writeFileSync(
    join(profile, 'config.toml'),
    'model_provider = "evil"\n[mcp_servers.repl]\ncommand = "/bin/repl"\n',
    { mode: 0o600 },
  );
  const auth = new SubscriptionAuthentication(
    root,
    {
      id: crypto.randomUUID(),
      integrationId: crypto.randomUUID(),
      runtime: 'codex',
      mode: 'native-profile',
      profileDirectory: profile,
    },
    recordedCodexStatus(['chatgpt']).statusSpawn,
  );
  const main = await auth.prepare('main', 'codex');
  const launched = main.launch(['codex', 'app-server'], {}, { sources: 'user', cwd: root });
  const userHome = launched.env.CODEX_HOME!;
  main.release();
  const plain = await auth.prepare('decision', 'codex');
  const plainHome = plain.launch(['codex', 'app-server'], {}).env.CODEX_HOME!;
  plain.release();
  expect(userHome).toBe(`${plainHome}-user`);
  const userConfig = readFileSync(join(userHome, 'config.toml'), 'utf8');
  expect(userConfig).toContain('cli_auth_credentials_store = "file"');
  expect(userConfig).toContain('mcp_servers');
  expect(userConfig).not.toContain('evil');
  expect(readlinkSync(join(userHome, 'skills'))).toBe(join(realpathSync(profile), 'skills'));
  expect(readFileSync(join(plainHome, 'config.toml'), 'utf8')).not.toContain('mcp_servers');
  expect(() => lstatSync(join(plainHome, 'skills'))).toThrow();
});
