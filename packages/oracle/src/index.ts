// Fixture types
export {
  type PRFixture,
  type PRFileChange,
  type EvalRun,
  type EvalDiagnosis,
  type RubricScores,
  type ContextGap,
  type CorpusSuggestion,
  type FixtureSource,
  type FixtureScorer,
  type FixtureDiagnoser,
  type ExtractOpts,
} from "./types";

// GitHub fixture extraction
export {
  GitHubFixtureSource,
  type GitHubFixtureConfig,
} from "./github-fixtures";

// Scoring
export {
  DiffScorer,
  LLMScorer,
  analyzeDiffs,
  parseDiffFiles,
  countDiffLines,
  type DiffStats,
  type LLMScorerConfig,
} from "./scorer";

// Runner
export {
  FixtureRunner,
  type RunnerConfig,
  type RunResult,
  type BatchResult,
  type BatchSummary,
} from "./runner";

// Store — persistent memory for eval runs
export {
  EvalStore,
  type StoredBatch,
  type RegressionReport,
  type ScoreTrend,
  type AggregatedGap,
  type AggregatedSuggestion,
} from "./store";

// Diagnoser — self-improvement reflector
export {
  HeuristicDiagnoser,
  LLMDiagnoser,
  type LLMDiagnoserConfig,
} from "./diagnoser";
