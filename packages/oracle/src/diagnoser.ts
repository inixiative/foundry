import type {
  PRFixture,
  EvalRun,
  EvalDiagnosis,
  ContextGap,
  CorpusSuggestion,
  FixtureDiagnoser,
} from "./types";
import { parseDiffFiles, countDiffLines } from "./scorer";
import type { LLMProvider } from "@inixiative/foundry-core";

// ---------------------------------------------------------------------------
// HeuristicDiagnoser — no LLM needed
// ---------------------------------------------------------------------------

/**
 * Analyzes eval runs using structural diff heuristics.
 *
 * Detects:
 * - Missing file patterns (agent missed entire directories)
 * - Wrong language/framework usage
 * - Missing test files
 * - Incomplete implementations
 * - Excessive scope creep
 *
 * Fast and free — good for tight feedback loops during development.
 */
export class HeuristicDiagnoser implements FixtureDiagnoser {
  readonly id = "heuristic";

  async diagnose(run: EvalRun, fixture: PRFixture): Promise<EvalDiagnosis> {
    const goldenFiles = parseDiffFiles(run.goldenDiff);
    const agentFiles = parseDiffFiles(run.agentOutput);

    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const contextGaps: ContextGap[] = [];
    const suggestions: CorpusSuggestion[] = [];

    // -- File overlap analysis --
    const missed = new Set<string>();
    const extra = new Set<string>();
    const overlap = new Set<string>();

    for (const f of goldenFiles) {
      if (agentFiles.has(f)) overlap.add(f);
      else missed.add(f);
    }
    for (const f of agentFiles) {
      if (!goldenFiles.has(f)) extra.add(f);
    }

    if (overlap.size === goldenFiles.size && goldenFiles.size > 0) {
      strengths.push("Touched all required files");
    }

    if (overlap.size > 0 && overlap.size < goldenFiles.size) {
      strengths.push(
        `Touched ${overlap.size} of ${goldenFiles.size} required files`
      );
    }

    // -- Missing file patterns --
    const missedDirs = detectMissedDirectories(missed);
    for (const dir of missedDirs) {
      const files = [...missed].filter((f) => f.startsWith(dir));
      weaknesses.push(`Missed entire directory: ${dir}/ (${files.length} files)`);
      contextGaps.push({
        layerId: "project-structure",
        missing: `Directory structure knowledge for ${dir}/`,
        evidence: `Golden diff modifies ${files.join(", ")} but agent produced no changes in ${dir}/`,
      });
      suggestions.push({
        kind: "add_rule",
        layerId: "project-structure",
        content: `When changes involve the ${dir.split("/")[0]}/ directory, check for related files in ${dir}/`,
        confidence: 0.7,
      });
    }

    // -- Missing test files --
    const missedTests = [...missed].filter((f) => isTestFile(f));
    if (missedTests.length > 0) {
      weaknesses.push(
        `Missing test files: ${missedTests.join(", ")}`
      );
      contextGaps.push({
        layerId: "testing-conventions",
        missing: "Test file requirements for this change",
        evidence: `Golden diff includes tests: ${missedTests.join(", ")}`,
      });
      suggestions.push({
        kind: "add_rule",
        layerId: "testing-conventions",
        content:
          "Always include corresponding test files when modifying source code. " +
          `Test patterns seen: ${missedTests.map((f) => extractTestPattern(f)).join(", ")}`,
        confidence: 0.8,
      });
    }

    // -- Extra/scope-creep files --
    if (extra.size > 0) {
      weaknesses.push(
        `Scope creep: modified ${extra.size} files not in golden diff (${[...extra].slice(0, 3).join(", ")}${extra.size > 3 ? "..." : ""})`
      );
    }

    // -- Volume analysis --
    const goldenLines = countDiffLines(run.goldenDiff);
    const agentLines = countDiffLines(run.agentOutput);
    const goldenTotal = goldenLines.additions + goldenLines.deletions;
    const agentTotal = agentLines.additions + agentLines.deletions;

    if (goldenTotal > 0) {
      const ratio = agentTotal / goldenTotal;
      if (ratio < 0.3) {
        weaknesses.push(
          `Incomplete implementation: agent produced ${agentTotal} changed lines vs golden's ${goldenTotal}`
        );
        contextGaps.push({
          layerId: "implementation-patterns",
          missing: "Full scope of required changes",
          evidence: `Agent output is ${Math.round(ratio * 100)}% of golden diff volume`,
        });
      } else if (ratio > 2.0) {
        weaknesses.push(
          `Over-engineered: agent produced ${agentTotal} changed lines vs golden's ${goldenTotal}`
        );
      } else if (ratio >= 0.7 && ratio <= 1.3) {
        strengths.push("Change volume closely matches golden diff");
      }
    }

    // -- Language/framework detection --
    const goldenLangs = detectLanguages(run.goldenDiff);
    const agentLangs = detectLanguages(run.agentOutput);
    const wrongLangs = [...agentLangs].filter((l) => !goldenLangs.has(l));
    if (wrongLangs.length > 0 && goldenLangs.size > 0) {
      weaknesses.push(
        `Used unexpected language/framework patterns: ${wrongLangs.join(", ")}`
      );
      contextGaps.push({
        layerId: "project-conventions",
        missing: `Project uses ${[...goldenLangs].join(", ")}, not ${wrongLangs.join(", ")}`,
        evidence: "File extensions and patterns in golden diff differ from agent output",
      });
    }

    // -- Score-based observations --
    if (run.scores.completion >= 80) {
      strengths.push("High task completion");
    }
    if (run.scores.craft >= 80) {
      strengths.push("Good code quality");
    }
    if (run.scores.precision < 50) {
      weaknesses.push("Low precision — significant scope creep or wrong targets");
    }
    if (run.scores.correctness < 50 && missed.size > 0) {
      contextGaps.push({
        layerId: "codebase-map",
        missing: "Knowledge of which files need modification for this type of task",
        evidence: `Agent missed: ${[...missed].slice(0, 5).join(", ")}`,
      });
      suggestions.push({
        kind: "add_example",
        layerId: "codebase-map",
        content: `For ${fixture.pr.title}: files involved are ${[...goldenFiles].join(", ")}`,
        confidence: 0.6,
      });
    }

    // -- Empty output --
    if (run.agentOutput.trim().length === 0) {
      weaknesses.push("Agent produced no output");
      contextGaps.push({
        layerId: "task-understanding",
        missing: "Ability to parse and respond to the task description",
        evidence: "Agent output was empty",
      });
    }

    return {
      runId: run.runId,
      fixtureId: run.fixtureId,
      strengths,
      weaknesses,
      contextGaps,
      suggestions,
    };
  }
}

