/**
 * PostgresMemory integration tests.
 *
 * These tests require a running PostgreSQL instance with the Foundry schema.
 * Run with: DATABASE_URL=postgresql://postgres:postgres@localhost:5932/foundry_test bun test tests/db/
 *
 * Setup:
 *   docker compose up -d
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5932/foundry_test bunx prisma db push
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5932/foundry_test bun test tests/db/
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { PostgresMemory } from '../../src/adapters/postgres-memory';
import { setupTestDb } from './setup';

const prisma = setupTestDb();
let pg: PostgresMemory;

beforeAll(() => {
  pg = new PostgresMemory(prisma);
});

describe('PostgresMemory', () => {
  describe('entries', () => {
    test('writeEntry and getEntry', async () => {
      await pg.writeEntry({
        id: 'entry-1',
        kind: 'convention',
        content: 'Use Zod for validation',
        source: 'operator:test',
      });

      const entry = await pg.getEntry('entry-1');
      expect(entry).toBeDefined();
      expect(entry!.id).toBe('entry-1');
      expect(entry!.kind).toBe('convention');
      expect(entry!.content).toBe('Use Zod for validation');
      expect(entry!.source).toBe('operator:test');
    });

    test('writeEntry upserts on conflict', async () => {
      await pg.writeEntry({
        id: 'upsert-1',
        kind: 'convention',
        content: 'original',
      });
      await pg.writeEntry({
        id: 'upsert-1',
        kind: 'convention',
        content: 'updated',
      });

      const entry = await pg.getEntry('upsert-1');
      expect(entry!.content).toBe('updated');
    });

    test('entriesByKind returns filtered results', async () => {
      await pg.writeEntry({ id: 'conv-1', kind: 'convention', content: 'A' });
      await pg.writeEntry({ id: 'corr-1', kind: 'correction', content: 'B' });
      await pg.writeEntry({ id: 'conv-2', kind: 'convention', content: 'C' });

      const conventions = await pg.entriesByKind('convention');
      expect(conventions.length).toBe(2);
      expect(conventions.every((e) => e.kind === 'convention')).toBe(true);
    });

    test('recentEntries returns ordered by timestamp', async () => {
      await pg.writeEntry({ id: 'recent-1', kind: 'test', content: 'first' });
      await pg.writeEntry({ id: 'recent-2', kind: 'test', content: 'second' });

      const entries = await pg.recentEntries(10, 'test');
      expect(entries.length).toBeGreaterThanOrEqual(2);
      // Most recent first
      const ids = entries.map((e) => e.id);
      expect(ids.indexOf('recent-2')).toBeLessThan(ids.indexOf('recent-1'));
    });

    test('searchEntries finds by content', async () => {
      await pg.writeEntry({
        id: 'search-1',
        kind: 'test',
        content: 'TypeScript is strongly typed',
      });
      await pg.writeEntry({
        id: 'search-2',
        kind: 'test',
        content: 'JavaScript is loosely typed',
      });

      const results = await pg.searchEntries('TypeScript');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r: any) => r.id === 'search-1')).toBe(true);
    });

    test('deleteEntry removes entry', async () => {
      await pg.writeEntry({ id: 'del-1', kind: 'test', content: 'gone' });
      expect(await pg.deleteEntry('del-1')).toBe(true);
      expect(await pg.getEntry('del-1')).toBeNull();
      expect(await pg.deleteEntry('del-1')).toBe(false);
    });

    test('writeEntry with meta', async () => {
      await pg.writeEntry({
        id: 'meta-1',
        kind: 'test',
        content: 'with metadata',
        meta: { score: 0.9, tags: ['a', 'b'] },
      });

      const entry = await pg.getEntry('meta-1');
      expect(entry!.meta).toEqual({ score: 0.9, tags: ['a', 'b'] });
    });
  });

  describe('adapter interfaces', () => {
    test('asSource loads entries as context', async () => {
      await pg.writeEntry({
        id: 'src-1',
        kind: 'convention',
        content: 'Convention A',
      });
      await pg.writeEntry({
        id: 'src-2',
        kind: 'other',
        content: 'Other B',
      });

      const src = pg.asSource('test-src', 'convention');
      const content = await src.load();
      expect(content).toContain('Convention A');
      expect(content).not.toContain('Other B');
    });

    test('asAdapter hydrates by entry id', async () => {
      await pg.writeEntry({
        id: 'hydrate-1',
        kind: 'test',
        content: 'hydrated content',
      });

      const adapter = pg.asAdapter();
      expect(adapter.system).toBe('postgres');
      const content = await adapter.hydrate({
        system: 'postgres',
        locator: 'hydrate-1',
      });
      expect(content).toBe('hydrated content');
    });

    test('asAdapter returns empty for missing', async () => {
      const adapter = pg.asAdapter();
      const content = await adapter.hydrate({
        system: 'postgres',
        locator: 'nonexistent-entry',
      });
      expect(content).toBe('');
    });
  });
});
