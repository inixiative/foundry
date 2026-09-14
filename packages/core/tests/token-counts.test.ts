import { describe, expect, test } from "bun:test";
import { sumTokenCounts, totalTokenCount } from "../src/token-counts";
import { BudgetExceededError, TokenTracker } from "../src/token-tracker";

const tokens = { input: 10, output: 20, cacheRead: 1000, cacheWrite: 200,
  cacheWrite5m: 50, cacheWrite1h: 150, thinking: 12,
  providerUsage: { service_tier: "standard", future_tag: true } };

describe("cache-aware token accounting", () => {
  test("adds disjoint input categories once and keeps unknown counters absent", () => {
    expect(totalTokenCount(tokens)).toBe(1230);
    expect(sumTokenCounts([{ input: 1, output: 2 }])).not.toHaveProperty("cacheRead");
    expect(sumTokenCounts([{ input: 1, output: 2, cacheRead: 0 }])).toHaveProperty("cacheRead", 0);
    expect(sumTokenCounts([tokens, tokens])).toEqual({ input: 20, output: 40,
      cacheRead: 2000, cacheWrite: 400, cacheWrite5m: 100, cacheWrite1h: 300, thinking: 24 });
  });

  test("preserves tags on records and exposes counters across every grouping", () => {
    const tracker = new TokenTracker();
    for (let i = 0; i < 2; i++) tracker.record({ provider: "claude-code", model: "test-model", agentId: "worker", threadId: "thread", tokens });
    expect(tracker.recent()[0].tokens.providerUsage).toEqual(tokens.providerUsage);
    expect(tracker.totalTokens.total).toBe(2460);
    expect(tracker.totalTokens.thinking).toBe(24);
    const summary = tracker.summary();
    expect(summary.tokens.cacheRead).toBe(2000);
    expect(summary.totalTokens).toBe(2460);
    for (const group of [summary.byProvider, summary.byModel, summary.byAgent, summary.byThread]) {
      expect(group[0]).toMatchObject({ input: 20, output: 40, cacheRead: 2000, cacheWrite: 400, total: 2460, calls: 2 });
    }
  });

  test("a cache-heavy call crosses the cumulative token budget", () => {
    const tracker = new TokenTracker({ budget: { maxTokens: 1200 } });
    expect(() => tracker.record({ provider: "claude-code", model: "test-model", tokens })).toThrow(BudgetExceededError);
    expect(tracker.budgetStatus.usedTokens).toBe(1230);
    expect(tracker.recent()).toHaveLength(1);
  });
});