// ---------------------------------------------------------------------------
// LLMDiagnoser — uses LLM for deeper analysis
// ---------------------------------------------------------------------------

export interface LLMDiagnoserConfig {
  provider: LLMProvider;
  /** Model to use for diagnosis. If not set, uses provider default. */
  model?: string;
}

/**
 * Uses an LLM to deeply analyze eval runs, identify missing context,
 * convention violations, and suggest corpus improvements.
 *
 * More expensive but catches semantic issues that heuristics miss.
 */
export class LLMDiagnoser implements FixtureDiagnoser {
  readonly id = "llm";

  private _provider: LLMProvider;
  private _model: string | undefined;

  constructor(config: LLMDiagnoserConfig) {
    this._provider = config.provider;
    this._model = config.model;
  }

  async diagnose(run: EvalRun, fixture: PRFixture): Promise<EvalDiagnosis> {
    const ticketText = fixture.ticket
      ? `## Ticket #${fixture.ticket.number}: ${fixture.ticket.title}\n${fixture.ticket.body}`
      : `## PR: ${fixture.pr.title}`;

    const prompt = `You are diagnosing why an AI coding agent scored the way it did on a task.

${ticketText}

## Scores
- Completion: ${run.scores.completion}/100
- Correctness: ${run.scores.correctness}/100
- Craft: ${run.scores.craft}/100
- Efficiency: ${run.scores.efficiency}/100
- Precision: ${run.scores.precision}/100
- Composite: ${run.composite}/100

## Golden Diff (what a human produced)
\`\`\`diff
${truncate(run.goldenDiff, 3000)}
\`\`\`

## Agent Diff (what the AI produced)
\`\`\`diff
${truncate(run.agentOutput, 3000)}
\`\`\`

## Context Layers Active
${run.layerIds.length > 0 ? run.layerIds.join(", ") : "(none)"}

## Files in Fixture
${fixture.files.map((f) => `- ${f.path} (${f.status})`).join("\n")}

Analyze the agent's performance and respond with ONLY a JSON object:
{
  "strengths": ["what the agent did well"],
  "weaknesses": ["what the agent got wrong"],
  "contextGaps": [
    {
      "layerId": "which-layer-should-have-this",
      "missing": "what knowledge was missing",
      "evidence": "evidence from the diffs"
    }
  ],
  "suggestions": [
    {
      "kind": "add_rule|add_example|update_doc|remove_rule",
      "layerId": "target-layer",
      "content": "the proposed content",
      "confidence": 0.0-1.0
    }
  ]
}

Focus on:
1. What context was missing that would have helped the agent?
2. What conventions were violated?
3. What knowledge would close the gap between agent and golden output?`;

    const result = await this._provider.complete(
      [
        {
          role: "system",
          content:
            "You are a precise AI evaluation diagnostician. Output only valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      { model: this._model, temperature: 0, maxTokens: 2048 }
    );

    return parseDiagnosisJSON(result.content, run.runId, run.fixtureId);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n... (truncated)";
}

function isTestFile(path: string): boolean {
  return /(?:\.test\.|\.spec\.|__tests__|_test\.go|test_.*\.py|Tests?\/)/.test(
    path
  );
}

function extractTestPattern(path: string): string {
  const match = path.match(
    /(?:\.test\.|\.spec\.|__tests__|_test\.go|test_.*\.py|Tests?\/)/
  );
  return match ? match[0] : "unknown";
}

/**
 * Detect missed directories — groups of missed files that share a common
 * directory prefix, indicating the agent missed an entire area of the codebase.
 */
function detectMissedDirectories(missed: Set<string>): string[] {
  if (missed.size < 2) return [];

  const dirCounts = new Map<string, number>();
  for (const file of missed) {
    const parts = file.split("/");
    if (parts.length >= 2) {
      const dir = parts.slice(0, -1).join("/");
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }
  }

  // A directory counts as "missed" if it has 2+ files the agent didn't touch
  return [...dirCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([dir]) => dir);
}

/**
 * Rough language detection from file extensions in a diff.
 */
function detectLanguages(diff: string): Set<string> {
  const langs = new Set<string>();
  const extMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    go: "go",
    rs: "rust",
    java: "java",
    rb: "ruby",
    swift: "swift",
    kt: "kotlin",
    cs: "csharp",
    css: "css",
    scss: "scss",
    html: "html",
  };

  const regex = /^(?:diff --git a\/(.+?) b\/|[\+\-]{3} [ab]\/(.+))$/gm;
  let match;
  while ((match = regex.exec(diff)) !== null) {
    const file = match[1] ?? match[2];
    if (file) {
      const ext = file.split(".").pop()?.toLowerCase();
      if (ext && extMap[ext]) {
        langs.add(extMap[ext]);
      }
    }
  }

  return langs;
}

function parseDiagnosisJSON(
  text: string,
  runId: string,
  fixtureId: string
): EvalDiagnosis {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      runId,
      fixtureId,
      strengths: [],
      weaknesses: ["Failed to parse LLM diagnosis response"],
      contextGaps: [],
      suggestions: [],
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    const strengths: string[] = Array.isArray(parsed.strengths)
      ? parsed.strengths.filter((s: unknown) => typeof s === "string")
      : [];

    const weaknesses: string[] = Array.isArray(parsed.weaknesses)
      ? parsed.weaknesses.filter((s: unknown) => typeof s === "string")
      : [];

    const contextGaps: ContextGap[] = Array.isArray(parsed.contextGaps)
      ? parsed.contextGaps
          .filter(
            (g: Record<string, unknown>) =>
              g && typeof g.layerId === "string" && typeof g.missing === "string"
          )
          .map((g: Record<string, unknown>) => ({
            layerId: g.layerId as string,
            missing: g.missing as string,
            evidence: (g.evidence as string) ?? "",
          }))
      : [];

    const suggestions: CorpusSuggestion[] = Array.isArray(parsed.suggestions)
      ? parsed.suggestions
          .filter(
            (s: Record<string, unknown>) =>
              s &&
              typeof s.kind === "string" &&
              typeof s.layerId === "string" &&
              typeof s.content === "string"
          )
          .map((s: Record<string, unknown>) => ({
            kind: s.kind as CorpusSuggestion["kind"],
            layerId: s.layerId as string,
            content: s.content as string,
            confidence: typeof s.confidence === "number" ? s.confidence : 0.5,
          }))
      : [];

    return { runId, fixtureId, strengths, weaknesses, contextGaps, suggestions };
  } catch {
    return {
      runId,
      fixtureId,
      strengths: [],
      weaknesses: ["Failed to parse LLM diagnosis JSON"],
      contextGaps: [],
      suggestions: [],
    };
  }
}
