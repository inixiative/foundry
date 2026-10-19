import { expect, test } from 'bun:test';
import type { ArchiveEntry } from '@inixiative/archive';
import { extractCorrections } from '../src';
import { commitsIn, commitsMade, snapshotTurns } from '../src/feedback/archive-turns';

const at = (i: number) => Date.parse('2026-06-12T10:00:00Z') + i * 60_000;
const entry = (i: number, kind: ArchiveEntry['kind'], text: string): ArchiveEntry => ({
  id: `r${i}:${kind === 'tool-result' ? 'result' : 'text'}-0`,
  kind,
  text,
  timestamp: at(i),
  sourceRef: `line:${i + 1}`,
});
const entries: ArchiveEntry[] = [
  entry(0, 'user', 'add a util module'),
  entry(1, 'assistant', 'Added util.ts.'),
  entry(2, 'tool-call', '{"name":"Bash","input":{"command":"git commit"}}'),
  entry(3, 'tool-result', '[main 1a2b3c4d5] add util\n 1 file changed'),
  entry(4, 'event', '[Request interrupted by user]'),
  entry(5, 'user', 'no - use a named export'),
  { ...entry(6, 'assistant', 'Fixed.'), timestamp: null },
];

test('typed prompts keep their id and sourceRef; interruptions and prose become turns', () => {
  expect(snapshotTurns({ entries })).toEqual([
    {
      role: 'user',
      id: 'r0:text-0',
      text: 'add a util module',
      timestamp: new Date(at(0)).toISOString(),
      sourceRef: 'line:1',
    },
    { role: 'assistant', text: 'Added util.ts.', timestamp: new Date(at(1)).toISOString() },
    { role: 'user', text: '', timestamp: new Date(at(4)).toISOString(), interrupted: true },
    {
      role: 'user',
      id: 'r5:text-0',
      text: 'no - use a named export',
      timestamp: new Date(at(5)).toISOString(),
      sourceRef: 'line:6',
    },
    { role: 'assistant', text: 'Fixed.', timestamp: '' },
  ]);
});

test('the commit scan adds a turn where a tool result printed commits, and changes no correction', () => {
  const scanned = snapshotTurns({ entries }, { commits: true });
  expect(scanned.find((turn) => turn.commits)).toEqual({
    role: 'assistant',
    id: 'r3:result-0',
    text: '',
    timestamp: new Date(at(3)).toISOString(),
    sourceRef: 'line:4',
    commits: ['1a2b3c4d5'],
  });
  expect(extractCorrections('s', scanned).corrections).toEqual(
    extractCorrections('s', snapshotTurns({ entries })).corrections,
  );
  expect(extractCorrections('s', scanned).corrections[0]).toMatchObject({
    messageId: 'r5:text-0',
    sourceRef: 'line:6',
    signals: expect.arrayContaining(['interruption']),
  });
});

test("commitsMade reads only git commit's [branch sha] line; commitsIn adds git log's", () => {
  const sha = 'a'.repeat(40);
  const text = `[feat/x 1234abc] add util\n 1 file changed\ncommit ${sha}\nAuthor: t`;
  expect(commitsMade(text)).toEqual([{ branch: 'feat/x', sha: '1234abc' }]);
  expect(commitsIn(text)).toEqual(['1234abc', sha]);
});

test('commitsMade keeps the branch git printed: a root commit, a detached HEAD, several in one result', () => {
  const text = [
    '[main (root-commit) 0a1b2c3] first',
    '[detached HEAD 4d5e6f7] wip',
    '[fix/b-2 89abcde0] amend',
    'see [notes] and [x y] for more',
  ].join('\n');
  expect(commitsMade(text)).toEqual([
    { branch: 'main', sha: '0a1b2c3' },
    { branch: 'detached HEAD', sha: '4d5e6f7' },
    { branch: 'fix/b-2', sha: '89abcde0' },
  ]);
});
