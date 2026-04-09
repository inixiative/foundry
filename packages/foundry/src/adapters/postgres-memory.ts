import type { PrismaClient } from "@prisma/client";
import type {
  ContextSource,
  HydrationAdapter,
  ContextRef,
  Signal,
  Trace as TraceObj,
  Intervention,
} from "@inixiative/foundry-core";
import { toOptionalPrismaJson, toPrismaJson } from "../persistence/prisma-json";
import { serializeTrace, upsertTraceRecord } from "../persistence/trace-record";

interface SearchEntryRow {
  id: string;
  kind: string;
  content: string;
  source: string | null;
  timestamp: Date;
  meta: unknown;
  createdAt: Date;
  updatedAt: Date;
}

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
        meta: toOptionalPrismaJson(entry.meta),
      },
      update: {
        content: entry.content,
        source: entry.source,
        meta: toOptionalPrismaJson(entry.meta),
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
    ` as Promise<SearchEntryRow[]>;
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
    const serialized = serializeTrace(trace);
    await this.prisma.$transaction((tx) => upsertTraceRecord(tx, serialized));
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
        content: toPrismaJson(signal.content),
        confidence: signal.confidence,
        refs: toOptionalPrismaJson(signal.refs),
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
        actual: toOptionalPrismaJson(intervention.actual),
        correction: toPrismaJson(intervention.correction),
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
    await this.prisma.message.create({
      data: {
        id: msg.id,
        threadId: msg.threadId,
        role: msg.role,
        content: msg.content,
        traceId: msg.traceId,
        meta: toOptionalPrismaJson(msg.meta),
      },
    });
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
