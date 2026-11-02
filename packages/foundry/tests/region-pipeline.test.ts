import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectionTests, RegionPipelineRuns, regionBuilds } from '../src/viewer/region-pipeline';

function paths() {
  const root = mkdtempSync(join(tmpdir(), 'region-pipeline-'));
  const data = join(root, 'data');
  const oracle = join(root, 'oracle');
  mkdirSync(join(data, 'build-2026-10-31-c2475dd1'), { recursive: true });
  writeFileSync(
    join(data, 'build-2026-10-31-c2475dd1', 'BUILD.json'),
    JSON.stringify({
      templateCommit: 'c2475dd1',
      builtAt: '2026-10-31T21:40:16',
      regionsHash: 'cd4b',
      regions: { a: {}, b: {} },
      maxTokens: 19288,
      over20k: [],
      usage: { calls: 250 },
    }),
  );
  mkdirSync(join(data, 'draft'), { recursive: true });
  mkdirSync(join(oracle, 'docs', 'findings'), { recursive: true });
  writeFileSync(
    join(oracle, 'docs', 'findings', '2026-11-01-stage1-bar-1d1d20f7.json'),
    JSON.stringify({
      date: '2026-11-01',
      regions: '1d1d20f7',
      metrics: { reading: 'does not hold the bar' },
    }),
  );
  writeFileSync(join(oracle, 'docs', 'findings', '2026-11-01-l2-confirm.json'), '{}');
  mkdirSync(join(oracle, 'pipelines', 'warden-regions'), { recursive: true });
  writeFileSync(
    join(oracle, 'pipelines', 'warden-regions', 'build_regions.py'),
    'import sys\nprint("building", sys.argv[1], sys.argv[3])\n',
  );
  return { data, oracle };
}

test('the Knowledge page reads the last region builds and the last detection tests', () => {
  const p = paths();
  expect(regionBuilds(p)).toEqual([
    {
      dir: join(p.data, 'build-2026-10-31-c2475dd1'),
      templateCommit: 'c2475dd1',
      builtAt: '2026-10-31T21:40:16',
      regionsHash: 'cd4b',
      regions: 2,
      maxTokens: 19288,
      over20k: 0,
      usage: { calls: 250 },
    },
  ]);
  expect(detectionTests(p)).toEqual([
    {
      id: '2026-11-01-stage1-bar-1d1d20f7',
      date: '2026-11-01',
      regions: '1d1d20f7',
      reading: 'does not hold the bar',
      metrics: { reading: 'does not hold the bar' },
    },
  ]);
});

test('a region build runs only when asked, one at a time, and keeps its log', async () => {
  const p = paths();
  const runs = new RegionPipelineRuns(p);
  expect(runs.start('not a sha')).toEqual({ error: 'commit must be a git sha' });
  const run = runs.start('702ae17c');
  if ('error' in run) throw Error(run.error);
  expect(runs.start('702ae17c')).toEqual({ error: 'a region build is already running' });
  const end = Date.now() + 10_000;
  while (run.state === 'running' && Date.now() < end) await Bun.sleep(20);
  expect(run).toMatchObject({
    state: 'done',
    exitCode: 0,
    step: 'region-build',
    commit: '702ae17c',
  });
  expect(run.log).toContain(`building 702ae17c ${run.out}`);
  expect(runs.list()).toHaveLength(1);
});
