import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextStack, Thread } from '@inixiative/foundry-core';
import { ThreadContextTracker } from '../src/archives/thread-context';
import { releaseWorktree, squashMergedInto } from '../src/git';
import { starterConfig, threadOnMerge, validateConfig } from '../src/viewer/config';
import { m0Scenario } from './helpers/m0-domain-loop';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'on-merge-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  const main = join(root, 'main');
  const run = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(['git', '-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      stderr: 'ignore',
    });
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', origin]);
  Bun.spawnSync(['git', 'clone', '-q', origin, main], { stderr: 'ignore' });
  writeFileSync(join(main, 'a.txt'), 'a\n');
  run(main, 'add', '.');
  run(main, 'commit', '-q', '-m', 'init');
  run(main, 'push', '-q', 'origin', 'main');
  run(main, 'remote', 'set-head', 'origin', 'main');
  return { root, main, run };
}

test('a branch counts as merged once a squash of it is on the default branch, never before', async () => {
  const { root, main, run } = repo();
  const wt = join(root, 'wt');
  run(main, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  expect(await squashMergedInto(wt, 'feat/x')).toBeUndefined(); // no commits of its own yet
  writeFileSync(join(wt, 'b.txt'), 'b\n');
  run(wt, 'add', '.');
  run(wt, 'commit', '-q', '-m', 'feat');
  expect(await squashMergedInto(wt, 'feat/x')).toBeUndefined();
  // Squash-merge it on main and push: origin/main now holds the same tree.
  run(main, 'merge', '-q', '--squash', 'feat/x');
  run(main, 'commit', '-q', '-m', 'feat (#1)');
  run(main, 'push', '-q', 'origin', 'main');
  run(wt, 'fetch', '-q');
  expect(await squashMergedInto(wt, 'feat/x')).toBe('main');

  // Classic release: git worktree remove, refused while dirty, never forced.
  writeFileSync(join(wt, 'dirty.txt'), 'x');
  expect(await releaseWorktree({ mode: 'classic', root: main, path: wt })).toMatchObject({
    error: expect.stringContaining('git worktree remove refused'),
  });
  rmSync(join(wt, 'dirty.txt'));
  expect(await releaseWorktree({ mode: 'classic', root: main, path: wt })).toEqual({
    released: true,
  });
});

test('the tracker records the merge on the checkout once and reports it once', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'on-merge-cwd-')));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const thread = new Thread('t', new ContextStack(), { description: '', cwd });
  const merges: string[] = [];
  let into: string | undefined;
  const tracker = new ThreadContextTracker({
    thread: () => thread,
    changed: () => {},
    git: async () => ({ branch: 'feat/x', worktree: cwd }),
    place: async () => ({ mode: 'classic', path: cwd, root: tmpdir(), main: false }),
    merged: async () => into,
    onMerged: (_t, base) => merges.push(base),
  });
  await tracker.refresh('t');
  expect(thread.meta.context?.checkout?.merged).toBeUndefined();
  into = 'main';
  await tracker.refresh('t');
  expect(thread.meta.context?.checkout?.merged).toEqual({ into: 'main', at: expect.any(Number) });
  await tracker.refresh('t');
  expect(merges).toEqual(['main']);
});

test('threadOnMerge: project over Foundry-wide over done; anything else is refused', () => {
  const config = starterConfig('controlled', 'controlled');
  expect(threadOnMerge(config, 'P')).toBe('done');
  config.threadOnMerge = 'auto-archive';
  expect(threadOnMerge(config, 'P')).toBe('auto-archive');
  config.projects = {
    P: { id: 'P', name: 'P', path: '/p', threadOnMerge: 'done' },
  } as typeof config.projects;
  expect(threadOnMerge(config, 'P')).toBe('done');
  (config as { threadOnMerge: unknown }).threadOnMerge = 'delete';
  expect(() => validateConfig(config)).toThrow(
    'threadOnMerge must be one of "done", "auto-archive"',
  );
});

test('an outcome newly done is the thread’s milestone until its next task starts', async () => {
  const s = await m0Scenario();
  cleanup.push(() => s.close());
  s.current.plans.setPlan('a', {
    outcomes: [
      { text: 'History recorded', status: 'doing' },
      { text: 'Clear resets it', status: 'todo' },
    ],
  });
  expect(s.current.directory.get('a')?.meta.done).toBeUndefined();
  s.current.plans.setPlan('a', {
    outcomes: [
      { text: 'History recorded', status: 'done' },
      { text: 'Clear resets it', status: 'todo' },
    ],
  });
  expect(s.current.directory.get('a')?.meta.done).toEqual({
    kind: 'milestone',
    text: 'History recorded',
    at: expect.any(Number),
  });
  await s.send('a', 't1', 'Now make clear reset the cap too');
  await s.settled('a');
  expect(s.current.directory.get('a')?.meta.done).toBeUndefined();
});
