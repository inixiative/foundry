import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { MuninnMemory } from "../src/adapters/muninn-memory";
import type { MemoryEntry, Signal } from "@inixiative/foundry-core";

// ---------------------------------------------------------------------------
// Mock MuninnDB REST server
// ---------------------------------------------------------------------------

const engrams = new Map<string, any>();
let mockPort: number;
let mockServer: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0, // random available port
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/api\//, "");
      const method = req.method;

      // Health
      if (path === "health") {
        return Response.json({ status: "ok" });
      }

      // POST /api/engrams — store
      if (method === "POST" && path === "engrams") {
        const body = await req.json() as any;
        const id = `eng_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        engrams.set(id, { id, ...body, created_at: new Date().toISOString() });
        return Response.json({ id });
      }

      // POST /api/engrams/bulk — batch store
      if (method === "POST" && path === "engrams/bulk") {
        const body = await req.json() as any;
        const ids: string[] = [];
        for (const e of body.engrams ?? []) {
          const id = `eng_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          engrams.set(id, { id, ...e, created_at: new Date().toISOString() });
          ids.push(id);
        }
        return Response.json({ ids });
      }

      // GET /api/engrams/:id — fetch by ID
      const engramMatch = path.match(/^engrams\/([^/]+)$/);
      if (method === "GET" && engramMatch) {
        const id = decodeURIComponent(engramMatch[1]);
        const engram = engrams.get(id);
        if (!engram) return new Response("Not found", { status: 404 });
        return Response.json(engram);
      }

      // DELETE /api/engrams/:id — soft-delete
      if (method === "DELETE" && engramMatch) {
        const id = decodeURIComponent(engramMatch[1]);
        if (!engrams.has(id)) return new Response("Not found", { status: 404 });
        engrams.delete(id);
        return Response.json({ deleted: true });
      }

      // GET /api/engrams — list
      if (method === "GET" && path === "engrams") {
        const vault = url.searchParams.get("vault") ?? "default";
        const limit = parseInt(url.searchParams.get("limit") ?? "20");
        const tagFilter = url.searchParams.get("tags");

        let results = [...engrams.values()]
          .filter((e) => e.vault === vault)
          .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

        if (tagFilter) {
          results = results.filter((e) => e.tags?.includes(tagFilter) || e.concept === tagFilter);
        }

        return Response.json(results.slice(0, limit));
      }

      // POST /api/activate — cognitive recall
      if (method === "POST" && path === "activate") {
        const body = await req.json() as any;
        const vault = body.vault ?? "default";
        const context = body.context ?? [];
        const maxResults = body.max_results ?? 20;
        const query = context.join(" ").toLowerCase();

        const results = [...engrams.values()]
          .filter((e) => e.vault === vault)
          .filter((e) => {
            if (!query) return true;
            return (e.content ?? "").toLowerCase().includes(query) ||
              (e.concept ?? "").toLowerCase().includes(query);
          })
          .slice(0, maxResults)
          .map((e, i) => ({
            id: e.id,
            score: 1.0 - i * 0.1,
            concept: e.concept,
            content: e.content,
            why: { semantic: 0.8, hebbian: 0.1, decay: 0.05, bayesian: 0.05 },
            hop_path: "direct",
          }));

        return Response.json(results);
      }

      return new Response("Not found", { status: 404 });
    },
  });

  mockPort = mockServer.port;
});

