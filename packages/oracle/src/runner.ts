import type {
  PRFixture,
  EvalRun,
  EvalDiagnosis,
  FixtureScorer,
  FixtureDiagnoser,
  ContextGap,
  CorpusSuggestion,
} from "./types";
import type { LLMProvider, LLMMessage, ContextStack } from "@inixiative/foundry-core";
import { assembledToMessages, computeHash } from "@inixiative/foundry-core";

// ---------------------------------------------------------------------------
// Fixture runner — executes an agent against PR fixtures
// ---------------------------------------------------------------------------

export interface RunnerConfig {
  /** LLM provider to use for agent execution. */
  provider: LLMProvider;
  /** Context stack with pre-warmed layers. */
  stack: ContextStack;
  /** Scorer to evaluate outputs. */
  scorer: FixtureScorer;
  /** Optional diagnoser for self-improvement suggestions. */
  diagnoser?: FixtureDiagnoser;
  /** Model override for the agent execution. */
  model?: string;
  /** Max tokens for agent response. */
  maxTokens?: number;
}

export interface RunResult {
  readonly run: EvalRun;
  readonly diagnosis?: EvalDiagnosis;
}

export interface BatchResult {
  readonly runs: RunResult[];
  readonly summary: BatchSummary;
}

export interface BatchSummary {
  readonly totalFixtures: number;
  readonly averageComposite: number;
  readonly averageScores: {
    completion: number;
    correctness: number;
    craft: number;
    efficiency: number;
    precision: number;
  };
  readonly bestRun: { fixtureId: string; composite: number } | null;
  readonly worstRun: { fixtureId: string; composite: number } | null;
  /** Context gaps seen across all runs. */
  readonly commonGaps: ContextGap[];
  /** Suggestions that appeared in multiple diagnoses. */
  readonly topSuggestions: CorpusSuggestion[];
  readonly durationMs: number;
}

/**
 * Runs an agent against PR fixtures and scores the results.
 *
 * The runner:
 * 1. Assembles context from the stack
 * 2. Builds a prompt from the fixture's ticket
 * 3. Calls the LLM provider
 * 4. Scores the output against the golden diff
 * 5. Optionally diagnoses gaps and suggests improvements
 */
export class FixtureRunner {
  private _provider: LLMProvider;
  private _stack: ContextStack;
  private _scorer: FixtureScorer;
  private _diagnoser: FixtureDiagnoser | undefined;
  private _model: string | undefined;
  private _maxTokens: number;

  constructor(config: RunnerConfig) {
    this._provider = config.provider;
    this._stack = config.stack;
    this._scorer = config.scorer;
    this._diagnoser = config.diagnoser;
    this._model = config.model;
    this._maxTokens = config.maxTokens ?? 4096;
  }

  /**
   * Run a single fixture.
   */
  async run(fixture: PRFixture): Promise<RunResult> {
    const startTime = performance.now();

    // 1. Assemble context
    const assembled = this._stack.assemble();
    const contextHash = computeHash(assembled.text);
    const layerIds = [
      ...new Set(
        assembled.blocks.filter((b) => b.id).map((b) => b.id as string)
      ),
    ];

    // 2. Build the agent prompt from the fixture
    const userPrompt = this._buildPrompt(fixture);

    // 3. Convert assembled context + user prompt to messages
    const messages = assembledToMessages(assembled, userPrompt);

    // 4. Call the LLM
    const completion = await this._provider.complete(messages, {
      model: this._model,
      maxTokens: this._maxTokens,
      temperature: 0,
    });

    const durationMs = Math.round(performance.now() - startTime);

    // 5. Score the output
    const { scores, composite } = await this._scorer.score(
      fixture,
      completion.content,
      { layerIds, contextHash }
    );

    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const run: EvalRun = {
      fixtureId: fixture.id,
      runId,
      timestamp: Date.now(),
      agentOutput: completion.content,
      goldenDiff: fixture.goldenDiff,
      scores,
      composite,
      tokens: completion.tokens,
      durationMs,
      layerIds,
      contextHash,
    };

    // 6. Optionally diagnose
    let diagnosis: EvalDiagnosis | undefined;
    if (this._diagnoser) {
      diagnosis = await this._diagnoser.diagnose(run, fixture);
    }

    return { run, diagnosis };
  }

  /**
   * Run a batch of fixtures and produce a summary.
   */
  async runBatch(fixtures: PRFixture[]): Promise<BatchResult> {
    const startTime = performance.now();
    const results: RunResult[] = [];

    for (const fixture of fixtures) {
      const result = await this.run(fixture);
      results.push(result);
    }

    const summary = this._summarize(results, performance.now() - startTime);
    return { runs: results, summary };
  }

