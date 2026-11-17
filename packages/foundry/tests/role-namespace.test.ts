/**
 * @atlas
 * @kind test
 * @partOf feature:composition, feature:wardens
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { roleDirectory } from '@inixiative/foundry-core';
import { configuredExperts } from '../src/agents/configured-experts';
import { regionOfSubject, regionRoleId, regionSourceId } from '../src/agents/region-roster';
import { roleFilePath } from '../src/feedback/apply';
import {
  ASSISTANT_ROLE,
  CODER_ROLE,
  FEEDBACK_ROLE,
  FORGE_MASTER_ROLE,
  MAIN_ROLE,
} from '../src/prompts/instruction-settings';
import {
  isIdName,
  isRoleId,
  roleIdIn,
  roleNameIn,
  roleNamespace,
} from '../src/prompts/role-namespace';
import { type FoundryConfig, starterConfig, validateConfig } from '../src/viewer/config';
import { resolveProjectView } from '../src/viewer/config-resolve';
import { writeRegions } from './helpers/regions';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectWithRegions(ids: readonly string[]): string {
  const project = mkdtempSync(join(tmpdir(), 'role-namespace-'));
  dirs.push(project);
  writeRegions(
    project,
    ids.map((id) => ({ id })),
  );
  return project;
}

function config(project: string): FoundryConfig {
  const c = starterConfig('central', 'central-model');
  c.layers = {};
  c.sources = {};
  c.projects.P = { id: 'P', path: project };
  return c;
}

test('a role id is built from a namespace and read back by it', () => {
  const id = roleIdIn(roleNamespace.region, 'lens-model');
  expect(id).toBe('region:lens-model');
  expect(regionRoleId('lens-model')).toBe(id);
  expect(roleNameIn(roleNamespace.region, id)).toBe('lens-model');
  expect(roleNameIn(roleNamespace.region, 'lens-model')).toBeUndefined();
  expect(isRoleId(id)).toBe(true);
  expect(isRoleId('main')).toBe(true);
  expect(isIdName('lens-model')).toBe(true);
  expect(isIdName(id)).toBe(false);
  // The region's source id is in the same namespace, in its own id space (sources, never agents).
  expect(regionSourceId('lens-model')).toBe(id);
  expect(regionOfSubject(`source-content:${id}@project:P`)).toBe('lens-model');
  for (const bad of ['region:', ':lens', 'region:../escape', 'region:a/b', '../escape', ''])
    expect(isRoleId(bad)).toBe(false);
});

test("a namespaced role's files nest by namespace on every rung", () => {
  expect(roleDirectory('region:lens-model')).toBe('region/lens-model');
  expect(roleDirectory('main')).toBe('main');
  const roots = { home: '/home/u', project: '/work/org/repo' };
  expect(roleFilePath('project', 'region:lens-model', 'instructions', roots)).toBe(
    '/work/org/repo/.foundry/roles/region/lens-model/instructions.md',
  );
  expect(roleFilePath('computer', 'region:lens-model', 'domainKnowledge', roots)).toBe(
    '/home/u/.foundry/roles/region/lens-model/domainKnowledge.md',
  );
  expect(() => roleFilePath('project', 'region:../escape', 'instructions', roots)).toThrow(
    'Invalid role id',
  );
});

test('a region may carry the name of any built-in role: its Warden is its own role', () => {
  // Foundry's own region `feedback` took the Feedback scope role's id while both were bare names,
  // and no Foundry with that project could boot (2026-11-16).
  const names = [
    MAIN_ROLE,
    CODER_ROLE,
    ASSISTANT_ROLE,
    FORGE_MASTER_ROLE,
    FEEDBACK_ROLE,
    'cartographer',
  ];
  const c = config(projectWithRegions(names));
  validateConfig(c);
  const view = resolveProjectView(c, 'P')!;
  expect(view.chorus.on).toBe(true);
  const experts = configuredExperts(view.config).experts;
  expect(experts.map((e) => e.domain).sort()).toEqual([...names].sort());
  for (const expert of experts) {
    expect(expert.agentId).toBe(regionRoleId(expert.domain));
    expect(names).not.toContain(expert.agentId);
  }
});

test("a region Warden's role is never a thread role", () => {
  const c = config(projectWithRegions(['lens-model']));
  c.composition = { roles: { [regionRoleId('lens-model')]: { thread: { label: 'Lens' } } } };
  expect(() => validateConfig(c)).toThrow("is a region Warden's role, never a thread role");
});

test("Foundry's own regions build a chorus: every committed region resolves to a Warden", () => {
  const repository = resolve(import.meta.dir, '..', '..', '..');
  const regionsDir = join(repository, '.foundry', 'regions');
  const committed = readdirSync(regionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(committed.length).toBeGreaterThan(0);
  const c = config(repository);
  validateConfig(c);
  const view = resolveProjectView(c, 'P')!;
  expect(view.chorus.reason).toBeUndefined();
  expect(view.chorus).toMatchObject({ on: true, enabledBy: 'repository' });
  expect(
    configuredExperts(view.config)
      .experts.map((e) => e.domain)
      .sort(),
  ).toEqual(committed);
});

test("a repository's project.json cannot write an agent over a region Warden", () => {
  const project = projectWithRegions(['conventions']);
  writeFileSync(
    join(project, '.foundry', 'project.json'),
    JSON.stringify({
      chorus: { enabled: true },
      agents: { [regionRoleId('conventions')]: { extends: 'executor' } },
    }),
  );
  const c = config(project);
  validateConfig(c);
  const view = resolveProjectView(c, 'P')!;
  // The file is refused whole and said so; nothing of it is applied.
  expect(view.chorus.repository?.error).toContain('the region: prefix names a region Warden');
  expect(view.config.agents[regionRoleId('conventions')]?.kind).not.toBe('executor');
});
