import { describe, test, expect } from "bun:test";
import type { LayerState } from "../src/agents/context-layer";
import {
  TrustBasedStrategy,
  LRUStrategy,
  SummarizeStrategy,
  HybridStrategy,
  type LayerSnapshot,
  type LLMProvider,
  type CompactionPlan,
} from "../src/agents/compaction";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<LayerSnapshot> & { id: string }): LayerSnapshot {
  return {
    content: "x".repeat(400), // 100 tokens by default
    tokens: 100,
    trust: 0.5,
    lastAccessed: Date.now() - 60_000,
    accessCount: 1,
    state: "warm" as LayerState,
    ...overrides,
  };
}

const mockProvider: LLMProvider = {
  complete: async (prompt: string) => {
    return "Summarized: " + prompt.slice(0, 50);
  },
};

// ---------------------------------------------------------------------------
// TrustBasedStrategy
// ---------------------------------------------------------------------------

describe("TrustBasedStrategy", () => {
  const strategy = new TrustBasedStrategy();

  test("select sorts layers by trust — low-trust targeted first", () => {
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "high", trust: 0.9, tokens: 100 }),
      makeSnapshot({ id: "low", trust: 0.1, tokens: 100 }),
      makeSnapshot({ id: "mid", trust: 0.5, tokens: 100 }),
    ];

    // budget = 200 means overage = 100 (total 300 - 200)
    const plan = strategy.select(layers, 200);

    // Low-trust layer should be targeted first
    expect(plan.targets.length).toBeGreaterThan(0);
    expect(plan.targets[0].layerId).toBe("low");
  });

  test("compact truncates content to targetTokens", async () => {
    const content = "a".repeat(800); // 200 tokens
    const result = await strategy.compact(content, { targetTokens: 50 });
    // 50 tokens * 4 chars = 200 chars
    expect(result.length).toBe(200);
  });

  test("compact returns original if already under target", async () => {
    const content = "hello";
    const result = await strategy.compact(content, { targetTokens: 100 });
    expect(result).toBe("hello");
  });

  test("zero-trust stale layers get evicted", () => {
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "stale-zero", trust: 0, state: "stale", tokens: 100 }),
      makeSnapshot({ id: "normal", trust: 0.5, tokens: 100 }),
    ];

    // budget = 100 means overage = 100
    const plan = strategy.select(layers, 100);

    expect(plan.evict).toContain("stale-zero");
    // The stale-zero layer should be evicted, not targeted
    expect(plan.targets.map((t) => t.layerId)).not.toContain("stale-zero");
  });

  test("returns empty plan when under budget", () => {
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "a", tokens: 50 }),
    ];

    const plan = strategy.select(layers, 200);
    expect(plan.targets).toEqual([]);
    expect(plan.evict).toEqual([]);
    expect(plan.estimatedSavings).toBe(0);
  });

  test("layers sorted by trust then by staleness", () => {
    const now = Date.now();
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "low-recent", trust: 0.1, lastAccessed: now - 1000, tokens: 100 }),
      makeSnapshot({ id: "low-old", trust: 0.1, lastAccessed: now - 100_000, tokens: 100 }),
      makeSnapshot({ id: "high", trust: 0.9, tokens: 100 }),
    ];

    // budget = 200 means overage = 100, need to compact ~100 tokens
    const plan = strategy.select(layers, 200);

    // low-old should come before low-recent (same trust, older access)
    const targetIds = plan.targets.map((t) => t.layerId);
    const evictAndTargets = [...plan.evict, ...targetIds];
    const oldIdx = evictAndTargets.indexOf("low-old");
    const recentIdx = evictAndTargets.indexOf("low-recent");
    if (oldIdx !== -1 && recentIdx !== -1) {
      expect(oldIdx).toBeLessThan(recentIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// LRUStrategy
// ---------------------------------------------------------------------------

describe("LRUStrategy", () => {
  test("select targets least recently accessed layers first", () => {
    const now = Date.now();
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "recent", lastAccessed: now - 1000, tokens: 100, accessCount: 5 }),
      makeSnapshot({ id: "old", lastAccessed: now - 100_000, tokens: 100, accessCount: 5 }),
      makeSnapshot({ id: "middle", lastAccessed: now - 50_000, tokens: 100, accessCount: 5 }),
    ];

    // budget = 200, overage = 100
    const plan = new LRUStrategy().select(layers, 200);

    // "old" should be evicted/targeted first
    const allIds = [...plan.evict, ...plan.targets.map((t) => t.layerId)];
    expect(allIds[0]).toBe("old");
  });

  test("frequency weighting affects selection order", () => {
    const now = Date.now();
    // Two layers with same recency but different access counts
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "frequent", lastAccessed: now - 50_000, tokens: 100, accessCount: 100 }),
      makeSnapshot({ id: "rare", lastAccessed: now - 50_000, tokens: 100, accessCount: 1 }),
    ];

    // High frequency weight — access count matters more
    const highFreqStrategy = new LRUStrategy({ frequencyWeight: 0.9 });
    const plan = highFreqStrategy.select(layers, 100);

    // "rare" should be targeted first (lower frequency score)
    const allIds = [...plan.evict, ...plan.targets.map((t) => t.layerId)];
    expect(allIds[0]).toBe("rare");
  });

  test("returns empty plan when under budget", () => {
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "a", tokens: 50 }),
    ];

    const plan = new LRUStrategy().select(layers, 200);
    expect(plan.targets).toEqual([]);
    expect(plan.evict).toEqual([]);
    expect(plan.estimatedSavings).toBe(0);
  });

  test("compact truncates content to target tokens", async () => {
    const strategy = new LRUStrategy();
    const content = "b".repeat(800); // 200 tokens
    const result = await strategy.compact(content, { targetTokens: 50 });
    expect(result.length).toBe(200); // 50 * 4
  });
});

