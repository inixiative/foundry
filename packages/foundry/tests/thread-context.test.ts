import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ArchiveSnapshot, archiveSnapshotSchema } from '@inixiative/archive';
import { ContextStack, Thread } from '@inixiative/foundry-core';
import { snapshotReferences, ThreadContextTracker } from '../src/archives/thread-context';
import { checkoutPlace, gitContext } from '../src/git';

const snapshot = (sessionId: string, texts: string[]): ArchiveSnapshot =>
  archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId: '00000000-0000-4000-8000-000000000000',
    source: 'foundry',
    sessionId,
    title: sessionId,
    tags: [],
    capturedAt: 1,
    coverage: { reasoning: 'unavailable', completeness: 'partial', omissions: [] },
    entries: texts.map((text, i) => ({
      id: `e${i}`,
      kind: 'tool-result',
      text,
      timestamp: i,
      sourceRef: `e${i}`,
    })),
  });

test("a thread's linked PRs and tickets come from Archive's reference tags, most-linked first, with link-outs", () => {
  const refs = snapshotReferences(
    snapshot('t', [
      'Opened https://github.com/inixiative/foundry/pull/60',
      'CI for https://github.com/inixiative/foundry/pull/60 is green; see https://github.com/inixiative/archive/issues/9',
      'Ticket https://linear.app/inixiative/issue/ENG-42/thread-names and commit https://github.com/inixiative/foundry/commit/abcdef1234',
    ]),
  );
  expect(refs).toEqual([
    {
      integration: 'github',
      ref: 'inixiative/foundry#60',
      url: 'https://github.com/inixiative/foundry/pull/60',
    },
    {
      integration: 'github',
      ref: 'inixiative/archive#9',
      url: 'https://github.com/inixiative/archive/pull/9',
    },
    { integration: 'linear', ref: 'ENG-42', url: 'https://linear.app/inixiative/issue/ENG-42' },
  ]);
});

test('the tracker derives repository, branch and worktree from git and publishes only real changes', async () => {
  const thread = new Thread('t', new ContextStack(), {
    description: '',
    cwd: '/w/foundry-thread-names/packages',
  });
  let changes = 0;
  let branch = 'feat/thread-names-and-context';
  const tracker = new ThreadContextTracker({
    thread: (id) => (id === 't' ? thread : undefined),
    changed: () => changes++,
    git: async () => ({
      remote: 'git@github.com:inixiative/foundry.git',
      branch,
      worktree: '/w/foundry-thread-names',
    }),
  });
  await tracker.observe(snapshot('t', ['https://github.com/inixiative/foundry/pull/60']));
  expect(thread.meta.context).toMatchObject({
    repository: 'inixiative/foundry',
    branch: 'feat/thread-names-and-context',
    worktree: '/w/foundry-thread-names',
    references: [{ integration: 'github', ref: 'inixiative/foundry#60' }],
  });
  expect(changes).toBe(1);
  await tracker.refresh('t');
  expect(changes).toBe(1);
  branch = 'fix/follow-up';
  await tracker.refresh('t');
  expect(thread.meta.context?.branch).toBe('fix/follow-up');
  expect(thread.meta.context?.references).toHaveLength(1);
  expect(changes).toBe(2);
});

test('concurrent refreshes coalesce into one rerun', async () => {
  const thread = new Thread('t', new ContextStack(), { description: '', cwd: '/w' });
  let calls = 0;
  const tracker = new ThreadContextTracker({
    thread: () => thread,
    changed: () => {},
    git: async () => {
      calls++;
      await Bun.sleep(5);
      return { branch: 'main' };
    },
  });
  await Promise.all([tracker.refresh('t'), tracker.refresh('t'), tracker.refresh('t')]);
  await Bun.sleep(20);
  expect(calls).toBe(2);
  expect(thread.meta.context?.branch).toBe('main');
});

