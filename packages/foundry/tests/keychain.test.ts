import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../src/audit/audit-log';
import {
  FOUNDRY_HOLDER,
  Keychain,
  KeychainError,
  memoryKeychainBackend,
  providerKeyEnvironment,
} from '../src/secrets/keychain';

const VALUE = 'correct horse battery staple';
const user = { kind: 'user' } as const;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixture = () => {
  const configDir = mkdtempSync(join(tmpdir(), 'foundry-keychain-'));
  dirs.push(configDir);
  const backend = memoryKeychainBackend();
  let at = 1_000;
  return { configDir, backend, keychain: new Keychain({ configDir, backend, now: () => at++ }) };
};

test('store, list, read, remove: values in the backend, names in a private index', async () => {
  const { configDir, backend, keychain } = fixture();
  const entry = await keychain.store('site-password', VALUE, { from: 'api', actor: user });
  expect(entry).toEqual({
    name: 'site-password',
    holder: FOUNDRY_HOLDER,
    from: 'api',
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  expect(keychain.list().map((e) => e.name)).toEqual(['site-password']);
  expect(await keychain.read('site-password', FOUNDRY_HOLDER)).toBe(VALUE);
  const index = join(configDir, '.private', 'keychain.json');
  expect(statSync(index).mode & 0o077).toBe(0);
  expect(readFileSync(index, 'utf8')).not.toContain(VALUE);
  expect(await keychain.remove('site-password', user)).toBe(true);
  expect(await backend.get('site-password')).toBeNull();
  expect(keychain.list()).toEqual([]);
  expect(await keychain.remove('site-password', user)).toBe(false);
});

test('an existing name needs replace; names, holders and values are checked', async () => {
  const { keychain } = fixture();
  await keychain.store('k', VALUE, { from: 'api', actor: user });
  await expect(keychain.store('k', 'other', { from: 'api', actor: user })).rejects.toThrow(
    'already in the keychain',
  );
  const replaced = await keychain.store('k', 'other', { from: 'api', actor: user, replace: true });
  expect(replaced.createdAt).toBe(1_000);
  expect(await keychain.read('k', FOUNDRY_HOLDER)).toBe('other');
  await expect(keychain.store('../k', VALUE, { from: 'api', actor: user })).rejects.toThrow(
    KeychainError,
  );
  await expect(
    keychain.store('k2', VALUE, { from: 'api', actor: user, holder: 'someone' }),
  ).rejects.toThrow('a holder is');
  await expect(keychain.store('k3', '', { from: 'api', actor: user })).rejects.toThrow('empty');
});

test('a connector entry is read by that connector alone; a foundry entry by everyone', async () => {
  const { keychain } = fixture();
  await keychain.store('ANTHROPIC_API_KEY', VALUE, {
    from: 'api',
    actor: user,
    holder: 'provider:anthropic',
  });
  await keychain.store('shared', VALUE, { from: 'api', actor: user });
  expect(await keychain.read('ANTHROPIC_API_KEY', 'provider:anthropic')).toBe(VALUE);
  await expect(keychain.read('ANTHROPIC_API_KEY', FOUNDRY_HOLDER)).rejects.toThrow(
    'held by provider:anthropic',
  );
  await expect(keychain.read('ANTHROPIC_API_KEY', 'provider:openai')).rejects.toThrow(
    KeychainError,
  );
  expect(await keychain.read('shared', 'provider:openai')).toBe(VALUE);
  expect(keychain.readable(FOUNDRY_HOLDER).map((e) => e.name)).toEqual(['shared']);
  keychain.grant('ANTHROPIC_API_KEY', FOUNDRY_HOLDER, user);
  expect(await keychain.read('ANTHROPIC_API_KEY', FOUNDRY_HOLDER)).toBe(VALUE);
  const resolver = keychain.resolver('provider:anthropic');
  expect(
    await resolver.resolve(
      { type: 'managed', id: 'shared' },
      { service: 's', url: 'u', projectId: 'p' },
    ),
  ).toBe(VALUE);
});

test('every change is an audit row of the entry, its metadata and never its value', async () => {
  const { configDir, keychain } = fixture();
  await keychain.store('k', VALUE, { from: 'pad', actor: { kind: 'agent', id: 'thread-1' } });
  keychain.grant('k', 'mcp:linear', user);
  await keychain.remove('k', user);
  const rows = AuditLog.for(configDir).rows('keychain:k');
  expect(rows.map((row) => row.action)).toEqual(['create', 'update', 'delete']);
  expect(rows[0]!.actor).toEqual({ kind: 'agent', id: 'thread-1' });
  expect(AuditLog.for(configDir).text(rows[1]!.id)).toContain('mcp:linear');
  expect(rows[2]!.afterHash).toBeNull();
  expect(readFileSync(join(configDir, 'audit.jsonl'), 'utf8')).not.toContain(VALUE);
});

test('an index entry whose native item is gone says so', async () => {
  const { backend, keychain } = fixture();
  await keychain.store('k', VALUE, { from: 'api', actor: user });
  await backend.delete('k');
  await expect(keychain.read('k', FOUNDRY_HOLDER)).rejects.toThrow('missing from the machine');
});

test("a provider's key comes from the environment first, else its own keychain entry", async () => {
  const { keychain } = fixture();
  await keychain.store('ANTHROPIC_API_KEY', VALUE, {
    from: 'api',
    actor: user,
    holder: 'provider:anthropic',
  });
  // Held by another provider: not handed to the one whose key it is named after.
  await keychain.store('OPENAI_API_KEY', VALUE, {
    from: 'api',
    actor: user,
    holder: 'provider:xai',
  });
  const base = { PATH: '/bin' };
  const merged = await providerKeyEnvironment(keychain, base);
  expect(merged.ANTHROPIC_API_KEY).toBe(VALUE);
  expect(merged.OPENAI_API_KEY).toBeUndefined();
  expect(merged.PATH).toBe('/bin');
  expect(base).toEqual({ PATH: '/bin' });
  const set = await providerKeyEnvironment(keychain, { ANTHROPIC_API_KEY: 'from-env' });
  expect(set.ANTHROPIC_API_KEY).toBe('from-env');
});
