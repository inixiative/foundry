import { makeJob } from "../makeJob";

export type PersistTracePayload = {
  traceId: string;
  messageId: string;
  /** Pre-serialized trace (summary already computed, spans flattened). */
  trace: {
    id: string;
    messageId: string;
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    root: unknown;
    summary: unknown;
    spans: Array<{
      id: string;
      parentId?: string;
      name: string;
      kind: string;
      agentId?: string;
      threadId?: string;
      status: string;
      layerIds?: string[];
      contextHash?: string;
      input?: unknown;
      output?: unknown;
      error?: unknown;
      annotations: Record<string, unknown>;
      startedAt: number;
      endedAt?: number;
      durationMs?: number;
    }>;
  };
};

/**
 * Persist a completed pipeline trace (with all spans) to Postgres.
 * Runs asynchronously so the API response isn't blocked by DB writes.
 */
export const persistTrace = makeJob<PersistTracePayload>(async (ctx, payload) => {
  const { db, log } = ctx;
  const { trace } = payload;

  await db.prisma.$transaction(async (tx: any) => {
    await tx.trace.upsert({
      where: { id: trace.id },
      create: {
        id: trace.id,
        messageId: trace.messageId,
        startedAt: trace.startedAt,
        endedAt: trace.endedAt,
        durationMs: trace.durationMs ?? 0,
        root: trace.root as any,
        summary: trace.summary as any,
      },
      update: {
        endedAt: trace.endedAt,
        durationMs: trace.durationMs ?? 0,
        root: trace.root as any,
        summary: trace.summary as any,
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
          input: span.input as any,
          output: span.output as any,
          error: span.error as any,
          annotations: span.annotations && Object.keys(span.annotations).length > 0
            ? (span.annotations as any)
            : undefined,
          startedAt: span.startedAt,
          endedAt: span.endedAt,
          durationMs: span.durationMs,
        },
        update: {
          status: span.status,
          output: span.output as any,
          error: span.error as any,
          endedAt: span.endedAt,
          durationMs: span.durationMs,
        },
      });
    }
  });

  log(`Persisted trace ${trace.id} (${trace.spans.length} spans)`);
});
