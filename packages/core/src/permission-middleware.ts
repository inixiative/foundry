import type { Middleware, DispatchContext, MiddlewareNext } from "./middleware";
import {
  CapabilityGate,
  CapabilityDeniedError,
  type Capability,
} from "./capability";

export interface PermissionCheckResult {
  action: "allow" | "deny" | "ask";
  /** Optional modified payload (like Claude Code's updatedInput). */
  modifiedPayload?: unknown;
  /** Reason for denial. */
  reason?: string;
}

export interface PermissionCheck {
  /** Which capability this check relates to. */
  capability: Capability;
  /** Narrow the check to specific agents. If omitted, applies to all. */
  agentIds?: string[];
  /** Custom check logic beyond the gate. */
  check: (ctx: DispatchContext) => PermissionCheckResult | Promise<PermissionCheckResult>;
}

export interface PermissionMiddlewareConfig {
  /** The capability gate to check against. */
  gate: CapabilityGate;
  /** Thread ID for prompt context. */
  threadId: string;
  /** Default capability to check for all dispatches. Default: "llm:call". */
  defaultCapability?: Capability;
  /** Additional custom permission checks. */
  checks?: PermissionCheck[];
}

/**
 * Creates a middleware that checks permissions before dispatch.
 *
 * Integrates the existing CapabilityGate into the dispatch pipeline.
 * Records permission decisions in ctx.annotations.
 */
export function permissionMiddleware(config: PermissionMiddlewareConfig): Middleware {
  const {
    gate,
    threadId,
    defaultCapability = "llm:call",
    checks,
  } = config;

  return async (ctx: DispatchContext, next: MiddlewareNext) => {
    // Check default capability via gate
    const resolution = await gate.check(defaultCapability, {
      agentId: ctx.agentId,
      threadId,
      detail: `Dispatch to agent ${ctx.agentId}`,
    });

    if (resolution.action === "rejected") {
      ctx.annotations["permission:denied"] = true;
      ctx.annotations["permission:capability"] = defaultCapability;
      throw new CapabilityDeniedError(defaultCapability, "deny");
    }

    ctx.annotations["permission:approved"] = true;
    ctx.annotations["permission:by"] = resolution.by;

    // Run custom checks
    if (checks) {
      for (const check of checks) {
        if (check.agentIds && !check.agentIds.includes(ctx.agentId)) continue;

        const result = await check.check(ctx);

        if (result.action === "deny") {
          ctx.annotations["permission:denied"] = true;
          ctx.annotations["permission:capability"] = check.capability;
          ctx.annotations["permission:reason"] = result.reason;
          throw new CapabilityDeniedError(
            check.capability,
            "deny",
          );
        }

        if (result.modifiedPayload !== undefined) {
          ctx.annotations["permission:modifiedPayload"] = result.modifiedPayload;
        }
      }
    }

    return next();
  };
}
