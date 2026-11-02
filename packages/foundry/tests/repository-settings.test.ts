import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUBSCRIPTION_WORKER_MODELS } from '@inixiative/foundry-core';
import { defaultConfig, type ProjectSettingsConfig } from '../src/viewer/config';
import {
  effectiveProject,
  readRepositorySettings,
  resolveProjectView,
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

const projectWith = (repository: unknown, mine: Partial<ProjectSettingsConfig> = {}) => {
  const path = mkdtempSync(join(tmpdir(), 'foundry-effective-'));
  dirs.push(path);
  mkdirSync(join(path, '.foundry'));
  writeFileSync(join(path, '.foundry/project.json'), JSON.stringify(repository));
  const config = defaultConfig();
  config.projects.p = { id: 'p', path, ...mine };
  return config;
};

test('a project applies this machine’s settings over the repository’s, key by key', () => {
  const config = projectWith(
    {
      threadOnMerge: 'auto-archive',
      gloss: { enabled: true, display: 'hover' },
      feedback: { capture: true },
      agents: {
        reviewer: { extends: 'base', prompt: 'team' },
        writer: { extends: 'base', prompt: 'team' },
      },
    },
    {
      gloss: { enabled: false } as ProjectSettingsConfig['gloss'],
      agents: { writer: { extends: 'base', prompt: 'mine' } },
    },
  );
  const project = effectiveProject(config, 'p')!;
  expect(project.threadOnMerge).toBe('auto-archive');
  expect(project.gloss).toEqual({ enabled: false, display: 'hover' });
  expect(project.feedback).toEqual({ capture: true });
  expect(project.agents).toEqual({
    reviewer: { extends: 'base', prompt: 'team' },
    writer: { extends: 'base', prompt: 'mine' },
  });
  // The raw settings stay this machine's alone: nothing of the repository's is copied into them.
  expect(config.projects.p!.threadOnMerge).toBeUndefined();
});

test('the worker and its model are one unit: they come from the layer that names the worker', () => {
  const team = projectWith({ defaults: { provider: 'codex' } });
  expect(effectiveProject(team, 'p')!.defaults).toMatchObject({
    provider: 'codex',
    model: SUBSCRIPTION_WORKER_MODELS.codex,
  });
  // My model alone doesn't pair with the team's worker unless that worker runs it.
  const mismatched = projectWith(
    { defaults: { provider: 'codex' } },
    { defaults: { model: 'fable' } },
  );
  expect(effectiveProject(mismatched, 'p')!.defaults!.model).toBe(SUBSCRIPTION_WORKER_MODELS.codex);
  // My worker brings my model.
  const mine = projectWith(
    { defaults: { provider: 'codex' } },
    { defaults: { provider: 'claude-code', model: 'fable' } },
  );
  expect(effectiveProject(mine, 'p')!.defaults).toMatchObject({
    provider: 'claude-code',
    model: 'fable',
  });
});

test('a repository file that breaks a rule is reported and none of it applies', () => {
  for (const bad of [
    { toolRules: {} },
    { label: 'team name' },
    { defaults: { nativeAuthenticationId: 'mine' } },
    { defaults: { provider: 'codex', model: 'fable' } },
    { agents: { w: { kind: 'domain-librarian' } } },
    { threadOnMerge: 'never' },
  ]) {
    const config = projectWith({ ...bad, steer: false });
    expect(readRepositorySettings(config.projects.p!.path)?.error).toBeString();
    expect(effectiveProject(config, 'p')).toEqual(config.projects.p);
  }
});

test('settings.json is checked without the repository: a teammate’s worker never stops it loading', () => {
  const config = projectWith({ defaults: { provider: 'muse' } });
  expect(resolveProjectView(config, 'p', { repository: false })!.config.defaults.provider).toBe(
    config.defaults.provider,
  );
  expect(resolveProjectView(config, 'p')!.config.defaults.provider).toBe('muse');
});
