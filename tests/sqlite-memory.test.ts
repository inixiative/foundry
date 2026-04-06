import { describe, test, expect, afterEach } from "bun:test";
import { SqliteMemory } from "../src/adapters/sqlite-memory";

describe("SqliteMemory", () => {
  let db: SqliteMemory;

  afterEach(() => {
    db?.close();
  });

  test("write and get", () => {
    db = new SqliteMemory(":memory:");
    db.write({
      id: "conv-1",
      kind: "convention",
      content: "Use Zod for validation",
      timestamp: Date.now(),
    });

    const entry = db.get("conv-1");
    expect(entry).toBeDefined();
    expect(entry!.content).toBe("Use Zod for validation");
    expect(entry!.kind).toBe("convention");
  });

  test("upsert replaces existing", () => {
    db = new SqliteMemory(":memory:");
    db.write({ id: "a", kind: "test", content: "original", timestamp: 1 });
    db.write({ id: "a", kind: "test", content: "updated", timestamp: 2 });

    const entry = db.get("a");
    expect(entry!.content).toBe("updated");
    expect(db.count()).toBe(1);
  });

  test("get returns undefined for missing", () => {
    db = new SqliteMemory(":memory:");
    expect(db.get("nonexistent")).toBeUndefined();
  });

  test("all returns entries filtered by kind", () => {
    db = new SqliteMemory(":memory:");
    db.write({ id: "a", kind: "convention", content: "A", timestamp: 1 });
    db.write({ id: "b", kind: "correction", content: "B", timestamp: 2 });
    db.write({ id: "c", kind: "convention", content: "C", timestamp: 3 });

    expect(db.all().length).toBe(3);
    expect(db.all("convention").length).toBe(2);
    expect(db.all("correction").length).toBe(1);
  });

  test("recent returns entries ordered by timestamp desc", () => {
    db = new SqliteMemory(":memory:");
    db.write({ id: "old", kind: "test", content: "old", timestamp: 1 });
    db.write({ id: "new", kind: "test", content: "new", timestamp: 100 });

    const entries = db.recent(10);
    expect(entries[0].id).toBe("new");
    expect(entries[1].id).toBe("old");
  });

  test("recent respects limit", () => {
    db = new SqliteMemory(":memory:");
    for (let i = 0; i < 10; i++) {
      db.write({ id: `e${i}`, kind: "test", content: `content ${i}`, timestamp: i });
    }

    expect(db.recent(3).length).toBe(3);
  });

  test("search uses full-text search", () => {
    db = new SqliteMemory(":memory:");
    db.write({ id: "a", kind: "test", content: "TypeScript is great", timestamp: 1 });
    db.write({ id: "b", kind: "test", content: "JavaScript is okay", timestamp: 2 });
    db.write({ id: "c", kind: "test", content: "TypeScript generics", timestamp: 3 });

    const results = db.search("TypeScript");
    expect(results.length).toBe(2);
  });

  test("delete removes entry", () => {
    db = new SqliteMemory(":memory:");
    db.write({ id: "del", kind: "test", content: "gone", timestamp: 1 });

    expect(db.delete("del")).toBe(true);
    expect(db.get("del")).toBeUndefined();
    expect(db.delete("del")).toBe(false);
  });

  test("count returns correct totals", () => {
    db = new SqliteMemory(":memory:");
    db.write({ id: "a", kind: "convention", content: "A", timestamp: 1 });
    db.write({ id: "b", kind: "correction", content: "B", timestamp: 2 });
    db.write({ id: "c", kind: "convention", content: "C", timestamp: 3 });

    expect(db.count()).toBe(3);
    expect(db.count("convention")).toBe(2);
    expect(db.count("correction")).toBe(1);
  });

  test("meta is preserved as JSON", () => {
    db = new SqliteMemory(":memory:");
    db.write({
      id: "meta-test",
      kind: "test",
      content: "content",
      timestamp: 1,
      meta: { score: 0.9, tags: ["a", "b"] },
    });

    const entry = db.get("meta-test");
    expect(entry!.meta).toEqual({ score: 0.9, tags: ["a", "b"] });
  });

  test("asSource loads entries as context string", async () => {
    db = new SqliteMemory(":memory:");
    db.write({ id: "a", kind: "convention", content: "Conv A", timestamp: 1 });
    db.write({ id: "b", kind: "other", content: "Other B", timestamp: 2 });

    const src = db.asSource("test-src", "convention");
    const content = await src.load();
    expect(content).toContain("Conv A");
    expect(content).not.toContain("Other B");
  });

  test("asSource returns empty for no entries", async () => {
    db = new SqliteMemory(":memory:");
    const src = db.asSource("test-src", "nonexistent");
    expect(await src.load()).toBe("");
  });

  test("asAdapter hydrates by entry id", async () => {
    db = new SqliteMemory(":memory:");
    db.write({ id: "entry-1", kind: "test", content: "hydrated", timestamp: 1 });

    const adapter = db.asAdapter();
    expect(adapter.system).toBe("sqlite");
    const content = await adapter.hydrate({ system: "sqlite", locator: "entry-1" });
    expect(content).toBe("hydrated");
  });

  test("asAdapter batch hydration", async () => {
    db = new SqliteMemory(":memory:");
    db.write({ id: "a", kind: "test", content: "A", timestamp: 1 });
    db.write({ id: "b", kind: "test", content: "B", timestamp: 2 });

    const adapter = db.asAdapter();
    const results = await adapter.hydrateBatch!([
      { system: "sqlite", locator: "a" },
      { system: "sqlite", locator: "b" },
      { system: "sqlite", locator: "missing" },
    ]);
    expect(results).toEqual(["A", "B", ""]);
  });

  test("signalWriter persists signals", async () => {
    db = new SqliteMemory(":memory:");
    const writer = db.signalWriter();

    await writer({
      id: "sig-1",
      kind: "correction",
      source: "test",
      content: { actual: "X", correction: "Y" },
      confidence: 1.0,
      timestamp: Date.now(),
    });

    const entry = db.get("sig-1");
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("correction");
    expect(entry!.content).toBe('{"actual":"X","correction":"Y"}');
  });
});
