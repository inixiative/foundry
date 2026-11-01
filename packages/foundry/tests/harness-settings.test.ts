import { afterEach, expect, test } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeSettingsFiles,
  harnessSettingSources,
  shareUserSetup,
  subscriptionSettingsGuard,
} from '../src/providers/harness-settings';
import { SubscriptionAuthentication } from '../src/providers/subscription-authentication';
import { subscriptionStatusProcess } from './helpers/subscription-transport';

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
  expect(guard.env).toEqual({
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: '',
    ANTHROPIC_BEDROCK_BASE_URL: '',
    ANTHROPIC_MODEL: '',
    AWS_PROFILE: '',
    CLAUDE_CODE_USE_BEDROCK: '',
    CLAUDE_CODE_USE_VERTEX: '',
    NODE_EXTRA_CA_CERTS: '',
  });
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
  // A real folder in the home is not Foundry's to replace.
  mkdirSync(join(home, 'agents'));
  mkdirSync(join(user, 'agents'));
  expect(() => shareUserSetup(home, user)).toThrow('not Foundry');
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
