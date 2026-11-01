import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRepositorySettings,
  settingLayer,
  writeRepositorySetting,
} from '../src/viewer/config-resolve';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("'set for everyone' writes one key of the committed project file and keeps the rest", () => {
  const project = mkdtempSync(join(tmpdir(), 'foundry-repo-settings-'));
  dirs.push(project);
  mkdirSync(join(project, '.foundry'));
  writeFileSync(
    join(project, '.foundry/project.json'),
    JSON.stringify({ $comment: 'team', chorus: { enabled: true } }),
  );
  writeRepositorySetting(project, 'conversations', { floor: 'conch' });
  expect(readRepositorySettings(project)).toMatchObject({
    chorus: { enabled: true },
    conversations: { floor: 'conch' },
  });
  expect(statSync(join(project, '.foundry/project.json')).mode & 0o777).toBe(0o644);
  writeRepositorySetting(project, 'chorus', null);
  const saved = JSON.parse(readFileSync(join(project, '.foundry/project.json'), 'utf8'));
  expect(saved).toEqual({ $comment: 'team', conversations: { floor: 'conch' } });
  writeFileSync(join(project, '.foundry/project.json'), '{"bogus": 1}');
  expect(() => writeRepositorySetting(project, 'chorus', { enabled: true })).toThrow('bogus');
});

test('a setting comes from this machine, else the repository, else the default', () => {
  expect(settingLayer(true, true)).toBe('settings');
  expect(settingLayer(false, true)).toBe('repository');
  expect(settingLayer(false, false)).toBe('default');
});