test('gitContext reads the origin, checked-out branch and worktree root of a real checkout', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thread-context-')));
  try {
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', '-C', root, ...args], { stderr: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('remote', 'add', 'origin', 'https://github.com/inixiative/foundry.git');
    git('checkout', '-q', '-b', 'feat/x');
    mkdirSync(join(root, 'sub'));
    expect(await gitContext(join(root, 'sub'))).toEqual({
      remote: 'https://github.com/inixiative/foundry.git',
      branch: 'feat/x',
      worktree: root,
    });
    expect(await gitContext(join(root, 'missing'))).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a thread's checkout record: template mode and slot from the repository, released once its worktree is gone", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thread-checkout-')));
  try {
    const main = join(root, 'main');
    mkdirSync(main);
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', '-C', main, ...args], { stderr: 'ignore' });
    git('init', '-q', '-b', 'main');
    writeFileSync(
      join(main, 'package.json'),
      JSON.stringify({ scripts: { 'worktree:create': './scripts/worktree/create.sh' } }),
    );
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    const linked = join(main, '.worktrees', 'feat-x');
    git('worktree', 'add', '-q', '-b', 'feat/x', linked);
    writeFileSync(join(linked, '.env.local'), 'API_PORT=8400\nWORKTREE_SLOT="3"\n');

    const thread = new Thread('t', new ContextStack(), { description: '', cwd: linked });
    const onMain = new Thread('m', new ContextStack(), { description: '', cwd: main });
    const outside = new Thread('o', new ContextStack(), { description: '', cwd: root });
    const threads = new Map([thread, onMain, outside].map((t) => [t.id, t]));
    const tracker = new ThreadContextTracker({
      thread: (id) => threads.get(id),
      changed: () => {},
    });

    await Promise.all([tracker.refresh('t'), tracker.refresh('m'), tracker.refresh('o')]);
    expect(thread.meta.context?.checkout).toEqual({
      mode: 'template',
      path: linked,
      root: main,
      main: false,
      slot: 3,
      state: 'live',
    });
    expect(onMain.meta.context?.checkout).toEqual({
      mode: 'template',
      path: main,
      root: main,
      main: true,
      slot: 0,
      state: 'live',
    });
    expect(outside.meta.context?.checkout).toEqual({ mode: 'none', main: false, state: 'live' });

    git('worktree', 'remove', '--force', linked);
    await tracker.refresh('t');
    expect(thread.meta.context).toMatchObject({
      branch: 'feat/x',
      worktree: linked,
      checkout: { mode: 'template', path: linked, slot: 3, state: 'released' },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repository without worktree:create is classic mode, with no slot', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thread-classic-')));
  try {
    Bun.spawnSync(['git', '-C', root, 'init', '-q', '-b', 'main']);
    expect(await checkoutPlace(root)).toEqual({
      mode: 'classic',
      path: root,
      root,
      main: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a released worktree is recreated from its branch with the repository mode, and its record goes live again', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thread-recreate-')));
  try {
    const main = join(root, 'main');
    mkdirSync(main);
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', '-C', main, ...args], { stderr: 'ignore' });
    git('init', '-q', '-b', 'main');
    // A template-mode repository whose create attaches the branch the way template's does.
    writeFileSync(
      join(main, 'package.json'),
      JSON.stringify({
        scripts: {
          'worktree:create':
            'sh -c \'git worktree add -q .worktrees/$(echo "$1" | tr / -) "$1"\' --',
        },
      }),
    );
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    const linked = join(main, '.worktrees', 'feat-x');
    git('worktree', 'add', '-q', '-b', 'feat/x', linked);
    mkdirSync(join(linked, 'sub'));
    writeFileSync(join(linked, 'sub', 'f'), '');
    git('-C', linked, 'add', '.');
    git('-C', linked, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'sub');

    const thread = new Thread('t', new ContextStack(), {
      description: '',
      cwd: join(linked, 'sub'),
    });
    const tracker = new ThreadContextTracker({ thread: () => thread, changed: () => {} });
    expect(tracker.recreate('t')).toEqual({ error: 'only a released worktree can be recreated' });
    await tracker.refresh('t');
    git('worktree', 'remove', '--force', linked);
    await tracker.refresh('t');
    expect(thread.meta.context?.checkout?.state).toBe('released');

    const run = tracker.recreate('t');
    if ('error' in run) throw Error(run.error);
    expect(thread.meta.context?.checkout?.state).toBe('recreating');
    await run.started;
    expect(thread.meta.context?.checkout).toEqual({
      mode: 'template',
      path: linked,
      root: main,
      main: false,
      state: 'live',
    });
    expect(thread.meta.context?.branch).toBe('feat/x');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed recreate leaves the worktree released, with the command error on the record', async () => {
  const thread = new Thread('t', new ContextStack(), { description: '', cwd: '/gone/wt' });
  thread.meta.context = {
    branch: 'feat/y',
    worktree: '/gone/wt',
    checkout: { mode: 'classic', path: '/gone/wt', root: '/gone', main: false, state: 'released' },
    references: [],
    updatedAt: 1,
  };
  const tracker = new ThreadContextTracker({
    thread: () => thread,
    changed: () => {},
    recreate: async () => ({ error: 'git worktree add failed (exit 128): invalid reference' }),
  });
  const run = tracker.recreate('t');
  if ('error' in run) throw Error(run.error);
  await run.started;
  expect(thread.meta.context?.checkout).toMatchObject({
    state: 'released',
    error: 'git worktree add failed (exit 128): invalid reference',
  });
});
