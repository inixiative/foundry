// Dev mode's settings (R-2026-11-25-05): `__devMode`, and the `__chorus` / `__oracle` hosts it
// points Warden calls and health checks at. Each is this machine's; the token is a keychain entry's name.

import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigStore,
  defaultConfig,
  devHost,
  devHostSetting,
  devModeAnywhere,
  devModeOn,
  type FoundryConfig,
  validateConfig,
} from '../src/viewer/config';
import { readRepositorySettings } from '../src/viewer/config-resolve';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const withDev = (patch: Partial<FoundryConfig>): FoundryConfig => ({
  ...defaultConfig(),
  ...patch,
});

test('the dev settings are checked: a boolean switch, an http(s) URL, a CHORUS_ keychain entry name, no extra keys', () => {
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
  ).toThrow('__chorus.tokenKey must name a keychain entry starting CHORUS_');
  // The token it names is sent to the host, so it can never name another credential.
  expect(() =>
    validateConfig(withDev({ __chorus: { url: 'http://x', tokenKey: 'ANTHROPIC_API_KEY' } })),
  ).toThrow('__chorus.tokenKey must name a keychain entry starting CHORUS_');
  expect(() =>
    validateConfig(withDev({ __oracle: { url: 'http://x', token: 'abc' } as never })),
  ).toThrow('__oracle.token is not a setting (url, tokenKey)');
});

test('devHost is a host only while dev mode is on, its trailing slash dropped and its token key defaulted', () => {
  expect(devHost(withDev({ __chorus: { url: 'http://localhost:4901/' } }))).toBeUndefined();
  expect(devHost(withDev({ __devMode: true }))).toBeUndefined();
  expect(
    devHost(withDev({ __devMode: true, __chorus: { url: 'http://localhost:4901/' } })),
  ).toEqual({ url: 'http://localhost:4901', tokenKey: 'CHORUS_DEV_TOKEN' });
  expect(
    devHost(withDev({ __devMode: true, __chorus: { url: 'http://h', tokenKey: 'CHORUS_MINE' } })),
  ).toEqual({ url: 'http://h', tokenKey: 'CHORUS_MINE' });
  expect(
    devHost(withDev({ __devMode: true, __oracle: { url: 'http://o//' } }), '__oracle'),
  ).toEqual({ url: 'http://o', tokenKey: 'CHORUS_DEV_TOKEN' });
});

test('a project’s own __devMode wins over the machine’s; the host is always the machine’s __chorus', () => {
  const chorus = { url: 'http://localhost:4901/' };
  const host = { url: 'http://localhost:4901', tokenKey: 'CHORUS_DEV_TOKEN' };
  const project = (own?: boolean) => ({
    id: 'p',
    path: '/p',
    ...(own === undefined ? {} : { __devMode: own }),
  });
  // Machine on: every project follows it, unless it turned itself off.
  const machineOn = withDev({
    __devMode: true,
    __chorus: chorus,
    projects: { a: project(), b: project(false) },
  });
  expect(devModeOn(machineOn, 'a')).toBe(true);
  expect(devModeOn(machineOn, 'b')).toBe(false);
  expect(devHost(machineOn, '__chorus', 'a')).toEqual(host);
  expect(devHost(machineOn, '__chorus', 'b')).toBeUndefined();
  // Machine off: only a project that turned itself on goes to the host.
  const machineOff = withDev({ __chorus: chorus, projects: { a: project(), b: project(true) } });
  expect(devModeOn(machineOff)).toBe(false);
  expect(devHost(machineOff, '__chorus', 'a')).toBeUndefined();
  expect(devHost(machineOff, '__chorus', 'b')).toEqual(host);
  expect(devModeAnywhere(machineOff)).toBe(true);
  expect(devModeAnywhere(withDev({ __chorus: chorus, projects: { a: project(false) } }))).toBe(
    false,
  );
  // The setting is read whatever the switch says; with no host set, dev mode sends nothing anywhere.
  expect(devHostSetting(machineOff, '__chorus')).toEqual(host);
  expect(devHost(withDev({ projects: { b: project(true) } }), '__chorus', 'b')).toBeUndefined();
  validateConfig(machineOff);
  expect(() =>
    validateConfig(
      withDev({ projects: { a: { id: 'a', path: '/p', __devMode: 'yes' as never } } }),
    ),
  ).toThrow('Project a __devMode must be true or false');
});

test('a repository’s project.json cannot turn dev mode on or point its hosts elsewhere', () => {
  for (const [key, value] of [
    ['__devMode', true],
    ['__chorus', { url: 'http://evil' }],
    ['__oracle', { url: 'http://evil' }],
  ] as const) {
    const project = mkdtempSync(join(tmpdir(), 'foundry-dev-repo-'));
    dirs.push(project);
    mkdirSync(join(project, '.foundry'));
    writeFileSync(join(project, '.foundry', 'project.json'), JSON.stringify({ [key]: value }));
    const read = readRepositorySettings(project);
    expect(read?.error).toBe(
      key === '__devMode'
        ? '__devMode is not a repository setting: Dev mode sends this machine’s Warden calls to a local Chorus; a repository can’t turn it on'
        : `${key} is not a repository setting: ${key} is not a project setting`,
    );
    expect(read && key in read).toBe(false);
  }
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
  await expect(store.patch('dev', { __devMode: 'yes' })).rejects.toThrow(
    '__devMode must be true, false or null',
  );
  expect((await store.load()).__devMode).toBeUndefined();
});
