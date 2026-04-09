import { describe, test, expect, beforeEach } from "bun:test";
import { MemoryToolAdapter, type MemoryBackend } from "../src/tools/memory-adapter";

/** Minimal in-memory backend for testing. */
function createMockBackend(): MemoryBackend & { store: Map<string, any> } {
  const store = new Map<string, any>();
  return {
    store,
    async write(entry) {
      store.set(entry.id, entry);
    },
    get(id) {
      return store.get(id);
    },
    search(query, limit = 20) {
      const q = query.toLowerCase();
      return [...store.values()]
        .filter((e) => e.content.toLowerCase().includes(q))
        .slice(0, limit);
    },
    all(kind) {
      const entries = [...store.values()];
      return kind ? entries.filter((e: any) => e.kind === kind) : entries;
    },
    recent(limit = 20, kind) {
      return [...store.values()]
        .filter((e: any) => !kind || e.kind === kind)
        .sort((a: any, b: any) => b.timestamp - a.timestamp)
        .slice(0, limit);
    },
    async delete(id) {
      return store.delete(id);
    },
  };
}

describe("MemoryToolAdapter", () => {
  let backend: ReturnType<typeof createMockBackend>;
  let tool: MemoryToolAdapter;

  beforeEach(() => {
    backend = createMockBackend();
    tool = new MemoryToolAdapter({ system: "test", backend });
  });

  test("has correct metadata", () => {
    expect(tool.id).toBe("memory-test");
    expect(tool.kind).toBe("memory");
    expect(tool.system).toBe("test");
    expect(tool.capabilities.read).toBe("data:read");
    expect(tool.capabilities.write).toBe("data:write");
    expect(tool.capabilities.delete).toBe("data:delete");
  });

  test("custom id", () => {
    const custom = new MemoryToolAdapter({ system: "x", backend, id: "my-mem" });
    expect(custom.id).toBe("my-mem");
  });

  // -- write --

  test("write stores entry", async () => {
    const result = await tool.write({
      id: "conv-1",
      kind: "convention",
      content: "Use Zod for validation",
      timestamp: Date.now(),
    });
    expect(result.ok).toBe(true);
    expect(result.data?.id).toBe("conv-1");
    expect(result.summary).toContain("conv-1");
    expect(backend.store.has("conv-1")).toBe(true);
  });

  // -- get --

  test("get retrieves existing entry", async () => {
    await tool.write({
      id: "entry-1",
      kind: "test",
      content: "hello",
      timestamp: Date.now(),
    });
    const result = await tool.get("entry-1");
    expect(result.ok).toBe(true);
    expect(result.data?.content).toBe("hello");
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  test("get returns null for missing entry", async () => {
    const result = await tool.get("nonexistent");
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  // -- search --

  test("search finds matching entries", async () => {
    await tool.write({ id: "a", kind: "test", content: "Use snake_case for variables", timestamp: 1 });
    await tool.write({ id: "b", kind: "test", content: "Use PascalCase for classes", timestamp: 2 });
    await tool.write({ id: "c", kind: "test", content: "Database schema version 3", timestamp: 3 });

    const result = await tool.search("case");
    expect(result.ok).toBe(true);
    expect(result.data?.length).toBe(2);
    expect(result.summary).toContain("Found 2 entries");
  });

  test("search returns empty for no matches", async () => {
    const result = await tool.search("nonexistent");
    expect(result.ok).toBe(true);
    expect(result.data?.length).toBe(0);
    expect(result.summary).toContain("No entries found");
  });

  test("search filters by kind", async () => {
    await tool.write({ id: "a", kind: "convention", content: "Use Zod", timestamp: 1 });
    await tool.write({ id: "b", kind: "signal", content: "Use Zod everywhere", timestamp: 2 });

    const result = await tool.search("Zod", { kind: "convention" });
    expect(result.ok).toBe(true);
    expect(result.data?.length).toBe(1);
    expect(result.data?.[0].kind).toBe("convention");
  });

  // -- recent --

  test("recent returns entries in reverse chronological order", async () => {
    await tool.write({ id: "old", kind: "test", content: "old", timestamp: 100 });
    await tool.write({ id: "new", kind: "test", content: "new", timestamp: 200 });
    await tool.write({ id: "newest", kind: "test", content: "newest", timestamp: 300 });

    const result = await tool.recent(2);
    expect(result.ok).toBe(true);
    expect(result.data?.length).toBe(2);
    expect(result.data?.[0].id).toBe("newest");
    expect(result.data?.[1].id).toBe("new");
  });

  test("recent filters by kind", async () => {
    await tool.write({ id: "a", kind: "convention", content: "x", timestamp: 1 });
    await tool.write({ id: "b", kind: "signal", content: "y", timestamp: 2 });

    const result = await tool.recent(10, "signal");
    expect(result.ok).toBe(true);
    expect(result.data?.length).toBe(1);
    expect(result.data?.[0].kind).toBe("signal");
  });

  // -- delete --

  test("delete removes entry", async () => {
    await tool.write({ id: "del-me", kind: "test", content: "bye", timestamp: 1 });
    const result = await tool.delete("del-me");
    expect(result.ok).toBe(true);
    expect(result.data?.deleted).toBe(true);
    expect(backend.store.has("del-me")).toBe(false);
  });

  test("delete returns false for missing entry", async () => {
    const result = await tool.delete("nope");
    expect(result.ok).toBe(true);
    expect(result.data?.deleted).toBe(false);
  });

  // -- factory methods --

  test("fromFileMemory sets system to file", () => {
    const t = MemoryToolAdapter.fromFileMemory(backend);
    expect(t.system).toBe("file");
    expect(t.id).toBe("memory-file");
  });

  test("fromSqliteMemory sets system to sqlite", () => {
    const t = MemoryToolAdapter.fromSqliteMemory(backend);
    expect(t.system).toBe("sqlite");
    expect(t.id).toBe("memory-sqlite");
  });

  test("from() generic factory", () => {
    const t = MemoryToolAdapter.from("custom-db", backend, "my-custom");
    expect(t.system).toBe("custom-db");
    expect(t.id).toBe("my-custom");
  });

  // -- estimatedTokens --

  test("search includes estimatedTokens", async () => {
    await tool.write({ id: "a", kind: "test", content: "a".repeat(400), timestamp: 1 });
    const result = await tool.search("a");
    expect(result.ok).toBe(true);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });
});
