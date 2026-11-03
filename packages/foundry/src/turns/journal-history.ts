/**
 * @atlas
 * @kind transformer
 * @partOf feature:threads
 */

import { MODEL_REGISTRY, type ThreadFork, type ThreadPlan } from '@inixiative/foundry-core';
import { memberPostReception } from '../agents/chorus-reception';
import type {
  HeldRecord,
  HeldResolutionRecord,
  MemberPostRecord,
  SharedEntryRecord,
} from '../conversations/types';
import { sharedEntryText, threadEntryOf } from '../conversations/view';
import type { JournalEntry, LocalSessionStore } from '../persistence/local-session-store';

/** How much of the conversation a fresh native session is given when its worker's window is unknown (newest kept). */
export const JOURNAL_HISTORY_CHARS = 40_000;

/** The journal row a mid-thread worker switch writes, in the thread's order (CORE-004's marker). */
export const WORKER_SWITCH_PHASE = 'worker-switch';
/** A thread moving to another worker (Aron, 2026-11-02): its marker, as the journal keeps it. */
export interface WorkerSwitchRecord {
  readonly from: string;
  readonly to: string;
  readonly fromLabel: string;
  readonly toLabel: string;
  /** The native session the thread held on the old worker; kept on record, never resumed. */
  readonly fromSession: string | null;
}

type HistoryStore = Pick<LocalSessionStore, 'journalEntries'> &
  Partial<Pick<LocalSessionStore, 'threadMeta' | 'phasesOf'>>;

/**
 * The seed budget for a session on this worker: a tenth of the smallest context window its models
 * have, at about four characters a token, so the seed fits whatever model the thread picks there
 * and leaves the window to the work. What grows past the window later is the harness's own
 * auto-compaction's to summarise (`providers/claude-context-budget.ts`); Foundry runs no
 * summariser of its own. Without a known window, `JOURNAL_HISTORY_CHARS`.
 */
export function workerHistoryBudget(worker: string | undefined): number {
  const windows = (worker ? (MODEL_REGISTRY[worker]?.models ?? []) : [])
    .map((model) => model.contextWindow)
    .filter((tokens): tokens is number => typeof tokens === 'number' && tokens > 0);
  if (!windows.length) return JOURNAL_HISTORY_CHARS;
  return Math.floor(Math.min(...windows) * 0.4);
}

/**
 * The conversation so far, from Foundry's own journal, for a native session that starts fresh on a
 * thread that already has turns: its earlier native conversation can't be resumed (the transcript
 * or rollout is gone), it is a fork, or the thread moved to another worker (`WORKER_SWITCH_PHASE`).
 * This is the one seeding path (CORE-004) for all three. It is the thread as a reader of it sees it:
 * the owner's messages, the agent's answers, members' posts (labelled as data from an outside
 * party, as they reached the agent), released sends and the markers where it was forked or moved,
 * oldest first, verbatim (each entry as a member reads it, cut at the 16,000-character read cap).
 * Past the budget the oldest are left out, contiguously, and the seed says how many. The thread's
 * plan follows.
 * Tool calls, Warden notes and composed context are not part of it; the session gets its standing
 * context the usual way. Undefined when there is nothing before this turn.
 */
export function journalHistory(
  store: HistoryStore,
  threadId: string,
  currentTurnId?: string,
  maxChars = JOURNAL_HISTORY_CHARS,
): string | undefined {
  const { kept, omitted, forkedFrom, moved } = seedParts(store, threadId, currentTurnId, maxChars);
  if (!kept.length) return undefined;
  const plan = planText(store.threadMeta?.(threadId)?.plan);
  return [
    '# The conversation so far',
    '',
    intro(forkedFrom, moved),
    ...(omitted
      ? [
          `${omitted} older ${omitted === 1 ? 'entry was' : 'entries were'} left out to fit; the full thread is in Foundry's journal.`,
        ]
      : []),
    '',
    kept.join('\n\n'),
    ...(plan ? ['', plan] : []),
  ].join('\n');
}

const PLAN_CHARS = 6_000;

interface SeedItem {
  readonly text: string;
  readonly marker?: boolean;
}