  /**
   * Compare two context configurations against the same fixtures.
   * Returns which configuration scored better.
   */
  async compare(
    fixtures: PRFixture[],
    altStack: ContextStack
  ): Promise<{
    current: BatchResult;
    alternative: BatchResult;
    winner: "current" | "alternative" | "tie";
    delta: number;
  }> {
    // Run with current stack
    const current = await this.runBatch(fixtures);

    // Run with alternative stack using a temporary runner (no internal mutation)
    const altRunner = new FixtureRunner({
      provider: this._provider,
      stack: altStack,
      scorer: this._scorer,
      diagnoser: this._diagnoser,
      model: this._model,
      maxTokens: this._maxTokens,
    });
    const alternative = await altRunner.runBatch(fixtures);

    const delta =
      alternative.summary.averageComposite - current.summary.averageComposite;

    const winner =
      Math.abs(delta) < 2
        ? "tie"
        : delta > 0
          ? "alternative"
          : "current";

    return { current, alternative, winner, delta };
  }

  // -- Internal --

  private _buildPrompt(fixture: PRFixture): string {
    const parts: string[] = [];

    if (fixture.ticket) {
      parts.push(`## Task: ${fixture.ticket.title}`);
      parts.push("");
      parts.push(fixture.ticket.body);
    } else {
      parts.push(`## Task: ${fixture.pr.title}`);
    }

    parts.push("");
    parts.push("## Instructions");
    parts.push(
      "Implement the changes described above. Output ONLY the unified diff of your changes."
    );
    parts.push("Use the standard diff format with --- and +++ headers.");

    if (fixture.files.length > 0) {
      parts.push("");
      parts.push("## Files in scope");
      for (const f of fixture.files) {
        parts.push(`- ${f.path} (${f.status})`);
      }
    }

    return parts.join("\n");
  }

  private _summarize(results: RunResult[], durationMs: number): BatchSummary {
    if (results.length === 0) {
      return {
        totalFixtures: 0,
        averageComposite: 0,
        averageScores: {
          completion: 0,
          correctness: 0,
          craft: 0,
          efficiency: 0,
          precision: 0,
        },
        bestRun: null,
        worstRun: null,
        commonGaps: [],
        topSuggestions: [],
        durationMs: Math.round(durationMs),
      };
    }

    const runs = results.map((r) => r.run);

    const avg = (fn: (r: EvalRun) => number) =>
      Math.round(runs.reduce((sum, r) => sum + fn(r), 0) / runs.length);

    const sorted = [...runs].sort((a, b) => b.composite - a.composite);

    // Collect all gaps and suggestions from diagnoses
    const allGaps: ContextGap[] = [];
    const allSuggestions: CorpusSuggestion[] = [];
    for (const r of results) {
      if (r.diagnosis) {
        allGaps.push(...r.diagnosis.contextGaps);
        allSuggestions.push(...r.diagnosis.suggestions);
      }
    }

    // Find common gaps (appear in >1 diagnosis)
    const gapCounts = new Map<string, { gap: ContextGap; count: number }>();
    for (const gap of allGaps) {
      const key = `${gap.layerId}:${gap.missing}`;
      const existing = gapCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        gapCounts.set(key, { gap, count: 1 });
      }
    }
    const commonGaps = [...gapCounts.values()]
      .filter((g) => g.count > 1)
      .sort((a, b) => b.count - a.count)
      .map((g) => g.gap);

    // Top suggestions by confidence
    const topSuggestions = [...allSuggestions]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10);

    return {
      totalFixtures: runs.length,
      averageComposite: avg((r) => r.composite),
      averageScores: {
        completion: avg((r) => r.scores.completion),
        correctness: avg((r) => r.scores.correctness),
        craft: avg((r) => r.scores.craft),
        efficiency: avg((r) => r.scores.efficiency),
        precision: avg((r) => r.scores.precision),
      },
      bestRun: sorted[0]
        ? { fixtureId: sorted[0].fixtureId, composite: sorted[0].composite }
        : null,
      worstRun: sorted[sorted.length - 1]
        ? {
            fixtureId: sorted[sorted.length - 1].fixtureId,
            composite: sorted[sorted.length - 1].composite,
          }
        : null,
      commonGaps,
      topSuggestions,
      durationMs: Math.round(durationMs),
    };
  }
}
