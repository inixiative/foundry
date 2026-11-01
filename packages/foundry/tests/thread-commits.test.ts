import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
import { branchCommits } from '../src/git';
import { createViewer } from '../src/viewer/server';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function git(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
}

/** A repo on `main` with one commit, then a `feat` branch two commits ahead. */
function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-commits-'));
  cleanup.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat');
  for (const name of ['b', 'c']) {
    writeFileSync(join(dir, `${name}.txt`), name);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `add ${name}`);
  }
  return dir;
}

test('branchCommits lists the checkout ahead of its base, newest first', async () => {
  const dir = fixtureRepo();
  const { base, commits } = await branchCommits(dir);
  expect(base).toBe('main');
  expect(commits.map((c) => c.subject)).toEqual(['add c', 'add b']);
  expect(commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
  expect(commits[0]!.author).toBe('Fixture');
  expect(commits[0]!.at).toBeGreaterThan(0);
});

test("GET /api/threads/:id/commits reads the thread's worktree, read-only", async () => {
  const dir = fixtureRepo();
  const configDir = mkdtempSync(join(tmpdir(), 'foundry-commits-config-'));
  cleanup.push(configDir);
  const main = new Thread('main', new ContextStack());
  main.meta.cwd = dir;
  const bare = new Thread('bare', new ContextStack());
  const viewer = createViewer({
    harness: new Harness(main),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir,
    localStore: null,
  });
  viewer.directory.add(bare);
  try {
    const res = await viewer.app.request('/api/threads/main/commits');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { base: string; commits: Array<{ subject: string }> };
    expect(body.base).toBe('main');
    expect(body.commits.map((c) => c.subject)).toEqual(['add c', 'add b']);

    const none = await viewer.app.request('/api/threads/bare/commits');
    expect(await none.json()).toEqual({ base: null, commits: [] });

    expect((await viewer.app.request('/api/threads/missing/commits')).status).toBe(404);
  } finally {
    await viewer.analyticsReady.catch(() => {});
  }
});