/** The entries a seed quotes (oldest first) and how many are past its budget. */
function seedParts(
  store: HistoryStore,
  threadId: string,
  currentTurnId: string | undefined,
  maxChars: number,
): {
  kept: string[];
  omitted: number;
  forkedFrom: ThreadFork | undefined;
  moved: WorkerSwitchRecord | undefined;
} {
  // A fork carries its source's conversation through the fork point, and that source's own
  // source's, newest first, so the budget keeps the most recent part of the whole line.
  const forkedFrom = store.threadMeta?.(threadId)?.forkedFrom;
  const items: SeedItem[] = [];
  // The switch this session starts fresh because of: the newest one, with no turn after it.
  let moved: WorkerSwitchRecord | undefined;
  let turnAfter = false;
  let reading: string | undefined = threadId;
  let through: number | undefined;
  for (let hops = 0; reading && hops < MAX_FORK_HOPS; hops++) {
    const entries = store
      .journalEntries(reading, {
        newest: true,
        limit: 5000,
        ...(through !== undefined ? { through } : {}),
      })
      .sort((a, b) => b.seq - a.seq);
    // On the thread itself, a heard entry not yet delivered rides this turn as a note instead.
    const delivered =
      hops === 0 && store.phasesOf
        ? new Set(
            store
              .phasesOf(reading, 'shared-entry-delivered')
              .map((row) => `${String(row.record.hostThreadId)}:${String(row.record.hostSeq)}`),
          )
        : undefined;
    for (const entry of entries) {
      if (
        delivered &&
        entry.source === 'phase' &&
        entry.phase === 'shared-entry' &&
        !delivered.has(`${String(entry.record.hostThreadId)}:${String(entry.record.hostSeq)}`)
      )
        continue;
      if (hops === 0 && entry.source === 'phase' && entry.phase === WORKER_SWITCH_PHASE) {
        if (!moved && !turnAfter) moved = entry.record as unknown as WorkerSwitchRecord;
        turnAfter = true;
      }
      const text = render(entry, currentTurnId);
      if (hops === 0 && text && entry.source === 'message') turnAfter = true;
      if (text) items.push({ text });
    }
    const fork: ThreadFork | undefined =
      hops === 0 ? forkedFrom : store.threadMeta?.(reading)?.forkedFrom;
    if (fork) items.push({ text: FORKED_HERE, marker: true });
    reading = fork?.threadId;
    through = fork?.journalSeq;
  }
  // Contiguous: the first entry that doesn't fit ends the history, so no answer loses its question.
  // A fork marker goes between two threads' parts only: never two in a row or a leading one.
  const kept: string[] = [];
  let omitted = 0;
  let chars = 0;
  let marker = false;
  for (const item of items) {
    if (item.marker) {
      marker = true;
      continue;
    }
    if (omitted || chars + item.text.length > maxChars) {
      omitted++;
      continue;
    }
    if (marker && kept.length) kept.push(FORKED_HERE);
    marker = false;
    kept.push(item.text);
    chars += item.text.length;
  }
  kept.reverse();
  return { kept, omitted, forkedFrom, moved };
}

function intro(forkedFrom: ThreadFork | undefined, moved: WorkerSwitchRecord | undefined): string {
  const record = 'It is a record of what was said, not a new message; the current message follows.';
  if (moved)
    return `This thread moved from ${moved.fromLabel} to ${moved.toLabel} mid-conversation, so this session started fresh on ${moved.toLabel}${
      forkedFrom ? ` (the thread is also a fork of thread ${forkedFrom.threadId})` : ''
    }. Here is the conversation so far from Foundry's journal, oldest first; "Continued on" marks where the worker changed. The earlier session's own state (files it read, tool results) did not carry over: read again what you need. ${record}`;
  if (forkedFrom)
    return `This thread was forked from thread ${forkedFrom.threadId} at its entry ${forkedFrom.journalSeq}, so this session started fresh. Here is the conversation it carries from Foundry's journal, oldest first: the source's conversation up to the fork, then this thread's own. ${record}`;
  return `This thread's earlier native session could not be resumed, so this session started fresh. Here is the thread's conversation so far from Foundry's journal, oldest first. ${record}`;
}

/** The thread's plan as the agent wrote it (or Foundry drafted it), short lines only. */
function planText(plan: ThreadPlan | undefined): string | undefined {
  if (!plan) return undefined;
  const section = (title: string, lines: string[]) =>
    lines.length ? [`${title}:`, ...lines.map((line) => `- ${line}`)] : [];
  const lines = [
    ...section(
      'Outcomes',
      plan.outcomes.map((o) => `[${o.status}] ${o.text}`),
    ),
    ...section(
      'Strategy',
      plan.strategy.map((s) => s.text),
    ),
    ...section(
      'Reasons',
      plan.reasons.map((r) => r.text),
    ),
    ...section(
      'Pains',
      plan.pains.map((p) => p.text),
    ),
    ...section(
      'Technical decisions',
      plan.technical.map(
        (t) =>
          `${t.concern}: ${t.decision} ${t.system}${t.path ? ` (${t.path})` : ''}: ${t.reason}`,
      ),
    ),
  ];
  if (!lines.length) return undefined;
  const text = [
    "# The thread's plan",
    plan.draftedBy === 'foundry'
      ? 'Foundry drafted it; record your own with set_plan when you can.'
      : 'Recorded with set_plan; it is still the plan unless the conversation changed it.',
    ...lines,
  ].join('\n');
  return text.length > PLAN_CHARS ? `${text.slice(0, PLAN_CHARS - 1)}…` : text;
}

const FORKED_HERE = '## Forked here';

/** How far up a chain of forks the history reaches (each hop is a source thread). */
const MAX_FORK_HOPS = 20;

function render(entry: JournalEntry, currentTurnId: string | undefined): string | undefined {
  // The turn being sent is the current message, not history: its own message, and the member's
  // post that opened it (`delivery: 'turn'`).
  if (currentTurnId) {
    if (entry.source === 'message' && entry.message.turnId === currentTurnId) return undefined;
    if (entry.source === 'phase' && entry.record.turnId === currentTurnId) return undefined;
  }
  // What a local member heard in a conversation it is in is part of its own conversation.
  if (entry.source === 'phase' && entry.phase === 'shared-entry')
    return `## Heard\n${sharedEntryText(entry.record as unknown as SharedEntryRecord)}`;
  if (entry.source === 'phase' && entry.phase === WORKER_SWITCH_PHASE) {
    const record = entry.record as unknown as WorkerSwitchRecord;
    return `## Continued on ${record.toLabel} from here (it ran on ${record.fromLabel} before)`;
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
    // People only (M6): an aside never reaches an agent, a fresh or forked session included.
    case 'aside':
      return undefined;
    default:
      return undefined;
  }
}
