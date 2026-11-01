/**
 * @atlas
 * @kind transformer
 * @partOf primitive:traces
 */
import type { Trace as FoundryTrace, Span } from '@inixiative/foundry-core';

export interface PersistedSpanRecord {
  id: string;
  parentId?: string;
  name: string;
  kind: Span['kind'];
  agentId?: string;
  threadId?: string;
  status: Span['status'];
  layerIds?: string[];
  contextHash?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  annotations: Record<string, unknown>;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
}

export interface PersistedTraceRecord {
  id: string;
  messageId: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  root: unknown;
  summary: unknown;
  spans: PersistedSpanRecord[];
}

export function serializeTrace(trace: FoundryTrace): PersistedTraceRecord {
  return {
    id: trace.id,
    messageId: trace.messageId,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: trace.durationMs,
    root: trace.root,
    summary: trace.summary(),
    spans: trace.spans.map((span) => ({
      id: span.id,
      parentId: span.parentId,
      name: span.name,
      kind: span.kind,
      agentId: span.agentId,
      threadId: span.threadId,
      status: span.status,
      layerIds: span.layerIds,
      contextHash: span.contextHash,
      input: span.input,
      output: span.output,
      error: span.error,
      annotations: span.annotations,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      durationMs: span.durationMs,
    })),
  };
}
