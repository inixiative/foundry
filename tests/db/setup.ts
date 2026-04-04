import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll } from "bun:test";

/**
 * Test DB setup — follows inixiative/template pattern.
 *
 * Creates a shared PrismaClient for the test database,
 * truncates all tables before each test file,
 * and disconnects after.
 *
 * Requires:
 *   - docker compose up -d (postgres running)
 *   - DATABASE_URL pointing to foundry_test db
 *   - bunx prisma db push (schema applied to test db)
 */

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/foundry_test";

let _prisma: PrismaClient | null = null;

/**
 * Get or create the test PrismaClient.
 * Shared across all test files in a single bun test run.
 */
export function getTestClient(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient({
      datasourceUrl: TEST_DATABASE_URL,
      log: [],
    });
  }
  return _prisma;
}

/**
 * Truncate all public tables (excluding Prisma internals).
 * Follows template's globalSetup pattern.
 */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  const tables = (await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    AND tablename NOT LIKE '_prisma%'
  `) as Array<{ tablename: string }>;

  if (tables.length === 0) return;

  // Disable FK checks for clean truncation
  await prisma.$executeRawUnsafe(
    `SET session_replication_role = 'replica'`
  );

  for (const { tablename } of tables) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "${tablename}" CASCADE`
    );
  }

  await prisma.$executeRawUnsafe(
    `SET session_replication_role = 'origin'`
  );
}

/**
 * Use in describe blocks that need DB access:
 *
 *   const prisma = setupTestDb();
 *   // prisma is ready — tables truncated before, disconnected after
 */
export function setupTestDb(): PrismaClient {
  const prisma = getTestClient();

  beforeAll(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    _prisma = null;
  });

  return prisma;
}
