import type { PrismaClient } from "@prisma/client";
import type { ContextSource } from "../agents/context-layer";
import type { HydrationAdapter, ContextRef } from "../agents/hydrator";
import type { Signal } from "../agents/signal";
import type { Trace as TraceObj } from "../agents/trace";
import type { Intervention } from "../agents/intervention";

/**
 * PostgreSQL-backed memory system via Prisma.
 *
 * Handles entries, traces, signals, interventions, and conversation messages.
 * Uses pgvector for semantic search when embeddings are provided.
 *
 * Requires:
 *   bun add prisma @prisma/client
 *   bunx prisma generate
 *   bunx prisma db push (or migrate)
 */
export class PostgresMemory {
  readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  // -- Entries --

  async writeEntry(entry: {
    id: string;
    kind: string;
    content: string;
    source?: string;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.entry.upsert({
      where: { id: entry.id },
      create: {
        id: entry.id,
        kind: entry.kind,
        content: entry.content,
        source: entry.source,
        meta: (entry.meta as any) ?? undefined,
      },
      update: {
        content: entry.content,
        source: entry.source,
        meta: (entry.meta as any) ?? undefined,
      },
    });
  }

  async getEntry(id: string) {
    return this.prisma.entry.findUnique({ where: { id } });
  }

  async entriesByKind(kind: string, limit: number = 100) {
    return this.prisma.entry.findMany({
      where: { kind },
      orderBy: { timestamp: "desc" },
      take: limit,
    });
  }

  async recentEntries(limit: number = 50, kind?: string) {
    return this.prisma.entry.findMany({
      where: kind ? { kind } : undefined,
      orderBy: { timestamp: "desc" },
      take: limit,
    });
  }

  async searchEntries(query: string, limit: number = 20) {
    // Escape ILIKE wildcards to prevent pattern injection
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    // Exclude the embedding column (pgvector Unsupported type) to avoid deserialization errors
    return this.prisma.$queryRaw`
      SELECT id, kind, content, source, timestamp, meta, "createdAt", "updatedAt"
      FROM entries
      WHERE content ILIKE ${"%" + escaped + "%"}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    ` as Promise<any[]>;
  }

  async deleteEntry(id: string): Promise<boolean> {
    try {
      await this.prisma.entry.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  // -- Traces --

  async writeTrace(trace: TraceObj): Promise<void> {
    const summary = trace.summary();

    // Batch trace + all spans in a single transaction to avoid N+1
    await this.prisma.$transaction(async (tx) => {
      await tx.trace.upsert({
        where: { id: trace.id },
        create: {
          id: trace.id,
          messageId: trace.messageId,
          startedAt: trace.startedAt,
          endedAt: trace.endedAt,
          durationMs: trace.durationMs,
          root: trace.root as any,
          summary: summary as any,
        },
        update: {
          endedAt: trace.endedAt,
          durationMs: trace.durationMs,
          root: trace.root as any,
          summary: summary as any,
        },
      });

      // Flatten spans for indexed querying — batched in same transaction
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
            annotations: Object.keys(span.annotations).length > 0
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
  }

  async getTrace(id: string) {
    return this.prisma.trace.findUnique({
      where: { id },
      include: { spans: true, interventions: true },
    });
  }

  async getTraceByMessage(messageId: string) {
    return this.prisma.trace.findFirst({
      where: { messageId },
      include: { spans: true, interventions: true },
    });
  }

  async recentTraces(limit: number = 50) {
    return this.prisma.trace.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { spans: true },
    });
  }

  /** Query spans across all traces — e.g. find all error spans, all classify spans, etc. */
  async querySpans(filter: {
    kind?: string;
    agentId?: string;
    status?: string;
    limit?: number;
  }) {
    return this.prisma.span.findMany({
      where: {
        kind: filter.kind,
        agentId: filter.agentId,
        status: filter.status,
      },
      orderBy: { startedAt: "desc" },
      take: filter.limit ?? 100,
    });
  }

  // -- Signals --

  async writeSignal(signal: Signal): Promise<void> {
    await this.prisma.signal.create({
      data: {
        id: signal.id,
        kind: signal.kind,
        source: signal.source,
        content: signal.content as any,
        confidence: signal.confidence,
        refs: signal.refs as any,
      },
    });
  }

  async recentSignals(limit: number = 50, kind?: string) {
    return this.prisma.signal.findMany({
      where: kind ? { kind } : undefined,
      orderBy: { timestamp: "desc" },
      take: limit,
    });
  }

  // -- Interventions --

  async writeIntervention(intervention: Intervention): Promise<void> {
    await this.prisma.intervention.create({
      data: {
        id: intervention.id,
        traceId: intervention.traceId,
        spanId: intervention.spanId,
        actual: intervention.actual as any,
        correction: intervention.correction as any,
        reason: intervention.reason,
        operator: intervention.operator,
      },
    });
  }

  // -- Messages (conversation history) --

  async writeMessage(msg: {
    id: string;
    threadId: string;
    role: "user" | "agent" | "system";
    content: string;
    traceId?: string;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.message.create({ data: msg as any });
  }

  async threadMessages(threadId: string, limit: number = 100) {
    return this.prisma.message.findMany({
      where: { threadId },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
  }

  // -- Adapter interfaces --

  /** ContextSource that loads entries of a kind as context. */
  asSource(id: string, kind?: string, limit: number = 100): ContextSource {
    const pg = this;
    return {
      id,
      async load() {
        const entries = await pg.recentEntries(limit, kind);
        if (entries.length === 0) return "";
        return entries
          .map((e: { kind: string; id: string; content: string }) => `[${e.kind}] ${e.id}: ${e.content}`)
          .join("\n");
      },
    };
  }

  /** HydrationAdapter — refs use entry ids as locators. */
  asAdapter(): HydrationAdapter {
    const pg = this;
    return {
      system: "postgres",
      async hydrate(ref: ContextRef): Promise<string> {
        const entry = await pg.getEntry(ref.locator);
        return entry ? entry.content : "";
      },
      async hydrateBatch(refs: ContextRef[]): Promise<string[]> {
        const results: string[] = [];
        for (const ref of refs) {
          const entry = await pg.getEntry(ref.locator);
          results.push(entry ? entry.content : "");
        }
        return results;
      },
    };
  }

  /** Signal writer — persists every signal to Postgres. */
  signalWriter() {
    const pg = this;
    return async (signal: Signal): Promise<void> => {
      await pg.writeSignal(signal);
    };
  }

  /** Trace writer — persists completed traces to Postgres. */
  traceWriter() {
    const pg = this;
    return async (trace: TraceObj): Promise<void> => {
      await pg.writeTrace(trace);
    };
  }
}
