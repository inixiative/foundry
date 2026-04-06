import { PrismaClient } from "@prisma/client";

/**
 * Foundry DB client — lazy singleton following inixiative/template pattern.
 *
 * In production, import `db` and use directly:
 *   import { db } from "./db/client";
 *   await db.entry.findMany();
 *
 * For tests, use `createClient()` with a test DATABASE_URL.
 */

let _client: PrismaClient | null = null;

/** Create a fresh PrismaClient. Use this in tests with a test DATABASE_URL. */
export function createClient(url?: string): PrismaClient {
  return new PrismaClient({
    datasourceUrl: url,
    log:
      process.env.NODE_ENV === "test"
        ? []
        : [{ emit: "stdout", level: "warn" }],
  });
}

/** Lazy singleton — created on first access. */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (!_client) {
      _client = createClient();
    }
    return (_client as any)[prop];
  },
});

/** Disconnect the singleton (for clean shutdown). */
export async function disconnect(): Promise<void> {
  if (_client) {
    await _client.$disconnect();
    _client = null;
  }
}
