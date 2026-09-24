import type { EventStream } from '@inixiative/foundry-core';
import { archiveSnapshotSchema, type ArchiveEntry, type ArchiveSnapshot } from '@inixiative/session-archive';
import { LocalArchiveStore } from '@inixiative/session-archive/local';
import type { LocalSessionStore } from '../persistence/local-session-store';

export function captureThread(journal: LocalSessionStore, sourceId: string, threadId: string): ArchiveSnapshot {
  const thread = journal.threads().find(thread => thread.id === threadId);
  if (!thread) throw new Error('Unknown archive source thread');
  const entries: ArchiveEntry[] = [];
  const records = journal.archiveRecords(threadId);
  for (const message of records.messages) entries.push({ id: message.id, turnId: message.turnId,
      kind: message.actor === 'user' ? 'user' : 'assistant', text: message.content, timestamp: message.timestamp,
      sourceRef: `message:${message.id}` });
  for (const { record } of records.tools) entries.push({ id: `tool:${record.id}`, turnId: record.association.owner?.messageId, kind: 'tool-result',
      text: JSON.stringify({ operation: record.operation, arguments: record.arguments, result: record.result, status: record.status }),
      timestamp: record.finishedAt, sourceRef: `native-tool:${record.id}` });
  const native = [...records.native];
  const seen = new Set(native.map(evidence => JSON.stringify(evidence)));
  for (const message of records.messages) for (const evidence of Array.isArray(message.meta?.nativeHistory) ? message.meta.nativeHistory : []) {
    const key = JSON.stringify(evidence);
    if (!seen.has(key)) { seen.add(key); native.push(evidence); }
  }
  for (const [index, evidence] of native.entries()) {
      if (!evidence || typeof evidence !== 'object') continue;
      if (!evidence.toolName && evidence.toolOutput === undefined && !evidence.toolInput) {
        if (typeof evidence.text === 'string' || typeof evidence.content === 'string') entries.push({
          id: `native:${index}`, turnId: evidence.owner?.messageId, kind: 'assistant',
          text: JSON.stringify({ text: evidence.text, content: evidence.content, form: evidence.textKind,
            phase: evidence.textPhase, outcome: evidence.nativeOutcome, itemId: evidence.itemId }),
          timestamp: evidence.observedAt ?? null, sourceRef: `native:${index}`,
        });
        continue;
      }
      entries.push({ id: `native:${index}`, turnId: evidence.owner?.messageId, callId: evidence.callId, kind: evidence.toolOutput !== undefined ? 'tool-result' : 'tool-call',
        text: JSON.stringify({ tool: evidence.toolName, input: evidence.toolInput, output: evidence.toolOutput,
          outputOmitted: evidence.toolOutputOmitted, outcome: evidence.nativeOutcome }),
        timestamp: evidence.observedAt ?? null, sourceRef: `native:${index}` });
    }
  for (const phase of records.phases) entries.push({ id: `phase:${phase.id}`, ...(phase.turnId ? { turnId: phase.turnId } : {}), kind: 'event',
      text: JSON.stringify({ phase: phase.phase, record: phase.record }), timestamp: phase.storedAt, sourceRef: `phase:${phase.id}` });
  for (const turn of records.turns) entries.push({ id: `turn:${turn.id}`, turnId: turn.id, kind: 'event',
    text: JSON.stringify({ status: turn.status, error: turn.error }), timestamp: turn.endedAt ?? turn.startedAt, sourceRef: `turn:${turn.id}` });
  entries.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.id.localeCompare(b.id));
  return archiveSnapshotSchema.parse({ schemaVersion: 1, sourceId, source: 'foundry', sessionId: threadId,
    title: thread.meta.description.slice(0, 500) || threadId, projectId: thread.meta.projectId,
    tags: thread.meta.tags, capturedAt: Date.now(),
    coverage: { reasoning: 'unavailable', completeness: 'partial',
      omissions: ['Recorded messages, turn outcomes, public native text observations, tools and phase events only; phase request context is included where recorded; central injected context, checkpoint traces, private reasoning and unrecorded activity are unavailable'] }, entries });
}

export class ArchiveCapture {
  private readonly pending = new Set<string>();
  private readonly unsubscribe: () => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  readonly errors = new Map<string, string>();
  constructor(readonly journal: LocalSessionStore, readonly archives: LocalArchiveStore, events: EventStream,
    private readonly captured?: (id: string) => void) {
    this.unsubscribe = events.subscribe(event => {
      if (event.kind === 'journal' && event.outcome !== 'failed') this.schedule(event.threadId);
    });
    for (const thread of journal.threads()) this.schedule(thread.id);
    journal.onClose(() => this.close());
  }
  schedule(threadId: string) {
    if (this.closed) return;
    this.pending.add(threadId);
    this.timer ??= setTimeout(() => this.flush(), 250);
    this.timer.unref();
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const threadId of this.pending) {
      try {
        const snapshot = captureThread(this.journal, this.archives.sourceId, threadId);
        const result = this.archives.capture(snapshot);
        this.errors.delete(threadId);
        this.captured?.(result.id);
      } catch {
        this.errors.set(threadId, 'Archive capture failed; source journal retained. Retry capture after resolving the error.');
      }
    }
    this.pending.clear();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribe();
    this.archives.close();
  }
}
