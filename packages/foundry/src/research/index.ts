// ---------------------------------------------------------------------------
// Research module — auto-research for optimal agent configurations
// ---------------------------------------------------------------------------

export type {
  Fixture,
  ConfigVariation,
  SingleRunResult,
  FixtureResult,
  ConfigResult,
  ExperimentReport,
  ExperimentConfig,
  CompositeWeights,
} from "./types";
export { DEFAULT_EXPERIMENT_CONFIG } from "./types";

export { BUILTIN_FIXTURES, loadFixtures, getAllFixtures } from "./fixtures";
export { oneAtATime, modelSweep, temperatureSweep, manual, applyVariation } from "./config-gen";
export { Judge, type JudgeResult, type JudgeConfig } from "./judge";
export { ExperimentRunner, type ProviderFactory, type RunnerDeps } from "./runner";
export { writeReport, generateMarkdown } from "./report";
