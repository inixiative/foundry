import { describe, test, expect, mock } from "bun:test";
import type { LLMProvider, CompletionResult, LLMMessage, CompletionOpts } from "@inixiative/foundry-core";
import {
  BUILTIN_FIXTURES,
  getAllFixtures,
  modelSweep,
  temperatureSweep,
  oneAtATime,
  applyVariation,
  Judge,
  ExperimentRunner,
  generateMarkdown,
  DEFAULT_EXPERIMENT_CONFIG,
} from "../src/research";
import type { ConfigVariation } from "../src/research";
import { defaultConfig } from "../src/viewer/config";

// ---------------------------------------------------------------------------
// Mock provider — returns canned responses based on agent role
// ---------------------------------------------------------------------------

function mockProvider(id = "mock"): LLMProvider {
  return {
    id,
    async complete(messages: LLMMessage[], opts?: CompletionOpts): Promise<CompletionResult> {
      const systemMsg = messages.find((m) => m.role === "system")?.content || "";
      const userMsg = messages.find((m) => m.role === "user")?.content || "";

      // Classifier response
      if (systemMsg.includes("Classify") || systemMsg.includes("classify")) {
        const category = userMsg.toLowerCase().includes("bug") ? "bug"
          : userMsg.toLowerCase().includes("feature") || userMsg.toLowerCase().includes("add") ? "feature"
          : userMsg.toLowerCase().includes("how") || userMsg.toLowerCase().includes("what") ? "question"
          : "general";
        return {
          content: JSON.stringify({ category, reasoning: "mock classify" }),
          model: opts?.model || "mock-model",
          tokens: { input: 100, output: 20 },
        };
      }

      // Router response
      if (systemMsg.includes("Route") || systemMsg.includes("route")) {
        const destination = userMsg.includes('"bug"') ? "executor-fix"
          : userMsg.includes('"feature"') ? "executor-build"
          : "executor-answer";
        return {
          content: JSON.stringify({ destination, contextSlice: ["system"], priority: 5, reasoning: "mock route" }),
          model: opts?.model || "mock-model",
          tokens: { input: 150, output: 30 },
        };
      }

      // Judge response
      if (systemMsg.includes("judge") || systemMsg.includes("Judge")) {
        return {
          content: JSON.stringify({ score: 7, reasoning: "Mock judge: adequate response" }),
          model: opts?.model || "mock-model",
          tokens: { input: 200, output: 30 },
        };
      }

      // Executor response (default)
      return {
        content: `Mock response to: ${userMsg.slice(0, 50)}...`,
        model: opts?.model || "mock-model",
        tokens: { input: 200, output: 100 },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures tests
// ---------------------------------------------------------------------------

describe("fixtures", () => {
  test("BUILTIN_FIXTURES has 10 fixtures", () => {
    expect(BUILTIN_FIXTURES.length).toBe(10);
  });

  test("all fixtures have required fields", () => {
    for (const f of BUILTIN_FIXTURES) {
      expect(f.id).toBeTruthy();
      expect(f.input).toBeTruthy();
      expect(f.expectedCategory).toBeTruthy();
      expect(f.expectedRoute).toBeTruthy();
      expect(f.qualityRubric).toBeTruthy();
    }
  });

  test("fixture IDs are unique", () => {
    const ids = BUILTIN_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("getAllFixtures returns built-in fixtures when no custom dir", () => {
    const fixtures = getAllFixtures();
    expect(fixtures.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Config generation tests
// ---------------------------------------------------------------------------

describe("config-gen", () => {
  const config = defaultConfig();
  // Add some agents for testing
  config.agents = {
    classifier: { id: "classifier", kind: "classifier", prompt: "Classify.", provider: "anthropic", model: "claude-haiku-4-5-20251001", temperature: 0, maxTokens: 256, visibleLayers: ["system"], peers: [], maxDepth: 1, enabled: true },
    router: { id: "router", kind: "router", prompt: "Route.", provider: "anthropic", model: "claude-haiku-4-5-20251001", temperature: 0, maxTokens: 256, visibleLayers: ["system"], peers: [], maxDepth: 1, enabled: true },
    "executor-fix": { id: "executor-fix", kind: "executor", prompt: "Fix bugs.", provider: "anthropic", model: "claude-sonnet-4-6-20250627", temperature: 0, maxTokens: 4096, visibleLayers: [], peers: [], maxDepth: 3, enabled: true },
    "executor-build": { id: "executor-build", kind: "executor", prompt: "Build features.", provider: "anthropic", model: "claude-sonnet-4-6-20250627", temperature: 0, maxTokens: 4096, visibleLayers: [], peers: [], maxDepth: 3, enabled: true },
    "executor-answer": { id: "executor-answer", kind: "executor", prompt: "Answer questions.", provider: "anthropic", model: "claude-sonnet-4-6-20250627", temperature: 0, maxTokens: 4096, visibleLayers: [], peers: [], maxDepth: 3, enabled: true },
  };

  test("oneAtATime generates correct number of variations", () => {
    const vars = oneAtATime("classifier", "model", ["haiku", "sonnet", "opus"]);
    expect(vars.length).toBe(3);
    expect(vars[0].id).toBe("classifier-model-haiku");
    expect(vars[0].agentOverrides.classifier.model).toBe("haiku");
  });

  test("modelSweep generates baseline + per-agent variations", () => {
    const vars = modelSweep(config);
    expect(vars.length).toBeGreaterThan(1);
    // Should include baseline
    expect(vars.find((v) => v.id === "baseline")).toBeTruthy();
    // Should include classifier variations
    expect(vars.filter((v) => v.id.startsWith("classifier-")).length).toBeGreaterThan(0);
    // Should include executor variations
    expect(vars.filter((v) => v.id.startsWith("executor-")).length).toBeGreaterThan(0);
  });

  test("temperatureSweep generates variations for each agent", () => {
    const winners = {
      classifier: { model: "claude-haiku-4-5-20251001" },
      "executor-fix": { model: "claude-sonnet-4-6-20250627" },
    };
    const vars = temperatureSweep(config, winners);
    expect(vars.length).toBeGreaterThan(0);
    // Should have temperature variations
    expect(vars.some((v) => v.id.includes("temp-0"))).toBe(true);
    expect(vars.some((v) => v.id.includes("temp-0.3"))).toBe(true);
  });

  test("applyVariation clones config and applies overrides", () => {
    const variation: ConfigVariation = {
      id: "test",
      description: "Test variation",
      agentOverrides: {
        classifier: { model: "new-model", temperature: 0.5 },
      },
    };

    const result = applyVariation(config, variation);

    // Should have the override
    expect(result.agents.classifier.model).toBe("new-model");
    expect(result.agents.classifier.temperature).toBe(0.5);

    // Original should be unchanged
    expect(config.agents.classifier.model).toBe("claude-haiku-4-5-20251001");
    expect(config.agents.classifier.temperature).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Judge tests
// ---------------------------------------------------------------------------

describe("judge", () => {
  test("scores output against rubric", async () => {
    const judge = new Judge({ provider: mockProvider() });
    const result = await judge.score(
      "Fix the auth bug",
      "The auth bug is caused by...",
      "Should identify root cause",
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(10);
    expect(result.reasoning).toBeTruthy();
  });

  test("handles provider errors gracefully", async () => {
    const errorProvider: LLMProvider = {
      id: "error",
      async complete() { throw new Error("API down"); },
    };
    const judge = new Judge({ provider: errorProvider });
    const result = await judge.score("input", "output", "rubric");
    expect(result.score).toBe(0);
    expect(result.reasoning).toContain("API down");
  });
});

// ---------------------------------------------------------------------------
// Runner tests (with mock provider)
// ---------------------------------------------------------------------------

describe("runner", () => {
  test("runs experiment with mock provider", async () => {
    const config = defaultConfig();
    config.agents = {
      classifier: { id: "classifier", kind: "classifier", prompt: "Classify.", provider: "mock", model: "mock", temperature: 0, maxTokens: 256, visibleLayers: ["system"], peers: [], maxDepth: 1, enabled: true },
      router: { id: "router", kind: "router", prompt: "Route.", provider: "mock", model: "mock", temperature: 0, maxTokens: 256, visibleLayers: ["system"], peers: [], maxDepth: 1, enabled: true },
      "executor-answer": { id: "executor-answer", kind: "executor", prompt: "Answer.", provider: "mock", model: "mock", temperature: 0, maxTokens: 4096, visibleLayers: [], peers: [], maxDepth: 3, enabled: true },
    };
    config.layers = {
      system: { id: "system", prompt: "System.", sourceIds: ["system-prompt"], trust: 1, staleness: 0, maxTokens: 2000, enabled: true },
    };
    config.sources = {
      "system-prompt": { id: "system-prompt", type: "inline", label: "System", uri: "You are helpful.", enabled: true },
    };

    const provider = mockProvider();
    const inlineSource = (id: string) => ({
      id,
      load: async () => "test source content",
    });

    const runner = new ExperimentRunner({
      baseConfig: config,
      providerFactory: () => provider,
      judgeProvider: provider,
      experimentConfig: { repetitions: 1, delayMs: 0 },
      sourceResolver: (sourceId) => inlineSource(sourceId),
    });

    const variations: ConfigVariation[] = [
      { id: "baseline", description: "Baseline", agentOverrides: {} },
    ];

    // Use just 2 fixtures for speed
    const fixtures = BUILTIN_FIXTURES.slice(0, 2);

    const report = await runner.run(variations, fixtures);

    expect(report.id).toBeTruthy();
    expect(report.configs.length).toBe(1);
    expect(report.configs[0].fixtures.length).toBe(2);
    expect(report.ranking.length).toBe(1);
    expect(report.ranking[0].rank).toBe(1);
    expect(report.durationMs).toBeGreaterThan(0);
  }, 30_000); // 30s timeout for LLM calls
});

// ---------------------------------------------------------------------------
// Report tests
// ---------------------------------------------------------------------------

describe("report", () => {
  test("generateMarkdown produces valid markdown", () => {
    const report = {
      id: "exp_test",
      startedAt: Date.now() - 60000,
      completedAt: Date.now(),
      durationMs: 60000,
      baseConfig: defaultConfig(),
      fixtures: BUILTIN_FIXTURES.slice(0, 2),
      configs: [
        {
          configId: "baseline",
          description: "Baseline config",
          fixtures: [
            {
              fixtureId: "bug-token-refresh",
              configId: "baseline",
              runs: [],
              classificationAccuracy: 1.0,
              routeAccuracy: 1.0,
              qualityMean: 7.5,
              qualityStdDev: 0.5,
              latencyP50: 2000,
              latencyP95: 3000,
              totalTokens: 1000,
              totalCost: 0.01,
            },
          ],
          overallClassificationAccuracy: 1.0,
          overallRouteAccuracy: 1.0,
          overallQualityMean: 7.5,
          overallLatencyP50: 2000,
          overallLatencyP95: 3000,
          totalTokens: 1000,
          totalCost: 0.01,
          compositeScore: 0.85,
        },
      ],
      ranking: [{ configId: "baseline", compositeScore: 0.85, rank: 1 }],
      weights: DEFAULT_EXPERIMENT_CONFIG.weights,
      totalCost: 0.01,
      totalTokens: 1000,
    };

    const md = generateMarkdown(report);
    expect(md).toContain("# Experiment Report");
    expect(md).toContain("Rankings");
    expect(md).toContain("Recommended Config");
    expect(md).toContain("Baseline config");
    expect(md).toContain("7.5/10");
  });
});
