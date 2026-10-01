import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { readState, recordBoot, releaseDir, selectRelease, stageUpdate } from './update';

const prepare = async () => {};
const identity = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'foundry-releases-'));
  const origin = join(root, 'origin.git'),
    repo = join(root, 'repo'),
    config = join(repo, '.foundry');
  await $`git init -q --bare -b main ${origin} && git clone -q ${origin} ${repo}`.quiet();
  const commit = async (content: string) => {
    await Bun.write(join(repo, 'version.txt'), content);
    await $`git add version.txt && git commit -q -m ${content} && git push -q origin HEAD:main`
      .cwd(repo)
      .env(identity)
      .quiet();
    return (await $`git -C ${repo} rev-parse HEAD`.quiet().text()).trim();
  };
  const autoUpdate = (mode: string) =>
    Bun.write(join(config, 'settings.json'), JSON.stringify({ daemon: { autoUpdate: mode } }));
  return { root, repo, config, commit, autoUpdate };
};

test('first boot runs stable seeded from HEAD; a staged candidate boots on trial and becomes stable', async () => {
  const f = await fixture();
  try {
    const a = await f.commit('a');
    const first = await selectRelease(f.repo, f.config, prepare);
    expect(first).toEqual({ sha: a, dir: releaseDir(f.config, a), trial: false });
    expect(await Bun.file(join(first.dir, 'version.txt')).text()).toBe('a');

    const b = await f.commit('b');
    await f.autoUpdate('check');
    expect(await stageUpdate(f.repo, f.config, 'main', prepare)).toEqual({
      action: 'reported',
      target: b,
    });
    await f.autoUpdate('apply');
    expect(await stageUpdate(f.repo, f.config, 'main', prepare)).toEqual({
      action: 'staged',
      target: b,
    });

    const trial = await selectRelease(f.repo, f.config, prepare);
    expect(trial).toEqual({ sha: b, dir: releaseDir(f.config, b), trial: true });
    await recordBoot(f.config, trial);
    expect(await readState(f.config)).toEqual({ stable: b, previous: a, failed: [] });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a candidate whose boot never completed is rejected, the relaunch runs stable, and it is never staged again', async () => {
  const f = await fixture();
  try {
    const a = await f.commit('a');
    await selectRelease(f.repo, f.config, prepare);
    await f.autoUpdate('apply');
    const bad = await f.commit('bad');
    await stageUpdate(f.repo, f.config, 'main', prepare);
    expect((await selectRelease(f.repo, f.config, prepare)).trial).toBe(true);

    // The trial boot died without reaching recordBoot; launchd relaunches.
    expect(await selectRelease(f.repo, f.config, prepare)).toEqual({
      sha: a,
      dir: releaseDir(f.config, a),
      trial: false,
    });
    expect((await readState(f.config)).failed).toEqual([bad]);
    expect(existsSync(releaseDir(f.config, bad))).toBe(false);
    expect(await stageUpdate(f.repo, f.config, 'main', prepare)).toEqual({
      action: 'skipped',
      target: bad,
      detail: 'it failed to boot before',
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a failed build stages nothing, and only stable and the release before it are kept', async () => {
  const f = await fixture();
  try {
    await f.commit('a');
    await selectRelease(f.repo, f.config, prepare);
    await f.autoUpdate('apply');
    await f.commit('b');
    const failed = await stageUpdate(f.repo, f.config, 'main', async () => {
      throw new Error('install failed');
    });
    expect(failed.action).toBe('failed');
    expect((await readState(f.config)).candidate).toBeUndefined();

    for (const version of ['b', 'c', 'd']) {
      if (version !== 'b') await f.commit(version);
      await stageUpdate(f.repo, f.config, 'main', prepare);
      await recordBoot(f.config, await selectRelease(f.repo, f.config, prepare));
    }
    const state = await readState(f.config);
    expect((await readdir(join(f.config, 'releases'))).sort()).toEqual(
      [state.previous!, state.stable!, 'state.json'].sort(),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a failed fetch reports what git said', async () => {
  const f = await fixture();
  try {
    await f.commit('a');
    await f.autoUpdate('apply');
    await $`git -C ${f.repo} remote set-url origin ${join(f.root, 'missing.git')}`.quiet();
    const result = await stageUpdate(f.repo, f.config, 'main', prepare);
    expect(result.action).toBe('failed');
    expect((result as { detail: string }).detail).toContain(
      'does not appear to be a git repository',
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
