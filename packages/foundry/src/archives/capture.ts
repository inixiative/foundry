import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import {
  type ArchiveActor,
  type ArchiveEntry,
  type ArchiveSnapshot,
  archiveSnapshotSchema,
} from '@inixiative/archive';
import { stampedRun } from '@inixiative/archive/exemption';
import {
  configuredModel,
  type EventStream,
  type NativeEvidence,
  type ServedModel,
  type ThreadMeta,
  threadTitle,
} from '@inixiative/foundry-core';
import { contentHash } from '../persistence/journal-content';
import type { LocalSessionStore } from '../persistence/local-session-store';
import type { ArchiveWriter } from './local';
import { RAW_MIDDLEWARE_PHASES, REDUCED_PHASE, type ReducedMiddleware } from './reduced-middleware';

/** The person operating this Foundry: its local account. */
export function localActor(): ArchiveActor | undefined {
  try {
    const { username } = userInfo();
    return username ? { kind: 'user', id: username } : undefined;
  } catch {
    return undefined;
  }
}

/** Archive's `model` / `effort` fields for an entry; values Archive would refuse are left off, never clipped. */
const stamp = (served: ServedModel | undefined) =>
  served && served.model.length <= 200
    ? {
        model: served.model,
        ...(served.effort && served.effort.length <= 40 ? { effort: served.effort } : {}),
      }
    : {};

/** The one model and effort a decision phase record says answered; none when absent or mixed. */
function phaseServed(record: unknown): ServedModel | undefined {
  const found = new Map<string, ServedModel>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(walk);
    for (const [key, nested] of Object.entries(value)) {
      const served = nested as Partial<ServedModel> | undefined;
      if (key === 'served' && typeof served?.model === 'string')
        found.set(JSON.stringify([served.model, served.effort]), {
          model: served.model,
          ...(typeof served.effort === 'string' ? { effort: served.effort } : {}),
        });
      else walk(nested);
    }
  };
  walk(record);
  return found.size === 1 ? [...found.values()][0] : undefined;
}

/**
 * A child thread's lineage (spec A): its direct parent, the tree's root, and the parent's entry that
 * spawned it (the parent's `handoff` row). A main thread has none.
 */
function lineageOf(
  journal: LocalSessionStore,
  meta: ThreadMeta,
): { lineage: NonNullable<ArchiveSnapshot['lineage']> } | undefined {
  if (!meta.parentThreadId) return undefined;
  const parents = new Map(journal.threads().map((t) => [t.id, t.meta.parentThreadId]));
  let root = meta.parentThreadId;
  for (let hops = 0; parents.get(root) && hops < 100; hops++) root = parents.get(root)!;
  const spawn = meta.spawn;
  const clip = (value: string | undefined, max: number) =>
    value ? value.slice(0, max) : undefined;
  const agentType = clip(spawn?.agentType, 200);
  const description = clip(spawn?.description, 500);
  return {
    lineage: {
      kind: 'subagent',
      parentSessionId: meta.parentThreadId,
      rootSessionId: root,
      ...(spawn?.handoffId ? { parentEntryId: `phase:${spawn.handoffId}` } : {}),
      ...(spawn?.toolCallId ? { toolUseId: spawn.toolCallId.slice(0, 256) } : {}),
      ...(agentType ? { agentType } : {}),
      ...(description ? { description } : {}),
      ...(typeof meta.depth === 'number' ? { depth: Math.min(meta.depth, 100) } : {}),
    },
  };
}

