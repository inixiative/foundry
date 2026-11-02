/**
 * @atlas
 * @kind service
 * @partOf feature:viewer
 */
/**
 * Every setting Search can find: the catalog (key paths and descriptions generated from the config
 * interfaces, `scripts/settings-catalog.ts`) with each one's current value and where it comes from.
 * Foundry-wide settings are yours (settings.json) or the default; a project's are yours (its entry in
 * settings.json), everyone's (the repository's `.foundry/project.json`) or the default. Values of
 * credential-like keys are never shown.
 */

import { defaultConfig, type FoundryConfig } from './config';
import { readRepositorySettings } from './config-resolve';
import catalog from './settings-catalog.json';

export type SettingSource = 'yours' | 'everyone' | 'default';

export interface SettingHit {
  path: string;
  scope: 'foundry' | 'project';
  description: string;
  value: string | null;
  source: SettingSource;
}

const SECRET = /key|token|secret|password|credential/i;
const MAX_VALUE = 160;

/** The value at a dotted path, or undefined. */
function at(root: unknown, path: string[]): unknown {
  let node = root;
  for (const part of path) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function shown(path: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (SECRET.test(path)) return 'set (hidden)';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
}

/** A catalog path with `*` expanded to the keys present in any of the roots. */
function expand(path: string, roots: unknown[]): string[][] {
  let paths: string[][] = [[]];
  for (const part of path.split('.')) {
    if (part !== '*') {
      paths = paths.map((p) => [...p, part]);
      continue;
    }
    paths = paths.flatMap((p) => {
      const keys = new Set(
        roots.flatMap((root) => {
          const node = at(root, p);
          return node && typeof node === 'object' ? Object.keys(node) : [];
        }),
      );
      return [...keys].map((key) => [...p, key]);
    });
  }
  return paths;
}

export function settingsIndex(
  config: FoundryConfig,
  project?: { id: string; path: string },
): SettingHit[] {
  const defaults = defaultConfig();
  const hits: SettingHit[] = [];
  for (const entry of catalog as Array<{
    path: string;
    scope: 'foundry' | 'project';
    description: string;
  }>) {
    if (entry.scope === 'foundry') {
      for (const path of expand(entry.path, [config, defaults])) {
        const mine = at(config, path);
        const value = mine ?? at(defaults, path);
        hits.push({
          path: path.join('.'),
          scope: 'foundry',
          description: entry.description,
          value: shown(entry.path, value),
          source: mine !== undefined ? 'yours' : 'default',
        });
      }
      continue;
    }
    if (!project) continue;
    const personal = config.projects?.[project.id];
    const repository = readRepositorySettings(project.path);
    for (const path of expand(entry.path, [personal, repository])) {
      const mine = at(personal, path);
      const everyone = at(repository, path);
      hits.push({
        path: path.join('.'),
        scope: 'project',
        description: entry.description,
        value: shown(entry.path, mine ?? everyone),
        source: mine !== undefined ? 'yours' : everyone !== undefined ? 'everyone' : 'default',
      });
    }
  }
  return hits;
}
