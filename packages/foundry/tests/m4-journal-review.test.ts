import { expect, spyOn, test } from "bun:test";
import { Database, type Statement } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, Thread } from "@inixiative/foundry-core";
import { LocalSessionStore } from "../src/persistence/local-session-store";

// Reviewer probes for the parent's journal statement-lifecycle correction (Fable). Disposable
// journals only; no GC, sleeps, global cache mutation or lock relaxation. Read-only toward production.

const finalized = (s: object) => Reflect.get(s, "isFinalized") === true;
const liveStatements = (store: LocalSessionStore) => (Reflect.get(store, "statements") as Map<string, Statement>).size;

function seeded(path: string, turns: number) {
  const thread = new Thread("owned", new ContextStack(), { projectId: "P" });
  const store = new LocalSessionStore(path);
  for (let n = 0; n < turns; n++) {
    store.beginTurn(thread, `turn-${n}`, `input-${n}`);
    store.completeTurn(thread, `turn-${n}`, `output-${n}`, { executionOutcome: "completed", persistence: "committed" },
      { id: `trace-${n}`, messageId: `turn-${n}`, startedAt: n, root: {}, summary: { id: `trace-${n}` }, spans: [] });
  }
  return { store, thread };
}

test("R1: live statements stay bounded under many distinct SQL shapes; every eviction is finalized; hot reuse prepares nothing new", () => {
  const dir = mkdtempSync(join(tmpdir(), "m4-journal-review-bounded-"));
  const prepare = spyOn(Database.prototype, "prepare");
  let store: LocalSessionStore | undefined;
  try {
    ({ store } = seeded(join(dir, "s.sqlite"), 30));
    const { thread } = { thread: new Thread("owned", new ContextStack(), { projectId: "P" }) };
    // Each distinct page size changes the IN(...) placeholder list, i.e. a distinct SQL shape.
    for (let limit = 1; limit <= 150; limit++) store.messageIndex(thread.id, { limit });
    const prepared = prepare.mock.results.filter(r => r.type === "return").map(r => r.value as Statement);
    expect(prepared.length).toBeGreaterThan(64);
    expect(liveStatements(store)).toBeLessThanOrEqual(64);
    const inMap = new Set((Reflect.get(store, "statements") as Map<string, Statement>).values());
    // Exact classification, not a loosened count: every unfinalized statement outside the store's cache must be
    // one of Bun 1.3.14's own transaction-control statements (prepared by Database.transaction, finalized by close).
    const driverTransaction = /^(BEGIN( DEFERRED| IMMEDIATE| EXCLUSIVE)?|COMMIT|ROLLBACK|SAVEPOINT .*|RELEASE .*|ROLLBACK TO .*)$/;
    const outside = prepared.filter(s => !inMap.has(s) && !finalized(s));
    expect(outside.map(s => String(s))).toEqual(outside.map(s => String(s)).filter(sql => driverTransaction.test(sql)));
    expect(outside.length).toBeLessThanOrEqual(9);
    expect(prepared.filter(s => !inMap.has(s) && !driverTransaction.test(String(s))).every(finalized)).toBe(true); // every store eviction finalized
    expect(prepared.length - inMap.size - outside.length).toBeGreaterThan(0); // evictions happened
    store.trace("trace-0"); // warm: the paging churn above evicted this shape from the 64-entry cache
    const before = prepare.mock.calls.length;
    for (let i = 0; i < 25; i++) store.trace("trace-0");
    expect(prepare.mock.calls.length).toBe(before); // hot query reused, not re-prepared
    store.close();
    expect(prepared.every(finalized)).toBe(true);
    expect(liveStatements(store)).toBe(0);
  } finally { store?.close(); prepare.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

test("R2: constructor failure after its first prepared statement finalizes it, closes the database and releases the file lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "m4-journal-review-ctor-"));
  const path = join(dir, "future.sqlite");
  const raw = new Database(path, { create: true }); raw.exec("PRAGMA user_version = 99"); raw.close();
  const prepare = spyOn(Database.prototype, "prepare");
  try {
    expect(() => new LocalSessionStore(path)).toThrow("Unsupported session store version");
    const prepared = prepare.mock.results.filter(r => r.type === "return").map(r => r.value as object);
    expect(prepared.length).toBeGreaterThanOrEqual(1); // the version PRAGMA went through the store helper
    expect(prepared.every(finalized)).toBe(true);
    // The lock is released: a fresh exclusive-mode handle opens and reads immediately, with no delay.
    const again = new Database(path); again.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE");
    expect((again.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(99);
    again.close();
  } finally { prepare.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

test("R3: close after heavy paging releases the exclusive lock immediately; reopen recovers history, traces and turn status exactly", () => {
  const dir = mkdtempSync(join(tmpdir(), "m4-journal-review-reopen-"));
  const path = join(dir, "s.sqlite");
  let store: LocalSessionStore | undefined;
  try {
    ({ store } = seeded(path, 40));
    const thread = new Thread("owned", new ContextStack(), { projectId: "P" });
    for (let limit = 1; limit <= 120; limit++) store.messageIndex(thread.id, { limit });
    const before = { messages: store.messages(thread.id, 1000).map(m => m.id), turn: store.turn("turn-39")?.status, trace: store.trace("trace-39")?.id };
    store.close(); store.close(); // idempotent
    store = new LocalSessionStore(path); // would throw SQLiteError: database is locked before the correction
    expect(store.messages(thread.id, 1000).map(m => m.id)).toEqual(before.messages);
    expect(store.turn("turn-39")?.status).toBe(before.turn);
    expect(store.trace("trace-39")?.id).toBe(before.trace);
    expect(store.messageIndex(thread.id, { limit: 10 }).messages).toHaveLength(10);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("R4: the global driver cache limit is untouched and a second exclusive opener is still refused while the store is open", () => {
  const dir = mkdtempSync(join(tmpdir(), "m4-journal-review-lock-"));
  const path = join(dir, "s.sqlite");
  const limit = Database.MAX_QUERY_CACHE_SIZE;
  let store: LocalSessionStore | undefined;
  try {
    ({ store } = seeded(path, 2));
    expect(Database.MAX_QUERY_CACHE_SIZE).toBe(limit);
    expect(() => new LocalSessionStore(path)).toThrow(/locked/i); // exclusive protection preserved while open
    store.close();
    const reopened = new LocalSessionStore(path); reopened.close();
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
