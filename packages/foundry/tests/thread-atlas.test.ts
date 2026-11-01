import { expect, test } from 'bun:test';
import type { NativeEvidence } from '@inixiative/foundry-core';
import type { TurnFlowRecord } from '../src/persistence/local-session-store';
import { conceptsTouched, threadPaths } from '../src/viewer/thread-atlas';

const ROOT = '/repo';
const use = (toolName: string, toolInput: Record<string, unknown>): NativeEvidence =>
  ({ kind: 'tool_use', toolName, toolInput }) as NativeEvidence;

function store(turns: Record<string, NativeEvidence[]>) {
  return {
    recentTurnIds: () => Object.keys(turns),
    turnFlowRecord: (_thread: string, turnId: string) =>
      ({ toolUses: turns[turnId] ?? [] }) as unknown as TurnFlowRecord,
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