export function captureThread(
  journal: LocalSessionStore,
  sourceId: string,
  threadId: string,
): ArchiveSnapshot {
  const thread = journal.threads().find((thread) => thread.id === threadId);
  if (!thread) throw new Error('Unknown archive source thread');
  const entries: ArchiveEntry[] = [];
  const records = journal.archiveRecords(threadId);
  const actor = localActor();
  const run = stampedRun();
  // What each native call ran on, by admission, and what the central executor ran on, by turn.
  const byAdmission = new Map<string, ServedModel>();
  const byTurn = new Map<string, ServedModel>();
  const learn = (evidence: NativeEvidence | undefined) => {
    const served = configuredModel(evidence?.configuration);
    if (served && evidence?.admissionId) byAdmission.set(evidence.admissionId, served);
    return served;
  };
  for (const message of records.messages) {
    if (message.actor !== 'agent') continue;
    const served = learn(message.meta?.native as NativeEvidence | undefined);
    if (served) byTurn.set(message.turnId, served);
  }
  const servedFor = (evidence: NativeEvidence) =>
    (evidence.admissionId ? byAdmission.get(evidence.admissionId) : undefined) ??
    // Auxiliary sessions (decision roles) never inherit the executor's model.
    ((evidence.owner?.providerSessionKey ?? threadId) === threadId && evidence.owner?.messageId
      ? byTurn.get(evidence.owner.messageId)
      : undefined);
  for (const message of records.messages)
    entries.push({
      id: message.id,
      turnId: message.turnId,
      kind: message.actor === 'user' ? 'user' : 'assistant',
      text: withImageReferences(message.content, message.meta?.images),
      timestamp: message.timestamp,
      sourceRef: `message:${message.id}`,
      ...(message.actor === 'agent' ? stamp(byTurn.get(message.turnId)) : {}),
    });
  for (const { record } of records.tools)
    entries.push({
      id: `tool:${record.id}`,
      turnId: record.association.owner?.messageId,
      kind: 'tool-result',
      text: JSON.stringify({
        operation: record.operation,
        arguments: record.arguments,
        result: record.result,
        status: record.status,
      }),
      timestamp: record.finishedAt,
      sourceRef: `native-tool:${record.id}`,
    });
  const native = [...records.native];
  const seen = new Set(native.map((evidence) => JSON.stringify(evidence)));
  for (const message of records.messages)
    for (const evidence of Array.isArray(message.meta?.nativeHistory)
      ? message.meta.nativeHistory
      : []) {
      const key = JSON.stringify(evidence);
      if (!seen.has(key)) {
        seen.add(key);
        native.push(evidence);
      }
    }
  for (const evidence of native) learn(evidence);
  for (const [index, evidence] of native.entries()) {
    if (!evidence || typeof evidence !== 'object') continue;
    if (!evidence.toolName && evidence.toolOutput === undefined && !evidence.toolInput) {
      if (typeof evidence.text === 'string' || typeof evidence.content === 'string')
        entries.push({
          id: `native:${index}`,
          turnId: evidence.owner?.messageId,
          kind: 'assistant',
          text: JSON.stringify({
            text: evidence.text,
            content: evidence.content,
            form: evidence.textKind,
            phase: evidence.textPhase,
            outcome: evidence.nativeOutcome,
            itemId: evidence.itemId,
          }),
          timestamp: evidence.observedAt ?? null,
          sourceRef: `native:${index}`,
          ...stamp(servedFor(evidence)),
        });
      continue;
    }
    const kind = evidence.toolOutput !== undefined ? 'tool-result' : 'tool-call';
    entries.push({
      id: `native:${index}`,
      turnId: evidence.owner?.messageId,
      callId: evidence.callId,
      kind,
      text: JSON.stringify({
        tool: evidence.toolName,
        input: evidence.toolInput,
        output: evidence.toolOutput,
        outputOmitted: evidence.toolOutputOmitted,
        outcome: evidence.nativeOutcome,
      }),
      timestamp: evidence.observedAt ?? null,
      sourceRef: `native:${index}`,
      ...(kind === 'tool-call' ? stamp(servedFor(evidence)) : {}),
    });
  }
  for (const phase of records.phases) {
    // A middleware call reaches Archive only reduced (spec A): its state and its result.
    if ((RAW_MIDDLEWARE_PHASES as readonly string[]).includes(phase.phase)) continue;
    if (phase.phase === REDUCED_PHASE) {
      const reduced = phase.record as unknown as ReducedMiddleware;
      entries.push({
        id: `mw:${reduced.callId}`,
        ...(phase.turnId ? { turnId: phase.turnId } : {}),
        kind: 'event',
        text: JSON.stringify(reduced),
        timestamp: reduced.at,
        sourceRef: `middleware:${reduced.callId}`,
        ...stamp(reduced.served),
      });
      continue;
    }
    entries.push({
      id: `phase:${phase.id}`,
      ...(phase.turnId ? { turnId: phase.turnId } : {}),
      kind: 'event',
      text: JSON.stringify({ phase: phase.phase, record: phase.record }),
      timestamp: phase.storedAt,
      sourceRef: `phase:${phase.id}`,
      ...stamp(phaseServed(phase.record)),
    });
  }
  for (const turn of records.turns)
    entries.push({
      id: `turn:${turn.id}`,
      turnId: turn.id,
      kind: 'event',
      text: JSON.stringify({ status: turn.status, error: turn.error }),
      timestamp: turn.endedAt ?? turn.startedAt,
      sourceRef: `turn:${turn.id}`,
    });
  entries.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.id.localeCompare(b.id));
  return archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId,
    source: 'foundry',
    sessionId: threadId,
    title: threadTitle(thread.meta)?.text.slice(0, 500) || threadId,
    projectId: thread.meta.projectId,
    ...(actor ? { actor } : {}),
    ...(lineageOf(journal, thread.meta) ?? {}),
    // A test or eval harness running this Foundry stamps its threads (ARCHIVE_RUN).
    tags: [...new Set([...(run ? [run] : []), ...thread.meta.tags])],
    capturedAt: Date.now(),
    coverage: {
      reasoning: 'unavailable',
      completeness: 'partial',
      omissions: [
        'Recorded messages, turn outcomes, public native text observations, tools and phase events only; middleware calls are reduced to their state and result (their input is not archived); central injected context, checkpoint traces, private reasoning and unrecorded activity are unavailable',
      ],
    },
    entries,
  });
}

