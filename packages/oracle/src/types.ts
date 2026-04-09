// ---------------------------------------------------------------------------
// PR-based fixture types for self-improvement evaluation
// ---------------------------------------------------------------------------

/**
 * A fixture extracted from a merged PR.
 *
 * Each merged PR is a complete training example:
 * - The ticket describes what was requested (input)
 * - The base commit is the repo state the agent would see (context)
 * - The squash diff is what a competent human produced (golden output)
 */
export interface PRFixture {
  readonly id: string;

  /** Source PR metadata. */
  readonly pr: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly mergedAt: string;
    readonly mergeCommitSha: string;
  };

  /** The ticket / issue that requested the work. */
  readonly ticket: {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly labels: string[];
    readonly url: string;
  } | null;

  /** The base commit SHA — repo state before the PR was merged. */
  readonly baseSha: string;

  /** The squash merge diff — the golden output. */
  readonly goldenDiff: string;

  /** Files changed in the PR, with before/after content. */
  readonly files: PRFileChange[];

  /** Metadata for filtering and categorization. */
  readonly meta: {
    readonly filesChanged: number;
    readonly additions: number;
    readonly deletions: number;
    readonly labels: string[];
    /** Estimated complexity: small (<50 lines), medium (50-200), large (>200). */
    readonly complexity: "small" | "medium" | "large";
  };
}

export interface PRFileChange {
  readonly path: string;
  readonly status: "added" | "modified" | "removed" | "renamed";
  readonly patch?: string;
  readonly previousPath?: string;
}

// ---------------------------------------------------------------------------
// Evaluation types
// ---------------------------------------------------------------------------

/** The result of running an agent against a fixture. */
export interface EvalRun {
  readonly fixtureId: string;
  readonly runId: string;
  readonly timestamp: number;

  /** The agent's produced diff / output. */
  readonly agentOutput: string;

  /** The golden diff for comparison. */
  readonly goldenDiff: string;

  /** Individual rubric scores. */
  readonly scores: RubricScores;

  /** Composite score (0-100). */
  readonly composite: number;

  /** Token usage for the run. */
  readonly tokens?: { input: number; output: number };

  /** Duration in milliseconds. */
  readonly durationMs: number;

  /** Which context layers were active during this run. */
  readonly layerIds: string[];

  /** Context hash for reproducibility. */
  readonly contextHash: string;
}

/**
 * Five scoring rubrics adapted from Foundry's evaluation philosophy.
 *
 * Each score is 0-100.
 */
export interface RubricScores {
  /**
   * Completion: Did the agent address the full ticket?
   * Measures: all subtasks covered, nothing left half-done.
   */
  readonly completion: number;

  /**
   * Correctness: Does the agent's output match the golden diff structurally?
   * Measures: right files touched, right patterns used, no regressions.
   */
  readonly correctness: number;

  /**
   * Craft: Code quality — pattern adherence, naming, structure.
   * Measures: matches project conventions, clean code, no antipatterns.
   */
  readonly craft: number;

  /**
   * Efficiency: How much context did the agent need?
   * Measures: quality ÷ tokens. Same output with fewer tokens scores higher.
   */
  readonly efficiency: number;

  /**
   * Precision: Did the agent change only what was needed?
   * Measures: minimal diff, no drive-by refactors, no scope creep.
   */
  readonly precision: number;
}

/** A diagnosis explaining why an agent scored the way it did. */
export interface EvalDiagnosis {
  readonly runId: string;
  readonly fixtureId: string;

  /** What the agent got right. */
  readonly strengths: string[];

  /** What the agent got wrong. */
  readonly weaknesses: string[];

  /** Specific context gaps — what was missing from the layers. */
  readonly contextGaps: ContextGap[];

  /** Suggested corpus mutations to improve performance. */
  readonly suggestions: CorpusSuggestion[];
}

export interface ContextGap {
  /** Which layer should have contained this knowledge. */
  readonly layerId: string;
  /** What was missing. */
  readonly missing: string;
  /** Evidence from the golden diff showing why it was needed. */
  readonly evidence: string;
}

export interface CorpusSuggestion {
  /** What kind of change: add a rule, add an example, update a doc. */
  readonly kind: "add_rule" | "add_example" | "update_doc" | "remove_rule";
  /** Target layer for the change. */
  readonly layerId: string;
  /** The proposed content. */
  readonly content: string;
  /** Confidence that this change would help (0-1). */
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Fixture source interface — pluggable PR extraction
// ---------------------------------------------------------------------------

/**
 * Interface for extracting fixtures from a source.
 * Implementations can pull from GitHub API, local git, or cached fixtures.
 */
export interface FixtureSource {
  readonly id: string;

  /** Extract fixtures from a repo. */
  extract(opts?: ExtractOpts): Promise<PRFixture[]>;

  /** Get a single fixture by PR number. */
  getByPR(prNumber: number): Promise<PRFixture | null>;
}

export interface ExtractOpts {
  /** Max number of PRs to extract. */
  limit?: number;
  /** Only PRs merged after this date. */
  since?: string;
  /** Only PRs with these labels. */
  labels?: string[];
  /** Filter by complexity. */
  complexity?: ("small" | "medium" | "large")[];
}

// ---------------------------------------------------------------------------
// Scorer interface — pluggable evaluation
// ---------------------------------------------------------------------------

/**
 * Scores an agent's output against a golden diff.
 * Implementations can use diff analysis, LLM-as-judge, or both.
 */
export interface FixtureScorer {
  readonly id: string;
  score(
    fixture: PRFixture,
    agentOutput: string,
    context?: { layerIds: string[]; contextHash: string }
  ): Promise<{ scores: RubricScores; composite: number }>;
}

/**
 * Diagnoses why an agent scored the way it did and suggests improvements.
 * This is the Reflector in the self-improvement loop.
 */
export interface FixtureDiagnoser {
  readonly id: string;
  diagnose(run: EvalRun, fixture: PRFixture): Promise<EvalDiagnosis>;
}
