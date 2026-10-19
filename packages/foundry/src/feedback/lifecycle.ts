/**
 * @atlas
 * @kind service
 * @partOf feature:feedback
 */
import type { StoredPhase } from '../persistence/local-session-store';
import {
  type FeedbackApplyRecord,
  type FeedbackCaptureRecord,
  type FeedbackCategory,
  type FeedbackInbox,
  type FeedbackLevel,
  type FeedbackRouteRecord,
  type FeedbackSlot,
  type FeedbackStatusRecord,
  type FeedbackTuneRecord,
  isFeedbackPhase,
} from './types';

export type FeedbackStatus = 'open' | 'applied' | 'dismissed' | 'deferred';

export interface FeedbackChange {
  readonly changeId: string;
  readonly role: string;
  readonly slot: FeedbackSlot;
  readonly level: FeedbackLevel;
  readonly path: string;
  readonly line: string;
  readonly appliedAt: number;
  revertedAt?: number;
}

export interface FeedbackOccurrence {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly at: number;
  readonly quote: string;
  readonly exposedAtTurn?: boolean;
}

/**
 * One item, folded from its journal rows: feedback → routed → change → recurrence. Provenance is the
 * origin (thread, turn, message) and the thread's project; `inbox` is open until archived.
 */
export interface FeedbackItem {
  readonly id: string;
  projectId: string | null;
  readonly origin: { threadId: string; turnId: string | null; at: number };
  statement: string;
  sharp: boolean;
  category?: FeedbackCategory;
  tags: string[];
  author?: { name: string; surface: string };
  messageId?: string;
  inbox: FeedbackInbox;
  quote: string;
  before: string;
  originKind: FeedbackCaptureRecord['origin'];
  detection?: FeedbackCaptureRecord['detection'];
  candidateDuplicateOf?: string;
  route?: FeedbackRouteRecord & { at: number };
  tuning: Array<FeedbackTuneRecord & { at: number }>;
  changes: FeedbackChange[];
  recurrences: FeedbackOccurrence[];
  status: FeedbackStatus;
  updatedAt: number;
}

type Row = Pick<StoredPhase, 'threadId' | 'turnId' | 'phase' | 'record' | 'storedAt'> & {
  projectId?: string | null;
};

/**
 * The fold over feedback rows. Rows for an unknown item (a route or tune whose capture was not read) are
 * kept until the capture arrives, so the fold does not depend on read order across threads.
 */
export class FeedbackLifecycle {
  private readonly _items = new Map<string, FeedbackItem>();
  private readonly _orphans = new Map<string, Row[]>();

  constructor(rows: Iterable<Row> = []) {
    for (const row of rows) this.apply(row);
  }

  get items(): FeedbackItem[] {
    return [...this._items.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): FeedbackItem | undefined {
    return this._items.get(id);
  }

  forProject(projectId: string | null): FeedbackItem[] {
    return this.items.filter((item) => item.projectId === projectId);
  }

  /** Apply one row; returns the item it changed, if any. */
  apply(row: Row): FeedbackItem | undefined {
    if (!isFeedbackPhase(row.phase)) return undefined;
    const itemId = (row.record as { itemId?: unknown }).itemId;
    if (typeof itemId !== 'string') return undefined;
    if (row.phase === 'feedback-capture') {
      const record = row.record as unknown as FeedbackCaptureRecord;
      const existing = this._items.get(itemId);
      if (existing) {
        existing.recurrences.push({
          threadId: row.threadId,
          turnId: row.turnId,
          at: row.storedAt,
          quote: record.quote,
          ...(record.exposedAtTurn !== undefined ? { exposedAtTurn: record.exposedAtTurn } : {}),
        });
        existing.updatedAt = row.storedAt;
        return existing;
      }
      const item: FeedbackItem = {
        id: itemId,
        projectId: row.projectId ?? null,
        origin: { threadId: row.threadId, turnId: row.turnId, at: row.storedAt },
        statement: record.statement,
        sharp: record.sharp,
        ...(record.category ? { category: record.category } : {}),
        tags: [...record.tags],
        ...(record.author ? { author: record.author } : {}),
        ...(record.messageId ? { messageId: record.messageId } : {}),
        inbox: 'open',
        quote: record.quote,
        before: record.before,
        originKind: record.origin,
        ...(record.detection ? { detection: record.detection } : {}),
        ...(record.candidateDuplicateOf
          ? { candidateDuplicateOf: record.candidateDuplicateOf }
          : {}),
        tuning: [],
        changes: [],
        recurrences: [],
        status: 'open',
        updatedAt: row.storedAt,
      };
      this._items.set(itemId, item);
      const pending = this._orphans.get(itemId) ?? [];
      this._orphans.delete(itemId);
      for (const orphan of pending) this.apply(orphan);
      return item;
    }
    const item = this._items.get(itemId);
    if (!item) {
      this._orphans.set(itemId, [...(this._orphans.get(itemId) ?? []), row]);
      return undefined;
    }
    item.updatedAt = Math.max(item.updatedAt, row.storedAt);
    if (row.phase === 'feedback-route') {
      item.route = { ...(row.record as unknown as FeedbackRouteRecord), at: row.storedAt };
    } else if (row.phase === 'feedback-tune') {
      const record = row.record as unknown as FeedbackTuneRecord;
      item.tuning.push({ ...record, at: row.storedAt });
      if (record.edited?.statement) item.statement = record.edited.statement;
      if (record.edited?.statement) item.sharp = true;
    } else if (row.phase === 'feedback-apply') {
      const record = row.record as unknown as FeedbackApplyRecord;
      item.changes.push({
        changeId: record.changeId,
        role: record.role,
        slot: record.slot,
        level: record.level,
        path: record.path,
        line: record.line,
        appliedAt: row.storedAt,
      });
    } else if (row.phase === 'feedback-status') {
      item.inbox = (row.record as unknown as FeedbackStatusRecord).inbox;
    } else if (row.phase === 'feedback-revert') {
      const record = row.record as unknown as FeedbackApplyRecord;
      const change = item.changes.find((c) => c.changeId === record.changeId);
      if (change) change.revertedAt = row.storedAt;
    }
    item.status = statusOf(item);
    return item;
  }
}

export const activeChanges = (item: FeedbackItem): FeedbackChange[] =>
  item.changes.filter((change) => change.revertedAt === undefined);

function statusOf(item: FeedbackItem): FeedbackStatus {
  if (activeChanges(item).length) return 'applied';
  const last = item.tuning.at(-1)?.answer;
  if (last === 'dismiss') return 'dismissed';
  if (last === 'later' || last === 'timeout') return 'deferred';
  return 'open';
}
