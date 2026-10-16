import { Database, type Statement } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  computeHash,
  freezeEvidence,
  type NativeEvidence,
  type NativeToolEvidence,
  type NativeToolRecord,
  newId,
  type Signal,
  type Thread,
  type ThreadMeta,
} from '@inixiative/foundry-core';
import type { ReviewJob } from '../agents/domain-librarian';
import type { PhaseRecordInput, ThreadKnowledgeBundle } from '../agents/thread-runtime';
import {
  RAW_MIDDLEWARE_PHASES,
  REDUCED_PHASE,
  reduceMiddleware,
} from '../archives/reduced-middleware';
import type { CompositionBody } from '../audit/compositions';
import { type CheckpointImport, checkpointSpans } from './checkpoint-import';
import {
  type ContentStore,
  contentHash,
  decodeRecord,
  encodeRecord,
  referencedHashes,
} from './journal-content';
import type { PersistedTraceRecord } from './trace-record';

export interface StoredMessage {
  id: string;
  threadId: string;
  turnId: string;
  actor: 'user' | 'agent';
  kind: 'text' | 'error';
  content: string;
  timestamp: number;
  traceId?: string;
  meta?: Record<string, unknown>;
  error?: string;
}

/**
 * `queued`: accepted and not yet handed to the executor's runtime (waiting on its thread, or in
 * classification, routing and pre-message middleware). `active`: the executor has its input, so
 * work may have reached the runtime. `interrupted`: Foundry restarted while the turn was active; the native
 * outcome is unknown. A queued turn found at restart was never sent and is failed instead.
 */
export type TurnStatus = 'queued' | 'active' | 'completed' | 'failed' | 'interrupted';

