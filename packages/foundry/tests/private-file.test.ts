import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic, writePrivateFile } from '../src/client/private-file';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-atomic-'));
  dirs.push(dir);
  return dir;
};

test('an atomic write replaces the file whole, with the mode asked for', () => {
  const dir = scratch();
  const shared = join(dir, 'project.json');
  writeFileAtomic(shared, 'one', 0o644);
  writeFileAtomic(shared, 'two', 0o644);
  expect(readFileSync(shared, 'utf8')).toBe('two');
  expect(statSync(shared).mode & 0o777).toBe(0o644);
  const secret = join(dir, 'secret.json');
  writePrivateFile(secret, '{}');
  expect(statSync(secret).mode & 0o777).toBe(0o600);
  writeFileAtomic(join(dir, 'bytes.bin'), new Uint8Array([1, 2, 3]), 0o600);
  expect([...readFileSync(join(dir, 'bytes.bin'))]).toEqual([1, 2, 3]);
  expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});

test('a failed atomic write leaves the old file and no temporary file behind', () => {
  const dir = scratch();
  const target = join(dir, 'target');
  mkdirSync(target); // renaming a file over a directory fails
  expect(() => writeFileAtomic(target, 'new', 0o600)).toThrow();
  expect(statSync(target).isDirectory()).toBe(true);
  expect(readdirSync(dir)).toEqual(['target']);
});
