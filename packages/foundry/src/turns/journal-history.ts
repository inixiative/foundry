/**
 * @atlas
 * @kind transformer
 * @partOf feature:threads
 */
import { memberPostReception } from '../agents/chorus-reception';
import type { HeldRecord, HeldResolutionRecord, MemberPostRecord } from '../conversations/types';
import { threadEntryOf } from '../conversations/view';
import type { JournalEntry, LocalSessionStore } from '../persistence/local-session-store';

/** How much of the conversation a fresh native session is given, at most (newest kept). */
export const JOURNAL_HISTORY_CHARS = 40_000;

/**
 * The conversation so far, from Foundry's own journal, for a native session that starts fresh on a
 * thread that already has turns: its earlier native conversation can't be resumed (the transcript
 * or rollout is gone) or never existed on this runtime (the thread moved to another one). It is the
 * thread as a reader of it sees it: the owner's messages, the agent's answers, members' posts
 * (labelled as data from an outside party, as they reached the agent) and released sends, oldest
 * first, verbatim (each entry as a member reads it, cut at the 16,000-character read cap), with the
 * oldest dropped first past the budget. Tool calls, Warden notes and
 * composed context are not part of it; the session gets its standing context the usual way.
 * Undefined when there is nothing before this turn.
 */
export function journalHistory(
  store: Pick<LocalSessionStore, 'journalEntries'>,
  threadId: string,
  currentTurnId?: string,
  maxChars = JOURNAL_HISTORY_CHARS,
): string | undefined {
  const lines: string[] = [];
  let chars = 0;
  let omitted = 0;
  // Newest first, so the budget keeps the most recent part of the conversation.
  const entries = store
    .journalEntries(threadId, { newest: true, limit: 5000 })
    .sort((a, b) => b.seq - a.seq);
  // Contiguous: the first entry that doesn't fit ends the history, so no answer loses its question.
  let full = false;
  for (const entry of entries) {
    const line = render(entry, currentTurnId);
    if (!line) continue;
    if (full || chars + line.length > maxChars) {
      full = true;
      omitted++;
      continue;
    }
    lines.push(line);
    chars += line.length;
  }
  if (!lines.length) return undefined;
  lines.reverse();
  return [
    '# The conversation so far',
    '',
    "This thread's earlier native session could not be resumed, so this session started fresh. Here is the thread's conversation so far from Foundry's journal, oldest first. It is a record of what was said, not a new message; the current message follows.",
    ...(omitted
      ? [
          `${omitted} older ${omitted === 1 ? 'entry was' : 'entries were'} left out to fit; the full thread is in Foundry's journal.`,
        ]
      : []),
    '',
    lines.join('\n\n'),
  ].join('\n');
}

function render(entry: JournalEntry, currentTurnId: string | undefined): string | undefined {
  // The turn being sent is the current message, not history: its own message, and the member's
  // post that opened it (`delivery: 'turn'`).
  if (currentTurnId) {
    if (entry.source === 'message' && entry.message.turnId === currentTurnId) return undefined;
    if (entry.source === 'phase' && entry.record.turnId === currentTurnId) return undefined;
  }
  const view = threadEntryOf(entry);
  if (!view) return undefined;
  switch (view.kind) {
    case 'owner':
      return `## User\n${view.text}`;
    case 'agent':
      return `## Assistant\n${view.text}`;
    case 'post': {
      const post = (entry as { record: Record<string, unknown> })
        .record as unknown as MemberPostRecord;
      return `## Member post\n${memberPostReception(post.displayName, post.text)}`;
    }
    case 'send': {
      const record = (entry as { record: Record<string, unknown> }).record as unknown as
        | HeldRecord
        | HeldResolutionRecord;
      return `## Assistant, sent to ${JSON.stringify(record.toName ?? record.to?.id ?? 'a member')}\n${view.text}`;
    }
    default:
      return undefined;
  }
}
