import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  DiffScorer,
  LLMScorer,
  analyzeDiffs,
  parseDiffFiles,
  countDiffLines,
} from "../src/scorer";
import { FixtureRunner } from "../src/runner";
import { EvalStore } from "../src/store";
import { ContextStack, ContextLayer } from "@inixiative/foundry-core";
import type { PRFixture, RubricScores } from "../src/types";
import type { BatchResult, RunResult } from "../src/runner";
import type { LLMProvider, CompletionResult, LLMMessage, CompletionOpts } from "@inixiative/foundry-core";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const GOLDEN_DIFF = `diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,5 +1,10 @@
+import { validate } from './validator';
+
 export function processInput(input: string): string {
-  return input.trim();
+  const cleaned = input.trim();
+  if (!validate(cleaned)) {
+    throw new Error('Invalid input');
+  }
+  return cleaned;
 }
diff --git a/src/validator.ts b/src/validator.ts
new file mode 100644
--- /dev/null
+++ b/src/validator.ts
@@ -0,0 +1,5 @@
+export function validate(input: string): boolean {
+  if (input.length === 0) return false;
+  if (input.length > 1000) return false;
+  return true;
+}`;

const AGENT_PERFECT_DIFF = GOLDEN_DIFF; // Exact match

const AGENT_PARTIAL_DIFF = `diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,5 +1,7 @@
+import { validate } from './validator';
+
 export function processInput(input: string): string {
-  return input.trim();
+  const cleaned = input.trim();
+  return cleaned;
 }`;

const AGENT_WRONG_FILES = `diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,4 @@
+import { something } from './other';
 export function main() {
   console.log("hello");
 }`;

