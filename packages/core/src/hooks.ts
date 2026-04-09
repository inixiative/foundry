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
  redirectTo?: string;
  modified?: Partial<HookContext>;
  annotations?: Record<string, unknown>;
}

export interface HookHandler {
  id: string;
  points: HookPoint[];
  priority?: number;
  handler: (ctx: HookContext) => Promise<HookResult>;
}

export interface PlanModeTrigger {
  kind: "complexity" | "newDomain" | "largeDiff" | "custom";
  threshold?: number;
  detect?: (ctx: HookContext) => boolean;
}

export interface PlanModeConfig {
  triggers: PlanModeTrigger[];
  plannerAgentId: string;
  requireApproval?: boolean;
}

// ---------------------------------------------------------------------------
// HookRegistry — engine mechanism, no built-in behaviors
// ---------------------------------------------------------------------------

const DEFAULT_PRIORITY = 100;

export class HookRegistry {
  private _handlers: Map<string, HookHandler> = new Map();

  register(handler: HookHandler): () => void {
    this._handlers.set(handler.id, handler);
    return () => { this._handlers.delete(handler.id); };
  }

  unregister(id: string): boolean {
    return this._handlers.delete(id);
  }

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

      if (result.modified) {
        current = {
          ...current,
          ...result.modified,
          meta: { ...current.meta, ...result.modified.meta },
        };
      }

      if (result.annotations) {
        current.meta = { ...current.meta, ...result.annotations };
      }

      if (result.redirectTo) {
        current.meta = { ...current.meta, redirectTo: result.redirectTo };
      }

      if (action === "abort" || action === "skip" || action === "redirect") {
        break;
      }
    }

    return { ...current, action };
  }

  forPoint(point: HookPoint): ReadonlyArray<HookHandler> {
    const matching: HookHandler[] = [];
    for (const handler of this._handlers.values()) {
      if (handler.points.includes(point)) {
        matching.push(handler);
      }
    }
    matching.sort(
      (a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY)
    );
    return matching;
  }

  get size(): number {
    return this._handlers.size;
  }

  get handlers(): ReadonlyArray<HookHandler> {
    return [...this._handlers.values()];
  }
}
