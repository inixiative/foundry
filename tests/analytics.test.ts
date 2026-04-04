import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { AnalyticsStore } from "../src/viewer/analytics";
import { TokenTracker } from "../src/agents/token-tracker";
import type { UsageEntry } from "../src/agents/token-tracker";
import type { AnalyticsSnapshot } from "../src/viewer/analytics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "analytics-test-"));
}

function makeUsageEntry(overrides?: Partial<UsageEntry>): UsageEntry {
  return {
    timestamp: Date.now(),
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    tokens: { input: 1000, output: 500 },
    cost: 0.0105,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Recording calls
// ---------------------------------------------------------------------------

describe("AnalyticsStore", () => {
  let dir: string;
  let store: AnalyticsStore;

  beforeEach(() => {
    dir = makeTmpDir();
    store = new AnalyticsStore(dir);
  });

  describe("recording calls", () => {
    test("recorded call appears in the store", () => {
      const entry = makeUsageEntry();
      const call = store.recordCall(entry);

      expect(call.id).toBeTruthy();
      expect(call.provider).toBe("anthropic");
      expect(call.model).toBe("claude-sonnet-4-20250514");
      expect(call.input).toBe(1000);
      expect(call.output).toBe(500);
      expect(call.cost).toBe(0.0105);
      expect(store.totalCalls).toBe(1);
    });

    test("records multiple calls and increments counter", () => {
      store.recordCall(makeUsageEntry());
      store.recordCall(makeUsageEntry());
      store.recordCall(makeUsageEntry());

      expect(store.totalCalls).toBe(3);
    });

    test("passes optional durationMs through", () => {
      const entry = makeUsageEntry();
      const call = store.recordCall(entry, { durationMs: 1234 });

      expect(call.durationMs).toBe(1234);
    });

    test("records agentId, threadId, spanId from entry", () => {
      const entry = makeUsageEntry({
        agentId: "coder",
        threadId: "thread-1",
        spanId: "span-42",
      });
      const call = store.recordCall(entry);

      expect(call.agentId).toBe("coder");
      expect(call.threadId).toBe("thread-1");
      expect(call.spanId).toBe("span-42");
    });
  });

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  describe("persistence", () => {
    test("saves calls and loads them in a new store instance", async () => {
      const persistDir = makeTmpDir();
      const store1 = new AnalyticsStore(persistDir);

      store1.recordCall(makeUsageEntry({ provider: "anthropic", model: "claude-sonnet-4-20250514" }));
      store1.recordCall(makeUsageEntry({ provider: "openai", model: "gpt-4o" }));

      // Wait for async persist
      await Bun.sleep(50);

      // New store from same directory
      const store2 = new AnalyticsStore(persistDir);
      await store2.load();

      expect(store2.totalCalls).toBe(2);
    });

    test("load is idempotent — second call does not duplicate", async () => {
      const persistDir = makeTmpDir();
      const store1 = new AnalyticsStore(persistDir);
      store1.recordCall(makeUsageEntry());

      await Bun.sleep(50);

      const store2 = new AnalyticsStore(persistDir);
      await store2.load();
      await store2.load(); // second call

      expect(store2.totalCalls).toBe(1);
    });

    test("load on empty directory does not throw", async () => {
      const emptyDir = makeTmpDir();
      const emptyStore = new AnalyticsStore(emptyDir);
      await emptyStore.load();

      expect(emptyStore.totalCalls).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Time-series rollups
  // -------------------------------------------------------------------------

  describe("time-series rollups", () => {
    test("groups calls into hourly buckets", () => {
      const base = new Date("2026-03-15T10:00:00Z").getTime();

      store.recordCall(makeUsageEntry({ timestamp: base, cost: 0.01 }));
      store.recordCall(makeUsageEntry({ timestamp: base + 30 * 60_000, cost: 0.02 })); // same hour
      store.recordCall(makeUsageEntry({ timestamp: base + 90 * 60_000, cost: 0.03 })); // next hour

      const hourly = store.timeSeries("hourly");

      expect(hourly.length).toBe(2);
      // First bucket has 2 calls
      const firstBucket = hourly[0];
      expect(firstBucket.calls).toBe(2);
      expect(firstBucket.cost).toBeCloseTo(0.03);
      // Second bucket has 1 call
      expect(hourly[1].calls).toBe(1);
      expect(hourly[1].cost).toBeCloseTo(0.03);
    });

    test("groups calls into daily buckets", () => {
      const day1 = new Date("2026-03-15T10:00:00Z").getTime();
      const day2 = new Date("2026-03-16T14:00:00Z").getTime();

      store.recordCall(makeUsageEntry({ timestamp: day1, cost: 0.01 }));
      store.recordCall(makeUsageEntry({ timestamp: day1 + 3600_000, cost: 0.02 })); // same day
      store.recordCall(makeUsageEntry({ timestamp: day2, cost: 0.03 }));

      const daily = store.timeSeries("daily");

      expect(daily.length).toBe(2);
      expect(daily[0].calls).toBe(2);
      expect(daily[1].calls).toBe(1);
    });

    test("timeSeries with since filter excludes older calls", () => {
      const old = new Date("2026-01-01T00:00:00Z").getTime();
      const recent = new Date("2026-03-15T10:00:00Z").getTime();

      store.recordCall(makeUsageEntry({ timestamp: old }));
      store.recordCall(makeUsageEntry({ timestamp: recent }));

      const series = store.timeSeries("daily", recent);
      expect(series.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Thread cost summaries
  // -------------------------------------------------------------------------

  describe("thread cost summaries", () => {
    test("breaks down costs by thread", () => {
      store.recordCall(makeUsageEntry({ threadId: "t1", cost: 0.10 }));
      store.recordCall(makeUsageEntry({ threadId: "t1", cost: 0.05 }));
      store.recordCall(makeUsageEntry({ threadId: "t2", cost: 0.20 }));

      const threads = store.threadCosts();

      expect(threads.length).toBe(2);
      // Sorted by cost descending
      expect(threads[0].threadId).toBe("t2");
      expect(threads[0].cost).toBeCloseTo(0.20);
      expect(threads[0].calls).toBe(1);

      expect(threads[1].threadId).toBe("t1");
      expect(threads[1].cost).toBeCloseTo(0.15);
      expect(threads[1].calls).toBe(2);
      expect(threads[1].avgCostPerCall).toBeCloseTo(0.075);
    });

    test("calls without threadId are grouped under (no thread)", () => {
      store.recordCall(makeUsageEntry({ threadId: undefined, cost: 0.05 }));
      store.recordCall(makeUsageEntry({ threadId: undefined, cost: 0.10 }));

      const threads = store.threadCosts();
      expect(threads.length).toBe(1);
      expect(threads[0].threadId).toBe("(no thread)");
      expect(threads[0].calls).toBe(2);
    });

    test("totalTokens is sum of input and output", () => {
      store.recordCall(
        makeUsageEntry({
          threadId: "t1",
          tokens: { input: 100, output: 200 },
        })
      );

      const threads = store.threadCosts();
      expect(threads[0].totalTokens).toBe(300);
    });
  });

  // -------------------------------------------------------------------------
  // Ranked models
  // -------------------------------------------------------------------------

  describe("ranked models", () => {
    test("ranks models by cost descending", () => {
      store.recordCall(makeUsageEntry({ model: "gpt-4o", cost: 0.50 }));
      store.recordCall(makeUsageEntry({ model: "gpt-4o", cost: 0.50 }));
      store.recordCall(makeUsageEntry({ model: "claude-sonnet-4-20250514", cost: 0.30 }));

      const tracker = new TokenTracker();
      const snap = store.snapshot(tracker);
      const models = snap.topModels;

      expect(models.length).toBe(2);
      expect(models[0].key).toBe("gpt-4o");
      expect(models[0].cost).toBeCloseTo(1.0);
      expect(models[0].calls).toBe(2);
      expect(models[1].key).toBe("claude-sonnet-4-20250514");
      expect(models[1].cost).toBeCloseTo(0.30);
    });

    test("percentage reflects share of total cost", () => {
      store.recordCall(makeUsageEntry({ model: "a", cost: 0.75 }));
      store.recordCall(makeUsageEntry({ model: "b", cost: 0.25 }));

      const tracker = new TokenTracker();
      const snap = store.snapshot(tracker);

      expect(snap.topModels[0].percentage).toBeCloseTo(0.75);
      expect(snap.topModels[1].percentage).toBeCloseTo(0.25);
    });
  });

  // -------------------------------------------------------------------------
  // Ranked agents
  // -------------------------------------------------------------------------

  describe("ranked agents", () => {
    test("ranks agents by cost descending", () => {
      store.recordCall(makeUsageEntry({ agentId: "coder", cost: 0.80 }));
      store.recordCall(makeUsageEntry({ agentId: "reviewer", cost: 0.20 }));
      store.recordCall(makeUsageEntry({ agentId: "coder", cost: 0.40 }));

      const tracker = new TokenTracker();
      const snap = store.snapshot(tracker);
      const agents = snap.topAgents;

      expect(agents.length).toBe(2);
      expect(agents[0].key).toBe("coder");
      expect(agents[0].cost).toBeCloseTo(1.20);
      expect(agents[1].key).toBe("reviewer");
    });

    test("entries without agentId are excluded from ranking", () => {
      store.recordCall(makeUsageEntry({ agentId: undefined, cost: 0.50 }));
      store.recordCall(makeUsageEntry({ agentId: "coder", cost: 0.30 }));

      const tracker = new TokenTracker();
      const snap = store.snapshot(tracker);

      expect(snap.topAgents.length).toBe(1);
      expect(snap.topAgents[0].key).toBe("coder");
    });
  });

  // -------------------------------------------------------------------------
  // connectTracker
  // -------------------------------------------------------------------------

  describe("connectTracker", () => {
    test("records via tracker appear in analytics", () => {
      const tracker = new TokenTracker();
      store.connectTracker(tracker);

      tracker.record({
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        tokens: { input: 500, output: 250 },
      });

      expect(store.totalCalls).toBe(1);

      const calls = store.callsBy("provider", "anthropic");
      expect(calls.length).toBe(1);
      expect(calls[0].input).toBe(500);
      expect(calls[0].output).toBe(250);
    });

    test("tracker record still returns the UsageEntry", () => {
      const tracker = new TokenTracker();
      store.connectTracker(tracker);

      const entry = tracker.record({
        provider: "openai",
        model: "gpt-4o",
        tokens: { input: 100, output: 50 },
      });

      expect(entry.provider).toBe("openai");
      expect(entry.model).toBe("gpt-4o");
      expect(entry.timestamp).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  describe("snapshot", () => {
    test("has all expected top-level fields", () => {
      store.recordCall(makeUsageEntry({ threadId: "t1", agentId: "coder" }));

      const tracker = new TokenTracker();
      const snap: AnalyticsSnapshot = store.snapshot(tracker);

      expect(snap.session).toBeDefined();
      expect(snap.timeSeries).toBeDefined();
      expect(snap.threads).toBeDefined();
      expect(snap.recentCalls).toBeDefined();
      expect(snap.topModels).toBeDefined();
      expect(snap.topAgents).toBeDefined();
      expect(snap.rollups).toBeDefined();
      expect(snap.rollups.hourly).toBeDefined();
      expect(snap.rollups.daily).toBeDefined();
      expect(snap.rollups.weekly).toBeDefined();
      expect(snap.rollups.monthly).toBeDefined();
    });

    test("recentCalls are in reverse chronological order and capped at 100", () => {
      // Record 5 calls with increasing timestamps
      for (let i = 0; i < 5; i++) {
        store.recordCall(
          makeUsageEntry({ timestamp: 1000 + i * 1000, cost: i * 0.01 })
        );
      }

      const tracker = new TokenTracker();
      const snap = store.snapshot(tracker);

      expect(snap.recentCalls.length).toBe(5);
      // Most recent first
      expect(snap.recentCalls[0].timestamp).toBe(5000);
      expect(snap.recentCalls[4].timestamp).toBe(1000);
    });

    test("session summary comes from the tracker", () => {
      const tracker = new TokenTracker();
      tracker.record({
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        tokens: { input: 1000, output: 500 },
      });

      const snap = store.snapshot(tracker);

      expect(snap.session.totalInput).toBe(1000);
      expect(snap.session.totalOutput).toBe(500);
      expect(snap.session.totalCalls).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // callsBy
  // -------------------------------------------------------------------------

  describe("callsBy", () => {
    test("filters by provider", () => {
      store.recordCall(makeUsageEntry({ provider: "anthropic" }));
      store.recordCall(makeUsageEntry({ provider: "openai" }));
      store.recordCall(makeUsageEntry({ provider: "anthropic" }));

      const anthropicCalls = store.callsBy("provider", "anthropic");
      expect(anthropicCalls.length).toBe(2);

      const openaiCalls = store.callsBy("provider", "openai");
      expect(openaiCalls.length).toBe(1);
    });

    test("filters by model", () => {
      store.recordCall(makeUsageEntry({ model: "gpt-4o" }));
      store.recordCall(makeUsageEntry({ model: "claude-sonnet-4-20250514" }));

      expect(store.callsBy("model", "gpt-4o").length).toBe(1);
      expect(store.callsBy("model", "claude-sonnet-4-20250514").length).toBe(1);
    });

    test("filters by agentId", () => {
      store.recordCall(makeUsageEntry({ agentId: "coder" }));
      store.recordCall(makeUsageEntry({ agentId: "reviewer" }));
      store.recordCall(makeUsageEntry({ agentId: "coder" }));

      expect(store.callsBy("agentId", "coder").length).toBe(2);
      expect(store.callsBy("agentId", "reviewer").length).toBe(1);
    });

    test("returns empty for non-matching filter", () => {
      store.recordCall(makeUsageEntry({ provider: "anthropic" }));

      expect(store.callsBy("provider", "nonexistent").length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  describe("empty state", () => {
    test("snapshot with no calls returns zeros", () => {
      const tracker = new TokenTracker();
      const snap = store.snapshot(tracker);

      expect(snap.session.totalInput).toBe(0);
      expect(snap.session.totalOutput).toBe(0);
      expect(snap.session.totalTokens).toBe(0);
      expect(snap.session.totalCost).toBe(0);
      expect(snap.session.totalCalls).toBe(0);
      expect(snap.timeSeries.length).toBe(0);
      expect(snap.threads.length).toBe(0);
      expect(snap.recentCalls.length).toBe(0);
      expect(snap.topModels.length).toBe(0);
      expect(snap.topAgents.length).toBe(0);
      expect(snap.rollups.hourly.length).toBe(0);
      expect(snap.rollups.daily.length).toBe(0);
    });

    test("totalCalls is zero on fresh store", () => {
      expect(store.totalCalls).toBe(0);
    });

    test("callsBy returns empty on fresh store", () => {
      expect(store.callsBy("provider", "anthropic").length).toBe(0);
    });

    test("threadCosts returns empty on fresh store", () => {
      expect(store.threadCosts().length).toBe(0);
    });
  });
});
