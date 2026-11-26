// Dev mode's settings (R-2026-11-25-05): `__devMode`, and the `__chorus` / `__oracle` hosts it
// points Warden calls and health checks at. Each is this machine's; the token is a keychain entry's name.

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigStore,
  defaultConfig,
  devChorus,
  type FoundryConfig,
  validateConfig,
  validateRepositoryProject,
} from '../src/viewer/config';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const withDev = (patch: Partial<FoundryConfig>): FoundryConfig => ({
  ...defaultConfig(),
  ...patch,
});

test('the dev settings are checked: a boolean switch, an http(s) URL, a keychain entry name, no extra keys', () => {
  validateConfig(withDev({ __devMode: true, __chorus: { url: 'http://localhost:4901' } }));
  validateConfig(
    withDev({ __oracle: { url: 'https://oracle.test', tokenKey: 'ORACLE_DEV.token' } }),
  );
  expect(() => validateConfig(withDev({ __devMode: 'yes' as never }))).toThrow(
    '__devMode must be true or false',
  );
  expect(() => validateConfig(withDev({ __chorus: { url: 'ftp://x' } }))).toThrow(
    '__chorus.url must be an http or https URL',
  );
  expect(() => validateConfig(withDev({ __chorus: { url: 'not a url' } }))).toThrow(
    '__chorus.url must be an http or https URL',
  );
  expect(() =>
    validateConfig(withDev({ __chorus: { url: 'http://x', tokenKey: 'sk-ant secret value!' } })),
  ).toThrow('__chorus.tokenKey must name a keychain entry');
  expect(() =>
    validateConfig(withDev({ __oracle: { url: 'http://x', token: 'abc' } as never })),
  ).toThrow('__oracle.token is not a setting (url, tokenKey)');
});

test('devChorus is the host only while dev mode is on, its trailing slash dropped and its token key defaulted', () => {
  expect(devChorus(withDev({ __chorus: { url: 'http://localhost:4901/' } }))).toBeUndefined();
  expect(devChorus(withDev({ __devMode: true }))).toBeUndefined();
  expect(
    devChorus(withDev({ __devMode: true, __chorus: { url: 'http://localhost:4901/' } })),
  ).toEqual({ url: 'http://localhost:4901', tokenKey: 'CHORUS_DEV_TOKEN' });
  expect(
    devChorus(withDev({ __devMode: true, __chorus: { url: 'http://h', tokenKey: 'MY_TOKEN' } })),
  ).toEqual({ url: 'http://h', tokenKey: 'MY_TOKEN' });
});

test('a repository cannot turn dev mode on or point its hosts elsewhere, and says why', () => {
  expect(() => validateRepositoryProject({ __devMode: true })).toThrow(
    '__devMode is not a repository setting: Dev mode is this machine’s',
  );
  expect(() => validateRepositoryProject({ __chorus: { url: 'http://evil' } })).toThrow(
    '__chorus is not a repository setting: Dev mode’s Chorus host is on this machine',
  );
  expect(() => validateRepositoryProject({ __oracle: { url: 'http://evil' } })).toThrow(
    '__oracle is not a repository setting',
  );
});

test("the 'dev' section: true turns dev mode on, false or null off; a host is set, and null removes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-dev-mode-'));
  dirs.push(dir);
  const store = new ConfigStore(dir);
  await store.save(defaultConfig());
  let next = await store.patch('dev', {
    __devMode: true,
    __chorus: { url: 'http://localhost:4901', tokenKey: 'CHORUS_DEV_TOKEN' },
  });
  expect(next.__devMode).toBe(true);
  expect(next.__chorus).toEqual({ url: 'http://localhost:4901', tokenKey: 'CHORUS_DEV_TOKEN' });
  next = await store.patch('dev', { __oracle: { url: 'http://localhost:4902' } });
  expect(next.__chorus?.url).toBe('http://localhost:4901');
  expect(next.__oracle).toEqual({ url: 'http://localhost:4902' });
  next = await store.patch('dev', { __devMode: false, __chorus: null });
  expect('__devMode' in next).toBe(false);
  expect('__chorus' in next).toBe(false);
  expect(next.__oracle?.url).toBe('http://localhost:4902');
  await expect(store.patch('dev', { __chorus: { url: 'nope' } })).rejects.toThrow(
    '__chorus.url must be an http or https URL',
  );
});
