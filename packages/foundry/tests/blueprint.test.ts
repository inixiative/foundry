import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { ContextStack, Thread } from '@inixiative/foundry-core';
import {
  BLUEPRINT_PLANS_AND_LOOPS_NOTE,
  FOUNDRY_TOOLS_NOTE,
  foundryToolsNote,
  PLAN_ASK_NOTE,
  planAskNote,
} from '../src/agents/chorus-reception';
import { artifactSchema, recordArtifact } from '../src/tools/thread-record';
import {
  blueprintDiagramsInPlansAndLoops,
  starterConfig,
  validateConfig,
  validateRepositoryProject,
} from '../src/viewer/config';
import { validateBlueprintSpec } from '../src/viewer/ui/markdown.js';

const SAMPLE_SCENE = {
  title: 'Cache Check',
  size: [600, 260],
  parts: [
    { id: 'client', kind: 'screen', at: [100, 130], label: 'CLIENT' },
    {
      id: 'cache',
      kind: 'drawer',
      at: [300, 130],
      n: 1,
      name: 'Cache',
      note: 'recent answers by the door',
      label: 'CACHE',
    },
    { id: 'db', kind: 'cabinet', at: [500, 130], n: 2, name: 'Database', label: 'DB' },
  ],
  lines: [
    { id: 'req', from: 'client.e', to: 'cache.w', arrow: true },
    { id: 'miss', from: 'cache.e', to: 'db.w', arrow: true },
  ],
  steps: [
    {
      say: 'A request arrives from the client and checks the cache (1).',
      draw: ['client', 'cache', 'req'],
      run: { on: 'req', item: 'chip', text: '#42' },
    },
    {
      say: 'On a miss, it falls through to the database (2).',
      draw: ['db', 'miss'],
      run: { on: 'miss', item: 'chip', text: '#42' },
    },
  ],
};

test('blueprintDiagramsInPlansAndLoops cascades personal project > repo > Foundry-wide > false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-blueprint-setting-'));
  try {
    const config = starterConfig();
    config.projects = { P: { id: 'P', path: dir } };
    expect(blueprintDiagramsInPlansAndLoops(config, 'P')).toBe(false);

    config.blueprintDiagrams = true;
    expect(blueprintDiagramsInPlansAndLoops(config, 'P')).toBe(true);

    mkdirSync(join(dir, '.foundry'), { recursive: true });
    writeFileSync(
      join(dir, '.foundry', 'project.json'),
      JSON.stringify({ blueprintDiagrams: false }),
    );
    expect(blueprintDiagramsInPlansAndLoops(config, 'P')).toBe(false);

    config.projects.P.blueprintDiagrams = true;
    expect(blueprintDiagramsInPlansAndLoops(config, 'P')).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateConfig and validateRepositoryProject reject non-boolean blueprintDiagrams', () => {
  const config = starterConfig();
  (config as { blueprintDiagrams: unknown }).blueprintDiagrams = 'yes';
  expect(() => validateConfig(config)).toThrow('blueprintDiagrams must be true or false');
  expect(() => validateRepositoryProject({ blueprintDiagrams: 'yes' })).toThrow(
    'blueprintDiagrams must be true or false',
  );
  expect(() => validateRepositoryProject({ blueprintDiagrams: true })).not.toThrow();
});

test('foundryToolsNote and planAskNote stay identical when off and include Blueprint guidance when on', () => {
  expect(foundryToolsNote(false)).toBe(FOUNDRY_TOOLS_NOTE);
  expect(foundryToolsNote(true)).toBe(`${FOUNDRY_TOOLS_NOTE}\n${BLUEPRINT_PLANS_AND_LOOPS_NOTE}`);
  expect(planAskNote(false)).toBe(PLAN_ASK_NOTE);
  expect(planAskNote(true)).toContain('kind: "blueprint"');
});

test('recordArtifact accepts kind: blueprint', () => {
  const parsed = artifactSchema.parse({
    id: 'cache-flow',
    title: 'Cache Check',
    kind: 'blueprint',
    content: JSON.stringify(SAMPLE_SCENE),
  });
  const thread = new Thread('bp-artifact', new ContextStack([]));
  const writes: unknown[] = [];
  const res = recordArtifact(thread, parsed, {
    write(_t, rec) {
      writes.push(rec);
      return { turnId: 'turn-1' };
    },
  });
  expect(res.written).toBe(true);
  expect(writes).toHaveLength(1);
  expect((thread.meta.artifacts as Array<{ kind: string }>)[0]?.kind).toBe('blueprint');
});

