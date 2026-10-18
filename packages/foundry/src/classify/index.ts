// Foundry's one classification primitive, for Wardens, Heralds and Oracle: a run of at most three
// stages, each asking a decision role whether a moment is in its area and reading the answer. It owns
// what a stage is told about answering (charters, response protocols), how the answer is read (strict
// envelopes, pointers, recogniser lines) and the stage loop (escalation, deadlines, fallback, trace).
// Callers frame the moment and supply a provider per stage; this module never builds one. Wardens run
// it live; Foundry's evals and Oracle's experiments run it through `scripts/evals/warden-charter.ts`.

export {
  type Charter,
  type ClassifyRole,
  charterFor,
  charterVersion,
} from './charters';
export {
  chartered,
  pointCharter,
  WARDEN_CHARTER,
  WARDEN_CHARTER_VERSION,
} from './charters/point.warden';
export { RECOGNISE_CHARTER } from './charters/recognise.warden';
export {
  type AddedSection,
  assemblePrompt,
  defaultSection,
  modeSections,
  PROMPT_SECTIONS,
  type SectionSource,
  type StageMode,
  stageModes,
  stageSections,
  withRegionInstructions,
} from './charters/sections';
export {
  ALL_OF_CAVEAT,
  CHOOSE_ONE_CAVEAT,
  MAX_POINTER_NAMES,
  type PointerCandidate,
  type PointerLevel,
  type PointerShape,
  parseWardenPointer,
  type WardenPointer,
} from './pointer';
export {
  ADVICE_RESPONSE_PROTOCOL,
  type AdviceAnswer,
  adviceResponseProtocol,
  type Envelope,
  FOLLOWUP_QUESTION,
  GUARD_RESPONSE_PROTOCOL,
  type GuardAnswerFinding,
  NO_COMMENT,
  NO_COMMENT_RULE,
  type ProtocolSpec,
  parseFollowup,
  protocolAnswer,
  readStageAnswer,
  responseProtocol,
  STRICT_RULE,
  type StageReading,
  validateAdviceResponse,
  validateGuardResponse,
} from './protocol';
export { parseRecognition, type Recognition } from './recognition';
export {
  type Carried,
  type ClassifiedSummary,
  type ClassifyResult,
  type ClassifyRunOptions,
  carriedSection,
  classifiedSummary,
  runStages,
  type StageCall,
  type StageDebug,
  type StageRun,
  stageRuns,
} from './run';
export {
  DEFAULT_STAGE,
  DEFAULT_STAGES,
  deadlineShares,
  EVAL_STAGE_KEYS,
  isDefaultStages,
  KNOWLEDGE_DOC,
  MAX_STAGES,
  type PointerSettings,
  STAGE_EFFORTS,
  type StageConfig,
  type StageEffort,
  type StageOutcomes,
  type StageReason,
  type StageTask,
  stageDocs,
  validateStages,
} from './stages';
