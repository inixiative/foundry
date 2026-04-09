// ---------------------------------------------------------------------------
// Capability — permission flags and gating for dangerous operations
// ---------------------------------------------------------------------------
//
// Every operation that could be dangerous (file writes, network calls,
// expensive LLM calls, data deletion, shell execution) is a "capability."
//
// A PermissionPolicy maps capabilities to permission levels:
//   - "allow"  → proceed silently
//   - "prompt" → emit an ActionPrompt and wait for approval
//   - "deny"   → reject immediately
//
// CapabilityGate checks permissions before operations. When a check
// results in "prompt", the gate uses the ActionQueue to block until
// a human (or policy hook) approves.
// ---------------------------------------------------------------------------

import { ActionQueue, type ActionResolution } from "./action-prompt";

// ---------------------------------------------------------------------------
// Built-in capabilities
// ---------------------------------------------------------------------------

/**
 * Known capability categories. Adapters and providers use these
 * to declare what they need. Custom capabilities use string literals.
 */
export type BuiltinCapability =
  // File system
  | "file:read"
  | "file:write"
  | "file:delete"
  // Network
  | "net:fetch"
  | "net:api"
  // LLM
  | "llm:call"
  | "llm:expensive"
  // Data stores
  | "data:read"
  | "data:write"
  | "data:delete"
  // Execution
  | "exec:shell"
  | "exec:process"
  // Browser
  | "browser:navigate"
  | "browser:interact"
  | "browser:execute"
  | "browser:screenshot"
  // Meta
  | "prompt:auto-resolve";

/** Any string is a valid capability. Builtins are just conventions. */
export type Capability = BuiltinCapability | (string & {});

export type PermissionLevel = "allow" | "prompt" | "deny";

// ---------------------------------------------------------------------------
// PermissionPolicy
// ---------------------------------------------------------------------------

export interface PermissionPolicy {
  /** Default for capabilities not explicitly listed. */
  defaults: PermissionLevel;
  /** Per-capability overrides. */
  capabilities: Partial<Record<string, PermissionLevel>>;
  /** Auto-prompt for LLM calls estimated above this dollar amount. */
  costThreshold?: number;
  /** Auto-prompt for operations touching these path patterns. */
  protectedPaths?: string[];
}

/** Convenience: everything allowed, no prompts. */
export const UNATTENDED_POLICY: PermissionPolicy = {
  defaults: "allow",
  capabilities: {},
};

/** Convenience: prompt for writes/deletes/exec/expensive, allow reads. */
export const SUPERVISED_POLICY: PermissionPolicy = {
  defaults: "prompt",
  capabilities: {
    "file:read": "allow",
    "data:read": "allow",
    "net:fetch": "allow",
    "llm:call": "allow",
  },
};

/** Convenience: deny dangerous ops, allow reads and cheap LLM. */
export const RESTRICTED_POLICY: PermissionPolicy = {
  defaults: "deny",
  capabilities: {
    "file:read": "allow",
    "data:read": "allow",
    "net:fetch": "allow",
    "llm:call": "allow",
    "llm:expensive": "deny",
    "exec:shell": "deny",
    "exec:process": "deny",
    "file:delete": "deny",
    "data:delete": "deny",
    "browser:navigate": "deny",
    "browser:interact": "deny",
    "browser:execute": "deny",
    "browser:screenshot": "deny",
  },
};

/** Convenience: browser-capable agent — allows navigation and interaction, prompts for JS execution. */
export const BROWSER_POLICY: PermissionPolicy = {
  defaults: "prompt",
  capabilities: {
    "file:read": "allow",
    "data:read": "allow",
    "net:fetch": "allow",
    "llm:call": "allow",
    "browser:navigate": "allow",
    "browser:interact": "allow",
    "browser:execute": "prompt",
    "browser:screenshot": "allow",
    "exec:shell": "deny",
    "exec:process": "deny",
    "file:delete": "deny",
    "data:delete": "deny",
  },
};