export interface StoredTurn {
  id: string;
  threadId: string;
  status: TurnStatus;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

/** Index row: identity, content and semantic status; `detail` states what exists without carrying it. */
export interface MessageSummary {
  id: string;
  seq: number;
  threadId: string;
  turnId: string;
  actor: StoredMessage['actor'];
  kind: StoredMessage['kind'];
  content: string;
  timestamp: number;
  traceId?: string;
  /** The stored trace summary (stages, totals) as the full-history route already returns it. */
  trace?: PersistedTraceRecord['summary'];
  error?: string;
  /** Primitive-valued metadata only (turnStatus, persistence, outcomes, injectedLayers, images); never objects. */
  meta?: Record<string, unknown>;
  status: {
    turn: StoredTurn['status'] | 'unknown';
    persistence: 'committed';
    executionOutcome?: string;
    nativeOutcome?: string;
  };
  /** What the owned detail holds that this row does not carry. `detailOnlyMeta` names metadata keys
   * present on the record but absent from `meta` (heavy, opaque or outside the allowlist). */
  detail: {
    injection: boolean;
    nativeHistory: number;
    nativeTools: number;
    trace: boolean;
    detailOnlyMeta: string[];
  };
}

/** Explicit summary contract: only these metadata keys are carried by the index, each a scalar of
 * bounded length, plus `injectedLayers` as a bounded list of flat provenance records. */
export const SUMMARY_META_KEYS = [
  'turnStatus',
  'persistence',
  'executionOutcome',
  'nativeOutcome',
  'attemptOutcome',
  'providerOutcome',
  'inputEvidence',
  'deliveryAcknowledgment',
  'neverSent',
] as const;
const SUMMARY_SCALAR_MAX = 512;
const SUMMARY_LAYERS_MAX = 8192;
const SUMMARY_KEYS_MAX = 32;

export interface MessageIndexPage {
  messages: MessageSummary[];
  hasMore: boolean;
  oldestReached: boolean;
  /** Oldest seq of this page; pass as `before` for the next older page. */
  nextBefore: number | null;
}

export interface TurnDetail {
  threadId: string;
  turnId: string;
  turn: StoredTurn;
  messages: StoredMessage[];
  trace: PersistedTraceRecord | null;
  injection: unknown;
  nativeHistory: NativeEvidence[];
  nativeTools: NativeToolEvidence[];
  /** Durable phase records correlated to this turn (routing, advice, guard requests and outcomes). */
  phases: StoredPhase[];
}

export type TurnFlowRecord = Omit<TurnDetail, 'nativeHistory' | 'nativeTools'> & {
  taskUses: NativeEvidence[];
};

/** Primitives, short primitive lists, and short lists of flat records (layer provenance
 * `{id, hash, tokens}`); never nested objects, never the injection or native payloads. */
function isSummaryValue(value: unknown): boolean {
  const primitive = (item: unknown) =>
    item === null || ['string', 'number', 'boolean'].includes(typeof item);
  if (primitive(value)) return true;
  if (!Array.isArray(value) || value.length > 64) return false;
  if (value.every(primitive)) return true;
  const flatRecord = (item: unknown) =>
    !!item &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    Object.keys(item).length <= 8 &&
    Object.values(item).every(primitive) &&
    JSON.stringify(item).length <= 512;
  return value.every(flatRecord);
}

export interface StoredLearning {
  threadId: string;
  signal: Signal;
  storedAt: number;
}

/** One immutable phase record (routing, advice, guard request or guard outcome) as stored. */
export interface StoredPhase {
  id: string;
  threadId: string;
  turnId: string | null;
  dispatchId: string | null;
  phase: string;
  record: Record<string, unknown>;
  storedAt: number;
}

function checksum(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
class StaleKnowledge extends Error {}

/** Local turn journal. A completed response and its artifact commit together. */
export class LocalSessionStore {
  private readonly db: Database;
  private readonly statements = new Map<string, Statement>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  private readonly volatileTools = new Map<string, NativeToolEvidence>();
  private readonly evictedToolEvidence = new Map<string, number>();
  /** Verified content by hash, bounded by total chars; content is immutable, so a hit never needs re-reading. */
  private readonly contentCache = new Map<string, string>();
  private contentCacheChars = 0;

  /** Long text referenced by journal records (`journal-content.ts`), stored once by hash. */
  private readonly content: ContentStore = {
    put: (text, references = []) => {
      // Always written (idempotent): a cached hash may belong to a write that later rolled back.
      const hash = contentHash(text);
      const inserted = this.query(
        'INSERT INTO session_content(hash, text, stored_at) VALUES (?, ?, ?) ON CONFLICT(hash) DO NOTHING',
      ).run(hash, text, Date.now());
      if (inserted.changes)
        for (const child of references)
          this.query(
            'INSERT INTO session_content_ref(parent, child) VALUES (?, ?) ON CONFLICT DO NOTHING',
          ).run(hash, child);
      return hash;
    },
    get: (hash) => {
      const cached = this.contentCache.get(hash);
      if (cached !== undefined) {
        this.contentCache.delete(hash);
        this.contentCache.set(hash, cached);
        return cached;
      }
      const row = this.query('SELECT text FROM session_content WHERE hash=?').get(hash) as {
        text: string;
      } | null;
      if (!row) throw new Error(`Journal content missing: ${hash}`);
      if (contentHash(row.text) !== hash)
        throw new Error(`Journal content checksum mismatch: ${hash}`);
      this.contentCache.set(hash, row.text);
      this.contentCacheChars += row.text.length;
      while (this.contentCacheChars > CONTENT_CACHE_CHARS && this.contentCache.size > 1) {
        const [oldest, text] = this.contentCache.entries().next().value!;
        this.contentCache.delete(oldest);
        this.contentCacheChars -= text.length;
      }
      return row.text;
    },
  };

  /** A journal record with its long text referenced by hash; over `limit` bytes, its bulk spills (never refused). */
  private encode(value: unknown, limit?: { bytes: number; what: string }): string {
    // One transaction for all of a record's content (a savepoint inside the caller's).
    return this.db.transaction(() =>
      encodeRecord(
        value,
        this.content,
        limit && {
          bytes: limit.bytes,
          spillKey: JOURNAL_SPILL_KEY,
          keep: SQL_READ_KEYS,
          reason: `${limit.what} exceeded ${limit.bytes} bytes after text references; its largest parts are stored by reference`,
        },
      ),
    )();
  }

  private decode<T>(text: string): T {
    return decodeRecord<T>(text, this.content);
  }

  /**
   * Hashes of content holding `needle`, and of every section list or nested record that references
   * one of them, walked up the reference index.
   */
  private contentHolding(needle: string): Set<string> {
    const found = new Set(
      (
        this.query('SELECT hash FROM session_content WHERE instr(text, ?) > 0').all(
          needle,
        ) as Array<{
          hash: string;
        }>
      ).map((row) => row.hash),
    );
    let frontier = [...found];
    while (frontier.length) {
      const next: string[] = [];
      for (const child of frontier)
        for (const row of this.query('SELECT parent FROM session_content_ref WHERE child=?').all(
          child,
        ) as Array<{ parent: string }>)
          if (!found.has(row.parent)) {
            found.add(row.parent);
            next.push(row.parent);
          }
      frontier = next;
    }
    return found;
  }

  /** The stored record is the same record as `value` (`encoded`), whichever store version wrote it. */
  private sameRecord(stored: string, encoded: string, value: unknown): boolean {
    return (
      stored === encoded || JSON.stringify(this.decode(stored)) === JSON.stringify(value ?? null)
    );
  }

  // Own a bounded cache: Bun 1.3.14 does not finalize statements created after
  // its query cache fills. Those statements can retain the exclusive file lock.
  private query(sql: string): Statement {
    if (this.closed) throw new Error('Session store is closed');
    let statement = this.statements.get(sql);
    if (statement) this.statements.delete(sql);
    else {
      if (this.statements.size >= 64) {
        const [oldest, evicted] = this.statements.entries().next().value!;
        evicted.finalize();
        this.statements.delete(oldest);
      }
      statement = this.db.prepare(sql);
    }
    this.statements.set(sql, statement);
    return statement;
  }

  private closeDatabase(): void {
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
    this.db.close();
  }

  private retainVolatileTool(evidence: NativeToolEvidence): void {
    this.volatileTools.set(evidence.record.id, evidence);
    if (this.volatileTools.size > 2000) {
      const oldest = this.volatileTools.values().next().value!;
      this.volatileTools.delete(oldest.record.id);
      const id = oldest.record.owner.threadId;
      this.evictedToolEvidence.set(id, (this.evictedToolEvidence.get(id) ?? 0) + 1);
    }
  }

  nativeToolRetention(threadId: string) {
    return {
      volatileRecords: [...this.volatileTools.values()].filter(
        (e) => e.record.owner.threadId === threadId,
      ).length,
      evictedVolatileRecords: this.evictedToolEvidence.get(threadId) ?? 0,
      limit: 2000,
      scope: 'process cache; failed writes and evictions are not durable server history',
    };
  }

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    try {
      // Hold the file lock until close: a second viewer must not recover live turns.
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE;');
      const version = this.query('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version > 5)
        throw new Error(`Unsupported session store version: ${version.user_version}`);
      this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS session_threads (id TEXT PRIMARY KEY, meta TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_turns (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES session_threads(id),
        status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, error TEXT
      );
      CREATE INDEX IF NOT EXISTS session_turns_thread ON session_turns(thread_id, started_at);
      CREATE TABLE IF NOT EXISTS session_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL REFERENCES session_threads(id),
        turn_id TEXT NOT NULL REFERENCES session_turns(id), actor TEXT NOT NULL, record TEXT NOT NULL,
        UNIQUE(turn_id, actor)
      );
      CREATE INDEX IF NOT EXISTS session_messages_thread ON session_messages(thread_id, seq);
      CREATE TABLE IF NOT EXISTS session_traces (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL REFERENCES session_threads(id),
        turn_id TEXT NOT NULL UNIQUE REFERENCES session_turns(id), record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_knowledge (
        thread_id TEXT PRIMARY KEY REFERENCES session_threads(id),
        record TEXT NOT NULL, checksum TEXT NOT NULL, stored_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_learning (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, signal_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL REFERENCES session_threads(id),
        record TEXT NOT NULL, checksum TEXT NOT NULL, stored_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_learning_thread ON session_learning(thread_id, seq);
      CREATE TABLE IF NOT EXISTS session_native (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, admission_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES session_threads(id), turn_id TEXT NOT NULL,
        record TEXT NOT NULL, stored_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_native_owner ON session_native(thread_id, turn_id, seq);
      CREATE TABLE IF NOT EXISTS session_native_tools (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL REFERENCES session_threads(id), turn_id TEXT,
        record TEXT NOT NULL, publication TEXT NOT NULL, stored_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_native_tools_owner ON session_native_tools(thread_id, turn_id, seq);
      CREATE TABLE IF NOT EXISTS checkpoint_traces (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL REFERENCES session_threads(id), record TEXT NOT NULL,
        checksum TEXT NOT NULL, provenance TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_phase (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL REFERENCES session_threads(id), turn_id TEXT, dispatch_id TEXT, phase TEXT NOT NULL,
        record TEXT NOT NULL, checksum TEXT NOT NULL, stored_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_phase_turn ON session_phase(thread_id, turn_id, seq);
      CREATE INDEX IF NOT EXISTS session_phase_dispatch ON session_phase(thread_id, dispatch_id, seq);
      CREATE INDEX IF NOT EXISTS session_phase_kind ON session_phase(phase, stored_at);
      CREATE TABLE IF NOT EXISTS session_content (
        hash TEXT PRIMARY KEY, text TEXT NOT NULL, stored_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_content_ref (
        parent TEXT NOT NULL, child TEXT NOT NULL, PRIMARY KEY(parent, child)
      );
      CREATE INDEX IF NOT EXISTS session_content_ref_child ON session_content_ref(child);
      CREATE TABLE IF NOT EXISTS composition_version (
        id TEXT PRIMARY KEY, role TEXT NOT NULL, slot TEXT NOT NULL, key TEXT NOT NULL UNIQUE,
        parts_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS composition_version_parts ON composition_version(parts_hash);
      PRAGMA user_version = 5;
    `);
    } catch (error) {
      this.closeDatabase();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    this.closeDatabase();
  }

  onClose(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  /** Import historical evidence without inventing turn outcomes or assistant messages. */
  importCheckpoint(batch: CheckpointImport): void {
    this.db.transaction(() => {
      for (const thread of batch.threads) {
        const existing = this.query('SELECT meta FROM session_threads WHERE id=?').get(
          thread.id,
        ) as { meta: string } | null;
        if (existing) {
          if (JSON.parse(existing.meta).projectId !== thread.meta.projectId)
            throw new Error(`Checkpoint owner conflict: ${thread.id}`);
        } else this.saveThread(thread);
      }
      for (const { threadId, trace } of batch.traces) {
        const record = JSON.stringify(trace);
        const existing = this.query(
          'SELECT thread_id, record FROM checkpoint_traces WHERE id=? OR turn_id=?',
        ).get(trace.id, trace.messageId) as { thread_id: string; record: string } | null;
        if (existing) {
          if (existing.thread_id !== threadId || existing.record !== record)
            throw new Error(`Checkpoint trace conflict: ${trace.id}`);
          continue;
        }
        if (this.trace(trace.id) || this.turn(trace.messageId))
          throw new Error(`Checkpoint overlaps a journaled turn: ${trace.id}`);
        this.query(
          'INSERT INTO checkpoint_traces(id, turn_id, thread_id, record, checksum, provenance) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
          trace.id,
          trace.messageId,
          threadId,
          record,
          checksum(record),
          JSON.stringify({
            kind: 'checkpoint-import',
            source: batch.source,
            capturedAt: batch.capturedAt,
            threadId,
            ownerEvidence: 'captured trace span or injection-layer identity',
            nativeOutcome: 'not-reverified',
          }),
        );
      }
    })();
  }

  /** Append outcome evidence without replacing knowledge or a newer live thread's metadata. */
  appendLearning(thread: Pick<Thread, 'id' | 'meta'>, signal: Signal): void {
    const content = signal.content as {
      owner?: { threadId?: string; projectId?: string };
      domain?: string;
    };
    if (
      signal.kind !== 'domain_learning' ||
      !signal.id ||
      !content?.domain ||
      content.owner?.threadId !== thread.id ||
      content.owner.projectId !== thread.meta.projectId
    )
      throw Error('Learning audit owner mismatch');
    this.db.transaction(() => {
      const record = this.encode(signal, { bytes: LEARNING_RECORD_LIMIT, what: 'learning audit' });
      const priorOwner = this.query('SELECT meta FROM session_threads WHERE id=?').get(
        thread.id,
      ) as { meta: string } | null;
      if (priorOwner && JSON.parse(priorOwner.meta).projectId !== content.owner!.projectId)
        throw Error('Stored learning audit owner mismatch');
      if (!priorOwner) this.saveThread(thread);
      const prior = this.query(
        'SELECT thread_id, record FROM session_learning WHERE signal_id=?',
      ).get(signal.id) as { thread_id: string; record: string } | null;
      if (prior) {
        if (prior.thread_id !== thread.id || !this.sameRecord(prior.record, record, signal))
          throw Error('Learning audit identity conflict');
        return;
      }
      this.query(
        'INSERT INTO session_learning(signal_id, thread_id, record, checksum, stored_at) VALUES (?, ?, ?, ?, ?)',
      ).run(signal.id, thread.id, record, checksum(record), Date.now());
    })();
  }

  /** Latest explicit capacity evidence per domain, independent of the hot history limit. */
  learningCapacity(threadId: string): Signal[] {
    const rows = this.query(`SELECT record, checksum FROM session_learning WHERE seq IN (
      SELECT MAX(seq) FROM session_learning WHERE thread_id=? AND json_extract(record, '$.content.capacity') IS NOT NULL
      GROUP BY json_extract(record, '$.content.domain'))`).all(threadId) as {
      record: string;
      checksum: string;
    }[];
    return rows.map((row) => {
      if (checksum(row.record) !== row.checksum) throw Error('Learning capacity checksum mismatch');
      return this.decode<Signal>(row.record);
    });
  }

  /** The update and its evidence are committed together, not as separate sinks. */
  saveKnowledge(
    thread: Pick<Thread, 'id' | 'meta'>,
    bundle: ThreadKnowledgeBundle,
    signal: Signal,
    expected?: { job: ReviewJob; eligible: () => boolean },
  ): 'committed' | 'duplicate' | 'stale' {
    if (bundle.threadId !== thread.id || bundle.projectId !== thread.meta.projectId)
      throw new Error('Knowledge owner mismatch');
    if (!bundle.domains || typeof bundle.domains !== 'object' || Array.isArray(bundle.domains))
      throw new Error('Invalid knowledge domain map');
    for (const snapshot of Object.values(bundle.domains)) {
      if (
        !snapshot ||
        snapshot.threadId !== thread.id ||
        snapshot.projectId !== thread.meta.projectId
      )
        throw new Error('Knowledge child owner mismatch');
    }
    if (signal.kind !== 'domain_learning' || !signal.id)
      throw new Error('Expected an identified learning event');
    const record = JSON.stringify(bundle);
    if (Buffer.byteLength(record) > 2_000_000)
      throw new Error('Knowledge journal record exceeds size limit');
    try {
      return this.db.transaction(() => {
        const event = this.encode(signal, { bytes: LEARNING_RECORD_LIMIT, what: 'learning event' });
        if (
          expected &&
          (!expected.eligible() ||
            expected.job.threadId !== thread.id ||
            expected.job.projectId !== thread.meta.projectId ||
            !expected.job.generation ||
            signal.id !== expected.job.id)
        )
          throw new StaleKnowledge();
        const existingOwner = this.query('SELECT meta FROM session_threads WHERE id=?').get(
          thread.id,
        ) as { meta: string } | null;
        if (existingOwner && JSON.parse(existingOwner.meta).projectId !== bundle.projectId)
          throw new Error('Stored knowledge project owner mismatch');
        const previousEvent = this.query(
          'SELECT thread_id, record FROM session_learning WHERE signal_id=?',
        ).get(signal.id) as { thread_id: string; record: string } | null;
        if (previousEvent) {
          if (
            previousEvent.thread_id !== thread.id ||
            !this.sameRecord(previousEvent.record, event, signal)
          )
            throw new Error('Learning event identity conflict');
          return 'duplicate' as const;
        }
        const previous = this.knowledge(thread.id);
        const update = signal.content as { domain?: string; decision?: string; revision?: number };
        const domain = update?.domain;
        if (!domain || !bundle.domains[domain])
          throw new Error('Learning event names an unknown domain');
        let committed = previous;
        if (update.decision === 'learned') {
          const next = bundle.domains[domain];
          const prior = previous?.domains[domain];
          if (expected) {
            const job = expected.job;
            if (
              job.domain !== domain ||
              (prior?.revision ?? 0) !== job.base.revision ||
              (prior?.hash ?? computeHash('')) !== job.base.hash ||
              next.revision !== job.base.revision + 1 ||
              next.hash !== computeHash(next.content) ||
              next.evidence.at(-1)?.id !== job.evidence.id ||
              (signal.content as { job?: ReviewJob }).job?.generation !== job.generation
            )
              throw new StaleKnowledge();
            if (prior?.evidence.some((e) => e.id === job.evidence.id)) return 'duplicate' as const;
          }
          if (
            update.revision !== next.revision ||
            (prior &&
              (next.revision < prior.revision ||
                (next.revision === prior.revision && next.hash !== prior.hash)))
          ) {
            throw new Error(`Knowledge revision cannot move backwards or conflict: ${domain}`);
          }
          // Another domain may already have learned while this signal was being
          // delivered. Commit only the domain whose evidence is in this transaction.
          committed = { ...bundle, domains: { ...previous?.domains, [domain]: next } };
        }
        this.saveThread(thread);
        const at = Date.now();
        this.query(
          'INSERT INTO session_learning(signal_id, thread_id, record, checksum, stored_at) VALUES (?, ?, ?, ?, ?)',
        ).run(signal.id, thread.id, event, checksum(event), at);
        if (committed) {
          const snapshotRecord = JSON.stringify(committed);
          this.query(
            'INSERT INTO session_knowledge(thread_id, record, checksum, stored_at) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET record=excluded.record, checksum=excluded.checksum, stored_at=excluded.stored_at',
          ).run(thread.id, snapshotRecord, checksum(snapshotRecord), at);
        }
        // A deadline crossed during synchronous SQL work cannot escape as a valid commit.
        if (expected && !expected.eligible()) throw new StaleKnowledge();
        return 'committed' as const;
      })();
    } catch (error) {
      if (error instanceof StaleKnowledge) return 'stale';
      throw error;
    }
  }

  knowledge(threadId: string): ThreadKnowledgeBundle | undefined {
    const row = this.query('SELECT record, checksum FROM session_knowledge WHERE thread_id=?').get(
      threadId,
    ) as { record: string; checksum: string } | null;
    if (!row) return undefined;
    if (checksum(row.record) !== row.checksum)
      throw new Error('Knowledge journal checksum mismatch');
    return JSON.parse(row.record);
  }

  /** Append one phase record; returns when it was stored. Idempotent for the same id and bytes; a different record under a known id is a conflict. */
  appendPhase(thread: Pick<Thread, 'id' | 'meta'>, input: PhaseRecordInput): number {
    if (!input.id || !input.phase) throw Error('Phase record requires id and phase');
    return this.db.transaction((): number => {
      const record = this.encode(input.record, {
        bytes: PHASE_RECORD_LIMIT,
        what: `${input.phase} phase record`,
      });
      this.saveThread(thread);
      // Idempotent only for an exact replay: the same thread, turn, dispatch, phase and bytes. Any contradiction
      // is refused without touching the original row.
      type PriorPhase = {
        thread_id: string;
        turn_id: string | null;
        dispatch_id: string | null;
        phase: string;
        record: string;
        stored_at: number;
      };
      const prior = this.query(
        'SELECT thread_id, turn_id, dispatch_id, phase, record, stored_at FROM session_phase WHERE id=?',
      ).get(input.id) as PriorPhase | null;
      if (prior) {
        const same =
          prior.thread_id === thread.id &&
          (prior.turn_id ?? null) === (input.turnId ?? null) &&
          (prior.dispatch_id ?? null) === (input.dispatchId ?? null) &&
          prior.phase === input.phase &&
          this.sameRecord(prior.record, record, input.record);
        if (!same) throw Error('Phase record identity conflict');
        return prior.stored_at;
      }
      const storedAt = Date.now();
      this.query(
        'INSERT INTO session_phase(id, thread_id, turn_id, dispatch_id, phase, record, checksum, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        input.id,
        thread.id,
        input.turnId,
        input.dispatchId,
        input.phase,
        record,
        checksum(record),
        storedAt,
      );
      // A middleware row that lands after its turn closed (a late guard outcome) is reduced now.
      if (
        input.turnId &&
        (RAW_MIDDLEWARE_PHASES as readonly string[]).includes(input.phase) &&
        !isOpenTurn(this.turn(input.turnId)?.status ?? 'unknown')
      )
        this.compactTurn(thread, input.turnId);
      return storedAt;
    })();
  }

  /** Phase records of a thread, oldest first: by turn, by dispatch, or only those with no turn correlation. */
  phaseHistory(
    threadId: string,
    opts: { turnId?: string; dispatchId?: string; uncorrelated?: boolean; limit?: number } = {},
  ): StoredPhase[] {
    const limit = opts.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
      throw new Error('Phase history limit must be an integer between 1 and 5000');
    const where = ['thread_id=?'],
      params: (string | number)[] = [threadId];
    if (opts.turnId !== undefined) {
      where.push('turn_id=?');
      params.push(opts.turnId);
    }
    if (opts.dispatchId !== undefined) {
      where.push('dispatch_id=?');
      params.push(opts.dispatchId);
    }
    if (opts.uncorrelated) where.push('turn_id IS NULL');
    const rows = this.query(
      `SELECT id, turn_id, dispatch_id, phase, record, checksum, stored_at FROM session_phase WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
    ).all(...params, limit) as Array<{
      id: string;
      turn_id: string | null;
      dispatch_id: string | null;
      phase: string;
      record: string;
      checksum: string;
      stored_at: number;
    }>;
    return rows.reverse().map((row) => {
      if (checksum(row.record) !== row.checksum) throw new Error('Phase record checksum mismatch');
      return {
        id: row.id,
        threadId,
        turnId: row.turn_id,
        dispatchId: row.dispatch_id,
        phase: row.phase,
        record: this.decode<Record<string, unknown>>(row.record),
        storedAt: row.stored_at,
      };
    });
  }

  /** Feedback lifecycle rows across threads, oldest first, with each thread's project (docs/FEEDBACK-LOOP.md). */
  feedbackPhases(
    opts: { projectId?: string } = {},
  ): Array<StoredPhase & { projectId: string | null }> {
    const rows = this.query(
      `SELECT p.id, p.thread_id, p.turn_id, p.dispatch_id, p.phase, p.record, p.checksum, p.stored_at,
              json_extract(t.meta, '$.projectId') AS project_id
         FROM session_phase p JOIN session_threads t ON t.id = p.thread_id
        WHERE p.phase LIKE 'feedback-%'${opts.projectId !== undefined ? " AND json_extract(t.meta, '$.projectId') = ?" : ''}
        ORDER BY p.seq`,
    ).all(...(opts.projectId !== undefined ? [opts.projectId] : [])) as Array<{
      id: string;
      thread_id: string;
      turn_id: string | null;
      dispatch_id: string | null;
      phase: string;
      record: string;
      checksum: string;
      stored_at: number;
      project_id: string | null;
    }>;
    return rows.map((row) => {
      if (checksum(row.record) !== row.checksum) throw new Error('Phase record checksum mismatch');
      return {
        id: row.id,
        threadId: row.thread_id,
        turnId: row.turn_id,
        dispatchId: row.dispatch_id,
        phase: row.phase,
        record: this.decode<Record<string, unknown>>(row.record),
        storedAt: row.stored_at,
        projectId: row.project_id,
      };
    });
  }

  /**
   * An observed subagent run (spec A): a turn of a child thread recorded from the native stream,
   * opened with the task it was given. Idempotent for the same turn.
   */
  startObservedTurn(thread: Pick<Thread, 'id' | 'meta'>, turnId: string, task: string): void {
    this.db.transaction(() => {
      if (this.turn(turnId)) return;
      this.saveThread(thread);
      const timestamp = Date.now();
      this.query(
        "INSERT INTO session_turns(id, thread_id, status, started_at) VALUES (?, ?, 'active', ?)",
      ).run(turnId, thread.id, timestamp);
      this.insertMessage({
        id: newId('msg'),
        threadId: thread.id,
        turnId,
        actor: 'user',
        kind: 'text',
        content: task,
        timestamp,
        meta: { observed: true },
      });
    })();
  }

  /** A native observation of an observed subagent run, owned by its child thread and turn. */
  appendObservedNative(
    thread: Pick<Thread, 'id' | 'meta'>,
    turnId: string,
    evidence: NativeEvidence,
  ): void {
    const owner: import('@inixiative/foundry-core').NativeOwner = {
      threadId: thread.id,
      ...(thread.meta.projectId ? { projectId: thread.meta.projectId } : {}),
      generation: 'observed',
      messageId: turnId,
      dispatchId: `observed:${turnId}`,
    };
    this.query(
      'INSERT INTO session_native(admission_id, thread_id, turn_id, record, stored_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      `observed:${turnId}`,
      thread.id,
      turnId,
      JSON.stringify({ ...evidence, owner }),
      Date.now(),
    );
  }

  /** The end of an observed subagent run: its answer as the agent message, and its outcome. */
  endObservedTurn(
    thread: Pick<Thread, 'id' | 'meta'>,
    turnId: string,
    content: string,
    outcome: 'completed' | 'failed',
  ): void {
    this.db.transaction(() => {
      const turn = this.turn(turnId);
      if (!turn || turn.threadId !== thread.id || !isOpenTurn(turn.status)) return;
      this.saveThread(thread);
      this.insertMessage({
        id: newId('msg'),
        threadId: thread.id,
        turnId,
        actor: 'agent',
        kind: outcome === 'failed' ? 'error' : 'text',
        content,
        timestamp: Date.now(),
        meta: { observed: true },
      });
      this.query('UPDATE session_turns SET status=?, ended_at=? WHERE id=?').run(
        outcome,
        Date.now(),
        turnId,
      );
    })();
  }

  /** A thread's running turn, else its latest queued one. */
  openTurn(threadId: string): StoredTurn | undefined {
    const row = this.query(
      "SELECT id FROM session_turns WHERE thread_id=? AND status IN ('queued', 'active') ORDER BY status = 'active' DESC, started_at DESC LIMIT 1",
    ).get(threadId) as { id: string } | null;
    return row ? this.turn(row.id) : undefined;
  }

  /** The native session identities a thread's executor evidence names (Codex thread, Claude session). */
  nativeSessionIds(threadId: string): Array<{ threadId?: string; sessionId?: string }> {
    return (
      this.query(
        `SELECT DISTINCT json_extract(record, '$.threadId') AS thread,
          COALESCE(json_extract(record, '$.externalSessionId'), json_extract(record, '$.nativeSessionId')) AS session
          FROM session_native WHERE thread_id=? AND admission_id NOT LIKE 'observed:%'`,
      ).all(threadId) as Array<{ thread: string | null; session: string | null }>
    ).flatMap(
      (row): Array<{ threadId?: string; sessionId?: string }> =>
        row.thread ? [{ threadId: row.thread }] : row.session ? [{ sessionId: row.session }] : [],
    );
  }

  /** Threads with a turn queued or running. */
  openTurnThreads(): string[] {
    return (
      this.query(
        "SELECT DISTINCT thread_id FROM session_turns WHERE status IN ('queued', 'active')",
      ).all() as Array<{ thread_id: string }>
    ).map((row) => row.thread_id);
  }

  /** Store text in the content store; returns its hash. */
  putContent(text: string): string {
    return this.content.put(text);
  }

  /** Text stored under `hash` (throws when it is missing). */
  contentText(hash: string): string {
    return this.content.get(hash);
  }

  /**
   * The composition version with exactly these parts (written once): its id. Parts name their
   * source version and the hash of the text it contributed, so the text and its provenance stay
   * reachable from the version (`session_content_ref`).
   */
  compositionVersion(role: string, slot: string, body: CompositionBody): string {
    const { parts } = body;
    const json = JSON.stringify(body);
    const key = contentHash(JSON.stringify([role, slot, json]));
    const found = this.query('SELECT id FROM composition_version WHERE key=?').get(key) as {
      id: string;
    } | null;
    if (found) return found.id;
    const partsHash = this.content.put(
      json,
      parts.flatMap((part) => ('text' in part ? [part.text] : [])),
    );
    const id = `cv_${Bun.randomUUIDv7()}`;
    this.query(
      'INSERT INTO composition_version(id, role, slot, key, parts_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING',
    ).run(id, role, slot, key, partsHash, Date.now());
    return (this.query('SELECT id FROM composition_version WHERE key=?').get(key) as { id: string })
      .id;
  }

  getCompositionVersion(
    id: string,
  ): (CompositionBody & { id: string; role: string; slot: string; createdAt: number }) | null {
    const row = this.query(
      'SELECT id, role, slot, parts_hash, created_at FROM composition_version WHERE id=?',
    ).get(id) as {
      id: string;
      role: string;
      slot: string;
      parts_hash: string;
      created_at: number;
    } | null;
    if (!row) return null;
    return {
      id: row.id,
      role: row.role,
      slot: row.slot,
      ...(JSON.parse(this.content.get(row.parts_hash)) as CompositionBody),
      createdAt: row.created_at,
    };
  }

  /** Composition versions one of whose parts' text holds `marker` (a feedback rule's `(fb_…)`). */
  compositionsHolding(marker: string, holding = this.contentHolding(marker)): Set<string> {
    const ids = new Set<string>();
    if (!holding.size) return ids;
    for (const row of this.query(
      'SELECT id, parts_hash FROM composition_version',
    ).iterate() as Iterable<{
      id: string;
      parts_hash: string;
    }>)
      if (holding.has(row.parts_hash)) ids.add(row.id);
    return ids;
  }

  /**
   * Advice and guard-request rows stored at or after `since` whose composed input held `marker` (by
   * the versions they name, or their recorded text): the calls that had a feedback rule in front of a
   * Warden; after retention, their reduced rows. Roles are the participants that had it.
   */
  phasesContaining(
    marker: string,
    since: number,
    limit = 500,
  ): Array<{
    threadId: string;
    turnId: string | null;
    phase: string;
    roles: string[];
    storedAt: number;
  }> {
    // Composed input is stored by reference: a row matches when it holds the marker inline, or a
    // reference that leads, through section lists and nested records, to content holding it.
    const holding = this.contentHolding(marker);
    const held = this.compositionsHolding(marker, holding);
    const compositions = [...held];
    const rows: Array<{
      thread_id: string;
      turn_id: string | null;
      phase: string;
      record: string;
      stored_at: number;
    }> = [];
    for (const row of this.query(
      `SELECT thread_id, turn_id, phase, record, stored_at FROM session_phase
        WHERE phase IN ('advice', 'guard-request') AND stored_at >= ? ORDER BY seq DESC`,
    ).iterate(since) as Iterable<(typeof rows)[number]>) {
      if (
        row.record.includes(marker) ||
        referencedHashes(row.record).some((hash) => holding.has(hash)) ||
        compositions.some((id) => row.record.includes(id))
      )
        rows.push(row);
      if (rows.length >= limit) break;
    }
    // Only the composed input counts: a participant's segments, or a guard call's system instructions.
    // The marker elsewhere (an observed tool input that read the role file) is not exposure.
    return rows
      .reverse()
      .map((row) => {
        type Versions = { instructions?: string; domainKnowledge?: string };
        const record = this.decode<{
          domain?: string;
          request?: { messages?: Array<{ role?: string; content?: unknown }>; versions?: Versions };
          participants?: Array<{
            domain?: string;
            segments?: unknown;
            request?: { versions?: Versions };
          }>;
        }>(row.record);
        // A call names the composition versions it was made of; one holding the marker is exposure.
        const composed = (versions?: Versions) =>
          !!versions &&
          [versions.instructions, versions.domainKnowledge].some((id) => !!id && held.has(id));
        const roles =
          row.phase === 'guard-request'
            ? record.domain &&
              (composed(record.request?.versions) ||
                (record.request?.messages ?? []).some(
                  (m) => m.role === 'system' && JSON.stringify(m.content ?? '').includes(marker),
                ))
              ? [record.domain]
              : []
            : (record.participants ?? [])
                .filter(
                  (p) =>
                    p.domain &&
                    (composed(p.request?.versions) ||
                      JSON.stringify(p.segments ?? '').includes(marker)),
                )
                .map((p) => p.domain as string);
        return {
          threadId: row.thread_id,
          turnId: row.turn_id,
          phase: row.phase,
          roles,
          storedAt: row.stored_at,
        };
      })
      .filter((row) => row.roles.length > 0)
      .concat(this.reducedExposure(held, since, limit));
  }

  /**
   * Exposure from reduced rows whose raw row retention removed: a call counts once, from its raw row
   * while it exists, then from its reduced row. Matched by the versions the call was composed of.
   */
  private reducedExposure(held: ReadonlySet<string>, since: number, limit: number) {
    if (!held.size) return [];
    const out: Array<{
      threadId: string;
      turnId: string | null;
      phase: string;
      roles: string[];
      storedAt: number;
    }> = [];
    const rawExists = this.query('SELECT 1 FROM session_phase WHERE id=?');
    for (const row of this.query(
      `SELECT thread_id, turn_id, record, stored_at FROM session_phase
        WHERE phase='${REDUCED_PHASE}' AND COALESCE(json_extract(record, '$.at'), stored_at) >= ?
        ORDER BY seq`,
    ).iterate(since) as Iterable<{
      thread_id: string;
      turn_id: string | null;
      record: string;
      stored_at: number;
    }>) {
      if (out.length >= limit) break;
      if (![...held].some((id) => row.record.includes(id))) continue;
      const reduced = this.decode<{
        callId: string;
        role: string;
        at?: number;
        state?: { versions?: { instructions?: string; domainKnowledge?: string } };
      }>(row.record);
      const versions = reduced.state?.versions;
      if (
        !versions ||
        ![versions.instructions, versions.domainKnowledge].some((id) => !!id && held.has(id))
      )
        continue;
      if (rawExists.get(reduced.callId.split(':')[0]!)) continue;
      out.push({
        threadId: row.thread_id,
        turnId: row.turn_id,
        phase: REDUCED_PHASE,
        roles: [reduced.role],
        // When the call ran, not when it was reduced.
        storedAt: reduced.at ?? row.stored_at,
      });
    }
    return out;
  }

  learningHistory(threadId: string, limit = 100): StoredLearning[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Learning history limit must be an integer between 1 and 1000');
    const rows = this.query(
      'SELECT record, checksum, stored_at FROM session_learning WHERE thread_id=? ORDER BY seq DESC LIMIT ?',
    ).all(threadId, limit) as Array<{ record: string; checksum: string; stored_at: number }>;
    return rows.reverse().map((row) => {
      if (checksum(row.record) !== row.checksum)
        throw new Error('Learning event checksum mismatch');
      return { threadId, signal: this.decode<Signal>(row.record), storedAt: row.stored_at };
    });
  }

  saveThread(thread: Pick<Thread, 'id' | 'meta'>): void {
    const existing = this.query('SELECT meta FROM session_threads WHERE id=?').get(thread.id) as {
      meta: string;
    } | null;
    if (existing && JSON.parse(existing.meta).projectId !== thread.meta.projectId)
      throw new Error(`Thread journal owner cannot change: ${thread.id}`);
    this.query(
      'INSERT INTO session_threads(id, meta) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET meta=excluded.meta',
    ).run(thread.id, JSON.stringify(thread.meta));
  }

  threads(): Array<{ id: string; meta: ThreadMeta }> {
    return (
      this.query('SELECT id, meta FROM session_threads ORDER BY rowid').all() as Array<{
        id: string;
        meta: string;
      }>
    ).map((row) => ({ id: row.id, meta: JSON.parse(row.meta) }));
  }

  turn(id: string): StoredTurn | undefined {
    const row = this.query(
      'SELECT id, thread_id AS threadId, status, started_at AS startedAt, ended_at AS endedAt, error FROM session_turns WHERE id=?',
    ).get(id) as StoredTurn | null;
    return row ?? undefined;
  }

  /** The thread's newest turn ids, newest first. */
  recentTurnIds(threadId: string, limit: number): string[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Recent turn limit must be an integer between 1 and 500');
    return (
      this.query(
        'SELECT id FROM session_turns WHERE thread_id=? ORDER BY started_at DESC, rowid DESC LIMIT ?',
      ).all(threadId, limit) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  /** Accept a turn: the user's message, with `meta` (host instructions, for one) beside it. */
  beginTurn(
    thread: Pick<Thread, 'id' | 'meta'>,
    id: string,
    content: string,
    meta?: Record<string, unknown>,
  ): void {
    this.db.transaction(() => {
      if (this.turn(id) || this.traceForTurn(id))
        throw new Error(`Turn already accepted or archived: ${id}`);
      this.saveThread(thread);
      const timestamp = Date.now();
      this.query(
        "INSERT INTO session_turns(id, thread_id, status, started_at) VALUES (?, ?, 'queued', ?)",
      ).run(id, thread.id, timestamp);
      this.insertMessage({
        id: newId('msg'),
        threadId: thread.id,
        turnId: id,
        actor: 'user',
        kind: 'text',
        content,
        timestamp,
        ...(meta ? { meta } : {}),
      });
    })();
  }

  /** The executor is handing the turn to its runtime: from here native work may exist. */
  startTurn(thread: Pick<Thread, 'id' | 'meta'>, id: string): void {
    this.db.transaction(() => {
      this.requireOpen(id, thread.id);
      this.query("UPDATE session_turns SET status='active' WHERE id=? AND status='queued'").run(id);
    })();
  }

  completeTurn(
    thread: Pick<Thread, 'id' | 'meta'>,
    id: string,
    content: string,
    meta: Record<string, unknown>,
    trace: PersistedTraceRecord,
  ): void {
    this.db.transaction(() => {
      this.requireOpen(id, thread.id);
      if (trace.messageId !== id) throw new Error('Trace does not belong to this turn');
      this.saveThread(thread);
      this.insertTrace(thread.id, id, trace);
      this.insertMessage({
        id: newId('msg'),
        threadId: thread.id,
        turnId: id,
        actor: 'agent',
        kind: 'text',
        content,
        timestamp: Date.now(),
        traceId: trace.id,
        meta,
      });
      this.query("UPDATE session_turns SET status='completed', ended_at=? WHERE id=?").run(
        Date.now(),
        id,
      );
      this.compactTurn(thread, id);
    })();
  }

  failTurn(
    thread: Pick<Thread, 'id' | 'meta'>,
    id: string,
    error: string,
    evidence?: { trace?: PersistedTraceRecord; meta?: Record<string, unknown> },
  ): void {
    this.db.transaction(() => {
      this.requireOpen(id, thread.id);
      this.saveThread(thread);
      if (evidence?.trace) {
        if (evidence.trace.messageId !== id) throw new Error('Trace does not belong to this turn');
        this.insertTrace(thread.id, id, evidence.trace);
      }
      this.finishUncertain(id, thread.id, 'failed', error, evidence?.trace?.id, evidence?.meta);
      this.compactTurn(thread, id);
    })();
  }

  /**
   * Spec A (docs/THREAD-TREE.md): a closed turn's middleware calls as reduced rows, one per call
   * (`middleware-reduced`, id `mw:<call id>`): state and result, never the message the call was
   * sent. Raw rows are never rewritten; they age out under `pruneRawMiddleware`. Idempotent: a call
   * already reduced is not reduced again, and a late call is reduced when it lands.
   */
  compactTurn(thread: Pick<Thread, 'id' | 'meta'>, turnId: string): number {
    const raw = RAW_MIDDLEWARE_PHASES.map((phase) => `'${phase}'`).join(', ');
    const rows = (
      this.query(
        `SELECT id, turn_id, phase, record, stored_at FROM session_phase
          WHERE thread_id=? AND turn_id=? AND phase IN (${raw}) ORDER BY seq`,
      ).all(thread.id, turnId) as Array<{
        id: string;
        turn_id: string | null;
        phase: string;
        record: string;
        stored_at: number;
      }>
    ).map((row) => ({
      id: row.id,
      turnId: row.turn_id,
      phase: row.phase,
      record: this.decode<Record<string, unknown>>(row.record),
      storedAt: row.stored_at,
    }));
    if (!rows.length) return 0;
    const done = new Set(
      (
        this.query(
          `SELECT id FROM session_phase WHERE thread_id=? AND turn_id=? AND phase='${REDUCED_PHASE}'`,
        ).all(thread.id, turnId) as Array<{ id: string }>
      ).map((row) => row.id),
    );
    let added = 0;
    for (const reduced of reduceMiddleware(rows, (text) => this.content.put(text))) {
      const id = `mw:${reduced.callId}`;
      if (done.has(id)) continue;
      this.appendPhase(thread, {
        id,
        turnId,
        dispatchId: null,
        phase: REDUCED_PHASE,
        record: reduced as unknown as Record<string, unknown>,
      });
      added++;
    }
    return added;
  }

  /**
   * Reduce every closed turn with a middleware row written after its reduced rows (by journal
   * order): on start, so a turn a restart interrupted is reduced before its first capture. Returns
   * the threads it reduced something for, so their capture can be scheduled.
   */
  compactClosedTurns(): string[] {
    const raw = RAW_MIDDLEWARE_PHASES.map((phase) => `'${phase}'`).join(', ');
    const pending = this.query(
      `SELECT p.thread_id AS thread_id, p.turn_id AS turn_id FROM session_phase p
        JOIN session_turns t ON t.id = p.turn_id
        WHERE t.status IN ('completed', 'failed', 'interrupted')
        GROUP BY p.thread_id, p.turn_id
        HAVING MAX(CASE WHEN p.phase IN (${raw}) THEN p.seq END) >
          COALESCE(MAX(CASE WHEN p.phase = '${REDUCED_PHASE}' THEN p.seq END), -1)`,
    ).all() as Array<{ thread_id: string; turn_id: string }>;
    const threads = new Map(this.threads().map((thread) => [thread.id, thread]));
    const changed = new Set<string>();
    for (const { thread_id, turn_id } of pending) {
      const thread = threads.get(thread_id);
      if (thread && this.db.transaction(() => this.compactTurn(thread, turn_id))())
        changed.add(thread_id);
    }
    return [...changed];
  }

  /**
   * Retention for raw middleware rows (`journal.rawMiddlewareDays`): a raw row is deleted once its
   * turn ended before `cutoff` and a reduced row names it as a source. A row no reduced row covers
   * (a guard request whose outcome never came) is kept. Then journal content nothing references any
   * more is released.
   */
  pruneRawMiddleware(cutoff: number): { rows: number; content: number } {
    const raw = RAW_MIDDLEWARE_PHASES.map((phase) => `'${phase}'`).join(', ');
    const rows = this.db.transaction(
      () =>
        this.query(
          `DELETE FROM session_phase WHERE phase IN (${raw})
            AND turn_id IN (SELECT id FROM session_turns
              WHERE status IN ('completed', 'failed', 'interrupted') AND ended_at < ?)
            AND EXISTS (SELECT 1 FROM session_phase r, json_each(r.record, '$.sources') source
              WHERE r.thread_id = session_phase.thread_id AND r.turn_id = session_phase.turn_id
                AND r.phase = '${REDUCED_PHASE}' AND source.value = session_phase.id)`,
        ).run(cutoff).changes,
    )();
    return { rows, content: rows ? this.collectContent() : 0 };
  }

  /**
   * Release journal content no record references: a mark from every table's records (and the
   * composition versions' parts) through the content references, then a sweep of the rest.
   */
  collectContent(): number {
    const marked = new Set<string>();
    // Every 64-hex string a record holds counts: content references, and plain hashes such as a
    // call's retrieved text (`versions.retrieved[].hash`). Marking more than needed is safe.
    const mark = (text: string | null | undefined) => {
      if (!text) return;
      for (const match of text.matchAll(/"([0-9a-f]{64})"/g)) marked.add(match[1]!);
    };
    for (const [table, column] of [
      ['session_threads', 'meta'],
      ['session_messages', 'record'],
      ['session_traces', 'record'],
      ['session_knowledge', 'record'],
      ['session_learning', 'record'],
      ['session_native', 'record'],
      ['session_native_tools', 'record'],
      ['checkpoint_traces', 'record'],
      ['session_phase', 'record'],
    ] as const)
      for (const row of this.query(`SELECT ${column} AS text FROM ${table}`).iterate() as Iterable<{
        text: string;
      }>)
        mark(row.text);
    for (const row of this.query(
      'SELECT parts_hash FROM composition_version',
    ).iterate() as Iterable<{
      parts_hash: string;
    }>)
      marked.add(row.parts_hash);
    let frontier = [...marked];
    while (frontier.length) {
      const next: string[] = [];
      for (const parent of frontier)
        for (const row of this.query('SELECT child FROM session_content_ref WHERE parent=?').all(
          parent,
        ) as Array<{ child: string }>)
          if (!marked.has(row.child)) {
            marked.add(row.child);
            next.push(row.child);
          }
      frontier = next;
    }
    let released = 0;
    this.db.transaction(() => {
      for (const row of this.query('SELECT hash FROM session_content').all() as Array<{
        hash: string;
      }>) {
        if (marked.has(row.hash)) continue;
        this.query('DELETE FROM session_content_ref WHERE parent=? OR child=?').run(
          row.hash,
          row.hash,
        );
        this.query('DELETE FROM session_content WHERE hash=?').run(row.hash);
        const cached = this.contentCache.get(row.hash);
        if (cached !== undefined) {
          this.contentCacheChars -= cached.length;
          this.contentCache.delete(row.hash);
        }
        released++;
      }
    })();
    return released;
  }

  /**
   * Call only at server startup. An active turn becomes `interrupted`: native work may have
   * continued and its outcome is unknown. A queued turn was never sent, so it fails cleanly.
   */
  recoverInterrupted(): { interrupted: number; neverSent: number } {
    return this.db.transaction(() => {
      const rows = this.query(
        "SELECT id, thread_id AS threadId, status FROM session_turns WHERE status IN ('queued', 'active')",
      ).all() as Array<{ id: string; threadId: string; status: 'queued' | 'active' }>;
      for (const row of rows) {
        if (row.status === 'queued')
          this.finishUncertain(row.id, row.threadId, 'failed', TURN_NEVER_SENT, undefined, {
            neverSent: true,
            inputEvidence: 'unavailable',
            deliveryAcknowledgment: 'unavailable',
            nativeOutcome: 'unknown',
            persistence: 'committed',
          });
        else
          this.finishUncertain(
            row.id,
            row.threadId,
            'interrupted',
            'Foundry restarted before recording completion. Native work may have continued; its outcome must be checked before retrying.',
            undefined,
            {
              inputEvidence: 'unavailable',
              deliveryAcknowledgment: 'unavailable',
              nativeOutcome: 'unknown',
              persistence: 'committed',
            },
          );
        const stored = this.query('SELECT meta FROM session_threads WHERE id=?').get(
          row.threadId,
        ) as { meta: string };
        const meta: ThreadMeta = JSON.parse(stored.meta);
        if (meta.status !== 'archived')
          this.saveThread({ id: row.threadId, meta: { ...meta, status: 'waiting' } });
      }
      const neverSent = rows.filter((row) => row.status === 'queued').length;
      return { interrupted: rows.length - neverSent, neverSent };
    })();
  }

  messages(threadId: string, limit = 100): StoredMessage[] {
    const rows = this.query(
      'SELECT record FROM (SELECT seq, record FROM session_messages WHERE thread_id=? ORDER BY seq DESC LIMIT ?) ORDER BY seq',
    ).all(threadId, boundedLimit(limit)) as Array<{ record: string }>;
    return rows.map((row) => {
      const message = this.decode<StoredMessage>(row.record);
      const native = this.nativeHistory(threadId, message.turnId);
      const tools = this.nativeTools(threadId, message.turnId);
      return (native.length || tools.length) && message.actor === 'agent'
        ? {
            ...message,
            meta: {
              ...message.meta,
              ...(native.length ? { nativeHistory: native } : {}),
              ...(tools.length ? { nativeTools: tools } : {}),
            },
          }
        : message;
    });
  }

  archiveRecords(threadId: string): {
    messages: StoredMessage[];
    native: NativeEvidence[];
    tools: NativeToolEvidence[];
    phases: StoredPhase[];
    turns: StoredTurn[];
  } {
    const records = <T>(table: string): T[] =>
      (
        this.query(`SELECT record FROM ${table} WHERE thread_id=? ORDER BY seq`).all(threadId) as {
          record: string;
        }[]
      ).map((row) => this.decode<T>(row.record));
    const phases = (
      this.query('SELECT * FROM session_phase WHERE thread_id=? ORDER BY seq').all(
        threadId,
      ) as any[]
    ).map((row) => {
      if (checksum(row.record) !== row.checksum) throw new Error('Archive phase checksum mismatch');
      return {
        id: row.id,
        threadId,
        turnId: row.turn_id,
        dispatchId: row.dispatch_id,
        phase: row.phase,
        record: this.decode<Record<string, unknown>>(row.record),
        storedAt: row.stored_at,
      };
    });
    const turns = (
      this.query(
        'SELECT id, status, started_at, ended_at, error FROM session_turns WHERE thread_id=? ORDER BY started_at, id',
      ).all(threadId) as any[]
    ).map((row) => ({
      id: row.id,
      threadId,
      status: row.status,
      startedAt: row.started_at,
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      ...(row.error === null ? {} : { error: row.error }),
    }));
    return {
      messages: records<StoredMessage>('session_messages'),
      // Native evidence is stored raw, never encoded.
      native: (
        this.query('SELECT record FROM session_native WHERE thread_id=? ORDER BY seq').all(
          threadId,
        ) as { record: string }[]
      ).map((row) => JSON.parse(row.record) as NativeEvidence),
      tools: this.nativeTools(threadId),
      phases,
      turns,
    };
  }

  /** Bounded summary index, newest page first. Summary fields are projected inside SQLite
   * (`json_extract` / `json_type` / `json_each`); the stored record, with its injection, native and
   * provider payloads, is never decoded in JavaScript here. `detail` states what the owned detail
   * holds so absent detail never reads as empty. */
  messageIndex(threadId: string, opts: { limit?: number; before?: number } = {}): MessageIndexPage {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 500);
    const before = opts.before;
    const metaColumns = SUMMARY_META_KEYS.map(
      (key) => `json_extract(record, '$.meta.${key}') AS meta_${key}`,
    ).join(', ');
    type IndexRow = {
      seq: number;
      id: string;
      turnId: string;
      actor: StoredMessage['actor'];
      kind: StoredMessage['kind'];
      content: string | null;
      timestamp: number;
      traceId: string | null;
      error: string | null;
      injectionType: string | null;
      inlineNative: number | null;
      inlineNativeOutcome: string | null;
      recordNativeOutcome: string | null;
      injectedLayers: string | null;
      images: string | null;
      metaKeys: string | null;
    } & Record<`meta_${(typeof SUMMARY_META_KEYS)[number]}`, unknown>;
    const rows = this.query(`SELECT seq, id, turn_id AS turnId, actor,
        json_extract(record, '$.kind') AS kind, json_extract(record, '$.content') AS content, json_extract(record, '$.timestamp') AS timestamp,
        json_extract(record, '$.traceId') AS traceId, json_extract(record, '$.error') AS error,
        json_type(record, '$.meta.injection') AS injectionType,
        json_array_length(record, '$.meta.nativeHistory') AS inlineNative,
        json_extract(record, '$.meta.nativeHistory[#-1].nativeOutcome') AS inlineNativeOutcome,
        json_extract(record, '$.meta.native.nativeOutcome') AS recordNativeOutcome,
        json_extract(record, '$.meta.injectedLayers') AS injectedLayers,
        json_extract(record, '$.meta.images') AS images,
        (SELECT group_concat(key, char(31)) FROM json_each(session_messages.record, '$.meta')) AS metaKeys,
        ${metaColumns}
      FROM session_messages WHERE thread_id=?${before === undefined ? '' : ' AND seq<?'} ORDER BY seq DESC LIMIT ?`).all(
      ...(before === undefined ? [threadId, limit + 1] : [threadId, before, limit + 1]),
    ) as IndexRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    const turnIds = [...new Set(page.map((row) => row.turnId))];
    const marks = turnIds.map(() => '?').join(',');
    const turnStatus = new Map<string, StoredTurn['status']>(),
      nativeCounts = new Map<string, number>(),
      toolCounts = new Map<string, number>(),
      traced = new Set<string>();
    const traceSummaries = new Map<string, PersistedTraceRecord['summary']>();
    if (turnIds.length) {
      for (const row of this.query(
        `SELECT id, status FROM session_turns WHERE thread_id=? AND id IN (${marks})`,
      ).all(threadId, ...turnIds) as Array<{ id: string; status: StoredTurn['status'] }>)
        turnStatus.set(row.id, row.status);
      for (const row of this.query(
        `SELECT turn_id AS turnId, COUNT(*) AS n FROM session_native WHERE thread_id=? AND turn_id IN (${marks}) GROUP BY turn_id`,
      ).all(threadId, ...turnIds) as Array<{ turnId: string; n: number }>)
        nativeCounts.set(row.turnId, row.n);
      for (const row of this.query(
        `SELECT turn_id AS turnId, COUNT(*) AS n FROM session_native_tools WHERE thread_id=? AND turn_id IN (${marks}) GROUP BY turn_id`,
      ).all(threadId, ...turnIds) as Array<{ turnId: string; n: number }>)
        toolCounts.set(row.turnId, row.n);
      for (const value of this.volatileTools.values()) {
        const owner = value.record.association.owner?.messageId;
        if (value.record.owner.threadId === threadId && owner && turnIds.includes(owner))
          toolCounts.set(owner, (toolCounts.get(owner) ?? 0) + 1);
      }
      // Only the stored summary leaves SQLite; the full trace record (spans, injection annotations) stays on disk.
      for (const row of this.query(
        `SELECT turn_id AS turnId, json_extract(record, '$.summary') AS summary FROM session_traces WHERE thread_id=? AND turn_id IN (${marks})`,
      ).all(threadId, ...turnIds) as Array<{ turnId: string; summary: string | null }>) {
        traced.add(row.turnId);
        if (row.summary)
          traceSummaries.set(
            row.turnId,
            JSON.parse(row.summary) as PersistedTraceRecord['summary'],
          );
      }
    }
    const keySeparator = String.fromCharCode(31);
    const messages = page.map((row) => {
      const meta: Record<string, unknown> = {};
      for (const key of SUMMARY_META_KEYS) {
        const value = row[`meta_${key}`];
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && value.length > SUMMARY_SCALAR_MAX) continue; // outside the contract: stays in detail
        if (typeof value === 'string' && value.startsWith('{"$')) continue; // a journal reference: the value stays in detail
        meta[key] = value;
      }
      if (
        typeof row.injectedLayers === 'string' &&
        row.injectedLayers.length <= SUMMARY_LAYERS_MAX
      ) {
        try {
          const layers = JSON.parse(row.injectedLayers);
          if (Array.isArray(layers) && isSummaryValue(layers)) meta.injectedLayers = layers;
        } catch {
          /* malformed provenance stays in detail */
        }
      }
      // A message's images by identity (id, type, size): the viewer shows them from the attachment route.
      if (typeof row.images === 'string' && row.images.length <= SUMMARY_LAYERS_MAX) {
        try {
          const images = JSON.parse(row.images);
          if (Array.isArray(images) && isSummaryValue(images)) meta.images = images;
        } catch {
          /* malformed image references stay in detail */
        }
      }
      const metaKeys = row.metaKeys ? row.metaKeys.split(keySeparator) : [];
      const detailOnlyMeta = metaKeys.filter((key) => !(key in meta)).slice(0, SUMMARY_KEYS_MAX);
      const status: MessageSummary['status'] = {
        turn: turnStatus.get(row.turnId) ?? 'unknown',
        persistence: 'committed',
      };
      if (typeof meta.executionOutcome === 'string')
        status.executionOutcome = meta.executionOutcome;
      const nativeOutcome =
        typeof meta.nativeOutcome === 'string'
          ? meta.nativeOutcome
          : typeof row.recordNativeOutcome === 'string'
            ? row.recordNativeOutcome
            : typeof row.inlineNativeOutcome === 'string'
              ? row.inlineNativeOutcome
              : undefined;
      if (nativeOutcome) status.nativeOutcome = nativeOutcome;
      const agent = row.actor === 'agent';
      const summary: MessageSummary = {
        id: row.id,
        seq: row.seq,
        threadId,
        turnId: row.turnId,
        actor: row.actor,
        kind: row.kind,
        content: row.content ?? '',
        timestamp: row.timestamp,
        status,
        detail: {
          injection: row.injectionType === 'object',
          nativeHistory: agent ? (nativeCounts.get(row.turnId) ?? 0) + (row.inlineNative ?? 0) : 0,
          nativeTools: agent ? (toolCounts.get(row.turnId) ?? 0) : 0,
          trace: row.traceId !== null && traced.has(row.turnId),
          detailOnlyMeta,
        },
      };
      if (row.traceId !== null) summary.traceId = row.traceId;
      const traceSummary = row.traceId !== null ? traceSummaries.get(row.turnId) : undefined;
      if (traceSummary) summary.trace = traceSummary;
      if (row.error !== null) summary.error = row.error;
      if (Object.keys(meta).length) summary.meta = meta;
      return summary;
    });
    return {
      messages,
      hasMore,
      oldestReached: !hasMore,
      nextBefore: hasMore && page.length ? page[0]!.seq : null,
    };
  }
  /** What the graph panel reads for one turn: the turn detail without the native history, plus only the
   * native `tool_use` records of the named tools (journalled rows, then those recorded inline on the completion). */
  turnFlowRecord(
    threadId: string,
    turnId: string,
    toolNames: readonly string[],
  ): TurnFlowRecord | undefined {
    const turn = this.turn(turnId);
    if (!turn || turn.threadId !== threadId) return undefined;
    const messages = (
      this.query(
        'SELECT record FROM session_messages WHERE thread_id=? AND turn_id=? ORDER BY seq',
      ).all(threadId, turnId) as Array<{ record: string }>
    ).map((row) => this.decode<StoredMessage>(row.record));
    const trace = this.traceForTurn(turnId) ?? null;
    const agent = messages.find((message) => message.actor === 'agent');
    const root = trace?.root as { annotations?: { injection?: unknown } } | undefined;
    const injection = agent?.meta?.injection ?? root?.annotations?.injection ?? null;
    const marks = toolNames.map(() => '?').join(',');
    const journalled = toolNames.length
      ? (
          this.query(`SELECT record FROM session_native WHERE thread_id=? AND turn_id=?
      AND json_extract(record, '$.kind')='tool_use' AND json_extract(record, '$.toolName') IN (${marks}) ORDER BY seq`).all(
            threadId,
            turnId,
            ...toolNames,
          ) as { record: string }[]
        ).map((row) => JSON.parse(row.record) as NativeEvidence)
      : [];
    const inline = Array.isArray(agent?.meta?.nativeHistory)
      ? (agent.meta.nativeHistory as NativeEvidence[]).filter(
          (e) =>
            e?.kind === 'tool_use' &&
            typeof e.toolName === 'string' &&
            toolNames.includes(e.toolName),
        )
      : [];
    const seen = new Set(journalled.map((e) => JSON.stringify(e)));
    const taskUses = [...journalled, ...inline.filter((e) => !seen.has(JSON.stringify(e)))];
    return {
      threadId,
      turnId,
      turn,
      messages,
      trace,
      injection,
      phases: this.phaseHistory(threadId, { turnId }),
      taskUses,
    };
  }

  /** Full owned detail for one turn, fetched lazily. The injection is the recorded artifact. */
  turnDetail(threadId: string, turnId: string): TurnDetail | undefined {
    const turn = this.turn(turnId);
    if (!turn || turn.threadId !== threadId) return undefined;
    const messages = (
      this.query(
        'SELECT record FROM session_messages WHERE thread_id=? AND turn_id=? ORDER BY seq',
      ).all(threadId, turnId) as Array<{ record: string }>
    ).map((row) => this.decode<StoredMessage>(row.record));
    const trace = this.traceForTurn(turnId) ?? null;
    const agent = messages.find((message) => message.actor === 'agent');
    const root = trace?.root as { annotations?: { injection?: unknown } } | undefined;
    const injection = agent?.meta?.injection ?? root?.annotations?.injection ?? null;
    // Journalled native rows first, then evidence recorded inline with the completion (deduplicated by content).
    const nativeHistory = this.nativeHistory(threadId, turnId);
    const seen = new Set(nativeHistory.map((evidence) => JSON.stringify(evidence)));
    const inline = Array.isArray(agent?.meta?.nativeHistory)
      ? (agent.meta.nativeHistory as NativeEvidence[])
      : [];
    for (const evidence of inline) {
      const key = JSON.stringify(evidence);
      if (!seen.has(key)) {
        seen.add(key);
        nativeHistory.push(freezeEvidence(evidence));
      }
    }
    return {
      threadId,
      turnId,
      turn,
      messages,
      trace,
      injection,
      nativeHistory,
      nativeTools: this.nativeTools(threadId, turnId),
      phases: this.phaseHistory(threadId, { turnId }),
    };
  }

  nativeHistory(threadId: string, turnId: string): NativeEvidence[] {
    return (
      this.query(
        'SELECT record FROM session_native WHERE thread_id=? AND turn_id=? ORDER BY seq',
      ).all(threadId, turnId) as { record: string }[]
    ).map((row) => freezeEvidence(JSON.parse(row.record)));
  }

  /** The observation is immutable; publication state is a separate column.
   * A failed write remains explicitly volatile and cannot veto native output. */
  persistNativeTool(
    thread: Pick<Thread, 'id' | 'meta'>,
    input: NativeToolRecord,
    publish: () => boolean,
  ): NativeToolEvidence {
    const record = freezeEvidence(input),
      association = record.association;
    if (record.owner.threadId !== thread.id) throw Error('Foreign native tool record refused');
    if (association.kind === 'registered-admission-window') {
      const first = this.query(
        'SELECT record FROM session_native WHERE admission_id=? ORDER BY seq LIMIT 1',
      ).get(association.admissionId ?? '') as { record: string } | null;
      if (
        !first ||
        JSON.stringify(JSON.parse(first.record).owner) !== JSON.stringify(association.owner) ||
        association.owner?.generation !== record.owner.generation ||
        association.owner?.threadId !== thread.id ||
        association.owner?.projectId !== record.owner.projectId
      )
        throw Error('Native tool association has no exact registered owner');
    } else if (
      association.owner ||
      association.admissionId ||
      record.owner.projectId !== thread.meta.projectId
    )
      throw Error('Unassociated tool cannot name an admission or foreign scope');
    const prior = this.query('SELECT record, publication FROM session_native_tools WHERE id=?').get(
      record.id,
    ) as { record: string; publication: NativeToolEvidence['publication'] } | null;
    if (prior) {
      if (prior.record !== JSON.stringify(record))
        throw Error('Native tool observation is immutable');
      return freezeEvidence({ record, persistence: 'committed', publication: prior.publication });
    }
    let evidence: NativeToolEvidence = freezeEvidence({
      record,
      persistence: 'pending',
      publication: 'pending',
    });
    this.retainVolatileTool(evidence);
    try {
      this.query(
        'INSERT INTO session_native_tools(id, thread_id, turn_id, record, publication, stored_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        record.id,
        thread.id,
        association.owner?.messageId ?? null,
        JSON.stringify(record),
        'pending',
        Date.now(),
      );
      evidence = freezeEvidence({ record, persistence: 'committed', publication: 'pending' });
    } catch {
      evidence = freezeEvidence({
        record,
        persistence: 'failed',
        publication: 'reconciliation-needed',
        error: 'tool-journal-write-failed',
      });
    }
    this.retainVolatileTool(evidence);
    let published = false;
    try {
      published = publish();
    } catch {}
    if (evidence.persistence === 'committed') {
      evidence = freezeEvidence({
        record,
        persistence: 'committed',
        publication: published ? 'published' : 'reconciliation-needed',
      });
      try {
        this.query('UPDATE session_native_tools SET publication=? WHERE id=?').run(
          evidence.publication,
          record.id,
        );
        this.volatileTools.delete(record.id);
      } catch {
        this.retainVolatileTool(evidence);
      }
    }
    return evidence;
  }

  nativeTools(threadId: string, turnId?: string): NativeToolEvidence[] {
    const rows = this.query(
      `SELECT record, publication FROM session_native_tools WHERE thread_id=?${turnId === undefined ? '' : ' AND turn_id=?'} ORDER BY seq`,
    ).all(...(turnId === undefined ? [threadId] : [threadId, turnId])) as {
      record: string;
      publication: NativeToolEvidence['publication'];
    }[];
    const found = new Map<string, NativeToolEvidence>(
      rows.map((row) => {
        const record = JSON.parse(row.record) as NativeToolRecord;
        return [
          record.id,
          freezeEvidence({
            record,
            persistence: 'committed' as const,
            publication: row.publication,
          }),
        ];
      }),
    );
    for (const [id, value] of this.volatileTools)
      if (
        value.record.owner.threadId === threadId &&
        (turnId === undefined || value.record.association.owner?.messageId === turnId)
      )
        found.set(id, value);
    return [...found.values()].sort(
      (a, b) =>
        a.record.finishedAt - b.record.finishedAt || a.record.startedAt - b.record.startedAt,
    );
  }

  registerNative(thread: Pick<Thread, 'id' | 'meta'>, evidence: NativeEvidence): void {
    this.db.transaction(() => {
      const owner = evidence.owner;
      if (
        !owner ||
        owner.threadId !== thread.id ||
        owner.projectId !== thread.meta.projectId ||
        !owner.messageId ||
        !evidence.admissionId
      )
        throw Error('Native registration requires the owning logical turn');
      this.requireOpen(owner.messageId, thread.id);
      if (
        this.query('SELECT 1 FROM session_native WHERE admission_id=? LIMIT 1').get(
          evidence.admissionId,
        )
      )
        throw Error('Duplicate native admission');
      this.assertNativeCapacity(thread, owner);
      this.query(
        'INSERT INTO session_native(admission_id, thread_id, turn_id, record, stored_at) VALUES (?, ?, ?, ?, ?)',
      ).run(evidence.admissionId, thread.id, owner.messageId, JSON.stringify(evidence), Date.now());
      // The executor's own admission sends the turn, whatever path got it here.
      if (owner.providerSessionKey === thread.id)
        this.query("UPDATE session_turns SET status='active' WHERE id=? AND status='queued'").run(
          owner.messageId,
        );
    })();
  }

  assertNativeCapacity(
    thread: Pick<Thread, 'id' | 'meta'>,
    owner: import('@inixiative/foundry-core').NativeOwner,
  ): void {
    if (
      owner.threadId !== thread.id ||
      owner.projectId !== thread.meta.projectId ||
      !owner.messageId
    )
      throw Error('Native capacity owner mismatch');
    this.requireOpen(owner.messageId, thread.id);
    const prior = this.query(
      'SELECT record FROM session_native WHERE thread_id=? ORDER BY seq',
    ).all(thread.id) as { record: string }[];
    const admissions = new Map<string, boolean>();
    for (const row of prior) {
      const e = JSON.parse(row.record) as NativeEvidence;
      // Missing historical pool identity stays conservative across code rollback.
      if (
        e.owner?.providerSessionKey &&
        owner.providerSessionKey &&
        e.owner.providerSessionKey !== owner.providerSessionKey
      )
        continue;
      admissions.set(
        e.admissionId!,
        admissions.get(e.admissionId!) === true ||
          e.nativeOutcome !== 'unknown' ||
          (e.dispatch === 'not-dispatched' && e.localOutcome === 'rejected'),
      );
    }
    if ([...admissions.values()].some((settled) => !settled))
      throw Error('Previous native outcome unresolved; no replay or new admission permitted');
  }

  appendNative(thread: Pick<Thread, 'id' | 'meta'>, evidence: NativeEvidence): void {
    const owner = evidence.owner;
    if (
      !owner ||
      !owner.messageId ||
      !evidence.admissionId ||
      owner.threadId !== thread.id ||
      owner.projectId !== thread.meta.projectId
    )
      throw Error('Foreign native evidence refused');
    const first = this.query(
      'SELECT record FROM session_native WHERE admission_id=? ORDER BY seq LIMIT 1',
    ).get(evidence.admissionId) as { record: string } | null;
    if (!first) throw Error('Native observation has no registered owner');
    if (first && JSON.stringify(JSON.parse(first.record).owner) !== JSON.stringify(owner))
      throw Error('Native admission owner changed');
    this.query(
      'INSERT INTO session_native(admission_id, thread_id, turn_id, record, stored_at) VALUES (?, ?, ?, ?, ?)',
    ).run(evidence.admissionId, thread.id, owner.messageId, JSON.stringify(evidence), Date.now());
  }

  traces(limit = 50): PersistedTraceRecord[] {
    const current = (
      this.query('SELECT record FROM session_traces ORDER BY seq DESC LIMIT ?').all(
        boundedLimit(limit),
      ) as Array<{ record: string }>
    ).map((row) => this.decode<PersistedTraceRecord>(row.record));
    const archived = this.query(
      'SELECT record, checksum, provenance FROM checkpoint_traces ORDER BY id DESC LIMIT ?',
    ).all(limit - current.length) as Array<{
      record: string;
      checksum: string;
      provenance: string;
    }>;
    return [...current, ...archived.map((row) => this.decodeCheckpointTrace(row))];
  }

  trace(id: string): PersistedTraceRecord | undefined {
    const row = this.query('SELECT record FROM session_traces WHERE id=?').get(id) as {
      record: string;
    } | null;
    if (row) return this.decode<PersistedTraceRecord>(row.record);
    const archived = this.query(
      'SELECT record, checksum, provenance FROM checkpoint_traces WHERE id=?',
    ).get(id) as { record: string; checksum: string; provenance: string } | null;
    return archived ? this.decodeCheckpointTrace(archived) : undefined;
  }

  traceForTurn(id: string): PersistedTraceRecord | undefined {
    const row = this.query('SELECT record FROM session_traces WHERE turn_id=?').get(id) as {
      record: string;
    } | null;
    if (row) return this.decode<PersistedTraceRecord>(row.record);
    const archived = this.query(
      'SELECT record, checksum, provenance FROM checkpoint_traces WHERE turn_id=?',
    ).get(id) as { record: string; checksum: string; provenance: string } | null;
    return archived ? this.decodeCheckpointTrace(archived) : undefined;
  }

  private decodeCheckpointTrace(row: {
    record: string;
    checksum: string;
    provenance: string;
  }): PersistedTraceRecord {
    if (checksum(row.record) !== row.checksum)
      throw new Error('Checkpoint trace checksum mismatch');
    const trace = JSON.parse(row.record);
    return {
      ...trace,
      spans: trace.spans ?? checkpointSpans(trace.root).map(({ children, ...span }) => span),
      archive: JSON.parse(row.provenance),
    };
  }

  /** The turn is accepted and not yet settled: queued or active. */
  private requireOpen(id: string, threadId: string): void {
    const turn = this.turn(id);
    if (!turn || turn.threadId !== threadId || !isOpenTurn(turn.status))
      throw new Error(`Turn is not open in thread ${threadId}: ${id}`);
  }

  /** The message's own text stays inline (the index reads it in SQL); its metadata references long text. */
  private insertMessage(message: StoredMessage): void {
    const { meta, ...rest } = message;
    // `rest` always holds the message's identity, so its JSON is a non-empty object to extend.
    const record =
      meta !== undefined
        ? `${JSON.stringify(rest).slice(0, -1)},"meta":${this.encode(meta)}}`
        : JSON.stringify(rest);
    this.query(
      'INSERT INTO session_messages(id, thread_id, turn_id, actor, record) VALUES (?, ?, ?, ?, ?)',
    ).run(message.id, message.threadId, message.turnId, message.actor, record);
  }

  /** A trace's spans and its root tree share their annotations by reference; the row is bounded. */
  private insertTrace(threadId: string, turnId: string, trace: PersistedTraceRecord): void {
    this.query(
      'INSERT INTO session_traces(id, thread_id, turn_id, record) VALUES (?, ?, ?, ?)',
    ).run(
      trace.id,
      threadId,
      turnId,
      this.encode(trace, { bytes: TRACE_RECORD_LIMIT, what: 'trace' }),
    );
  }

  private finishUncertain(
    id: string,
    threadId: string,
    status: 'failed' | 'interrupted',
    error: string,
    traceId?: string,
    meta?: Record<string, unknown>,
  ): void {
    this.insertMessage({
      id: newId('msg'),
      threadId,
      turnId: id,
      actor: 'agent',
      kind: 'error',
      content: error,
      timestamp: Date.now(),
      error,
      traceId,
      meta: { ...meta, error, turnStatus: status },
    });
    this.query('UPDATE session_turns SET status=?, ended_at=?, error=? WHERE id=?').run(
      status,
      Date.now(),
      error,
      id,
    );
  }
}

/** Row limits after text references; a record over its limit spills its bulk, never refused. */
const PHASE_RECORD_LIMIT = 200_000;
const LEARNING_RECORD_LIMIT = 100_000;
const TRACE_RECORD_LIMIT = 200_000;
/** Root keys the store reads in SQL (`$.content.domain`, `$.summary`); spilling moves only what is below them. */
const SQL_READ_KEYS = ['content', 'summary', 'meta'];
const CONTENT_CACHE_CHARS = 16_000_000;
/** Key on a record whose bulk spilled: why, at what size, and which paths moved out (`SpillNote`). */
export const JOURNAL_SPILL_KEY = '$journal';

export const TURN_NEVER_SENT =
  'Foundry restarted before this turn was sent. Nothing ran; send it again.';

/** Accepted and not yet settled. */
export function isOpenTurn(status: TurnStatus | 'unknown'): boolean {
  return status === 'queued' || status === 'active';
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000)
    throw new Error('limit must be an integer between 1 and 10000');
  return value;
}
