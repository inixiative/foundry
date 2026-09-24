import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, Thread } from "../../../packages/core/src";
import { LocalSessionStore } from "../../../packages/foundry/src/persistence/local-session-store";

test("journal closes and immediately reopens after varied history queries without garbage collection", () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-journal-statements-"));
  const path = join(dir, "sessions.sqlite");
  const originalCacheLimit = Database.MAX_QUERY_CACHE_SIZE;
  const thread = new Thread("owned", new ContextStack(), { projectId: "P" });
  const prepare = spyOn(Database.prototype, "prepare");
  let store: LocalSessionStore | undefined;
  try {
    store = new LocalSessionStore(path);
    for (let n = 0; n < 40; n++) {
      const id = `turn-${n}`;
      store.beginTurn(thread, id, `input-${n}`);
      store.completeTurn(thread, id, `output-${n}`, {},
        { id: `trace-${n}`, messageId: id, startedAt: n, root: {}, summary: { id: `trace-${n}` }, spans: [] });
    }
    // Vary real index page shapes past the driver's query cache and any bounded
    // store cache, then leave a successful scalar read as the final operation.
    for (let limit = 1; limit <= 80; limit++) store.messageIndex(thread.id, { limit });
    expect(store.trace("trace-0")?.messageId).toBe("turn-0");
    const prepared = prepare.mock.calls.length;
    for (let n = 0; n < 20; n++) store.trace("trace-0");
    expect(prepare.mock.calls.length).toBe(prepared);
    const statements = prepare.mock.results.filter(r => r.type === "return").map(r => r.value);
    const finalized = (statement: object) => Reflect.get(statement, "isFinalized") === true;
    // Include the driver's transaction-control statements, outside the store cache.
    expect(statements.filter(s => !finalized(s)).length).toBeLessThanOrEqual(80);
    store.close();
    expect(statements.every(finalized)).toBe(true);
    store.close();
    store = new LocalSessionStore(path);
    expect(store.messages(thread.id, 100)).toHaveLength(80);
    expect(store.trace("trace-0")?.messageId).toBe("turn-0");
    expect(Database.MAX_QUERY_CACHE_SIZE).toBe(originalCacheLimit);
  } finally {
    store?.close();
    prepare.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
