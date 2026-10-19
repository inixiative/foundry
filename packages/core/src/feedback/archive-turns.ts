import type { ArchiveSnapshot } from '@inixiative/archive';
import { typedPrompt } from '@inixiative/archive/import';
import type { TranscriptTurn } from './correction';

// An Archive session as transcript turns, the input `extractCorrections` reads. Shared by Foundry's
// `foundry repeats` and Oracle's session miner; its own export, so the core root never loads Archive.

const INTERRUPTED = /^\s*\[Request interrupted by user/;
const COMMIT_BRACKET = /\[([^[\]\n]+?)\s([0-9a-f]{7,40})\]/g;
/** `git commit` adds this to the branch on a repository's first commit. */
const ROOT_COMMIT = /\s+\(root-commit\)$/;
const COMMIT_LINE = /^commit ([0-9a-f]{40})/gm;

/** A commit a session made, as `git commit` printed it: the branch it was on, and its short SHA. */
export interface MadeCommit {
  /** As git printed it: `main`, `feat/x`, `detached HEAD`; `(root-commit)` dropped. */
  readonly branch: string;
  readonly sha: string;
}

/**
 * Commits a tool result says were made: `git commit`'s `[branch sha]` line only, with the branch,
 * so a reader can tell work on a PR's own branch (amended or rebased away later) from other work.
 */
export const commitsMade = (text: string): MadeCommit[] =>
  [...text.matchAll(COMMIT_BRACKET)].map((m) => ({
    branch: m[1]!.replace(ROOT_COMMIT, ''),
    sha: m[2]!,
  }));

/** Commit SHAs a tool result printed: `git commit`'s `[branch sha]` line, `git log`'s `commit <sha>`. */
export const commitsIn = (text: string) => [
  ...commitsMade(text).map((made) => made.sha),
  ...[...text.matchAll(COMMIT_LINE)].map((m) => m[1]!),
];

export interface SnapshotTurnsOptions {
  /** Also a turn per tool result that printed commits (`commits`): where the work landed. */
  readonly commits?: boolean;
}

/** The transcript as turns: what the person typed, the agent's prose, and interruptions. */
export function snapshotTurns(
  snapshot: Pick<ArchiveSnapshot, 'entries'>,
  options: SnapshotTurnsOptions = {},
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const entry of snapshot.entries) {
    const timestamp = entry.timestamp === null ? '' : new Date(entry.timestamp).toISOString();
    if (entry.kind === 'assistant') turns.push({ role: 'assistant', text: entry.text, timestamp });
    else if ((entry.kind === 'user' || entry.kind === 'event') && INTERRUPTED.test(entry.text))
      turns.push({ role: 'user', text: '', timestamp, interrupted: true });
    else if (entry.kind === 'user') {
      const text = typedPrompt(entry.text);
      if (text)
        turns.push({ role: 'user', id: entry.id, text, timestamp, sourceRef: entry.sourceRef });
    } else if (options.commits && entry.kind === 'tool-result') {
      const commits = commitsIn(entry.text);
      if (commits.length)
        turns.push({
          role: 'assistant',
          id: entry.id,
          text: '',
          timestamp,
          sourceRef: entry.sourceRef,
          commits,
        });
    }
  }
  return turns;
}
