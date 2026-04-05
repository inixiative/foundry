/**
 * PostgresMemory integration tests.
 *
 * These tests require a running PostgreSQL instance with the Foundry schema.
 * Run with: DATABASE_URL=postgresql://postgres:postgres@localhost:5532/foundry_test bun test tests/db/
 *
 * Setup:
 *   docker compose up -d
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5532/foundry_test bunx prisma db push
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5532/foundry_test bun test tests/db/
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PostgresMemory } from "../../src/adapters/postgres-memory";
import { Trace } from "../../src/agents/trace";
import { SignalBus } from "../../src/agents/signal";
import { InterventionLog } from "../../src/agents/intervention";
import { setupTestDb } from "./setup";

const prisma = setupTestDb();
let pg: PostgresMemory;

beforeAll(() => {
  pg = new PostgresMemory(prisma);
});

describe("PostgresMemory", () => {
  describe("entries", () => {
    test("writeEntry and getEntry", async () => {
      await pg.writeEntry({
        id: "entry-1",
        kind: "convention",
        content: "Use Zod for validation",
        source: "operator:test",
      });

      const entry = await pg.getEntry("entry-1");
      expect(entry).toBeDefined();
      expect(entry!.id).toBe("entry-1");
      expect(entry!.kind).toBe("convention");
      expect(entry!.content).toBe("Use Zod for validation");
      expect(entry!.source).toBe("operator:test");
    });

    test("writeEntry upserts on conflict", async () => {
      await pg.writeEntry({
        id: "upsert-1",
        kind: "convention",
        content: "original",
      });
      await pg.writeEntry({
        id: "upsert-1",
        kind: "convention",
        content: "updated",
      });

      const entry = await pg.getEntry("upsert-1");
      expect(entry!.content).toBe("updated");
    });

    test("entriesByKind returns filtered results", async () => {
      await pg.writeEntry({ id: "conv-1", kind: "convention", content: "A" });
      await pg.writeEntry({ id: "corr-1", kind: "correction", content: "B" });
      await pg.writeEntry({ id: "conv-2", kind: "convention", content: "C" });

      const conventions = await pg.entriesByKind("convention");
      expect(conventions.length).toBe(2);
      expect(conventions.every((e) => e.kind === "convention")).toBe(true);
    });

    test("recentEntries returns ordered by timestamp", async () => {
      await pg.writeEntry({ id: "recent-1", kind: "test", content: "first" });
      await pg.writeEntry({ id: "recent-2", kind: "test", content: "second" });

      const entries = await pg.recentEntries(10, "test");
      expect(entries.length).toBeGreaterThanOrEqual(2);
      // Most recent first
      const ids = entries.map((e) => e.id);
      expect(ids.indexOf("recent-2")).toBeLessThan(ids.indexOf("recent-1"));
    });

    test("searchEntries finds by content", async () => {
      await pg.writeEntry({
        id: "search-1",
        kind: "test",
        content: "TypeScript is strongly typed",
      });
      await pg.writeEntry({
        id: "search-2",
        kind: "test",
        content: "JavaScript is loosely typed",
      });

      const results = await pg.searchEntries("TypeScript");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r: any) => r.id === "search-1")).toBe(true);
    });

    test("deleteEntry removes entry", async () => {
      await pg.writeEntry({ id: "del-1", kind: "test", content: "gone" });
      expect(await pg.deleteEntry("del-1")).toBe(true);
      expect(await pg.getEntry("del-1")).toBeNull();
      expect(await pg.deleteEntry("del-1")).toBe(false);
    });

    test("writeEntry with meta", async () => {
      await pg.writeEntry({
        id: "meta-1",
        kind: "test",
        content: "with metadata",
        meta: { score: 0.9, tags: ["a", "b"] },
      });

      const entry = await pg.getEntry("meta-1");
      expect(entry!.meta).toEqual({ score: 0.9, tags: ["a", "b"] });
    });
  });

  describe("traces", () => {
    test("writeTrace persists trace and spans", async () => {
      const trace = new Trace("msg-trace-1");
      trace.start("classify", "classify", { agentId: "classifier" });
      trace.end({ category: "bug" });
      trace.start("route", "route", { agentId: "router" });
      trace.end({ destination: "executor-fix" });
      trace.finish();

      await pg.writeTrace(trace);

      const stored = await pg.getTrace(trace.id);
      expect(stored).toBeDefined();
      expect(stored!.messageId).toBe("msg-trace-1");
      expect(stored!.spans.length).toBe(3); // ingress + classify + route
    });

    test("getTraceByMessage finds by messageId", async () => {
      const trace = new Trace("msg-find-1");
      trace.finish();
      await pg.writeTrace(trace);

      const found = await pg.getTraceByMessage("msg-find-1");
      expect(found).toBeDefined();
      expect(found!.messageId).toBe("msg-find-1");
    });

    test("recentTraces returns ordered results", async () => {
      const t1 = new Trace("msg-recent-1");
      t1.finish();
      await pg.writeTrace(t1);

      const t2 = new Trace("msg-recent-2");
      t2.finish();
      await pg.writeTrace(t2);

      const recent = await pg.recentTraces(10);
      expect(recent.length).toBeGreaterThanOrEqual(2);
    });

    test("querySpans finds spans by filter", async () => {
      const trace = new Trace("msg-spans-1");
      trace.start("classify", "classify", { agentId: "my-classifier" });
      trace.end("done");
      trace.finish();
      await pg.writeTrace(trace);

      const spans = await pg.querySpans({ kind: "classify" });
      expect(spans.length).toBeGreaterThanOrEqual(1);
      expect(spans.some((s) => s.agentId === "my-classifier")).toBe(true);
    });
  });

  describe("signals", () => {
    test("writeSignal and recentSignals", async () => {
      await pg.writeSignal({
        id: "sig-pg-1",
        kind: "correction",
        source: "operator:test",
        content: { actual: "X", correction: "Y" },
        confidence: 1.0,
        timestamp: Date.now(),
      });

      const signals = await pg.recentSignals(10, "correction");
      expect(signals.length).toBeGreaterThanOrEqual(1);
      expect(signals.some((s) => s.id === "sig-pg-1")).toBe(true);
    });
  });

  describe("interventions", () => {
    test("writeIntervention persists", async () => {
      // Need a trace first for FK
      const trace = new Trace("msg-int-1");
      trace.start("classify", "classify");
      const span = trace.current!;
      trace.end();
      trace.finish();
      await pg.writeTrace(trace);

      await pg.writeIntervention({
        id: "int-pg-1",
        traceId: trace.id,
        spanId: span.id,
        actual: { category: "feature" },
        correction: { category: "bug" },
        reason: "misclassified",
        operator: "aron",
        timestamp: Date.now(),
      });

      // Verify via trace include
      const stored = await pg.getTrace(trace.id);
      expect(stored!.interventions.length).toBe(1);
      expect(stored!.interventions[0].operator).toBe("aron");
    });
  });

  describe("messages", () => {
    test("writeMessage and threadMessages", async () => {
      await pg.writeMessage({
        id: "msg-pg-1",
        threadId: "thread-1",
        role: "user",
        content: "Hello, agent",
      });
      await pg.writeMessage({
        id: "msg-pg-2",
        threadId: "thread-1",
        role: "agent",
        content: "Hello, user",
      });
      await pg.writeMessage({
        id: "msg-pg-3",
        threadId: "thread-2",
        role: "user",
        content: "Different thread",
      });

      const messages = await pg.threadMessages("thread-1");
      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("agent");
    });
  });

  describe("adapter interfaces", () => {
    test("asSource loads entries as context", async () => {
      await pg.writeEntry({
        id: "src-1",
        kind: "convention",
        content: "Convention A",
      });
      await pg.writeEntry({
        id: "src-2",
        kind: "other",
        content: "Other B",
      });

      const src = pg.asSource("test-src", "convention");
      const content = await src.load();
      expect(content).toContain("Convention A");
      expect(content).not.toContain("Other B");
    });

    test("asAdapter hydrates by entry id", async () => {
      await pg.writeEntry({
        id: "hydrate-1",
        kind: "test",
        content: "hydrated content",
      });

      const adapter = pg.asAdapter();
      expect(adapter.system).toBe("postgres");
      const content = await adapter.hydrate({
        system: "postgres",
        locator: "hydrate-1",
      });
      expect(content).toBe("hydrated content");
    });

    test("asAdapter returns empty for missing", async () => {
      const adapter = pg.asAdapter();
      const content = await adapter.hydrate({
        system: "postgres",
        locator: "nonexistent-entry",
      });
      expect(content).toBe("");
    });

    test("signalWriter persists signals", async () => {
      const writer = pg.signalWriter();
      await writer({
        id: "sig-writer-1",
        kind: "taste",
        source: "agent:test",
        content: { preference: "tabs" },
        confidence: 0.7,
        timestamp: Date.now(),
      });

      const signals = await pg.recentSignals(10, "taste");
      expect(signals.some((s) => s.id === "sig-writer-1")).toBe(true);
    });

    test("traceWriter persists traces", async () => {
      const writer = pg.traceWriter();
      const trace = new Trace("msg-writer-1");
      trace.start("test", "execute");
      trace.end("done");
      trace.finish();

      await writer(trace);

      const stored = await pg.getTrace(trace.id);
      expect(stored).toBeDefined();
      expect(stored!.messageId).toBe("msg-writer-1");
    });
  });
});