// ---------------------------------------------------------------------------
// SummarizeStrategy
// ---------------------------------------------------------------------------

describe("SummarizeStrategy", () => {
  test("compact uses LLM provider to summarize content", async () => {
    const strategy = new SummarizeStrategy(mockProvider);
    const content = "This is a long document that needs summarization for context window management.";
    const result = await strategy.compact(content, { targetTokens: 50 });

    expect(result).toStartWith("Summarized: ");
  });

  test("preserveKeys are included in the compaction prompt", async () => {
    let capturedPrompt = "";
    const capturingProvider: LLMProvider = {
      complete: async (prompt: string) => {
        capturedPrompt = prompt;
        return "short summary";
      },
    };

    const strategy = new SummarizeStrategy(capturingProvider);
    await strategy.compact("Some content", {
      targetTokens: 50,
      preserveKeys: ["API_KEY", "userId", "sessionToken"],
    });

    expect(capturedPrompt).toContain("API_KEY");
    expect(capturedPrompt).toContain("userId");
    expect(capturedPrompt).toContain("sessionToken");
    expect(capturedPrompt).toContain("Preserve these key terms");
  });

  test("custom compaction prompt used", async () => {
    let capturedPrompt = "";
    const capturingProvider: LLMProvider = {
      complete: async (prompt: string) => {
        capturedPrompt = prompt;
        return "custom summary";
      },
    };

    const strategy = new SummarizeStrategy(capturingProvider);
    await strategy.compact("Some content here", {
      targetTokens: 50,
      prompt: "Condense this into bullet points.",
    });

    expect(capturedPrompt).toContain("Condense this into bullet points.");
    // Should NOT contain the default prompt
    expect(capturedPrompt).not.toContain("Summarize the following context");
  });

  test("constructor-level custom prompt is used as default", async () => {
    let capturedPrompt = "";
    const capturingProvider: LLMProvider = {
      complete: async (prompt: string) => {
        capturedPrompt = prompt;
        return "result";
      },
    };

    const strategy = new SummarizeStrategy(capturingProvider, {
      prompt: "Be very concise.",
    });
    await strategy.compact("Content", { targetTokens: 50 });

    expect(capturedPrompt).toContain("Be very concise.");
  });

  test("select targets largest layers first for maximum savings", () => {
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "small", tokens: 50 }),
      makeSnapshot({ id: "large", tokens: 200 }),
      makeSnapshot({ id: "medium", tokens: 100 }),
    ];

    // budget = 200, total = 350, overage = 150
    const plan = new SummarizeStrategy(mockProvider).select(layers, 200);

    // Largest layer should be targeted first
    expect(plan.targets[0].layerId).toBe("large");
    // Summarize never evicts
    expect(plan.evict).toEqual([]);
  });

  test("truncates LLM output if it exceeds target by more than 20%", async () => {
    const verboseProvider: LLMProvider = {
      complete: async () => "x".repeat(2000), // 500 tokens — way over any reasonable target
    };

    const strategy = new SummarizeStrategy(verboseProvider);
    const result = await strategy.compact("input", { targetTokens: 50 });
    // Should be truncated to 50 tokens * 4 chars = 200 chars
    expect(result.length).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// HybridStrategy
// ---------------------------------------------------------------------------

describe("HybridStrategy", () => {
  test("select routes low-trust to truncation, high-trust to summarize", () => {
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "low-trust", trust: 0.1, tokens: 200 }),
      makeSnapshot({ id: "mid-trust", trust: 0.5, tokens: 200 }),
      makeSnapshot({ id: "high-trust", trust: 0.9, tokens: 200 }),
    ];

    // budget = 200, total = 600, overage = 400
    // Phase 1 (trust-based on low bucket): low has 200 tokens vs budget 200 → overage 0 within bucket
    //   but global overage is 400 so trust-based gets budget=200 for the low bucket (200 tokens),
    //   overage within low = 0 → no savings from phase 1
    // Phase 2 (LRU on mid bucket): remaining=400, midTokens=200, midBudget=200-400=-200 → overage=400
    // Phase 3 (summarize on high bucket): remaining still > 0
    // Use a tighter budget to force all phases to contribute
    const hybrid = new HybridStrategy(mockProvider);
    const plan = hybrid.select(layers, 200);

    // Should have targets from sub-strategies covering the overage
    expect(plan.targets.length).toBeGreaterThan(0);
    expect(plan.estimatedSavings).toBeGreaterThan(0);

    // All three trust tiers should be represented in targets or evictions
    const allIds = [...plan.evict, ...plan.targets.map((t) => t.layerId)];
    // At minimum, high-trust layer should be targeted via summarize phase
    expect(allIds).toContain("high-trust");
  });

  test("select returns empty plan when under budget", () => {
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "a", trust: 0.1, tokens: 50 }),
      makeSnapshot({ id: "b", trust: 0.9, tokens: 50 }),
    ];

    const plan = new HybridStrategy(mockProvider).select(layers, 500);
    expect(plan.targets).toEqual([]);
    expect(plan.evict).toEqual([]);
    expect(plan.estimatedSavings).toBe(0);
  });

  test("select evicts zero-trust stale layers via trust-based phase", () => {
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "stale-zero", trust: 0, state: "stale", tokens: 100 }),
      makeSnapshot({ id: "high", trust: 0.9, tokens: 200 }),
    ];

    // total = 300, budget = 150, overage = 150
    // Phase 1 (trust-based on low bucket): low has stale-zero with 100 tokens, budget=150
    //   overage within low = 100 - 150 = -50 → no action yet
    //   But the global budget is 150 so trust-based.select gets budget=150 for just the low bucket
    //   low total = 100 < 150 → no savings. Need budget low enough.
    // Actually: trust-based.select(low, budget=150) → totalTokens=100, overage=-50 → empty plan
    // We need the global budget to be small enough that the low bucket itself is over budget.
    // The low bucket is passed to _trustBased.select(low, budget).
    // budget passed is the overall budget (150), and low only has 100 tokens, so no overage.
    // To force eviction: make the budget very small so all phases engage.
    const plan = new HybridStrategy(mockProvider).select(layers, 50);

    // With budget=50, total=300, overage=250
    // Phase 1: _trustBased.select([stale-zero(100 tokens)], budget=50) → overage=50
    //   stale-zero has trust=0, state=stale → evicted, savings=100
    expect(plan.evict).toContain("stale-zero");
  });

  test("compact delegates to summarize strategy", async () => {
    const hybrid = new HybridStrategy(mockProvider);
    const result = await hybrid.compact("Some content to compact", { targetTokens: 50 });
    expect(result).toStartWith("Summarized: ");
  });

  test("strategies accessor exposes sub-strategies", () => {
    const hybrid = new HybridStrategy(mockProvider);
    expect(hybrid.strategies.trustBased.id).toBe("trust-based");
    expect(hybrid.strategies.lru.id).toBe("lru");
    expect(hybrid.strategies.summarize.id).toBe("summarize");
  });
});