function makeFixture(overrides?: Partial<PRFixture>): PRFixture {
  return {
    id: "test/repo#1",
    pr: {
      owner: "test",
      repo: "repo",
      number: 1,
      title: "Add input validation",
      url: "https://github.com/test/repo/pull/1",
      mergedAt: "2026-01-01T00:00:00Z",
      mergeCommitSha: "abc123",
    },
    ticket: {
      number: 10,
      title: "Add input validation to processInput",
      body: "We need to validate input before processing. Add a validator module and throw on invalid input.",
      labels: ["enhancement"],
      url: "https://github.com/test/repo/issues/10",
    },
    baseSha: "def456",
    goldenDiff: GOLDEN_DIFF,
    files: [
      { path: "src/utils.ts", status: "modified" },
      { path: "src/validator.ts", status: "added" },
    ],
    meta: {
      filesChanged: 2,
      additions: 12,
      deletions: 1,
      labels: ["enhancement"],
      complexity: "small",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Diff analysis utilities
// ---------------------------------------------------------------------------

describe("parseDiffFiles", () => {
  test("extracts file paths from unified diff", () => {
    const files = parseDiffFiles(GOLDEN_DIFF);
    expect(files.has("src/utils.ts")).toBe(true);
    expect(files.has("src/validator.ts")).toBe(true);
  });

  test("handles empty diff", () => {
    expect(parseDiffFiles("")).toEqual(new Set());
  });
});

describe("countDiffLines", () => {
  test("counts additions and deletions", () => {
    const { additions, deletions } = countDiffLines(GOLDEN_DIFF);
    expect(additions).toBeGreaterThan(0);
    expect(deletions).toBeGreaterThan(0);
  });

  test("ignores --- and +++ headers", () => {
    const diff = "--- a/file.ts\n+++ b/file.ts\n+added line\n-removed line";
    const { additions, deletions } = countDiffLines(diff);
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
  });
});

describe("analyzeDiffs", () => {
  test("identifies file overlap between golden and agent", () => {
    const stats = analyzeDiffs(GOLDEN_DIFF, AGENT_PARTIAL_DIFF);
    expect(stats.filesOverlap.has("src/utils.ts")).toBe(true);
    expect(stats.filesMissed.has("src/validator.ts")).toBe(true);
    expect(stats.filesExtra.size).toBe(0);
  });

  test("identifies extra files in agent diff", () => {
    const stats = analyzeDiffs(GOLDEN_DIFF, AGENT_WRONG_FILES);
    expect(stats.filesExtra.has("src/main.ts")).toBe(true);
    expect(stats.filesMissed.has("src/utils.ts")).toBe(true);
    expect(stats.filesMissed.has("src/validator.ts")).toBe(true);
  });

  test("perfect match has full overlap", () => {
    const stats = analyzeDiffs(GOLDEN_DIFF, AGENT_PERFECT_DIFF);
    expect(stats.filesOverlap.size).toBe(stats.filesInGolden.size);
    expect(stats.filesMissed.size).toBe(0);
    expect(stats.filesExtra.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DiffScorer
// ---------------------------------------------------------------------------

describe("DiffScorer", () => {
  const scorer = new DiffScorer();

  test("perfect match scores high", async () => {
    const fixture = makeFixture();
    const { scores, composite } = await scorer.score(fixture, AGENT_PERFECT_DIFF);

    expect(scores.completion).toBe(100);
    expect(scores.correctness).toBe(100);
    expect(scores.precision).toBe(100);
    expect(composite).toBeGreaterThan(80);
  });

  test("partial match scores lower on completion", async () => {
    const fixture = makeFixture();
    const { scores } = await scorer.score(fixture, AGENT_PARTIAL_DIFF);

    // Only touched 1 of 2 golden files
    expect(scores.completion).toBe(50);
    expect(scores.correctness).toBeLessThan(100);
  });

  test("wrong files scores low on precision and completion", async () => {
    const fixture = makeFixture();
    const { scores } = await scorer.score(fixture, AGENT_WRONG_FILES);

    expect(scores.completion).toBe(0); // Missed all golden files
    expect(scores.precision).toBe(0); // No overlap
  });

  test("empty output scores zero", async () => {
    const fixture = makeFixture();
    const { scores, composite } = await scorer.score(fixture, "");

    expect(scores.craft).toBe(0);
    expect(composite).toBe(0);
  });

  test("debug statements penalize craft", async () => {
    const diffWithDebug = GOLDEN_DIFF + "\n+  console.log('debug');\n+  debugger;";
    const fixture = makeFixture();
    const { scores: scoresClean } = await scorer.score(fixture, GOLDEN_DIFF);
    const { scores: scoresDebug } = await scorer.score(fixture, diffWithDebug);

    expect(scoresDebug.craft).toBeLessThan(scoresClean.craft);
  });

  test("scores include context info when provided", async () => {
    const fixture = makeFixture();
    const { scores } = await scorer.score(fixture, GOLDEN_DIFF, {
      layerIds: ["conventions", "docs"],
      contextHash: "abc123",
    });

    expect(scores.efficiency).toBeGreaterThan(0);
  });

  test("composite is weighted average", async () => {
    const fixture = makeFixture();
    const { scores, composite } = await scorer.score(fixture, GOLDEN_DIFF);

    const expected = Math.round(
      scores.completion * 0.3 +
        scores.correctness * 0.3 +
        scores.craft * 0.15 +
        scores.efficiency * 0.1 +
        scores.precision * 0.15
    );

    expect(composite).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// FixtureRunner
// ---------------------------------------------------------------------------

describe("FixtureRunner", () => {
  function makeMockProvider(response: string): LLMProvider {
    return {
      id: "mock",
      async complete(messages: LLMMessage[], opts?: CompletionOpts): Promise<CompletionResult> {
        return {
          content: response,
          model: "mock-model",
          tokens: { input: 100, output: 50 },
          finishReason: "stop",
        };
      },
    };
  }

  function makeStack(): ContextStack {
    const layer = new ContextLayer({
      id: "conventions",
      prompt: "Follow these coding conventions.",
    });
    layer.set("Use TypeScript strict mode. Prefer const.");
    return new ContextStack([layer]);
  }

  test("runs a single fixture and returns scored result", async () => {
    const provider = makeMockProvider(GOLDEN_DIFF);
    const stack = makeStack();
    const scorer = new DiffScorer();

    const runner = new FixtureRunner({ provider, stack, scorer });
    const { run } = await runner.run(makeFixture());

    expect(run.fixtureId).toBe("test/repo#1");
    expect(run.runId).toBeTruthy();
    expect(run.composite).toBeGreaterThan(0);
    expect(run.scores.completion).toBeDefined();
    expect(run.tokens).toEqual({ input: 100, output: 50 });
    expect(run.layerIds).toContain("conventions");
    expect(run.contextHash).toBeTruthy();
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("runBatch produces summary", async () => {
    const provider = makeMockProvider(AGENT_PARTIAL_DIFF);
    const stack = makeStack();
    const scorer = new DiffScorer();

    const runner = new FixtureRunner({ provider, stack, scorer });
    const fixtures = [makeFixture(), makeFixture({ id: "test/repo#2" })];
    const { runs, summary } = await runner.runBatch(fixtures);

    expect(runs).toHaveLength(2);
    expect(summary.totalFixtures).toBe(2);
    expect(summary.averageComposite).toBeGreaterThan(0);
    expect(summary.bestRun).toBeTruthy();
    expect(summary.worstRun).toBeTruthy();
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("compare evaluates two stacks against same fixtures", async () => {
    const provider = makeMockProvider(AGENT_PARTIAL_DIFF);
    const scorer = new DiffScorer();

    const stack1 = makeStack();
    const stack2 = new ContextStack();
    const layer2 = new ContextLayer({ id: "better-docs" });
    layer2.set("More comprehensive docs");
    stack2.addLayer(layer2);

    const runner = new FixtureRunner({ provider, stack: stack1, scorer });
    const fixtures = [makeFixture()];

    const comparison = await runner.compare(fixtures, stack2);

    expect(comparison.current.runs).toHaveLength(1);
    expect(comparison.alternative.runs).toHaveLength(1);
    expect(["current", "alternative", "tie"]).toContain(comparison.winner);
    expect(typeof comparison.delta).toBe("number");
  });

  test("uses assembled context from stack", async () => {
    let capturedMessages: LLMMessage[] = [];

    const provider: LLMProvider = {
      id: "capture",
      async complete(messages) {
        capturedMessages = messages;
        return {
          content: GOLDEN_DIFF,
          model: "test",
          tokens: { input: 50, output: 50 },
        };
      },
    };

    const layer = new ContextLayer({
      id: "rules",
      prompt: "These are project rules.",
    });
    layer.set("Always validate input.");
    const stack = new ContextStack([layer]);

    const runner = new FixtureRunner({
      provider,
      stack,
      scorer: new DiffScorer(),
    });

    await runner.run(makeFixture());

    // System message should contain the layer content
    const systemMsg = capturedMessages.find((m) => m.role === "system");
    expect(systemMsg?.content).toContain("These are project rules.");
    expect(systemMsg?.content).toContain("Always validate input.");

    // User message should contain the ticket
    const userMsg = capturedMessages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("Add input validation");
    expect(userMsg?.content).toContain("src/utils.ts");
  });

  test("empty batch returns zero summary", async () => {
    const provider = makeMockProvider("");
    const stack = makeStack();
    const scorer = new DiffScorer();

    const runner = new FixtureRunner({ provider, stack, scorer });
    const { summary } = await runner.runBatch([]);

    expect(summary.totalFixtures).toBe(0);
    expect(summary.averageComposite).toBe(0);
    expect(summary.bestRun).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LLMScorer (mock provider)
// ---------------------------------------------------------------------------

describe("LLMScorer", () => {
  test("parses JSON scores from LLM response", async () => {
    const mockProvider: LLMProvider = {
      id: "mock",
      async complete() {
        return {
          content: '{"completion": 85, "correctness": 90, "craft": 75, "efficiency": 80, "precision": 70}',
          model: "test",
        };
      },
    };

    const scorer = new LLMScorer({ provider: mockProvider });
    const fixture = makeFixture();
    const { scores, composite } = await scorer.score(fixture, GOLDEN_DIFF);

    expect(scores.completion).toBe(85);
    expect(scores.correctness).toBe(90);
    expect(scores.craft).toBe(75);
    expect(scores.efficiency).toBe(80);
    expect(scores.precision).toBe(70);
    expect(composite).toBeGreaterThan(0);
  });

  test("handles LLM returning JSON in code block", async () => {
    const mockProvider: LLMProvider = {
      id: "mock",
      async complete() {
        return {
          content: '```json\n{"completion": 50, "correctness": 60, "craft": 70, "efficiency": 80, "precision": 90}\n```',
          model: "test",
        };
      },
    };

    const scorer = new LLMScorer({ provider: mockProvider });
    const { scores } = await scorer.score(makeFixture(), GOLDEN_DIFF);

    expect(scores.completion).toBe(50);
    expect(scores.correctness).toBe(60);
  });

  test("returns zero scores on unparseable response", async () => {
    const mockProvider: LLMProvider = {
      id: "mock",
      async complete() {
        return { content: "I cannot evaluate this.", model: "test" };
      },
    };

    const scorer = new LLMScorer({ provider: mockProvider });
    const { scores } = await scorer.score(makeFixture(), GOLDEN_DIFF);

    expect(scores.completion).toBe(0);
    expect(scores.correctness).toBe(0);
  });

  test("clamps scores to 0-100 range", async () => {
    const mockProvider: LLMProvider = {
      id: "mock",
      async complete() {
        return {
          content: '{"completion": 150, "correctness": -10, "craft": 75, "efficiency": 80, "precision": 70}',
          model: "test",
        };
      },
    };

    const scorer = new LLMScorer({ provider: mockProvider });
    const { scores } = await scorer.score(makeFixture(), GOLDEN_DIFF);

    expect(scores.completion).toBe(100);
    expect(scores.correctness).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EvalStore — persistent memory for eval runs
// ---------------------------------------------------------------------------

function makeBatchResult(
  composite: number,
  fixtureIds: string[] = ["test/repo#1"],
  overrides?: Partial<RunResult>
): BatchResult {
  const runs: RunResult[] = fixtureIds.map((fid) => ({
    run: {
      fixtureId: fid,
      runId: `run-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      agentOutput: GOLDEN_DIFF,
      goldenDiff: GOLDEN_DIFF,
      scores: {
        completion: composite,
        correctness: composite,
        craft: composite,
        efficiency: composite,
        precision: composite,
      },
      composite,
      tokens: { input: 500, output: 200 },
      durationMs: 100,
      layerIds: ["conventions"],
      contextHash: "abc123",
    },
    ...overrides,
  }));

  return {
    runs,
    summary: {
      totalFixtures: runs.length,
      averageComposite: composite,
      averageScores: {
        completion: composite,
        correctness: composite,
        craft: composite,
        efficiency: composite,
        precision: composite,
      },
      bestRun: { fixtureId: fixtureIds[0], composite },
      worstRun: { fixtureId: fixtureIds[fixtureIds.length - 1], composite },
      commonGaps: [],
      topSuggestions: [],
      durationMs: 100,
    },
  };
}

describe("EvalStore", () => {
  const TEST_DIR = join(import.meta.dir, ".eval-store-test");

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  test("save and retrieve a batch", async () => {
    const store = new EvalStore(TEST_DIR);
    const result = makeBatchResult(85);

    const batchId = await store.save(result, "baseline", "abc123");

    const stored = await store.get(batchId);
    expect(stored).not.toBeNull();
    expect(stored!.label).toBe("baseline");
    expect(stored!.contextVersion).toBe("abc123");
    expect(stored!.result.summary.averageComposite).toBe(85);
  });

  test("list returns batches sorted newest first", async () => {
    const store = new EvalStore(TEST_DIR);

    await store.save(makeBatchResult(80), "first");
    await Bun.sleep(5);
    await store.save(makeBatchResult(85), "second");
    await Bun.sleep(5);
    await store.save(makeBatchResult(90), "third");

    const list = await store.list();
    expect(list.length).toBe(3);
    expect(list[0].label).toBe("third");
    expect(list[2].label).toBe("first");
  });

  test("latest returns most recent batch", async () => {
    const store = new EvalStore(TEST_DIR);

    await store.save(makeBatchResult(80), "baseline");
    await Bun.sleep(5);
    await store.save(makeBatchResult(90), "baseline");
    await Bun.sleep(5);
    await store.save(makeBatchResult(75), "experiment");

    const latest = await store.latest("baseline");
    expect(latest).not.toBeNull();
    expect(latest!.result.summary.averageComposite).toBe(90);

    const latestAll = await store.latest();
    expect(latestAll).not.toBeNull();
    expect(latestAll!.label).toBe("experiment");
  });

  test("compare produces regression report", async () => {
    const store = new EvalStore(TEST_DIR);
    const fixtures = ["test/repo#1", "test/repo#2"];

    const baseId = await store.save(
      makeBatchResult(80, fixtures),
      "baseline"
    );
    const candId = await store.save(
      makeBatchResult(90, fixtures),
      "candidate"
    );

    const report = await store.compare(baseId, candId);
    expect(report).not.toBeNull();
    expect(report!.verdict).toBe("improved");
    expect(report!.delta.composite).toBe(10);
    expect(report!.improved.length).toBe(2);
    expect(report!.regressed.length).toBe(0);
  });

  test("compare returns neutral for small deltas", async () => {
    const store = new EvalStore(TEST_DIR);

    const baseId = await store.save(makeBatchResult(80), "baseline");
    const candId = await store.save(makeBatchResult(81), "candidate");

    const report = await store.compare(baseId, candId);
    expect(report!.verdict).toBe("neutral");
  });

  test("compare returns null for missing batch", async () => {
    const store = new EvalStore(TEST_DIR);
    const baseId = await store.save(makeBatchResult(80), "baseline");

    const report = await store.compare(baseId, "nonexistent");
    expect(report).toBeNull();
  });

  test("trends computes direction and slope", async () => {
    const store = new EvalStore(TEST_DIR);

    // Simulate improving scores over time
    await store.save(makeBatchResult(70), "run");
    await store.save(makeBatchResult(75), "run");
    await store.save(makeBatchResult(80), "run");
    await store.save(makeBatchResult(85), "run");

    const trends = await store.trends();
    expect(trends.length).toBe(6); // composite + 5 rubrics

    const compositeTrend = trends.find((t) => t.rubric === "composite");
    expect(compositeTrend).toBeDefined();
    expect(compositeTrend!.direction).toBe("improving");
    expect(compositeTrend!.slope).toBeGreaterThan(0);
    expect(compositeTrend!.points.length).toBe(4);
  });

  test("trends returns empty for insufficient data", async () => {
    const store = new EvalStore(TEST_DIR);
    await store.save(makeBatchResult(80), "run");

    const trends = await store.trends();
    expect(trends.length).toBe(0);
  });

  test("aggregateGaps collects gaps across batches", async () => {
    const store = new EvalStore(TEST_DIR);

    const withGaps = makeBatchResult(80);
    withGaps.runs[0] = {
      ...withGaps.runs[0],
      diagnosis: {
        runId: withGaps.runs[0].run.runId,
        fixtureId: withGaps.runs[0].run.fixtureId,
        strengths: ["good"],
        weaknesses: ["bad"],
        contextGaps: [
          {
            layerId: "conventions",
            missing: "error handling pattern",
            evidence: "golden diff uses try/catch",
          },
        ],
        suggestions: [],
      },
    };

    await store.save(withGaps, "run-1");
    await store.save(withGaps, "run-2");

    const gaps = await store.aggregateGaps();
    expect(gaps.length).toBe(1);
    expect(gaps[0].occurrences).toBe(2);
    expect(gaps[0].acrossBatches).toBe(2);
    expect(gaps[0].gap.missing).toBe("error handling pattern");
  });

  test("aggregateSuggestions collects suggestions across batches", async () => {
    const store = new EvalStore(TEST_DIR);

    const withSuggs = makeBatchResult(80);
    withSuggs.runs[0] = {
      ...withSuggs.runs[0],
      diagnosis: {
        runId: withSuggs.runs[0].run.runId,
        fixtureId: withSuggs.runs[0].run.fixtureId,
        strengths: [],
        weaknesses: [],
        contextGaps: [],
        suggestions: [
          {
            kind: "add_rule",
            layerId: "conventions",
            content: "Always wrap errors in try/catch",
            confidence: 0.9,
          },
        ],
      },
    };

    await store.save(withSuggs, "run-1");
    await store.save(withSuggs, "run-2");

    const suggestions = await store.aggregateSuggestions();
    expect(suggestions.length).toBe(1);
    expect(suggestions[0].occurrences).toBe(2);
    expect(suggestions[0].averageConfidence).toBe(0.9);
    expect(suggestions[0].suggestion.kind).toBe("add_rule");
  });

  test("persists across instances", async () => {
    const store1 = new EvalStore(TEST_DIR);
    await store1.save(makeBatchResult(80), "persistent");

    // New instance, same directory
    const store2 = new EvalStore(TEST_DIR);
    const list = await store2.list();
    expect(list.length).toBe(1);
    expect(list[0].label).toBe("persistent");
  });

  test("get returns null for nonexistent batch", async () => {
    const store = new EvalStore(TEST_DIR);
    const result = await store.get("nonexistent");
    expect(result).toBeNull();
  });
});
