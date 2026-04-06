import type { CompactionStrategy } from "./compaction";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HookPoint =
  | "pre:dispatch"
  | "post:dispatch"
  | "pre:classify"
  | "post:classify"
  | "pre:route"
  | "post:route"
  | "pre:compact"
  | "post:compact"
  | "session:create"
  | "session:archive"
  | "budget:warning"
  | "budget:exceeded"
  | "plan:enter"
  | "plan:exit"
  | "error:agent"
  | "error:provider";

export interface HookContext {
  hookPoint: HookPoint;
  threadId?: string;
  agentId?: string;
  payload?: unknown;
  result?: unknown;
  meta: Record<string, unknown>;
  timestamp: number;
}

export interface HookResult {
  action: "continue" | "skip" | "abort" | "redirect";
  /** If action is "redirect", the agent/route to redirect to. */
  redirectTo?: string;
  /** Modified fields to merge into the context. */
  modified?: Partial<HookContext>;
  /** Annotations for trace/observability. */
  annotations?: Record<string, unknown>;
}

export interface HookHandler {
  id: string;
  points: HookPoint[];
  /** Lower = runs first. Default 100. */
  priority?: number;
  handler: (ctx: HookContext) => Promise<HookResult>;
}

// ---------------------------------------------------------------------------
// TokenTracker — lightweight budget tracker used by budgetGuardHook
// ---------------------------------------------------------------------------

export interface TokenTracker {
  /** Total tokens consumed so far. */
  readonly used: number;
  /** Hard budget limit. */
  readonly limit: number;
  /** Optional soft warning threshold (0–1 ratio of limit). */
  readonly warningThreshold?: number;
}

// ---------------------------------------------------------------------------
// PlanModeConfig — configuration for the plan mode hook
// ---------------------------------------------------------------------------

export interface PlanModeTrigger {
  kind: "complexity" | "newDomain" | "largeDiff" | "custom";
  /** Threshold value for built-in triggers (e.g. token count for "complexity"). */
  threshold?: number;
  /** Custom detection function for "custom" triggers. */
  detect?: (ctx: HookContext) => boolean;
}

export interface PlanModeConfig {
  /** When to auto-enter plan mode. */
  triggers: PlanModeTrigger[];
  /** The planner agent to route to. */
  plannerAgentId: string;
  /** Whether to require approval before executing plan. */
  requireApproval?: boolean;
}

// ---------------------------------------------------------------------------
// HookRegistry
// ---------------------------------------------------------------------------

const DEFAULT_PRIORITY = 100;

/**
 * Central registry for lifecycle hooks.
 *
 * Hooks are registered for specific hook points and run in priority order
 * (lower priority number = earlier execution). Execution stops early
 * if any hook returns "abort".
 */
export class HookRegistry {
  private _handlers: Map<string, HookHandler> = new Map();

  /**
   * Register a hook handler. Returns an unsubscribe function.
   */
  register(handler: HookHandler): () => void {
    this._handlers.set(handler.id, handler);
    return () => {
      this._handlers.delete(handler.id);
    };
  }

  /**
   * Unregister a hook handler by id.
   */
  unregister(id: string): boolean {
    return this._handlers.delete(id);
  }

  /**
   * Execute all hooks for a given point in priority order.
   *
   * Each hook can modify the context (via `modified`), skip remaining
   * hooks ("skip"), abort the operation ("abort"), or redirect to a
   * different agent ("redirect").
   *
   * Returns the final context merged with the last action.
   */
  async execute(
    point: HookPoint,
    ctx: HookContext
  ): Promise<HookContext & { action: HookResult["action"] }> {
    const handlers = this.forPoint(point);
    let current = { ...ctx };
    let action: HookResult["action"] = "continue";

    for (const handler of handlers) {
      const result = await handler.handler(current);
      action = result.action;

      // Merge modifications into current context
      if (result.modified) {
        current = {
          ...current,
          ...result.modified,
          meta: { ...current.meta, ...result.modified.meta },
        };
      }

      // Merge annotations into meta
      if (result.annotations) {
        current.meta = { ...current.meta, ...result.annotations };
      }

      // Store redirect target in meta so callers can access it
      if (result.redirectTo) {
        current.meta = { ...current.meta, redirectTo: result.redirectTo };
      }

      if (action === "abort" || action === "skip" || action === "redirect") {
        break;
      }
    }

    return { ...current, action };
  }

  /**
   * Get all registered handlers for a given hook point, sorted by priority.
   */
  forPoint(point: HookPoint): ReadonlyArray<HookHandler> {
    const matching: HookHandler[] = [];

    for (const handler of this._handlers.values()) {
      if (handler.points.includes(point)) {
        matching.push(handler);
      }
    }

    matching.sort(
      (a, b) =>
        (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY)
    );

    return matching;
  }