// ---------------------------------------------------------------------------
// CapabilityGate
// ---------------------------------------------------------------------------

export class CapabilityDeniedError extends Error {
  readonly capability: string;
  readonly level: PermissionLevel;
  constructor(capability: string, level: PermissionLevel) {
    super(`Capability "${capability}" is ${level}`);
    this.name = "CapabilityDeniedError";
    this.capability = capability;
    this.level = level;
  }
}

export interface GateContext {
  agentId: string;
  threadId: string;
  /** Extra info for the prompt message (path, cost, model, etc.). */
  detail?: string;
  meta?: Record<string, unknown>;
}

export class CapabilityGate {
  private _policy: PermissionPolicy;
  private _queue: ActionQueue;

  constructor(policy: PermissionPolicy, queue: ActionQueue) {
    this._policy = policy;
    this._queue = queue;
  }

  get policy(): PermissionPolicy { return this._policy; }

  /** Update policy at runtime (e.g. operator toggles supervised mode). */
  setPolicy(policy: PermissionPolicy): void {
    this._policy = policy;
  }

  /**
   * Check a capability. Returns the resolution if prompted, or
   * a synthetic resolution for allow/deny.
   */
  async check(capability: Capability, ctx: GateContext): Promise<ActionResolution> {
    const level = this._resolve(capability, ctx);

    if (level === "allow") {
      return { by: "policy", action: "approved", timestamp: Date.now() };
    }

    if (level === "deny") {
      return { by: "policy", action: "rejected", timestamp: Date.now() };
    }

    // level === "prompt"
    const message = this._buildMessage(capability, ctx);
    return this._queue.prompt({
      kind: "approval",
      message,
      agentId: ctx.agentId,
      threadId: ctx.threadId,
      capability,
      urgency: this._urgencyFor(capability),
      meta: ctx.meta,
    });
  }

  /**
   * Check and throw if denied or rejected.
   * Use this as a guard before dangerous operations.
   */
  async require(capability: Capability, ctx: GateContext): Promise<void> {
    const resolution = await this.check(capability, ctx);
    if (resolution.action !== "approved") {
      throw new CapabilityDeniedError(capability, "deny");
    }
  }

  /**
   * Synchronous check — returns the permission level without prompting.
   * Use this when you need to know the level but can't block.
   */
  levelFor(capability: Capability, ctx?: Partial<GateContext>): PermissionLevel {
    return this._resolve(capability, ctx as GateContext);
  }

  // -- Internal --

  private _resolve(capability: Capability, ctx?: GateContext): PermissionLevel {
    // Explicit capability override
    const explicit = this._policy.capabilities[capability];
    if (explicit) return explicit;

    // Cost threshold check for LLM calls
    if (capability === "llm:call" && this._policy.costThreshold != null && ctx?.meta?.estimatedCost != null) {
      if ((ctx.meta.estimatedCost as number) > this._policy.costThreshold) {
        return "prompt";
      }
    }

    // Protected paths check for file ops
    if ((capability === "file:write" || capability === "file:delete") && this._policy.protectedPaths?.length && ctx?.meta?.path) {
      const path = ctx.meta.path as string;
      if (this._policy.protectedPaths.some((p) => path.includes(p))) {
        return "prompt";
      }
    }

    return this._policy.defaults;
  }

  private _buildMessage(capability: Capability, ctx: GateContext): string {
    const detail = ctx.detail ? ` — ${ctx.detail}` : "";
    return `Agent "${ctx.agentId}" requires capability "${capability}"${detail}`;
  }

  private _urgencyFor(capability: Capability): "low" | "normal" | "high" | "critical" {
    if (capability === "exec:shell" || capability === "exec:process") return "high";
    if (capability.endsWith(":delete")) return "high";
    if (capability === "llm:expensive") return "normal";
    return "normal";
  }
}
