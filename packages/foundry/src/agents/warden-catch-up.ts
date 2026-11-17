/**
 * @atlas
 * @kind service
 * @partOf feature:wardens
 */
import type { EarlierMessages } from './domain-librarian';

/** A Warden catching up is asked on at most this many user messages at once, the current one included. */
export const CATCH_UP_MAX_MESSAGES = 5;
/** And on at most about 4k tokens of them; the current message is always sent whole. */
export const CATCH_UP_MAX_CHARS = 16_000;

/** Decisions that answered a user message: a chime, `NO_COMMENT`, or the pre-filter ruling it out. */
const ANSWERED = new Set(['contribute', 'no-comment']);

/** One journalled advice row, as `restore` reads it (`advice` phase, oldest first). */
export interface CatchUpRow {
  readonly id: string;
  readonly turnId: string | null;
  readonly record: Readonly<Record<string, unknown>>;
}

/** One Warden's answer at a moment, as the orchestrator or the journal records it. */
export interface CatchUpAnswer {
  readonly domain: string;
  readonly decision: string;
  readonly reason?: string;
}

/** Whether this answer counts as answering the message: a chime, `NO_COMMENT`, or a pre-filter skip. */
export const answeredMessage = (answer: CatchUpAnswer): boolean =>
  ANSWERED.has(answer.decision) || (answer.decision === 'skipped' && answer.reason === 'prefilter');

/**
 * Each Warden's cursor over a thread's user messages (Aron: "wardens should try and inject in the
 * delta of messages after their last injection"). The cursor is the last user message the Warden
 * answered; the next user-message advice it is asked carries the ones it missed since, oldest first.
 * A Warden first asked at a message starts just before it, so a Warden added mid-thread is not
 * handed the thread's history. Cursors only move forward. Rebuilt from the journal on restore.
 */
export class WardenCatchUp {
  /** The newest user messages, numbered from 1; a duplicate prepare of one message keeps its number. */
  private _messages: { readonly seq: number; readonly key?: string; readonly text: string }[] = [];
  private _lastSeq = 0;
  private readonly _answered = new Map<string, number>();

  /** Record the user message the chorus is asked on now and return its number. `key` is its message id. */
  message(text: string, key?: string): number {
    const known = key ? this._messages.find((m) => m.key === key) : undefined;
    if (known) return known.seq;
    const seq = ++this._lastSeq;
    this._messages = [...this._messages, { seq, ...(key ? { key } : {}), text }].slice(
      -CATCH_UP_MAX_MESSAGES,
    );
    return seq;
  }

  /** The current message's number (a re-fire asks on it again); 0 before any. */
  get current(): number {
    return this._lastSeq;
  }

  /**
   * What `domain` missed before message `seq`: the newest messages that fit `CATCH_UP_MAX_MESSAGES`
   * (the current one included) and `CATCH_UP_MAX_CHARS`, oldest first, and how many older ones were
   * left out. A Warden seen for the first time starts at `seq - 1`: nothing missed.
   */
  missedBy(domain: string, seq: number): EarlierMessages | undefined {
    const after = this._answered.get(domain);
    if (after === undefined) {
      this._answered.set(domain, seq - 1);
      return undefined;
    }
    const missed = seq - 1 - after;
    if (missed <= 0) return undefined;
    let chars = this._messages.find((m) => m.seq === seq)?.text.length ?? 0;
    const messages: string[] = [];
    for (const m of [...this._messages].reverse()) {
      if (m.seq >= seq || m.seq <= after) continue;
      if (
        messages.length + 1 >= CATCH_UP_MAX_MESSAGES ||
        chars + m.text.length > CATCH_UP_MAX_CHARS
      )
        break;
      chars += m.text.length;
      messages.unshift(m.text);
    }
    return { messages, dropped: missed - messages.length };
  }

  /** The answers at message `seq`: each Warden that answered moves its cursor there (never back). */
  answered(seq: number, answers: readonly CatchUpAnswer[]): void {
    for (const answer of answers) {
      if (!this._answered.has(answer.domain)) this._answered.set(answer.domain, seq - 1);
      if (answeredMessage(answer))
        this._answered.set(answer.domain, Math.max(this._answered.get(answer.domain)!, seq));
    }
  }

  /** A Retry on a user message answered: the newest held message with that text is the one it answered. */
  answeredMoment(text: string, answers: readonly CatchUpAnswer[]): void {
    const seq = this._messages.findLast((m) => m.text === text)?.seq;
    if (seq !== undefined) this.answered(seq, answers);
  }

  /**
   * Rebuild from the thread's journalled advice rows, oldest first: each user-message row (one per
   * turn) is a message, its answers move cursors, and a Retry row answers the message of the row it
   * retried. Rows of other triggers are ignored.
   */
  restore(rows: readonly CatchUpRow[]): void {
    const seqOfRow = new Map<string, number>();
    const seqOfTurn = new Map<string, number>();
    for (const row of rows) {
      const record = row.record;
      if (record.trigger !== 'user-message') continue;
      const retryOf = typeof record.retryOf === 'string' ? record.retryOf : undefined;
      let seq: number | undefined;
      if (retryOf) seq = seqOfRow.get(retryOf);
      else if (row.turnId && seqOfTurn.has(row.turnId)) seq = seqOfTurn.get(row.turnId);
      else if (typeof record.moment === 'string') {
        seq = this.message(record.moment);
        if (row.turnId) seqOfTurn.set(row.turnId, seq);
      }
      if (seq === undefined) continue;
      seqOfRow.set(row.id, seq);
      this.answered(seq, [
        ...rowAnswers(record.participants),
        ...prefilteredAnswers(record.prefiltered),
      ]);
    }
  }
}

function rowAnswers(value: unknown): CatchUpAnswer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((p) =>
    p && typeof p.domain === 'string' && typeof p.decision === 'string'
      ? [{ domain: p.domain, decision: p.decision }]
      : [],
  );
}

function prefilteredAnswers(value: unknown): CatchUpAnswer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((p) =>
    p && typeof p.domain === 'string'
      ? [{ domain: p.domain, decision: 'skipped', reason: 'prefilter' }]
      : [],
  );
}
