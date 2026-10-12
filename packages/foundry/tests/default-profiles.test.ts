import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultProfileDirectory,
  isDefaultProfile,
  profileEnvironment,
} from '../src/providers/default-profiles';

const home = process.env.HOME;
const roots: string[] = [];
afterEach(() => {
  process.env.HOME = home;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshHome() {
  const root = mkdtempSync(join(tmpdir(), 'default-profiles-'));
  roots.push(root);
  process.env.HOME = root;
  return root;
}

test('a default login not created yet is still the default profile', () => {
  freshHome();
  for (const runtime of ['claude', 'codex'] as const) {
    expect(isDefaultProfile(defaultProfileDirectory(runtime), runtime)).toBe(true);
    expect(profileEnvironment(runtime, defaultProfileDirectory(runtime))).toEqual({});
  }
});

test('another directory is a separate profile', () => {
  const root = freshHome();
  expect(isDefaultProfile(join(root, 'other'), 'codex')).toBe(false);
  expect(profileEnvironment('codex', join(root, 'other'))).toEqual({
    CODEX_HOME: join(root, 'other'),
  });
});
