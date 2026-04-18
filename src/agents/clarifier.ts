import { Decider, type DeciderConfig, type Decision } from "./decider";
import type { AgentConfig } from "./base-agent";
import type { Classification } from "./classifier";

/**
 * What the clarifier receives: the raw message plus the classification
 * already computed upstream. No re-classification needed.
 */
export interface ClarifyPayload {
  readonly message: string;
  readonly classification: Classification;
}

/**
 * needed=false → request is complete enough to execute.
 * needed=true  → request is underspecified; questions contains what's missing.
 */
export interface ClarificationResult {
  readonly needed: boolean;
  readonly questions?: string[];
  readonly reasoning?: string;
}

export type ClarifyHandler = (
  context: string,
  payload: ClarifyPayload
) => Promise<Decision<ClarificationResult>>;

export interface ClarifierConfig extends AgentConfig {
  handler: ClarifyHandler;
}

/**
 * A Clarifier determines whether a request is complete enough to execute,
 * surfacing Socratic questions when it isn't.
 *
 * Fast by design: its context layer should contain ONLY a compact
 * "completeness schema" — a map of category → required slots. Not the full
 * taxonomy, not executor instructions, not conversation history.
 *
 *   { "code-generation": ["language", "goal", "constraints"],
 *     "data-query":       ["data source", "time range", "output format"] }
 *
 * The classification is passed directly as payload (already computed upstream)
 * so the clarifier can look up the right slot list without re-classifying.
 * Pair with a fast model (Haiku-class) — this is slot-checking, not reasoning.
 *
 * Sits between "route" and "execute" in the flow. When needed=true the harness
 * short-circuits and returns the questions instead of dispatching to the executor.
 */
export class Clarifier extends Decider<ClarifyPayload, ClarificationResult> {
  constructor(config: ClarifierConfig) {
    super(config as DeciderConfig<ClarifyPayload, ClarificationResult>);
  }
}
