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
import { memberPostReception } from '../agents/chorus-reception';
import type { JournalEntry } from '../persistence/local-session-store';
import { quotedName } from './roster';
import type {
  AsideRecord,
  HeldRecord,
  HeldResolutionRecord,
  MemberPostRecord,
  SharedEntryRecord,
} from './types';

/**
 * The read-off point (docs/reference/CONVERSATIONS.md §4.7): a member reads a lens over the main
 * thread's journal and nothing else. These functions are that lens. Only five things can ever be an
 * entry: what the owner typed, the main agent's answers, members' posts, released sends and asides
 * (people only: every agent path skips them). Tool
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
  if (entry.phase === 'aside') {
    const aside = entry.record as unknown as AsideRecord;
    return {
      journalSeq: entry.seq,
      at,
      kind: 'aside',
      member: aside.member,
      text: clip(aside.text),
    };
  }
  if (entry.phase === 'member-post') {
    const post = entry.record as unknown as MemberPostRecord;
    return {
      journalSeq: entry.seq,
      at,
      kind: 'post',
      member: post.member,
      text: clip(post.text),
    };
  }
  // A send is an entry once it is readable: written released (`auto`), or released by the owner.
  const send = (
    record: Pick<HeldRecord, 'kind' | 'to'> & {
      commission?: { report: 'post' | 'notify'; expiresAt?: string };
    },
    text: string,
  ): ThreadEntry | null =>
    record.kind === 'send' && record.to
      ? {
          journalSeq: entry.seq,
          at,
          kind: 'send',
          member: record.to,
          ...(record.commission?.expiresAt
            ? {
                commission: {
                  report: record.commission.report,
                  expiresAt: record.commission.expiresAt,
                },
              }
            : {}),
          text: clip(text),
        }
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
 * `thread`: every entry; the wrapper narrows it further per reader (the host agent's own messages
 * only for the owner, a `notify` report only for its author and the owner).
 */
export function visibleTo(
  entry: ThreadEntry,
  view: { member: ConversationMember; lens: Pick<ThreadsLens, 'view'> },
): boolean {
  if (view.lens.view === 'thread') return true;
  // An aside goes to every person in the thread, whatever they sit in on (no DMs, Aron 11-01).
  if (entry.kind === 'aside') return true;
  return (entry.kind === 'post' || entry.kind === 'send') && sameMember(entry.member, view.member);
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

/** A mirrored entry as the member's agent reads it: the owner's words as his, anyone else's as data. */
export function sharedEntryText(entry: SharedEntryRecord): string {
  const where = `In the conversation ${quotedName(entry.hostName)} (entry ${entry.hostSeq})`;
  if (entry.kind === 'owner') return `${where}, the owner said:\n${entry.text}`;
  if (entry.kind === 'agent') return `${where}, the host agent answered:\n${entry.text}`;
  if (entry.kind === 'send')
    return `${where}, ${entry.speaker}${entry.addressed ? ' (reply with post_to_conversation, inReplyTo ' + entry.hostSeq + ')' : ''}:\n${entry.text}`;
  return `${where}:\n${memberPostReception(entry.speaker, entry.text)}`;
}