const RETRY_MS = 30_000;

/**
 * Writes each journalled thread to the local Archive. The journal stays the source of truth, so a
 * failed write (no local Archive yet, server down) is recorded and the thread captured again later.
 */
export class ArchiveCapture {
  private readonly pending = new Set<string>();
  private readonly unsubscribe: () => void;
  private readonly retry: ReturnType<typeof setInterval>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  /** Stands in for the Archive's source id while it is unreachable; such snapshots are never written. */
  private readonly unsentSourceId = crypto.randomUUID();
  private closed = false;
  private readonly renewal: ReturnType<typeof setInterval>;
  /** This Foundry's name on its claims: one per journal, so two Foundries never share one. */
  private readonly claimant: string;
  readonly errors = new Map<string, string>();
  /** The last claim refusal per session (or `hold`), for diagnosis; capture goes on regardless. */
  readonly claimErrors = new Map<string, string>();
  constructor(
    readonly journal: LocalSessionStore,
    private readonly writer: () => ArchiveWriter | undefined,
    events: EventStream,
    /** Each thread's snapshot as built, whether or not the Archive accepted it. */
    private readonly captured?: (snapshot: ArchiveSnapshot) => void,
  ) {
    this.unsubscribe = events.subscribe((event) => {
      if (event.kind === 'journal' && event.outcome !== 'failed') this.schedule(event.threadId);
    });
    this.retry = setInterval(() => {
      for (const threadId of this.errors.keys()) this.schedule(threadId);
    }, RETRY_MS);
    this.retry.unref();
    this.claimant = `foundry:${contentHash(resolve(journal.path)).slice(0, 16)}`;
    this.renewal = setInterval(() => void this.renew().catch(() => {}), RENEW_MS);
    this.renewal.unref();
    for (const thread of journal.threads()) this.schedule(thread.id);
    journal.onClose(() => this.close());
  }
  schedule(threadId: string) {
    if (this.closed) return;
    this.pending.add(threadId);
    this.timer ??= setTimeout(() => void this.flush(), 250);
    this.timer.unref();
  }
  /** Captures every pending thread; flushes run one at a time so revisions land in order. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const threads = [...this.pending];
    this.pending.clear();
    const run = this.flushing.then(() => this.write(threads));
    this.flushing = run.catch(() => {});
    return run;
  }
  private async write(threads: string[]) {
    if (this.closed) return;
    const writer = this.writer();
    const sourceId = await writer?.sourceId().catch(() => undefined);
    for (const threadId of threads) {
      let snapshot: ArchiveSnapshot;
      try {
        snapshot = captureThread(this.journal, sourceId ?? this.unsentSourceId, threadId);
      } catch {
        this.errors.set(threadId, 'Archive capture failed to read the source journal.');
        continue;
      }
      this.captured?.(snapshot);
      if (!writer) {
        this.errors.set(
          threadId,
          'No local Archive is set up; run bun run archive setup. The source journal is retained.',
        );
        continue;
      }
      try {
        if (!sourceId) throw Error('Archive unreachable');
        // The native sessions behind this thread are Foundry's to record: claimed while it writes
        // them, fulfilled by the archive it wrote (the collector then leaves the raw transcript).
        const sessions = nativeSessions(this.journal, threadId);
        await this.claim(writer, sessions);
        const stored = await writer.capture(snapshot);
        await this.fulfil(writer, sessions, stored.id);
        this.errors.delete(threadId);
      } catch {
        this.errors.set(
          threadId,
          'Archive capture failed; the source journal is retained and capture retries every 30 seconds.',
        );
      }
    }
  }
  /**
   * Renew the lease on every thread with an open turn: a thread at work keeps its native sessions
   * claimed; once its turn closes, its last capture fulfils them, and a crash lets the lease lapse
   * so the collector keeps the raw transcript. Runs in the capture chain, so a renewal never lands
   * after (and undoes) the fulfilment of a turn that closed meanwhile.
   */
  renew(): Promise<void> {
    const run = this.flushing.then(async () => {
      const writer = this.writer();
      if (!writer || this.closed) return;
      await this.claim(
        writer,
        this.journal
          .openTurnThreads()
          .flatMap((threadId) => nativeSessions(this.journal, threadId)),
      );
    });
    this.flushing = run.catch(() => {});
    return run;
  }
  /** Claims are a courtesy to the collector: a refused claim never stops Foundry writing its journal. */
  private async claim(writer: ArchiveWriter, sessions: NativeSession[]) {
    if (!sessions.length) return;
    try {
      await writer.holdClaims({ claimant: this.claimant, ttlMs: CLAIM_TTL_MS, sessions });
    } catch (error) {
      this.claimErrors.set('hold', (error as Error).message);
    }
  }
  private async fulfil(writer: ArchiveWriter, sessions: NativeSession[], archiveId: string) {
    for (const session of sessions)
      try {
        await writer.fulfilClaim({ claimant: this.claimant, ...session, archiveId });
      } catch (error) {
        this.claimErrors.set(`${session.source}:${session.sessionId}`, (error as Error).message);
      }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    clearInterval(this.retry);
    clearInterval(this.renewal);
    this.unsubscribe();
  }
}

