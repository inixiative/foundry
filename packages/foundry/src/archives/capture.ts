import { userInfo } from 'node:os';
import {
  type ArchiveActor,
  type ArchiveEntry,
  type ArchiveSnapshot,
  archiveSnapshotSchema,
} from '@inixiative/archive';
import {
  configuredModel,
  type EventStream,
  type NativeEvidence,
  type ServedModel,
  threadTitle,
} from '@inixiative/foundry-core';
import type { LocalSessionStore } from '../persistence/local-session-store';
import type { ArchiveWriter } from './local';

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
      text: message.content,
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
  for (const phase of records.phases)
    entries.push({
      id: `phase:${phase.id}`,
      ...(phase.turnId ? { turnId: phase.turnId } : {}),
      kind: 'event',
      text: JSON.stringify({ phase: phase.phase, record: phase.record }),
      timestamp: phase.storedAt,
      sourceRef: `phase:${phase.id}`,
      // Decision roles' answers: route, advice and guard outcomes record what served them.
      ...stamp(phaseServed(phase.record)),
    });
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
    tags: thread.meta.tags,
    capturedAt: Date.now(),
    coverage: {
      reasoning: 'unavailable',
      completeness: 'partial',
      omissions: [
        'Recorded messages, turn outcomes, public native text observations, tools and phase events only; phase request context is included where recorded; central injected context, checkpoint traces, private reasoning and unrecorded activity are unavailable',
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
  readonly errors = new Map<string, string>();
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
        await writer.capture(snapshot);
        this.errors.delete(threadId);
      } catch {
        this.errors.set(
          threadId,
          'Archive capture failed; the source journal is retained and capture retries every 30 seconds.',
        );
      }
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    clearInterval(this.retry);
    this.unsubscribe();
  }
}
