import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ArchiveSnapshot, archiveSnapshotSchema } from '@inixiative/archive';
import { ContextStack, Thread } from '@inixiative/foundry-core';
import { snapshotReferences, ThreadContextTracker } from '../src/archives/thread-context';
import { gitContext } from '../src/git';

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