  // -----------------------------------------------------------------------
  // Built-in hook factories
  // -----------------------------------------------------------------------

  /**
   * Creates a plan-mode hook that detects complex scenarios and redirects
   * to a planner agent.
   *
   * Triggers on "pre:dispatch" and checks each configured trigger:
   * - "complexity": payload string length exceeds threshold (default 4000 chars)
   * - "newDomain": payload contains unknown domain markers in meta
   * - "largeDiff": payload token estimate exceeds threshold
   * - "custom": calls the user-supplied detect function
   */
  static planModeHook(opts: PlanModeConfig): HookHandler {
    return {
      id: "builtin:plan-mode",
      points: ["pre:dispatch"],
      priority: 50,
      handler: async (ctx: HookContext): Promise<HookResult> => {
        let triggered = false;

        for (const trigger of opts.triggers) {
          switch (trigger.kind) {
            case "complexity": {
              const threshold = trigger.threshold ?? 4000;
              const payloadStr =
                typeof ctx.payload === "string"
                  ? ctx.payload
                  : JSON.stringify(ctx.payload ?? "");
              if (payloadStr.length > threshold) triggered = true;
              break;
            }

            case "newDomain": {
              // Check if meta signals an unknown domain
              if (ctx.meta.unknownDomain || ctx.meta.newDomain) {
                triggered = true;
              }
              break;
            }

            case "largeDiff": {
              const threshold = trigger.threshold ?? 2000;
              const payloadStr =
                typeof ctx.payload === "string"
                  ? ctx.payload
                  : JSON.stringify(ctx.payload ?? "");
              const estimatedTokens = Math.ceil(payloadStr.length / 4);
              if (estimatedTokens > threshold) triggered = true;
              break;
            }

            case "custom": {
              if (trigger.detect && trigger.detect(ctx)) {
                triggered = true;
              }
              break;
            }
          }

          if (triggered) break;
        }

        if (triggered) {
          return {
            action: "redirect",
            redirectTo: opts.plannerAgentId,
            annotations: {
              planMode: true,
              requireApproval: opts.requireApproval ?? false,
            },
          };
        }

        return { action: "continue" };
      },
    };
  }

  /**
   * Creates a budget guard hook that monitors token usage and emits
   * warnings or aborts when budget is exceeded.
   *
   * Triggers on "pre:dispatch":
   * - If usage exceeds warningThreshold, annotates with "budget:warning"
   * - If usage exceeds limit, returns "abort"
   */
  static budgetGuardHook(tracker: TokenTracker): HookHandler {
    return {
      id: "builtin:budget-guard",
      points: ["pre:dispatch"],
      priority: 10,
      handler: async (_ctx: HookContext): Promise<HookResult> => {
        const ratio = tracker.used / tracker.limit;
        const warningThreshold = tracker.warningThreshold ?? 0.8;

        if (ratio >= 1) {
          return {
            action: "abort",
            annotations: {
              budgetExceeded: true,
              budgetUsed: tracker.used,
              budgetLimit: tracker.limit,
            },
          };
        }

        if (ratio >= warningThreshold) {
          return {
            action: "continue",
            annotations: {
              budgetWarning: true,
              budgetUsed: tracker.used,
              budgetLimit: tracker.limit,
              budgetRatio: ratio,
            },
          };
        }

        return { action: "continue" };
      },
    };
  }

  /**
   * Creates an auto-compact hook that triggers compaction when the
   * context stack's estimated token usage exceeds a threshold.
   *
   * Triggers on "pre:dispatch". Reads `meta.stackTokens` (number)
   * to determine current token usage. If over threshold, annotates
   * with compaction plan info. The caller is responsible for executing
   * the actual compaction using the returned plan.
   */
  static autoCompactHook(
    strategy: CompactionStrategy,
    threshold: number
  ): HookHandler {
    return {
      id: "builtin:auto-compact",
      points: ["pre:dispatch"],
      priority: 20,
      handler: async (ctx: HookContext): Promise<HookResult> => {
        const stackTokens =
          typeof ctx.meta.stackTokens === "number"
            ? ctx.meta.stackTokens
            : 0;

        if (stackTokens <= threshold) {
          return { action: "continue" };
        }

        // Build a compaction plan from layer snapshots in meta
        const snapshots = Array.isArray(ctx.meta.layerSnapshots)
          ? (ctx.meta.layerSnapshots as import("./compaction").LayerSnapshot[])
          : [];

        const plan = strategy.select(snapshots, threshold);

        return {
          action: "continue",
          annotations: {
            autoCompact: true,
            compactionStrategy: strategy.id,
            compactionPlan: plan,
            stackTokens,
            threshold,
          },
        };
      },
    };
  }
}
