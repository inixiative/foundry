import type {
  ContextLayer,
  ContextStack,
  ExecutionResult,
  DispatchContext,
  Middleware,
  SignalBus,
  Signal,
} from "@inixiative/foundry-core";

// ---------------------------------------------------------------------------
// Reaction rules — what to do when a dispatch completes
// ---------------------------------------------------------------------------

/**
 * Context passed to a reaction rule's `act` function.
 * Gives the rule everything it needs to mutate the thread's state.
 */
export interface ReactionContext {
  /** The dispatch that just completed. */
  readonly dispatch: DispatchContext;
  /** The result of the dispatch. */
  readonly result: ExecutionResult;
  /** The thread's full context stack (can warm/set layers). */
  readonly stack: ContextStack;
  /** The thread's RunContext layer (ephemeral, per-thread). */
  readonly runContext: ContextLayer | null;
  /** The thread's signal bus (for emitting new signals). */
  readonly signals: SignalBus;
  /** Append text to the RunContext layer. */
  appendRunContext(text: string): void;
  /** Re-warm a specific layer (reload from sources). */
  rewarmLayer(layerId: string): Promise<void>;
  /** Set a layer's content directly. */
  setLayer(layerId: string, content: string): void;
  /** Emit a signal. */
  emit(signal: Omit<Signal, "id" | "timestamp">): void;
}

/**
 * A reaction rule — fires after a dispatch based on a condition.
 */
export interface ReactionRule {
  /** Unique ID for this rule. */
  readonly id: string;
  /** Human-readable description. */
  readonly description?: string;
  /**
   * When to fire. Receives the dispatch context and result.
   * Return true to trigger the `act` function.
   */
  when: (dispatch: DispatchContext, result: ExecutionResult) => boolean;
  /**
   * What to do. Can mutate the RunContext layer, re-warm layers,
   * emit signals, or write to memory.
   */
  act: (ctx: ReactionContext) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// ReactiveMiddleware — fires rules after each dispatch
// ---------------------------------------------------------------------------

export interface ReactiveMiddlewareConfig {
  /** The thread's context stack. */
  stack: ContextStack;
  /** The thread's signal bus. */
  signals: SignalBus;
  /** Thread ID (used to find the RunContext layer). */
  threadId: string;
}

/**
 * Middleware that fires reaction rules after each dispatch.
 *
 * Wraps `next()`, gets the result, then checks each rule.
 * Rules can mutate the RunContext layer, re-warm other layers,
 * emit signals, or write to persistent memory.
 *
 * This is what makes agents and layers dynamic during a run.
 *
 * Usage:
 *   const reactive = new ReactiveMiddleware({ stack, signals, threadId });
 *   reactive.addRule({ ... });
 *   thread.middleware.use("reactive", reactive.asMiddleware());
 */
export class ReactiveMiddleware {
  private _rules: ReactionRule[] = [];
  private _stack: ContextStack;
  private _signals: SignalBus;
  private _threadId: string;

  constructor(config: ReactiveMiddlewareConfig) {
    this._stack = config.stack;
    this._signals = config.signals;
    this._threadId = config.threadId;
  }

  addRule(rule: ReactionRule): void {
    this._rules.push(rule);
  }

  removeRule(id: string): boolean {
    const idx = this._rules.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    this._rules.splice(idx, 1);
    return true;
  }

  get rules(): ReadonlyArray<ReactionRule> {
    return this._rules;
  }

