import type { Prisma } from "@prisma/client";
import type { Span, Trace as FoundryTrace } from "@inixiative/foundry-core";
import { toOptionalPrismaJson, toPrismaJson } from "./prisma-json";

export interface PersistedSpanRecord {
  id: string;
  parentId?: string;
  name: string;
  kind: Span["kind"];
  agentId?: string;
  threadId?: string;
  status: Span["status"];
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

export async function upsertTraceRecord(
  tx: Prisma.TransactionClient,
  trace: PersistedTraceRecord,
): Promise<void> {
  await tx.trace.upsert({
    where: { id: trace.id },
    create: {
      id: trace.id,
      messageId: trace.messageId,
      startedAt: trace.startedAt,
      endedAt: trace.endedAt,
      durationMs: trace.durationMs,
      root: toPrismaJson(trace.root),
      summary: toOptionalPrismaJson(trace.summary),
    },
    update: {
      endedAt: trace.endedAt,
      durationMs: trace.durationMs,
      root: toPrismaJson(trace.root),
      summary: toOptionalPrismaJson(trace.summary),
    },
  });

  for (const span of trace.spans) {
    await tx.span.upsert({
      where: { id: span.id },
      create: {
        id: span.id,
        traceId: trace.id,
        parentId: span.parentId,
        name: span.name,
        kind: span.kind,
        agentId: span.agentId,
        threadId: span.threadId,
        status: span.status,
        layerIds: span.layerIds ?? [],
        contextHash: span.contextHash,
        input: toOptionalPrismaJson(span.input),
        output: toOptionalPrismaJson(span.output),
        error: toOptionalPrismaJson(span.error),
        annotations: Object.keys(span.annotations).length > 0
          ? toOptionalPrismaJson(span.annotations)
          : undefined,
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        durationMs: span.durationMs,
      },
      update: {
        status: span.status,
        output: toOptionalPrismaJson(span.output),
        error: toOptionalPrismaJson(span.error),
        endedAt: span.endedAt,
        durationMs: span.durationMs,
      },
    });
  }
}
