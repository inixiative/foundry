import { expect, test } from 'bun:test';
import type { NativeEvidence } from '@inixiative/foundry-core';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { conceptsTouched, threadPaths } from '../src/viewer/thread-atlas';

const ROOT = '/repo';
const use = (toolName: string, toolInput: Record<string, unknown>): NativeEvidence =>
  ({ kind: 'tool_use', toolName, toolInput }) as NativeEvidence;

function store(turns: Record<string, NativeEvidence[]>) {
  return {
    recentTurnIds: () => Object.keys(turns),
    turnToolUses: (_thread: string, turnId: string) => turns[turnId] ?? [],
    archiveRecordsMark: () => JSON.stringify(turns),
  };
}

test('a thread reads and writes repo-relative paths across its turns', () => {
  const paths = threadPaths(
    store({
      t1: [use('Read', { file_path: `${ROOT}/src/auth/jwt.ts` }), use('Grep', { pattern: 'x' })],
      t2: [
        use('Edit', { file_path: `${ROOT}/src/auth/session.ts` }),
        use('Bash', { command: 'ls' }),
      ],
    }),
    'thread',
    ROOT,
  );
  expect([...paths.read]).toEqual(['src/auth/jwt.ts']);
  expect([...paths.written]).toEqual(['src/auth/session.ts']);
});

test('concepts touched count the files read or changed, most-touched first, with their doc', () => {
  const graph = {
    conceptToFiles: {
      'feature:auth': ['src/auth/jwt.ts', 'src/auth/session.ts', 'src/auth/other.ts'],
      'infrastructure:redis': ['src/redis.ts'],
      'feature:billing': ['src/auth/session.ts'],
    },
    usesConsumers: {},
    thesaurus: { 'feature:auth': { phrases: ['auth'], doc: 'docs/claude/AUTH.md' } },
  };
  const touched = conceptsTouched(graph, {
    read: new Set(['src/auth/jwt.ts']),
    written: new Set(['src/auth/session.ts']),
  });
  expect(touched).toEqual([
    {
      concept: 'feature:auth',
      files: 2,
      changed: 1,
      paths: ['src/auth/jwt.ts', 'src/auth/session.ts'],
      doc: 'docs/claude/AUTH.md',
    },
    { concept: 'feature:billing', files: 1, changed: 1, paths: ['src/auth/session.ts'], doc: null },
  ]);
});

const journalThread = {
  id: 'atlas-thread',
  meta: {
    description: 'Atlas',
    projectId: 'project-a',
    tags: [],
    status: 'idle' as const,
    createdAt: 1,
    lastActiveAt: 1,
  },
};
const owner = (turnId: string) => ({
  threadId: journalThread.id,
  projectId: 'project-a',
  messageId: turnId,
  generation: 'g',
  dispatchId: 'd',
});
const trace = (turnId: string) =>
  ({ id: `trace-${turnId}`, messageId: turnId, root: {}, spans: [] }) as never;

/** A finished turn with one journalled tool call and one recorded inline on its completion. */
function workedTurn(journal: LocalSessionStore, turnId: string, read: string, edited: string) {
  journal.beginTurn(journalThread, turnId, 'Work');
  const base = { schema: 1 as const, admissionId: `admission-${turnId}`, owner: owner(turnId) };
  journal.registerNative(journalThread, { ...base, nativeOutcome: 'unknown' as const });
  journal.appendNative(journalThread, {
    ...base,
    nativeOutcome: 'completed',
    kind: 'tool_use',
    toolName: 'Read',
    toolInput: { file_path: `${ROOT}/${read}` },
  });
  const inline = {
    ...base,
    kind: 'tool_use',
    toolName: 'Edit',
    // Long enough that the journal stores the inline history behind a content reference.
    toolInput: { file_path: `${ROOT}/${edited}`, old_string: 'x'.repeat(5000), new_string: 'y' },
  };
  journal.completeTurn(journalThread, turnId, 'done', { nativeHistory: [inline] }, trace(turnId));
}

test("a turn's tool uses are the flow record's, without its trace or phases", () => {
  const journal = new LocalSessionStore(':memory:');
  journal.saveThread(journalThread);
  workedTurn(journal, 'turn-a', 'src/a.ts', 'src/b.ts');
  const names = ['Read', 'Edit'];
  const uses = journal.turnToolUses(journalThread.id, 'turn-a', names);
  expect(uses.map((u) => u.toolName)).toEqual(['Read', 'Edit']);
  expect(uses).toEqual(journal.turnFlowRecord(journalThread.id, 'turn-a', names)!.toolUses);
  expect(journal.turnToolUses(journalThread.id, 'turn-a', ['Grep'])).toEqual([]);
});

test("a thread's paths are read again only when its journal changes", () => {
  const journal = new LocalSessionStore(':memory:');
  journal.saveThread(journalThread);
  workedTurn(journal, 'turn-a', 'src/a.ts', 'src/b.ts');
  let reads = 0;
  const counted = {
    recentTurnIds: (id: string, limit: number) => journal.recentTurnIds(id, limit),
    archiveRecordsMark: (id: string) => journal.archiveRecordsMark(id),
    turnToolUses: (id: string, turnId: string, names: readonly string[]) => {
      reads++;
      return journal.turnToolUses(id, turnId, names);
    },
  };
  const first = threadPaths(counted, journalThread.id, ROOT);
  expect([...first.read]).toEqual(['src/a.ts']);
  expect([...first.written]).toEqual(['src/b.ts']);
  expect(threadPaths(counted, journalThread.id, ROOT)).toBe(first);
  expect(reads).toBe(1);
  workedTurn(journal, 'turn-b', 'src/c.ts', 'src/d.ts');
  const second = threadPaths(counted, journalThread.id, ROOT);
  expect(reads).toBe(3);
  expect([...second.read].sort()).toEqual(['src/a.ts', 'src/c.ts']);
  expect([...second.written].sort()).toEqual(['src/b.ts', 'src/d.ts']);
});