  /**
   * Returns a Middleware function for use with thread.middleware.use().
   */
  asMiddleware(): Middleware {
    return async (ctx, next) => {
      const result = await next();

      // Build reaction context
      const runContext = this._stack.getLayer(`run:${this._threadId}`) ?? null;

      const reactionCtx: ReactionContext = {
        dispatch: ctx,
        result,
        stack: this._stack,
        runContext,
        signals: this._signals,

        appendRunContext: (text: string) => {
          if (!runContext) return;
          const current = runContext.content;
          const updated = current ? `${current}\n\n${text}` : text;
          runContext.set(updated);
        },

        rewarmLayer: async (layerId: string) => {
          const layer = this._stack.getLayer(layerId);
          if (layer) {
            layer.invalidate();
            await layer.warm();
          }
        },

        setLayer: (layerId: string, content: string) => {
          const layer = this._stack.getLayer(layerId);
          if (layer) layer.set(content);
        },

        emit: (signal) => {
          this._signals.emit({
            ...signal,
            id: `sig_${crypto.randomUUID()}`,
            timestamp: Date.now(),
          });
        },
      };

      // Fire matching rules
      for (const rule of this._rules) {
        try {
          if (rule.when(ctx, result)) {
            await rule.act(reactionCtx);
          }
        } catch (err) {
          // Rule errors don't break the pipeline — log and continue
          console.warn(`[reactive] rule "${rule.id}" failed:`, (err as Error).message);
        }
      }

      return result;
    };
  }
}

// ---------------------------------------------------------------------------
// Built-in reaction rules
// ---------------------------------------------------------------------------

/**
 * Logs low-confidence results to the RunContext so downstream stages
 * can see that upstream was uncertain.
 */
export function lowConfidenceRule(threshold: number = 0.5): ReactionRule {
  return {
    id: "low-confidence",
    description: `Flag results with confidence below ${threshold}`,
    when: (_ctx, result) => {
      const output = result.output as any;
      return typeof output?.confidence === "number" && output.confidence < threshold;
    },
    act: (ctx) => {
      const output = ctx.result.output as any;
      ctx.appendRunContext(
        `[low-confidence] ${ctx.dispatch.agentId} returned confidence=${output.confidence}: ${output.reasoning ?? "no reason"}`
      );
    },
  };
}

/**
 * When a classification override happens (router disagrees with classifier),
 * record it in RunContext so the executor sees the correction.
 */
export function classificationOverrideRule(): ReactionRule {
  return {
    id: "classification-override",
    description: "Record when router overrides classifier's category",
    when: (ctx, _result) => {
      // Fires on route stage — check if annotations show a mismatch
      return ctx.agentId.includes("router") && ctx.annotations["classifierCategory"] !== undefined;
    },
    act: (ctx) => {
      const original = ctx.dispatch.annotations["classifierCategory"];
      const routed = (ctx.result.output as any)?.value?.destination;
      if (original && routed) {
        ctx.appendRunContext(
          `[override] Classifier said "${original}" but router chose "${routed}"`
        );
      }
    },
  };
}

/**
 * Re-warm a layer when a specific agent runs.
 * Useful for keeping context fresh based on pipeline activity.
 */
export function rewarmOnAgentRule(agentId: string, layerId: string): ReactionRule {
  return {
    id: `rewarm-${layerId}-on-${agentId}`,
    description: `Re-warm layer "${layerId}" after agent "${agentId}" runs`,
    when: (ctx) => ctx.agentId === agentId,
    act: async (ctx) => {
      await ctx.rewarmLayer(layerId);
    },
  };
}

/**
 * Emit a signal when an agent's output matches a pattern.
 * Useful for capturing corrections, conventions, or patterns.
 */
export function emitOnPatternRule(
  agentId: string,
  pattern: RegExp,
  signalKind: string,
): ReactionRule {
  return {
    id: `emit-${signalKind}-on-${agentId}`,
    description: `Emit "${signalKind}" signal when ${agentId} output matches ${pattern}`,
    when: (ctx, result) => {
      if (ctx.agentId !== agentId) return false;
      const output = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
      return pattern.test(output);
    },
    act: (ctx) => {
      const output = typeof ctx.result.output === "string"
        ? ctx.result.output
        : JSON.stringify(ctx.result.output);
      ctx.emit({
        kind: signalKind,
        source: `agent:${ctx.dispatch.agentId}`,
        content: { match: output.slice(0, 500) },
        confidence: 0.8,
      });
    },
  };
}
