import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vendorOfProvider } from '@inixiative/foundry-core';
import { providerAccounts } from '../src/providers/provider-accounts';
import { defaultConfig } from '../src/viewer/config';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateProfile() {
  const root = mkdtempSync(join(tmpdir(), 'provider-accounts-'));
  roots.push(root);
  const dir = join(root, 'profile');
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

const onPath = () => '/usr/local/bin/cli';
const enable = (config: ReturnType<typeof defaultConfig>, ...ids: string[]) => {
  for (const id of ids) {
    const { vendor, mode } = vendorOfProvider(id)!;
    const settings = config.vendors[vendor.id]!;
    config.vendors[vendor.id] = {
      ...settings,
      enabled: true,
      [mode]: { ...settings[mode], enabled: true },
    };
  }
};

test('subscription mode reports the main-thread and decision profiles where they live', () => {
  const config = defaultConfig();
  const worker = privateProfile();
  config.nativeAuthentication = [
    {
      id: crypto.randomUUID(),
      integrationId: crypto.randomUUID(),
      runtime: 'claude',
      mode: 'native-profile',
      profileDirectory: worker,
    },
  ];
  config.defaults = {
    ...config.defaults,
    provider: 'claude-code',
    nativeAuthenticationId: config.nativeAuthentication[0]!.id,
  };
  config.subscriptionOnly = { decisionRuntime: 'codex', model: 'gpt-5.6-luna' };
  enable(config, 'claude-code', 'codex', 'anthropic');

  const accounts = Object.fromEntries(
    providerAccounts(config, { which: onPath, environment: {} }).map((a) => [a.provider, a]),
  );

  expect(accounts['claude-code']).toMatchObject({
    source: 'profile',
    detail: worker,
    ready: true,
    uses: ['main thread'],
  });
  expect(accounts.codex).toMatchObject({ source: 'login', uses: ['decisions'] });
  expect(accounts.anthropic).toMatchObject({
    source: 'none',
    detail: 'ANTHROPIC_API_KEY',
    ready: false,
  });
});

test('by default the Claude login runs both the main thread and the decisions', () => {
  const config = defaultConfig();
  enable(config, 'claude-code', 'codex');
  const accounts = Object.fromEntries(
    providerAccounts(config, { which: onPath, environment: {} }).map((a) => [a.provider, a]),
  );
  expect(accounts['claude-code']!.uses).toEqual(['main thread', 'decisions']);
  expect(accounts.codex!.uses).toEqual([]);
});

test('API providers report their variable by name, never its value', () => {
  const config = defaultConfig();
  config.apiTokens = true;
  enable(config, 'anthropic', 'openai');

  const accounts = providerAccounts(config, {
    which: onPath,
    environment: { ANTHROPIC_API_KEY: 'sk-secret' },
  });

  expect(JSON.stringify(accounts)).not.toContain('sk-secret');
  expect(accounts.find((a) => a.provider === 'anthropic')).toMatchObject({
    source: 'api-key',
    detail: 'ANTHROPIC_API_KEY',
    ready: true,
  });
  expect(accounts.find((a) => a.provider === 'openai')).toMatchObject({
    source: 'api-key',
    ready: false,
    issue: 'OPENAI_API_KEY is not set',
  });
});

test('a main thread bound to a Kingdom owner reports Kingdom as its account', () => {
  const config = defaultConfig();
  config.apiTokens = true;
  config.kingdomInference = [
    {
      id: 'owner-1',
      url: 'https://kingdom.example',
      credentialFile: '/private/signet.json',
      selection: {},
    },
  ];
  config.defaults = { ...config.defaults, provider: 'claude-code', kingdomOwnerKey: 'owner-1' };
  enable(config, 'claude-code');

  expect(
    providerAccounts(config, { which: onPath }).find((a) => a.provider === 'claude-code'),
  ).toMatchObject({
    source: 'kingdom',
    detail: 'https://kingdom.example',
    ready: true,
    uses: ['main thread'],
  });
});

test('a missing CLI makes a login unready', () => {
  const config = defaultConfig();
  enable(config, 'claude-code');
  const account = providerAccounts(config, { which: () => null }).find(
    (a) => a.provider === 'claude-code',
  );
  expect(account).toMatchObject({ ready: false, issue: 'The claude CLI is not on PATH' });
});

test('a broken decision profile on the main runtime is never reported ready', () => {
  const config = defaultConfig();
  const worker = privateProfile();
  const id = () => crypto.randomUUID();
  config.nativeAuthentication = [
    {
      id: id(),
      integrationId: id(),
      runtime: 'claude',
      mode: 'native-profile',
      profileDirectory: worker,
    },
    {
      id: id(),
      integrationId: id(),
      runtime: 'claude',
      mode: 'native-profile',
      profileDirectory: join(worker, '..', 'missing-decision-profile'),
    },
  ];
  config.defaults = {
    ...config.defaults,
    provider: 'claude-code',
    nativeAuthenticationId: config.nativeAuthentication[0]!.id,
  };
  config.subscriptionOnly = {
    decisionSourceId: config.nativeAuthentication[1]!.id,
    model: 'sonnet',
  };
  enable(config, 'claude-code');

  const account = providerAccounts(config, { which: onPath }).find(
    (a) => a.provider === 'claude-code',
  );
  expect(account?.ready).toBe(false);
  expect(account?.issue).toBeTruthy();
});