test('bundled blueprint check.mjs lints JSON scenes cleanly and fails invalid JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-blueprint-lint-'));
  try {
    const checkScript = resolve(
      import.meta.dir,
      '../src/plugin/skills/blueprint/scripts/check.mjs',
    );
    const validFile = join(dir, 'cache.json');
    writeFileSync(validFile, JSON.stringify(SAMPLE_SCENE));
    const ok = Bun.spawnSync(['node', checkScript, validFile], { stdout: 'pipe', stderr: 'pipe' });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toContain('clean');

    const badFile = join(dir, 'bad.json');
    writeFileSync(badFile, JSON.stringify({ title: 'Broken', parts: [], steps: [] }));
    const fail = Bun.spawnSync(['node', checkScript, badFile], { stdout: 'pipe', stderr: 'pipe' });
    expect(fail.exitCode).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vendored blueprint.js matches its pinned sha256 in vendor/manifest.json', () => {
  const vendorDir = resolve(import.meta.dir, '../src/viewer/ui/vendor');
  const manifest = JSON.parse(readFileSync(join(vendorDir, 'manifest.json'), 'utf8')) as {
    files: Array<{ file: string; sha256: string }>;
  };
  const entry = manifest.files.find((f) => f.file === 'blueprint.js');
  expect(entry).toBeDefined();
  if (!entry) throw new Error('missing blueprint.js entry in vendor/manifest.json');
  const actual = createHash('sha256')
    .update(readFileSync(join(vendorDir, 'blueprint.js')))
    .digest('hex');
  expect(actual).toBe(entry.sha256);
});

test('validateBlueprintSpec rejects oversized DoS specs, malformed run.span, compile errors, and empty steps', () => {
  const runtimePath = resolve(import.meta.dir, '../src/viewer/ui/vendor/blueprint.js');
  const box: Record<string, unknown> = {};
  box.globalThis = box;
  vm.runInNewContext(readFileSync(runtimePath, 'utf8'), box, { filename: runtimePath });
  const bp = box.BLUEPRINT;

  expect(() => validateBlueprintSpec(JSON.stringify(SAMPLE_SCENE), bp)).not.toThrow();
  expect(() =>
    validateBlueprintSpec(
      JSON.stringify({
        parts: [{ id: 't', kind: 'tank', at: [100, 100], w: 1e8, level: 0.5 }],
        steps: [{ say: 'x', draw: ['t'] }],
      }),
      bp,
    ),
  ).toThrow('dimension out of bounds');
  expect(() =>
    validateBlueprintSpec(
      JSON.stringify({
        parts: { id: 't', kind: 'tank', at: [100, 100], w: 1e8, level: 0.5 },
        steps: { say: 'x', draw: ['t'] },
      }),
      bp,
    ),
  ).toThrow('dimension out of bounds');
  expect(() =>
    validateBlueprintSpec(
      JSON.stringify({
        size: [1e6, 300],
        parts: [{ id: 'a', kind: 'box', at: [100, 100] }],
        steps: [{ say: 'x', draw: ['a'] }],
      }),
      bp,
    ),
  ).toThrow('size out of bounds');
  expect(() =>
    validateBlueprintSpec(
      JSON.stringify({
        parts: [{ id: 'a', kind: 'box', at: [100, 100] }],
        lines: [{ id: 'l', from: 'a.e', to: 'a.w' }],
        steps: [{ say: 'x', draw: ['a', 'l'], run: { on: 'l', span: [] } }],
      }),
      bp,
    ),
  ).toThrow('run.span');
  expect(() =>
    validateBlueprintSpec(
      JSON.stringify({
        parts: [{ id: 'a', kind: 'box', at: [100, 100] }],
        steps: [{ say: 'x', draw: ['missing'], run: { on: 'nope' } }],
      }),
      bp,
    ),
  ).toThrow();
  expect(() =>
    validateBlueprintSpec(JSON.stringify({ title: 'Empty', parts: [], steps: [] }), bp),
  ).toThrow('no steps');
});

test('Settings Search maps blueprintDiagrams to Foundry Threads and Project Agent sections', async () => {
  const prevLocation = (globalThis as Record<string, unknown>).location;
  const prevWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).location = { pathname: '/' };
  (globalThis as Record<string, unknown>).window = { addEventListener() {} };
  try {
    const { settingSection } = await import('../src/viewer/ui/route.js');
    expect(settingSection('foundry', 'blueprintDiagrams')).toBe('threads');
    expect(settingSection('project', 'blueprintDiagrams')).toBe('agent');
  } finally {
    if (prevLocation === undefined) delete (globalThis as Record<string, unknown>).location;
    else (globalThis as Record<string, unknown>).location = prevLocation;
    if (prevWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = prevWindow;
  }
});