afterAll(() => {
  mockServer.stop();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function createMemory() {
  return new MuninnMemory({
    baseUrl: `http://localhost:${mockPort}`,
    vault: "test",
  });
}

describe("MuninnMemory", () => {
  test("constructor defaults", () => {
    const m = new MuninnMemory({});
    expect(m.vault).toBe("default");
  });

  test("write() stores an engram", async () => {
    const m = createMemory();
    const entry: MemoryEntry = {
      id: "test-1",
      kind: "convention",
      content: "Use snake_case for variables",
      timestamp: Date.now(),
    };

    // Should not throw
    await m.write(entry);

    // Verify it was stored (search for it)
    const results = await m.search("snake_case");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("snake_case");
  });

  test("get() retrieves by ID", async () => {
    const m = createMemory();

    // Write directly to get the ID
    const entry: MemoryEntry = {
      id: "direct-get",
      kind: "signal",
      content: "Test retrieval",
      timestamp: Date.now(),
    };
    await m.write(entry);

    // Get all engrams and find ours
    const recent = await m.recent(100);
    const stored = recent.find((e) => e.content.includes("Test retrieval"));
    expect(stored).toBeDefined();

    if (stored) {
      const fetched = await m.get(stored.id);
      expect(fetched).toBeDefined();
      expect(fetched!.content).toContain("Test retrieval");
    }
  });

  test("get() returns undefined for missing ID", async () => {
    const m = createMemory();
    const result = await m.get("nonexistent-id-12345");
    expect(result).toBeUndefined();
  });

  test("search() returns matching entries", async () => {
    const m = createMemory();
    await m.write({
      id: "search-1",
      kind: "convention",
      content: "Always use TypeScript strict mode",
      timestamp: Date.now(),
    });

    const results = await m.search("TypeScript");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("TypeScript");
    expect(results[0].kind).toBe("convention");
  });

  test("searchMemories() preserves scores", async () => {
    const m = createMemory();
    await m.write({
      id: "scored-1",
      kind: "memory",
      content: "Unique scored content xyz123",
      timestamp: Date.now(),
    });

    const results = await m.searchMemories("xyz123");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeDefined();
    expect(typeof results[0].score).toBe("number");
    expect(results[0].metadata?.why).toBeDefined();
  });

  test("recent() returns entries sorted by time", async () => {
    const m = createMemory();
    const entries = await m.recent(5);
    expect(Array.isArray(entries)).toBe(true);
    // We've been writing entries, so there should be some
    expect(entries.length).toBeGreaterThan(0);
  });

  test("delete() removes entry", async () => {
    const m = createMemory();
    await m.write({
      id: "to-delete",
      kind: "temp",
      content: "Delete me please",
      timestamp: Date.now(),
    });

    // Find the stored entry
    const recent = await m.recent(100);
    const stored = recent.find((e) => e.content.includes("Delete me"));
    expect(stored).toBeDefined();

    if (stored) {
      const deleted = await m.delete(stored.id);
      expect(deleted).toBe(true);
    }
  });

  test("delete() returns false for missing ID", async () => {
    const m = createMemory();
    const result = await m.delete("nonexistent-delete-id");
    expect(result).toBe(false);
  });

  test("writeBatch() stores multiple engrams", async () => {
    const m = createMemory();
    const entries: MemoryEntry[] = [
      { id: "batch-1", kind: "fact", content: "Batch item alpha", timestamp: Date.now() },
      { id: "batch-2", kind: "fact", content: "Batch item beta", timestamp: Date.now() },
      { id: "batch-3", kind: "fact", content: "Batch item gamma", timestamp: Date.now() },
    ];

    await m.writeBatch(entries);

    const results = await m.search("Batch item");
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  test("asSource() returns a loadable ContextSource", async () => {
    const m = createMemory();
    await m.write({
      id: "source-1",
      kind: "convention",
      content: "Context source test content",
      timestamp: Date.now(),
    });

    const source = m.asSource("test-source");
    expect(source.id).toBe("test-source");

    const loaded = await source.load();
    expect(typeof loaded).toBe("string");
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded).toContain("MuninnDB Memories");
  });

  test("asAdapter() hydrates by engram ID", async () => {
    const m = createMemory();
    await m.write({
      id: "hydrate-test",
      kind: "fact",
      content: "Hydration target content",
      timestamp: Date.now(),
    });

    const recent = await m.recent(100);
    const stored = recent.find((e) => e.content.includes("Hydration target"));
    expect(stored).toBeDefined();

    if (stored) {
      const adapter = m.asAdapter();
      expect(adapter.system).toBe("muninn");

      const content = await adapter.hydrate({ system: "muninn", locator: stored.id });
      expect(content).toContain("Hydration target");
    }
  });

  test("asAdapter() hydrates by search query", async () => {
    const m = createMemory();
    await m.write({
      id: "hydrate-search",
      kind: "fact",
      content: "Searchable hydration qwerty789",
      timestamp: Date.now(),
    });

    const adapter = m.asAdapter();
    const content = await adapter.hydrate({ system: "muninn", locator: "?qwerty789" });
    expect(content).toContain("qwerty789");
  });

  test("signalWriter() persists signals as engrams", async () => {
    const m = createMemory();
    const writer = m.signalWriter();

    const signal: Signal = {
      id: "sig-1",
      kind: "correction",
      source: "test-agent",
      content: "Signal persistence test unique999",
      confidence: 0.9,
      refs: [],
      timestamp: Date.now(),
    };

    await writer(signal);

    const results = await m.search("unique999");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("unique999");
  });

  test("signalWriter() filters by kind", async () => {
    const m = createMemory();
    const writer = m.signalWriter({ kinds: ["convention"] });

    const ignored: Signal = {
      id: "sig-ignored",
      kind: "correction",
      source: "test",
      content: "This should be filtered out filtertest111",
      confidence: 1,
      refs: [],
      timestamp: Date.now(),
    };
    const accepted: Signal = {
      id: "sig-accepted",
      kind: "convention",
      source: "test",
      content: "This should be stored filtertest222",
      confidence: 1,
      refs: [],
      timestamp: Date.now(),
    };

    await writer(ignored);
    await writer(accepted);

    const results222 = await m.search("filtertest222");
    expect(results222.length).toBeGreaterThan(0);

    // The ignored signal content should not appear when searching specifically
    const results111 = await m.search("filtertest111");
    expect(results111.length).toBe(0);
  });

  test("all() returns entries", async () => {
    const m = createMemory();
    const all = await m.all();
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeGreaterThan(0);
  });

  test("entries have correct structure", async () => {
    const m = createMemory();
    const entries = await m.recent(1);
    if (entries.length > 0) {
      const entry = entries[0];
      expect(entry.id).toBeDefined();
      expect(typeof entry.id).toBe("string");
      expect(entry.kind).toBeDefined();
      expect(entry.content).toBeDefined();
      expect(typeof entry.timestamp).toBe("number");
    }
  });
});
