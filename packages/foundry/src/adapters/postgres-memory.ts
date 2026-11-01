/**
 * @atlas
 * @kind adapter
 * @partOf infrastructure:prisma, primitive:memory
 */
import type { ContextRef, ContextSource, HydrationAdapter } from '@inixiative/foundry-core';
import type { PrismaClient } from '@prisma/client';
import { toOptionalPrismaJson } from '../persistence/prisma-json';

interface SearchEntryRow {
  id: string;
  kind: string;
  content: string;
  source: string | null;
  timestamp: Date;
  meta: unknown;
  updatedAt: Date;
}

/**
 * PostgreSQL-backed memory system via Prisma.
 *
 * A memory backend: entries an agent writes and reads through the `postgres` memory tool. The
 * journal (SQLite) and the Archive hold the record of turns; nothing here mirrors them.
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
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }

  async recentEntries(limit: number = 50, kind?: string) {
    return this.prisma.entry.findMany({
      where: kind ? { kind } : undefined,
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }

  async searchEntries(query: string, limit: number = 20) {
    // Escape ILIKE wildcards to prevent pattern injection
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    // Exclude the embedding column (pgvector Unsupported type) to avoid deserialization errors
    return this.prisma.$queryRaw`
      SELECT id, kind, content, source, timestamp, meta, "updatedAt"
      FROM entries
      WHERE content ILIKE ${'%' + escaped + '%'}
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

  // -- Adapter interfaces --

  /** ContextSource that loads entries of a kind as context. */
  asSource(id: string, kind?: string, limit: number = 100): ContextSource {
    const pg = this;
    return {
      id,
      async load() {
        const entries = await pg.recentEntries(limit, kind);
        if (entries.length === 0) return '';
        return entries
          .map(
            (e: { kind: string; id: string; content: string }) =>
              `[${e.kind}] ${e.id}: ${e.content}`,
          )
          .join('\n');
      },
    };
  }

  /** HydrationAdapter — refs use entry ids as locators. */
  asAdapter(): HydrationAdapter {
    const pg = this;
    return {
      system: 'postgres',
      async hydrate(ref: ContextRef): Promise<string> {
        const entry = await pg.getEntry(ref.locator);
        return entry ? entry.content : '';
      },
      async hydrateBatch(refs: ContextRef[]): Promise<string[]> {
        const results: string[] = [];
        for (const ref of refs) {
          const entry = await pg.getEntry(ref.locator);
          results.push(entry ? entry.content : '');
        }
        return results;
      },
    };
  }
}
