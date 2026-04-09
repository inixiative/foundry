import type {
  PRFixture,
  RubricScores,
  FixtureScorer,
} from "./types";

// ---------------------------------------------------------------------------
// Diff analysis utilities
// ---------------------------------------------------------------------------

interface DiffStats {
  filesInGolden: Set<string>;
  filesInAgent: Set<string>;
  filesOverlap: Set<string>;
  filesMissed: Set<string>;
  filesExtra: Set<string>;
  goldenAdditions: number;
  goldenDeletions: number;
  agentAdditions: number;
  agentDeletions: number;
}

function parseDiffFiles(diff: string): Set<string> {
  const files = new Set<string>();
  const regex = /^(?:diff --git a\/(.+?) b\/|[\+\-]{3} [ab]\/(.+))$/gm;
  let match;
  while ((match = regex.exec(diff)) !== null) {
    const file = match[1] ?? match[2];
    if (file && file !== "/dev/null" && !file.startsWith("/dev/")) {
      files.add(file);
    }
  }
  return files;
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

function analyzeDiffs(goldenDiff: string, agentDiff: string): DiffStats {
  const filesInGolden = parseDiffFiles(goldenDiff);
  const filesInAgent = parseDiffFiles(agentDiff);

  const filesOverlap = new Set<string>();
  const filesMissed = new Set<string>();
  const filesExtra = new Set<string>();

  for (const f of filesInGolden) {
    if (filesInAgent.has(f)) filesOverlap.add(f);
    else filesMissed.add(f);
  }
  for (const f of filesInAgent) {
    if (!filesInGolden.has(f)) filesExtra.add(f);
  }

  const golden = countDiffLines(goldenDiff);
  const agent = countDiffLines(agentDiff);

  return {
    filesInGolden,
    filesInAgent,
    filesOverlap,
    filesMissed,
    filesExtra,
    goldenAdditions: golden.additions,
    goldenDeletions: golden.deletions,
    agentAdditions: agent.additions,
    agentDeletions: agent.deletions,
  };
}

// ---------------------------------------------------------------------------
// DiffScorer — heuristic-based scoring from diff analysis
// ---------------------------------------------------------------------------

/**
 * Scores agent output against golden diff using structural diff analysis.
 * No LLM required — pure heuristic scoring based on file overlap,
 * line counts, and diff shape.
 *
 * Good for fast iteration. Use LLMScorer for deeper evaluation.
 */
export class DiffScorer implements FixtureScorer {
  readonly id = "diff";

  async score(
    fixture: PRFixture,
    agentOutput: string,
    context?: { layerIds: string[]; contextHash: string }
  ): Promise<{ scores: RubricScores; composite: number }> {
    // Short-circuit on empty output
    if (agentOutput.trim().length === 0) {
      const zero: RubricScores = {
        completion: 0, correctness: 0, craft: 0, efficiency: 0, precision: 0,
      };
      return { scores: zero, composite: 0 };
    }

    const stats = analyzeDiffs(fixture.goldenDiff, agentOutput);

    const completion = this._scoreCompletion(stats);
    const correctness = this._scoreCorrectness(stats);
    const craft = this._scoreCraft(stats, agentOutput);
    const efficiency = context
      ? this._scoreEfficiency(stats, context.layerIds.length)
      : 50;
    const precision = this._scorePrecision(stats);

    const scores: RubricScores = {
      completion,
      correctness,
      craft,
      efficiency,
      precision,
    };

    // Weighted composite — completion and correctness matter most
    const composite = Math.round(
      completion * 0.3 +
        correctness * 0.3 +
        craft * 0.15 +
        efficiency * 0.1 +
        precision * 0.15
    );

    return { scores, composite };
  }

  /**
   * Completion: What fraction of golden files did the agent touch?
   */
  private _scoreCompletion(stats: DiffStats): number {
    if (stats.filesInGolden.size === 0) return 100;
    const coverage = stats.filesOverlap.size / stats.filesInGolden.size;
    return Math.round(coverage * 100);
  }

  /**
   * Correctness: Did the agent touch the right files with roughly right volume?
   * Penalized for missing files and for wildly different line counts.
   */
  private _scoreCorrectness(stats: DiffStats): number {
    if (stats.filesInGolden.size === 0) return 100;

    // File overlap score
    const fileScore = stats.filesOverlap.size / stats.filesInGolden.size;

    // Line volume similarity (how close is agent's change volume to golden)
    const goldenTotal = stats.goldenAdditions + stats.goldenDeletions;
    const agentTotal = stats.agentAdditions + stats.agentDeletions;

    let volumeScore = 1;
    if (goldenTotal > 0) {
      const ratio = agentTotal / goldenTotal;
      // Penalize being too far from 1.0 in either direction
      volumeScore = Math.max(0, 1 - Math.abs(1 - ratio) * 0.5);
    }

    return Math.round(((fileScore * 0.6 + volumeScore * 0.4) * 100));
  }

  /**
   * Craft: Basic code quality signals from the diff.
   * Checks for common antipatterns in the agent output.
   */
  private _scoreCraft(stats: DiffStats, agentOutput: string): number {
    let score = 80; // Start with a decent baseline

    // Penalize console.log / debugger left in
    const debugPatterns = /\+.*(?:console\.log|debugger|TODO|FIXME|HACK)/gi;
    const debugMatches = agentOutput.match(debugPatterns);
    if (debugMatches) {
      score -= Math.min(30, debugMatches.length * 5);
    }

    // Penalize very long lines (>120 chars) added
    const longLines = agentOutput
      .split("\n")
      .filter((l) => l.startsWith("+") && l.length > 120);
    if (longLines.length > 5) {
      score -= Math.min(15, longLines.length);
    }

    // Reward if additions/deletions ratio is balanced (refactoring signal)
    if (stats.agentAdditions > 0 && stats.agentDeletions > 0) {
      score += 5;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Efficiency: Quality relative to context size.
   * Fewer layers for the same result = more efficient.
   */
  private _scoreEfficiency(stats: DiffStats, layerCount: number): number {
    const filesCovered = stats.filesOverlap.size;
    if (filesCovered === 0) return 0;

    // More files covered per layer = more efficient
    const ratio = filesCovered / Math.max(1, layerCount);
    return Math.min(100, Math.round(ratio * 50));
  }

  /**
   * Precision: Did the agent change only what was needed?
   * Penalized for extra files and scope creep.
   */
  private _scorePrecision(stats: DiffStats): number {
    const totalAgentFiles = stats.filesInAgent.size;
    if (totalAgentFiles === 0) return 0;

    // What fraction of agent's changes were actually needed?
    const relevantRatio = stats.filesOverlap.size / totalAgentFiles;

    // Penalize extra files
    const extraPenalty = Math.min(0.5, stats.filesExtra.size * 0.1);

    return Math.round(Math.max(0, relevantRatio - extraPenalty) * 100);
  }
}

// ---------------------------------------------------------------------------
// LLMScorer — uses an LLM-as-judge for deeper evaluation
// ---------------------------------------------------------------------------

import type { LLMProvider } from "@inixiative/foundry-core";

export interface LLMScorerConfig {
  provider: LLMProvider;
  /** Model to use for scoring. If not set, uses provider default. */
  model?: string;
}

/**
 * Uses an LLM to score agent output against golden diff.
 * More expensive but catches semantic correctness that diff analysis misses.
 *
 * The LLM receives the ticket, golden diff, and agent diff, then scores
 * each rubric with a brief justification.
 */
export class LLMScorer implements FixtureScorer {
  readonly id = "llm";

  private _provider: LLMProvider;
  private _model: string | undefined;

  constructor(config: LLMScorerConfig) {
    this._provider = config.provider;
    this._model = config.model;
  }

  async score(
    fixture: PRFixture,
    agentOutput: string
  ): Promise<{ scores: RubricScores; composite: number }> {
    const ticketText = fixture.ticket
      ? `## Ticket #${fixture.ticket.number}: ${fixture.ticket.title}\n${fixture.ticket.body}`
      : `## PR: ${fixture.pr.title}`;

    const prompt = `You are evaluating an AI coding agent's output against a golden reference.

${ticketText}

## Golden Diff (what a human produced)
\`\`\`diff
${truncate(fixture.goldenDiff, 4000)}
\`\`\`

## Agent Diff (what the AI produced)
\`\`\`diff
${truncate(agentOutput, 4000)}
\`\`\`

Score the agent's output on these 5 rubrics (0-100 each):

1. **completion**: Did the agent address the full ticket? All subtasks covered?
2. **correctness**: Does it match the golden diff structurally? Right files, right patterns?
3. **craft**: Code quality — naming, structure, convention adherence?
4. **efficiency**: How concise is the solution? Minimal overhead?
5. **precision**: Did it change only what was needed? No scope creep?

Respond with ONLY a JSON object:
{"completion": N, "correctness": N, "craft": N, "efficiency": N, "precision": N}`;

    const result = await this._provider.complete(
      [
        {
          role: "system",
          content:
            "You are a precise code review scoring system. Output only valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      { model: this._model, temperature: 0, maxTokens: 256 }
    );

    const scores = parseScoresJSON(result.content);

    const composite = Math.round(
      scores.completion * 0.3 +
        scores.correctness * 0.3 +
        scores.craft * 0.15 +
        scores.efficiency * 0.1 +
        scores.precision * 0.15
    );

    return { scores, composite };
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n... (truncated)";
}

function parseScoresJSON(text: string): RubricScores {
  // Extract JSON from the response (may be wrapped in markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { completion: 0, correctness: 0, craft: 0, efficiency: 0, precision: 0 };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      completion: clamp(parsed.completion ?? 0),
      correctness: clamp(parsed.correctness ?? 0),
      craft: clamp(parsed.craft ?? 0),
      efficiency: clamp(parsed.efficiency ?? 0),
      precision: clamp(parsed.precision ?? 0),
    };
  } catch {
    return { completion: 0, correctness: 0, craft: 0, efficiency: 0, precision: 0 };
  }
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export { analyzeDiffs, parseDiffFiles, countDiffLines, type DiffStats };
