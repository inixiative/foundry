import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSettingsCatalog, CATALOG_FILE } from '../../../scripts/settings-catalog';
import { defaultConfig } from '../src/viewer/config';
import { splitSections } from '../src/viewer/doc-sections';
import { settingsIndex } from '../src/viewer/settings-search';

test('the committed settings catalog matches the config interfaces (run bun scripts/settings-catalog.ts)', () => {
  expect(JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))).toEqual(buildSettingsCatalog());
});

test('the catalog takes each key and its JSDoc, nested interfaces and maps included', () => {
  const catalog = buildSettingsCatalog(`
    interface Inner {
      /** How deep. */
      depth?: number;
    }
    export interface FoundryConfig {
      /** Your name. */ installationName?: string;
      tunnel?: Inner;
      agents: Record<string, Inner>;
      projects: Record<string, ProjectSettingsConfig>;
    }
    export interface ProjectSettingsConfig {
      /** Run it. */
      enabled?: boolean;
    }
  `);
  expect(catalog).toEqual([
    { path: 'installationName', scope: 'foundry', description: 'Your name.' },
    { path: 'tunnel', scope: 'foundry', description: '' },
    { path: 'tunnel.depth', scope: 'foundry', description: 'How deep.' },
    { path: 'agents', scope: 'foundry', description: '' },
    { path: 'agents.*.depth', scope: 'foundry', description: 'How deep.' },
    { path: 'enabled', scope: 'project', description: 'Run it.' },
  ]);
});

test('a setting says whether it is yours, everyone’s or the default, and never shows a credential', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-index-'));
  try {
    mkdirSync(join(dir, '.foundry'));
    writeFileSync(
      join(dir, '.foundry', 'project.json'),
      JSON.stringify({ chorus: { enabled: true } }),
    );
    const config = { ...defaultConfig(), installationName: 'Studio' };
    config.projects = { shop: { id: 'shop', path: dir, conversations: { maxAgentTurns: 3 } } };
    const index = settingsIndex(config, { id: 'shop', path: dir });
    const find = (scope: string, path: string) =>
      index.find((s) => s.scope === scope && s.path === path);
    expect(find('foundry', 'installationName')).toMatchObject({ value: 'Studio', source: 'yours' });
    expect(find('project', 'chorus.enabled')).toMatchObject({ value: 'true', source: 'everyone' });
    // A key typed from another file (conversations' zod schema) is one entry with its whole value.
    expect(find('project', 'conversations')).toMatchObject({
      value: '{"maxAgentTurns":3}',
      source: 'yours',
    });
    expect(
      index
        .filter((s) => /key|token|secret|password|credential/i.test(s.path) && s.value)
        .every((s) => s.value === 'set (hidden)'),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a doc splits at its headings, ignoring # inside code fences', () => {
  expect(
    splitSections('Intro\n# Locks\nUse withLock.\n```\n# not a heading\n```\n## Retries\nThree.'),
  ).toEqual([
    { heading: null, level: 0, text: 'Intro' },
    { heading: 'Locks', level: 1, text: 'Use withLock.\n```\n# not a heading\n```' },
    { heading: 'Retries', level: 2, text: 'Three.' },
  ]);
});
