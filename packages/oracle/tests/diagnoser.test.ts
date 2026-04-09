import { describe, test, expect } from "bun:test";
import { HeuristicDiagnoser, LLMDiagnoser } from "../src/diagnoser";
import type { PRFixture, EvalRun } from "../src/types";
import type {
  LLMProvider,
  CompletionResult,
  LLMMessage,
  CompletionOpts,
} from "@inixiative/foundry-core";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const GOLDEN_DIFF = `diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,5 @@
+import { validate } from './validator';
 export function main() {
-  return null;
+  const result = validate();
+  return result;
 }
diff --git a/tests/main.test.ts b/tests/main.test.ts
--- /dev/null
+++ b/tests/main.test.ts
@@ -0,0 +1,5 @@
+import { main } from '../src/main';
+test('main returns result', () => {
+  expect(main()).toBeDefined();
+});
+export {};`;

const AGENT_PARTIAL_DIFF = `diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,4 @@
+import { validate } from './validator';
 export function main() {
-  return null;
+  return validate();
 }`;

const fixture: PRFixture = {
  id: "test-fixture",
  pr: {
    owner: "test",
    repo: "repo",
    number: 1,
    title: "Fix bug",
    url: "",
    mergedAt: "2024-01-01",
    mergeCommitSha: "abc123",
  },
  ticket: {
    number: 1,
    title: "Fix the bug",
    body: "Bug description",
    labels: [],
    url: "",
  },
  baseSha: "def456",
  goldenDiff: GOLDEN_DIFF,
  files: [
    { path: "src/main.ts", status: "modified" as const },
    { path: "tests/main.test.ts", status: "added" as const },
  ],
  meta: {
    filesChanged: 2,
    additions: 15,
    deletions: 2,
    labels: ["bug"],
    complexity: "small",
  },
};

function makeRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    fixtureId: "test-fixture",
    runId: "run-1",
    timestamp: Date.now(),
    agentOutput: "",
    goldenDiff: GOLDEN_DIFF,
    scores: {
      completion: 50,
      correctness: 50,
      craft: 50,
      efficiency: 50,
      precision: 50,
    },
    composite: 50,
    durationMs: 100,
    layerIds: ["base"],
    contextHash: "hash123",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HeuristicDiagnoser
// ---------------------------------------------------------------------------

