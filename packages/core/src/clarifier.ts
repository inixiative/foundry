import type { AgentConfig } from './base-agent';
import type { Classification } from './classifier';
import type { ContextStack } from './context-stack';
import { Decider, type DeciderConfig, type Decision } from './decider';
import type { ExecuteMeta } from './executor';

/** The raw message plus the classification already computed upstream. */
export interface ClarifyPayload {
  readonly message: string;
  readonly classification: Classification;
}

/** needed=true: the request is underspecified and `questions` says what is missing. */
export interface ClarificationResult {
  readonly needed: boolean;
  readonly questions?: string[];
  readonly reasoning?: string;
}

export type ClarifyHandler = (
  context: string,
  payload: ClarifyPayload,
  meta?: ExecuteMeta,
) => Promise<Decision<ClarificationResult>>;

export interface ClarifierConfig extends AgentConfig {
  handler: ClarifyHandler;
}

/**
 * A Clarifier is a Decider that checks whether a request is complete enough
 * to execute. Its context should hold only a compact completeness schema
 * (category -> required slots); pair it with a fast model.
 *
 * Sits between "route" and "execute". When needed=true the harness
 * short-circuits and returns the questions instead of dispatching execution.
 */
export class Clarifier extends Decider<ClarifyPayload, ClarificationResult> {
  constructor(config: ClarifierConfig) {
    super(config as DeciderConfig<ClarifyPayload, ClarificationResult>);
  }

  override withStack(stack: ContextStack): Clarifier {
    return new Clarifier({ ...this.agentConfig(stack), handler: this._handler });
  }
}
