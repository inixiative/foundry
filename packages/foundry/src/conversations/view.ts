/**
 * @atlas
 * @kind transformer
 * @partOf feature:conversations
 */
import {
  type ConversationMember,
  type ThreadEntry,
  type ThreadsLens,
  type ThreadViewResult,
  threadTextLimit,
} from '@inixiative/signet';
import type { JournalEntry } from '../persistence/local-session-store';
import type { HeldRecord, HeldResolutionRecord, MemberPostRecord } from './types';

/**
 * The read-off point (docs/reference/CONVERSATIONS.md §4.7): a member reads a lens over the main
 * thread's journal and nothing else. These functions are that lens. Only four things can ever be an
 * entry: what the owner typed, the main agent's answers, members' posts and released sends. Tool
 * calls, Warden rows, composed context and held sends are not entries, so no view can show them.
 */

/** One journal entry as a member would see it, before any view: null when no member ever sees it. */
export function threadEntryOf(entry: JournalEntry): ThreadEntry | null {
  if (entry.source === 'message') {
    const { message } = entry;
    const meta = message.meta ?? {};
    // A member's post that opened a turn is shown once, as its post row; observed subagent runs
    // and failed turns are never part of the conversation.
    if (meta.origin !== undefined || meta.observed !== undefined || message.kind !== 'text')
      return null;
    return {
      journalSeq: entry.seq,
      at: new Date(message.timestamp).toISOString(),
      kind: message.actor === 'user' ? 'owner' : 'agent',
      member: null,
      text: clip(message.content),
    };
  }
  const at = new Date(entry.storedAt).toISOString();
  if (entry.phase === 'member-post') {
    const post = entry.record as unknown as MemberPostRecord;
    return {
      journalSeq: entry.seq,
      at,
      kind: 'post',
      member: { kind: 'signet', id: post.signetId },
      text: clip(post.text),
    };
  }
  // A send is an entry once it is readable: written released (`auto`), or released by the owner.
  const send = (record: Pick<HeldRecord, 'kind' | 'to'>, text: string): ThreadEntry | null =>
    record.kind === 'send' && record.to
      ? { journalSeq: entry.seq, at, kind: 'send', member: record.to, text: clip(text) }
      : null;
  if (entry.phase === 'outbound-held') {
    const record = entry.record as unknown as HeldRecord;
    return record.status === 'released' ? send(record, record.text) : null;
  }
  if (entry.phase === 'outbound-resolution') {
    const resolution = entry.record as unknown as HeldResolutionRecord;
    return resolution.action === 'released' ? send(resolution, resolution.text) : null;
  }
  return null;
}

/**
 * Whether a member with this lens sees an entry. `own`: its posts and the sends addressed to it.
 * `thread` (owner recipients only, which Kingdom enforces): every entry.
 */
export function visibleTo(
  entry: ThreadEntry,
  view: { signetId: string; lens: Pick<ThreadsLens, 'view'> },
): boolean {
  if (view.lens.view === 'thread') return true;
  return (
    (entry.kind === 'post' || entry.kind === 'send') &&
    sameMember(entry.member, { kind: 'signet', id: view.signetId })
  );
}

export const sameMember = (a: ConversationMember | null, b: ConversationMember | null) =>
  !!a && !!b && a.kind === b.kind && a.id === b.id;

const clip = (text: string) =>
  text.length > threadTextLimit ? `${text.slice(0, threadTextLimit - 1)}…` : text;

/**
 * A view cut at the 16,000-character read cap (§4.7), at least one entry. `forward`: oldest first
 * from the cursor, so a reader continues after the last entry; `newest`: the newest that fit, for a
 * live snapshot. `journalSeq` is where the view was taken: the thread's seq now, or the last entry
 * when a forward read was cut.
 */
export function capView(
  entries: readonly ThreadEntry[],
  journalSeq: number,
  direction: 'forward' | 'newest',
  more = false,
): ThreadViewResult {
  const ordered = direction === 'newest' ? [...entries].reverse() : [...entries];
  const kept: ThreadEntry[] = [];
  let chars = 0;
  for (const entry of ordered) {
    if (kept.length && (chars + entry.text.length > threadTextLimit || kept.length >= 1000)) break;
    kept.push(entry);
    chars += entry.text.length;
  }
  const truncated = more || kept.length < entries.length;
  if (direction === 'newest') kept.reverse();
  return {
    journalSeq:
      direction === 'forward' && truncated && kept.length ? kept.at(-1)!.journalSeq : journalSeq,
    entries: kept,
    truncated,
  };
}