describe("HeuristicDiagnoser", () => {
  const diagnoser = new HeuristicDiagnoser();

  test("missing files — golden diff has files agent didn't touch", async () => {
    // Agent only touched src/main.ts, missed tests/main.test.ts
    const run = makeRun({
      agentOutput: AGENT_PARTIAL_DIFF,
    });

    const diagnosis = await diagnoser.diagnose(run, fixture);

    // Should detect the missing test file
    expect(diagnosis.weaknesses.length).toBeGreaterThan(0);
    const missedTestWeak = diagnosis.weaknesses.find((w) =>
      w.includes("tests/main.test.ts")
    );
    expect(missedTestWeak).toBeDefined();
  });

  test("missing test files — golden has test files, agent has none", async () => {
    // Agent touches a source file but no test file
    const run = makeRun({
      agentOutput: AGENT_PARTIAL_DIFF,
    });

    const diagnosis = await diagnoser.diagnose(run, fixture);

    // Should have a context gap about testing conventions
    const testGap = diagnosis.contextGaps.find(
      (g) => g.layerId === "testing-conventions"
    );
    expect(testGap).toBeDefined();
    expect(testGap!.missing).toContain("Test file");

    // Should have a suggestion about adding test rules
    const testSugg = diagnosis.suggestions.find(
      (s) => s.layerId === "testing-conventions"
    );
    expect(testSugg).toBeDefined();
    expect(testSugg!.kind).toBe("add_rule");
    expect(testSugg!.confidence).toBeGreaterThan(0);
  });

  test("complete match — agent output covers all golden files", async () => {
    // Agent touches exactly the same files as golden (with proper ---/+++ headers)
    const run = makeRun({
      agentOutput: [
        "diff --git a/src/main.ts b/src/main.ts",
        "--- a/src/main.ts",
        "+++ b/src/main.ts",
        "+import { validate } from './validator';",
        " export function main() {",
        "-  return null;",
        "+  return validate();",
        " }",
        "diff --git a/tests/main.test.ts b/tests/main.test.ts",
        "--- /dev/null",
        "+++ b/tests/main.test.ts",
        "+import { main } from '../src/main';",
        "+test('main works', () => {",
        "+  expect(main()).toBeDefined();",
        "+});",
      ].join("\n"),
      scores: {
        completion: 90,
        correctness: 90,
        craft: 90,
        efficiency: 90,
        precision: 90,
      },
      composite: 90,
    });

    const diagnosis = await diagnoser.diagnose(run, fixture);

    // Should have "Touched all required files" strength
    const allFilesStrength = diagnosis.strengths.find((s) =>
      s.includes("all required files")
    );
    expect(allFilesStrength).toBeDefined();

    // No critical missing-file gaps
    const missingFileGaps = diagnosis.contextGaps.filter(
      (g) =>
        g.layerId === "testing-conventions" ||
        g.layerId === "project-structure"
    );
    expect(missingFileGaps.length).toBe(0);
  });

  test("volume mismatch — agent output much shorter than golden", async () => {
    // Golden has substantial diff, agent has very little
    const goldenDiff = `diff --git a/src/main.ts b/src/main.ts
+line1
+line2
+line3
+line4
+line5
+line6
+line7
+line8
+line9
+line10
-old1
-old2
-old3
-old4
-old5
diff --git a/tests/main.test.ts b/tests/main.test.ts
+test1
+test2
+test3
+test4
+test5`;

    const run = makeRun({
      goldenDiff,
      agentOutput:
        "diff --git a/src/main.ts b/src/main.ts\n+line1",
    });

    const diagnosis = await diagnoser.diagnose(run, fixture);

    // Should detect incomplete implementation
    const volumeWeak = diagnosis.weaknesses.find((w) =>
      w.includes("Incomplete implementation") || w.includes("changed lines")
    );
    expect(volumeWeak).toBeDefined();

    // Should have a context gap about implementation patterns
    const implGap = diagnosis.contextGaps.find(
      (g) => g.layerId === "implementation-patterns"
    );
    expect(implGap).toBeDefined();
  });

  test("scope creep — agent touched files not in golden", async () => {
    // Agent touches golden files plus extra files (with proper ---/+++ headers)
    const run = makeRun({
      agentOutput: [
        "diff --git a/src/main.ts b/src/main.ts",
        "--- a/src/main.ts",
        "+++ b/src/main.ts",
        "+fix",
        "diff --git a/tests/main.test.ts b/tests/main.test.ts",
        "--- /dev/null",
        "+++ b/tests/main.test.ts",
        "+test",
        "diff --git a/src/utils.ts b/src/utils.ts",
        "--- a/src/utils.ts",
        "+++ b/src/utils.ts",
        "+refactored",
        "diff --git a/src/config.ts b/src/config.ts",
        "--- a/src/config.ts",
        "+++ b/src/config.ts",
        "+tweaked",
      ].join("\n"),
    });

    const diagnosis = await diagnoser.diagnose(run, fixture);

    // Should detect scope creep
    const creepWeak = diagnosis.weaknesses.find((w) =>
      w.includes("Scope creep")
    );
    expect(creepWeak).toBeDefined();
    expect(creepWeak).toContain("2 files not in golden");
  });

  test("reasoning field — verify reasoning strings are non-empty", async () => {
    const run = makeRun({
      agentOutput:
        "diff --git a/src/main.ts b/src/main.ts\n+fix",
    });

    const diagnosis = await diagnoser.diagnose(run, fixture);

    // fixtureId and runId should be populated
    expect(diagnosis.fixtureId).toBe("test-fixture");
    expect(diagnosis.runId).toBe("run-1");

    // All context gaps should have non-empty evidence and missing fields
    for (const gap of diagnosis.contextGaps) {
      expect(gap.missing.length).toBeGreaterThan(0);
      expect(gap.evidence.length).toBeGreaterThan(0);
      expect(gap.layerId.length).toBeGreaterThan(0);
    }

    // All suggestions should have non-empty content
    for (const sug of diagnosis.suggestions) {
      expect(sug.content.length).toBeGreaterThan(0);
      expect(sug.layerId.length).toBeGreaterThan(0);
    }
  });

  test("empty agent output — detects no output", async () => {
    const run = makeRun({ agentOutput: "" });

    const diagnosis = await diagnoser.diagnose(run, fixture);

    const emptyWeak = diagnosis.weaknesses.find((w) =>
      w.includes("no output")
    );
    expect(emptyWeak).toBeDefined();
  });

  test("score-based observations — high completion noted", async () => {
    const run = makeRun({
      agentOutput: fixture.goldenDiff,
      scores: {
        completion: 90,
        correctness: 90,
        craft: 85,
        efficiency: 70,
        precision: 80,
      },
      composite: 85,
    });

    const diagnosis = await diagnoser.diagnose(run, fixture);

    const completionStrength = diagnosis.strengths.find((s) =>
      s.includes("High task completion")
    );
    expect(completionStrength).toBeDefined();

    const craftStrength = diagnosis.strengths.find((s) =>
      s.includes("Good code quality")
    );
    expect(craftStrength).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// LLMDiagnoser
// ---------------------------------------------------------------------------

describe("LLMDiagnoser", () => {
  test("parses structured JSON diagnosis from LLM", async () => {
    const mockProvider: LLMProvider = {
      id: "mock",
      async complete(
        _messages: LLMMessage[],
        _opts?: CompletionOpts
      ): Promise<CompletionResult> {
        return {
          content: JSON.stringify({
            strengths: ["Correctly identified the bug location"],
            weaknesses: ["Missed edge case handling"],
            contextGaps: [
              {
                layerId: "error-handling",
                missing: "Error boundary patterns",
                evidence: "Golden diff wraps in try/catch",
              },
            ],
            suggestions: [
              {
                kind: "add_rule",
                layerId: "error-handling",
                content: "Always add try/catch around I/O operations",
                confidence: 0.85,
              },
            ],
          }),
          model: "test-model",
        };
      },
    };

    const diagnoser = new LLMDiagnoser({ provider: mockProvider });
    const run = makeRun({
      agentOutput:
        "diff --git a/src/main.ts b/src/main.ts\n+fix",
    });

    const diagnosis = await diagnoser.diagnose(run, fixture);

    expect(diagnosis.runId).toBe("run-1");
    expect(diagnosis.fixtureId).toBe("test-fixture");
    expect(diagnosis.strengths).toContain(
      "Correctly identified the bug location"
    );
    expect(diagnosis.weaknesses).toContain("Missed edge case handling");
    expect(diagnosis.contextGaps).toHaveLength(1);
    expect(diagnosis.contextGaps[0].layerId).toBe("error-handling");
    expect(diagnosis.contextGaps[0].missing).toBe("Error boundary patterns");
    expect(diagnosis.contextGaps[0].evidence).toBe(
      "Golden diff wraps in try/catch"
    );
    expect(diagnosis.suggestions).toHaveLength(1);
    expect(diagnosis.suggestions[0].kind).toBe("add_rule");
    expect(diagnosis.suggestions[0].confidence).toBe(0.85);
  });

  test("malformed response — LLM returns non-JSON, fallback diagnosis", async () => {
    const mockProvider: LLMProvider = {
      id: "mock",
      async complete(): Promise<CompletionResult> {
        return {
          content:
            "I'm sorry, I cannot analyze this diff properly. Let me explain why...",
          model: "test-model",
        };
      },
    };

    const diagnoser = new LLMDiagnoser({ provider: mockProvider });
    const run = makeRun({
      agentOutput:
        "diff --git a/src/main.ts b/src/main.ts\n+fix",
    });

    const diagnosis = await diagnoser.diagnose(run, fixture);

    expect(diagnosis.runId).toBe("run-1");
    expect(diagnosis.fixtureId).toBe("test-fixture");
    expect(diagnosis.strengths).toHaveLength(0);
    // Should contain a parsing failure weakness
    expect(diagnosis.weaknesses.length).toBeGreaterThan(0);
    expect(
      diagnosis.weaknesses.some((w) => w.includes("Failed to parse"))
    ).toBe(true);
    expect(diagnosis.contextGaps).toHaveLength(0);
    expect(diagnosis.suggestions).toHaveLength(0);
  });

  test("LLM returns JSON embedded in markdown code block", async () => {
    const mockProvider: LLMProvider = {
      id: "mock",
      async complete(): Promise<CompletionResult> {
        return {
          content:
            '```json\n{"strengths": ["Good"], "weaknesses": ["Bad"], "contextGaps": [], "suggestions": []}\n```',
          model: "test-model",
        };
      },
    };

    const diagnoser = new LLMDiagnoser({ provider: mockProvider });
    const run = makeRun({
      agentOutput:
        "diff --git a/src/main.ts b/src/main.ts\n+fix",
    });

    const diagnosis = await diagnoser.diagnose(run, fixture);

    expect(diagnosis.strengths).toContain("Good");
    expect(diagnosis.weaknesses).toContain("Bad");
  });

  test("LLM returns partial JSON — missing optional fields handled", async () => {
    const mockProvider: LLMProvider = {
      id: "mock",
      async complete(): Promise<CompletionResult> {
        return {
          content: JSON.stringify({
            strengths: ["Partial response"],
            // Missing weaknesses, contextGaps, suggestions
          }),
          model: "test-model",
        };
      },
    };

    const diagnoser = new LLMDiagnoser({ provider: mockProvider });
    const run = makeRun({
      agentOutput:
        "diff --git a/src/main.ts b/src/main.ts\n+fix",
    });

    const diagnosis = await diagnoser.diagnose(run, fixture);

    expect(diagnosis.strengths).toContain("Partial response");
    expect(diagnosis.weaknesses).toHaveLength(0);
    expect(diagnosis.contextGaps).toHaveLength(0);
    expect(diagnosis.suggestions).toHaveLength(0);
  });
});
