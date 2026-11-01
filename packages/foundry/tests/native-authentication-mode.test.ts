import { expect, test } from 'bun:test';
import { codexReadsUserHome } from '../src/prompts/instruction-stack';
import {
  nativeAuthenticationMode,
  projectRunsOnKingdom,
} from '../src/providers/native-authentication-mode';
import { defaultConfig } from '../src/viewer/config';

const codex = () => {
  const config = defaultConfig();
  config.apiTokens = true; // no subscription policy: the login is decided by the rule under test
  config.defaults.provider = 'codex';
  config.projects = {
    pool: { id: 'pool', path: '/tmp/pool', capacity: 'kingdom' },
    mine: { id: 'mine', path: '/tmp/mine' },
  };
  return config;
};

test('one rule decides the login: Kingdom bindings, else native profiles, else the user', () => {
  const config = codex();
  expect(nativeAuthenticationMode(config)).toBe('user');
  config.defaults.nativeAuthenticationId = 'work';
  expect(nativeAuthenticationMode(config)).toBe('native-profile');
  config.kingdomInferenceAssignments = { thread: { ownerKey: 'Organization::o:' } };
  expect(nativeAuthenticationMode(config)).toBe('kingdom');
});

test("Codex reads the user's own home only for a project that runs on the user's login", () => {
  const config = codex();
  expect(projectRunsOnKingdom(config, 'pool')).toBe(true);
  expect(codexReadsUserHome(config, 'mine')).toBe(true);
  expect(codexReadsUserHome(config, undefined)).toBe(true);
  // A project on a Kingdom capacity pool runs Codex on the pool's login, not ~/.codex.
  expect(codexReadsUserHome(config, 'pool')).toBe(false);
  config.defaults.nativeAuthenticationId = 'work';
  expect(codexReadsUserHome(config, 'mine')).toBe(false);
});