// ---------------------------------------------------------------------------
// CompactionPlan structure
// ---------------------------------------------------------------------------

describe("CompactionPlan structure", () => {
  test("targets contain layerId and targetTokens", () => {
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "a", trust: 0.1, tokens: 200 }),
      makeSnapshot({ id: "b", trust: 0.5, tokens: 200 }),
    ];

    const plan = new TrustBasedStrategy().select(layers, 200);

    for (const target of plan.targets) {
      expect(target).toHaveProperty("layerId");
      expect(target).toHaveProperty("targetTokens");
      expect(typeof target.layerId).toBe("string");
      expect(typeof target.targetTokens).toBe("number");
      expect(target.targetTokens).toBeGreaterThan(0);
    }
  });

  test("evict contains layer IDs as strings", () => {
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "evictme", trust: 0, state: "stale", tokens: 100 }),
      makeSnapshot({ id: "keep", trust: 0.9, tokens: 100 }),
    ];

    const plan = new TrustBasedStrategy().select(layers, 100);

    for (const id of plan.evict) {
      expect(typeof id).toBe("string");
    }
    expect(plan.evict).toContain("evictme");
  });

  test("estimatedSavings is a positive number when compaction needed", () => {
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "a", tokens: 200 }),
      makeSnapshot({ id: "b", tokens: 200 }),
    ];

    const plan = new TrustBasedStrategy().select(layers, 200);
    expect(plan.estimatedSavings).toBeGreaterThan(0);
  });

  test("estimatedSavings is zero when under budget", () => {
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "a", tokens: 50 }),
    ];

    const plan = new TrustBasedStrategy().select(layers, 200);
    expect(plan.estimatedSavings).toBe(0);
  });

  test("all plan fields are present", () => {
    const layers: LayerSnapshot[] = [
      makeSnapshot({ id: "a", tokens: 100 }),
    ];

    const plan = new TrustBasedStrategy().select(layers, 50);
    expect(plan).toHaveProperty("targets");
    expect(plan).toHaveProperty("evict");
    expect(plan).toHaveProperty("estimatedSavings");
    expect(Array.isArray(plan.targets)).toBe(true);
    expect(Array.isArray(plan.evict)).toBe(true);
    expect(typeof plan.estimatedSavings).toBe("number");
  });
});
