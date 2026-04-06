import { Decider, type DeciderConfig, type Decision } from "./decider";
import type { AgentConfig } from "./base-agent";

/**
 * A routing decision — "where should this go?"
 */
export interface Route {
  readonly destination: string;
  readonly priority?: number;
  /** Optional context slice hint — what context the destination should receive. */
  readonly contextSlice?: string[];
}

export type RouteHandler<TPayload> = (
  context: string,
  payload: TPayload
) => Promise<Decision<Route>>;

export interface RouterConfig<TPayload = unknown> extends AgentConfig {
  handler: RouteHandler<TPayload>;
}

/**
 * A Router is a Decider that returns a destination.
 *
 * "Given everything you know about the topology, where does this GO?"
 * The Router has the full map loaded in its context layers.
 * The caller sends a payload and gets back a destination — not the map.
 */
export class Router<TPayload = unknown> extends Decider<TPayload, Route> {
  constructor(config: RouterConfig<TPayload>) {
    super(config as DeciderConfig<TPayload, Route>);
  }
}
