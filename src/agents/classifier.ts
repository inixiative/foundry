import { Decider, type DeciderConfig, type Decision } from "./decider";
import type { AgentConfig } from "./base-agent";

/**
 * A classification — "what is this thing?"
 */
export interface Classification {
  readonly category: string;
  readonly subcategory?: string;
  readonly tags?: string[];
}

export type ClassifyHandler<TPayload> = (
  context: string,
  payload: TPayload
) => Promise<Decision<Classification>>;

export interface ClassifierConfig<TPayload = unknown> extends AgentConfig {
  handler: ClassifyHandler<TPayload>;
}

/**
 * A Classifier is a Decider that returns a category.
 *
 * "Given everything you know about the taxonomy, what IS this?"
 * The Classifier has the full taxonomy loaded in its context layers.
 * The caller sends a payload and gets back a category — not the taxonomy.
 */
export class Classifier<TPayload = unknown> extends Decider<
  TPayload,
  Classification
> {
  constructor(config: ClassifierConfig<TPayload>) {
    super(config as DeciderConfig<TPayload, Classification>);
  }
}
