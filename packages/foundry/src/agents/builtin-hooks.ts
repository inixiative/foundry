import type {
  HookHandler,
  HookContext,
  HookResult,
  PlanModeConfig,
} from "@inixiative/foundry-core";

export interface HookTokenTracker {
  readonly used: number;
  readonly limit: number;
  readonly warningThreshold?: number;
}

export function planModeHook(opts: PlanModeConfig): HookHandler {
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
            const payloadStr = typeof ctx.payload === "string" ? ctx.payload : JSON.stringify(ctx.payload ?? "");
            if (payloadStr.length > threshold) triggered = true;
            break;
          }
          case "newDomain":
            if (ctx.meta.unknownDomain || ctx.meta.newDomain) triggered = true;
            break;
          case "largeDiff": {
            const threshold = trigger.threshold ?? 2000;
            const payloadStr = typeof ctx.payload === "string" ? ctx.payload : JSON.stringify(ctx.payload ?? "");
            if (Math.ceil(payloadStr.length / 4) > threshold) triggered = true;
            break;
          }
          case "custom":
            if (trigger.detect?.(ctx)) triggered = true;
            break;
        }
        if (triggered) break;
      }

      if (triggered) {
        return {
          action: "redirect",
          redirectTo: opts.plannerAgentId,
          annotations: { planMode: true, requireApproval: opts.requireApproval ?? false },
        };
      }
      return { action: "continue" };
    },
  };
}

export function budgetGuardHook(tracker: HookTokenTracker): HookHandler {
  return {
    id: "builtin:budget-guard",
    points: ["pre:dispatch"],
    priority: 10,
    handler: async (_ctx: HookContext): Promise<HookResult> => {
      const ratio = tracker.used / tracker.limit;
      if (ratio >= 1) {
        return { action: "abort", annotations: { budgetExceeded: true, budgetUsed: tracker.used, budgetLimit: tracker.limit } };
      }
      if (ratio >= (tracker.warningThreshold ?? 0.8)) {
        return { action: "continue", annotations: { budgetWarning: true, budgetUsed: tracker.used, budgetLimit: tracker.limit, budgetRatio: ratio } };
      }
      return { action: "continue" };
    },
  };
}
