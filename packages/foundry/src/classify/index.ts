// Foundry's one classification primitive: what a decision role is told about answering (charters,
// response protocols) and how its answer is read (strict envelopes, pointers). Wardens run it live;
// Foundry's evals and Oracle's experiments run the same code through `scripts/evals/warden-charter.ts`.

export { chartered, WARDEN_CHARTER, WARDEN_CHARTER_VERSION } from './charters/point.warden';
export {
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
  GUARD_RESPONSE_PROTOCOL,
  type GuardAnswerFinding,
  NO_COMMENT,
  NO_COMMENT_RULE,
  protocolAnswer,
  STRICT_RULE,
  validateAdviceResponse,
  validateGuardResponse,
} from './protocol';
