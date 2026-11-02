import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUBSCRIPTION_WORKER_MODELS } from '@inixiative/foundry-core';
import { defaultAgents, defaultConfig, type ProjectSettingsConfig } from '../src/viewer/config';
import {
  effectiveProject,
  readRepositorySettings,
  repositorySettingsProblem,
  resolveProjectView,
  setAtPath,
  settingLayer,
  writeRepositorySettings,
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
  writeRepositorySettings(project, [['conversations', { floor: 'conch' }]]);
  expect(readRepositorySettings(project)).toMatchObject({
    chorus: { enabled: true },
    conversations: { floor: 'conch' },
  });
  expect(statSync(join(project, '.foundry/project.json')).mode & 0o777).toBe(0o644);
  writeRepositorySettings(project, [['chorus', null]]);
  const saved = JSON.parse(readFileSync(join(project, '.foundry/project.json'), 'utf8'));
  expect(saved).toEqual({ $comment: 'team', conversations: { floor: 'conch' } });
  writeFileSync(join(project, '.foundry/project.json'), '{"bogus": 1}');
  expect(() => writeRepositorySettings(project, [['chorus', { enabled: true }]])).toThrow('bogus');
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
  config.agents = defaultAgents();
  config.agents.planner = { ...config.agents.executor!, id: 'planner' };
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
        reviewer: { extends: 'planner', prompt: 'team' },
        writer: { extends: 'executor', prompt: 'team' },
      },
    },
    {
      gloss: { enabled: false } as ProjectSettingsConfig['gloss'],
      agents: { writer: { extends: 'executor', prompt: 'mine' } },
    },
  );
  const project = effectiveProject(config, 'p')!;
  expect(project.threadOnMerge).toBe('auto-archive');
  expect(project.gloss).toEqual({ enabled: false, display: 'hover' });
  expect(project.feedback).toEqual({ capture: true });
  expect(project.agents).toEqual({
    reviewer: { extends: 'planner', prompt: 'team' },
    writer: { extends: 'executor', prompt: 'mine' },
  });
  expect(repositorySettingsProblem(config.projects.p!.path)).toBeUndefined();
  // Two project agents extending one global agent can't be built: the team's settings don't apply.
  const clash = projectWith(
    { threadOnMerge: 'auto-archive', agents: { a: { extends: 'executor' } } },
    {
      agents: { b: { extends: 'executor', prompt: 'mine' } },
    },
  );
  expect(effectiveProject(clash, 'p')!.threadOnMerge).toBeUndefined();
  expect(repositorySettingsProblem(clash.projects.p!.path)).toMatchObject({
    kind: 'unbuildable',
    message: expect.stringContaining('extend'),
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
  // My model wins when the team's worker runs it.
  const runs = projectWith(
    { defaults: { provider: 'codex', model: SUBSCRIPTION_WORKER_MODELS.codex } },
    { defaults: { model: 'gpt-6-luna' } },
  );
  expect(effectiveProject(runs, 'p')!.defaults!.model).toBe('gpt-6-luna');
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
    { sources: { notes: { id: 'notes', type: 'markdown', uri: '/Users/me/notes' } } },
    { defaults: { classifierProvider: 'anthropic' } },
    { defaults: { model: 'gpt-6-astra' } },
    { defaults: { provider: 'codex', codexEffort: 'bogus' } },
    { agents: [1, 2] },
    { agents: { cls: { kind: 'classifier', provider: 'anthropic' } } },
    { agents: { exec: { kind: 'executor', tools: true } } },
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

test('team settings this machine can’t build don’t apply here, and why is reported', () => {
  const config = projectWith({
    steer: false,
    agents: { reviewer: { extends: 'not-on-this-machine' } },
  });
  const path = config.projects.p!.path;
  expect(readRepositorySettings(path)?.error).toBeUndefined();
  const view = resolveProjectView(config, 'p')!;
  expect(view.config.agents.reviewer).toBeUndefined();
  expect(repositorySettingsProblem(path)?.message).toContain('not-on-this-machine');
});

test('a setting path never reaches an object’s prototype', () => {
  const root: Record<string, unknown> = {};
  for (const path of [
    ['gloss', '__proto__', 'polluted'],
    ['constructor', 'x'],
    ['a', 'prototype'],
  ])
    expect(() => setAtPath(root, path, 'yes')).toThrow('is not a setting');
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test('a repository’s agents are executors on a model their worker runs; decision roles stay this machine’s', () => {
  const withClassifier = (repository: unknown) => {
    const config = projectWith(repository);
    config.agents.classifier = { ...config.agents.executor!, id: 'classifier', kind: 'classifier' };
    return config;
  };
  // An extension carries no kind of its own: it is judged by the agent it extends.
  const extended = withClassifier({
    agents: { mine: { extends: 'classifier', model: 'claude-opus-5-5' } },
  });
  expect(effectiveProject(extended, 'p')!.agents).toBeUndefined();
  expect(repositorySettingsProblem(extended.projects.p!.path)?.message).toContain('decision roles');
  // An executor's model must be one the worker in effect runs.
  const offWorker = projectWith({
    agents: { coder: { extends: 'executor', model: 'gpt-6-astra' } },
  });
  expect(effectiveProject(offWorker, 'p')!.agents).toBeUndefined();
  expect(repositorySettingsProblem(offWorker.projects.p!.path)?.message).toContain('not a');
});

test('the verdict on the team’s settings follows the config asked about', () => {
  const without = projectWith({ agents: { r: { extends: 'planner' } } });
  delete without.agents.planner;
  const path = without.projects.p!.path;
  const withParent = structuredClone(without);
  withParent.agents.planner = { ...withParent.agents.executor!, id: 'planner' };
  effectiveProject(without, 'p');
  expect(repositorySettingsProblem(path)?.kind).toBe('unbuildable');
  effectiveProject(withParent, 'p');
  expect(repositorySettingsProblem(path)).toBeUndefined();
  // A memo hit restores its own verdict.
  effectiveProject(without, 'p');
  expect(repositorySettingsProblem(path)?.kind).toBe('unbuildable');
});