/** A native session Foundry drives, as the Archive collector names it. */
interface NativeSession {
  readonly source: 'claude-code' | 'codex';
  readonly sessionId: string;
}

/** How long a claim holds without renewal: a crashed Foundry's sessions are captured raw after it. */
const CLAIM_TTL_MS = 10 * 60_000;
const RENEW_MS = 2 * 60_000;

/**
 * The native sessions behind a thread: the executor's (a Claude session id, or a Codex thread id)
 * and, for an observed Codex sub-agent thread, its own thread. A Claude subagent's transcript
 * follows its session's claim.
 */
function nativeSessions(journal: LocalSessionStore, threadId: string): NativeSession[] {
  const meta = journal.threads().find((t) => t.id === threadId)?.meta;
  // An observed subagent's own native session: a Codex child's thread (a Claude subagent's
  // transcript follows its session's claim, so it has none of its own).
  if (meta?.spawn?.observed)
    return meta.spawn.via === 'native-codex' && meta.spawn.nativeTaskId
      ? [{ source: 'codex', sessionId: meta.spawn.nativeTaskId }]
      : [];
  const found = new Map<string, NativeSession>();
  for (const id of journal.nativeSessionIds(threadId)) {
    const session: NativeSession = id.threadId
      ? { source: 'codex', sessionId: id.threadId }
      : { source: 'claude-code', sessionId: id.sessionId! };
    found.set(`${session.source}:${session.sessionId}`, session);
  }
  return [...found.values()];
}

/** A message's text with each image it carried named by reference; the archive holds no bytes. */
function withImageReferences(text: string, images: unknown): string {
  if (!Array.isArray(images) || !images.length) return text;
  const references = images.map(
    (image: { id?: unknown; mediaType?: unknown; bytes?: unknown }) =>
      `[image ${String(image?.id)} (${String(image?.mediaType)}, ${String(image?.bytes)} bytes)]`,
  );
  return [text, ...references].filter(Boolean).join('\n\n');
}
