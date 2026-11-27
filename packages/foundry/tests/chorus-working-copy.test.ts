import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chorusWorkingCopyDir } from '../src/agents/chorus-working-copy';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const checkout = (origin?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'chorus-working-copy-'));
  dirs.push(dir);
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', '-C', dir, ...args], { stderr: 'ignore' });
  git('init', '-q');
  if (origin) git('remote', 'add', 'origin', origin);
  return dir;
};

const home = process.env.CHORUS_HOME!;

test.each([
  ['git@github.com:inixiative/kingdom.git'],
  ['https://github.com/inixiative/kingdom.git'],
  ['https://github.com/inixiative/kingdom'],
  ['ssh://git@github.com/inixiative/kingdom.git'],
])('the working copy of a checkout whose origin is %s is <CHORUS_HOME>/projects/inixiative/kingdom', (origin) => {
  expect(chorusWorkingCopyDir(checkout(origin))).toBe(
    join(home, 'projects', 'inixiative', 'kingdom'),
  );
});

test('a checkout with no origin has no working copy', () => {
  expect(chorusWorkingCopyDir(checkout())).toBeNull();
});

test('a checkout that gains its own .git is read again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chorus-working-copy-'));
  dirs.push(dir);
  const inner = join(dir, 'inner');
  mkdirSync(inner);
  expect(chorusWorkingCopyDir(inner)).toBeNull();
  Bun.spawnSync(['git', '-C', inner, 'init', '-q']);
  Bun.spawnSync(['git', '-C', inner, 'remote', 'add', 'origin', 'git@github.com:test/inner.git']);
  expect(chorusWorkingCopyDir(inner)).toBe(join(home, 'projects', 'test', 'inner'));
});
