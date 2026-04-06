import { describe, test, expect } from "bun:test";
import {
  HookRegistry,
  type HookContext,
  type HookHandler,
  type HookResult,
  type HookPoint,
  type TokenTracker,
} from "../src/agents/hooks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<HookContext>): HookContext {
  return {
    hookPoint: "pre:dispatch",
    threadId: "thread-1",
    agentId: "coder",
    payload: "test payload",
    meta: {},
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeHandler(
  id: string,
  points: HookPoint[],
  result: HookResult,
  opts?: { priority?: number }
): HookHandler {
  return {
    id,
    points,
    priority: opts?.priority,
    handler: async (_ctx: HookContext) => result,
  };
}

// ---------------------------------------------------------------------------
// HookRegistry
// ---------------------------------------------------------------------------

describe("HookRegistry", () => {
  // 1. Register and execute
  describe("register and execute", () => {
    test("registered hook is called when its point is executed", async () => {
      const registry = new HookRegistry();
      let called = false;

      registry.register({
        id: "test-hook",
        points: ["pre:dispatch"],
        handler: async (_ctx) => {
          called = true;
          return { action: "continue" };
        },
      });

      await registry.execute("pre:dispatch", makeContext());
      expect(called).toBe(true);
    });

    test("hook receives the context", async () => {
      const registry = new HookRegistry();
      let receivedCtx: HookContext | null = null;

      registry.register({
        id: "ctx-hook",
        points: ["pre:dispatch"],
        handler: async (ctx) => {
          receivedCtx = ctx;
          return { action: "continue" };
        },
      });

      const ctx = makeContext({ agentId: "planner", threadId: "t-99" });
      await registry.execute("pre:dispatch", ctx);

      expect(receivedCtx).not.toBeNull();
      expect(receivedCtx!.agentId).toBe("planner");
      expect(receivedCtx!.threadId).toBe("t-99");
    });
  });

  // 2. Priority ordering
  describe("priority ordering", () => {
    test("hooks execute in priority order (lower number first)", async () => {
      const registry = new HookRegistry();
      const order: string[] = [];

      registry.register({
        id: "low-priority",
        points: ["pre:dispatch"],
        priority: 200,
        handler: async () => {
          order.push("low");
          return { action: "continue" };
        },
      });

      registry.register({
        id: "high-priority",
        points: ["pre:dispatch"],
        priority: 10,
        handler: async () => {
          order.push("high");
          return { action: "continue" };
        },
      });

      registry.register({
        id: "mid-priority",
        points: ["pre:dispatch"],
        priority: 100,
        handler: async () => {
          order.push("mid");
          return { action: "continue" };
        },
      });

      await registry.execute("pre:dispatch", makeContext());
      expect(order).toEqual(["high", "mid", "low"]);
    });

    test("hooks without priority default to 100", async () => {
      const registry = new HookRegistry();
      const order: string[] = [];

      registry.register({
        id: "explicit-99",
        points: ["pre:dispatch"],
        priority: 99,
        handler: async () => {
          order.push("first");
          return { action: "continue" };
        },
      });

      registry.register({
        id: "default-priority",
        points: ["pre:dispatch"],
        // no priority => defaults to 100
        handler: async () => {
          order.push("second");
          return { action: "continue" };
        },
      });

      await registry.execute("pre:dispatch", makeContext());
      expect(order).toEqual(["first", "second"]);
    });
  });

  // 3. Abort stops chain
  describe("abort stops chain", () => {
    test("abort prevents subsequent hooks from running", async () => {
      const registry = new HookRegistry();
      let secondCalled = false;

      registry.register({
        id: "aborter",
        points: ["pre:dispatch"],
        priority: 10,
        handler: async () => ({ action: "abort" }),
      });

      registry.register({
        id: "after-abort",
        points: ["pre:dispatch"],
        priority: 20,
        handler: async () => {
          secondCalled = true;
          return { action: "continue" };
        },
      });

      const result = await registry.execute("pre:dispatch", makeContext());
      expect(result.action).toBe("abort");
      expect(secondCalled).toBe(false);
    });
  });

  // 4. Skip action
  describe("skip action", () => {
    test("skip action is reflected in result", async () => {
      const registry = new HookRegistry();

      registry.register({
        id: "skipper",
        points: ["pre:dispatch"],
        handler: async () => ({ action: "skip" }),
      });

      const result = await registry.execute("pre:dispatch", makeContext());
      expect(result.action).toBe("skip");
    });

    test("skip prevents subsequent hooks from running", async () => {
      const registry = new HookRegistry();
      let afterSkipCalled = false;

      registry.register({
        id: "skipper",
        points: ["pre:dispatch"],
        priority: 10,
        handler: async () => ({ action: "skip" }),
      });

      registry.register({
        id: "after-skip",
        points: ["pre:dispatch"],
        priority: 20,
        handler: async () => {
          afterSkipCalled = true;
          return { action: "continue" };
        },
      });

      await registry.execute("pre:dispatch", makeContext());
      expect(afterSkipCalled).toBe(false);
    });
  });

  // 5. Redirect action
  describe("redirect action", () => {
    test("redirect with redirectTo is stored in meta", async () => {
      const registry = new HookRegistry();

      registry.register({
        id: "redirector",
        points: ["pre:dispatch"],
        handler: async () => ({
          action: "redirect",
          redirectTo: "planner-agent",
        }),
      });

      const result = await registry.execute("pre:dispatch", makeContext());
      expect(result.action).toBe("redirect");
      expect(result.meta.redirectTo).toBe("planner-agent");
    });

    test("redirect stops the chain", async () => {
      const registry = new HookRegistry();
      let afterRedirectCalled = false;

      registry.register({
        id: "redirector",
        points: ["pre:dispatch"],
        priority: 10,
        handler: async () => ({
          action: "redirect",
          redirectTo: "planner-agent",
        }),
      });

      registry.register({
        id: "after-redirect",
        points: ["pre:dispatch"],
        priority: 20,
        handler: async () => {
          afterRedirectCalled = true;
          return { action: "continue" };
        },
      });

      await registry.execute("pre:dispatch", makeContext());
      expect(afterRedirectCalled).toBe(false);
    });
  });

  // 6. Multiple hook points
  describe("multiple hook points", () => {
    test("handler registered for multiple points is called for each", async () => {
      const registry = new HookRegistry();
      const calledAt: HookPoint[] = [];

      registry.register({
        id: "multi-point",
        points: ["pre:dispatch", "post:dispatch", "pre:classify"],
        handler: async (ctx) => {
          calledAt.push(ctx.hookPoint);
          return { action: "continue" };
        },
      });

      await registry.execute("pre:dispatch", makeContext({ hookPoint: "pre:dispatch" }));
      await registry.execute("post:dispatch", makeContext({ hookPoint: "post:dispatch" }));
      await registry.execute("pre:classify", makeContext({ hookPoint: "pre:classify" }));
      // Should not be called for unregistered point
      await registry.execute("pre:route", makeContext({ hookPoint: "pre:route" }));

      expect(calledAt).toEqual(["pre:dispatch", "post:dispatch", "pre:classify"]);
    });
  });

  // 7. Unregister
  describe("unregister", () => {
    test("unregistered hook is not called", async () => {
      const registry = new HookRegistry();
      let called = false;

      registry.register({
        id: "removable",
        points: ["pre:dispatch"],
        handler: async () => {
          called = true;
          return { action: "continue" };
        },
      });

      registry.unregister("removable");
      await registry.execute("pre:dispatch", makeContext());

      expect(called).toBe(false);
    });

    test("register returns unsubscribe function that removes hook", async () => {
      const registry = new HookRegistry();
      let callCount = 0;

      const unsub = registry.register({
        id: "unsub-hook",
        points: ["pre:dispatch"],
        handler: async () => {
          callCount++;
          return { action: "continue" };
        },
      });

      await registry.execute("pre:dispatch", makeContext());
      expect(callCount).toBe(1);

      unsub();
      await registry.execute("pre:dispatch", makeContext());
      expect(callCount).toBe(1); // not called again
    });

    test("unregister returns false for unknown id", () => {
      const registry = new HookRegistry();
      expect(registry.unregister("nonexistent")).toBe(false);
    });

    test("unregister returns true for known id", () => {
      const registry = new HookRegistry();
      registry.register({
        id: "known",
        points: ["pre:dispatch"],
        handler: async () => ({ action: "continue" }),
      });
      expect(registry.unregister("known")).toBe(true);
    });
  });

  // 8. forPoint
  describe("forPoint", () => {
    test("returns only hooks for the specified point", () => {
      const registry = new HookRegistry();

      registry.register({
        id: "dispatch-hook",
        points: ["pre:dispatch"],
        handler: async () => ({ action: "continue" }),
      });

      registry.register({
        id: "classify-hook",
        points: ["pre:classify"],
        handler: async () => ({ action: "continue" }),
      });

      registry.register({
        id: "both-hook",
        points: ["pre:dispatch", "pre:classify"],
        handler: async () => ({ action: "continue" }),
      });

      const dispatchHooks = registry.forPoint("pre:dispatch");
      expect(dispatchHooks.length).toBe(2);
      const ids = dispatchHooks.map((h) => h.id);
      expect(ids).toContain("dispatch-hook");
      expect(ids).toContain("both-hook");

      const classifyHooks = registry.forPoint("pre:classify");
      expect(classifyHooks.length).toBe(2);
      const classifyIds = classifyHooks.map((h) => h.id);
      expect(classifyIds).toContain("classify-hook");
      expect(classifyIds).toContain("both-hook");
    });

    test("returns empty array when no hooks match", () => {
      const registry = new HookRegistry();
      expect(registry.forPoint("pre:route").length).toBe(0);
    });

    test("returned hooks are sorted by priority", () => {
      const registry = new HookRegistry();

      registry.register({
        id: "late",
        points: ["pre:dispatch"],
        priority: 200,
        handler: async () => ({ action: "continue" }),
      });

      registry.register({
        id: "early",
        points: ["pre:dispatch"],
        priority: 5,
        handler: async () => ({ action: "continue" }),
      });

      const hooks = registry.forPoint("pre:dispatch");
      expect(hooks[0].id).toBe("early");
      expect(hooks[1].id).toBe("late");
    });
  });

  // 9. Modified context
  describe("modified context", () => {
    test("hook modifications are visible to downstream hooks", async () => {
      const registry = new HookRegistry();
      let downstreamPayload: unknown = null;

      registry.register({
        id: "modifier",
        points: ["pre:dispatch"],
        priority: 10,
        handler: async () => ({
          action: "continue",
          modified: { payload: "modified-payload" },
        }),
      });

      registry.register({
        id: "reader",
        points: ["pre:dispatch"],
        priority: 20,
        handler: async (ctx) => {
          downstreamPayload = ctx.payload;
          return { action: "continue" };
        },
      });

      await registry.execute("pre:dispatch", makeContext({ payload: "original" }));
      expect(downstreamPayload).toBe("modified-payload");
    });

    test("meta modifications are merged", async () => {
      const registry = new HookRegistry();

      registry.register({
        id: "meta-setter",
        points: ["pre:dispatch"],
        priority: 10,
        handler: async () => ({
          action: "continue",
          modified: { meta: { key1: "value1" } },
        }),
      });

      registry.register({
        id: "meta-reader",
        points: ["pre:dispatch"],
        priority: 20,
        handler: async () => ({
          action: "continue",
          modified: { meta: { key2: "value2" } },
        }),
      });

      const result = await registry.execute(
        "pre:dispatch",
        makeContext({ meta: { existing: true } })
      );

      expect(result.meta.existing).toBe(true);
      expect(result.meta.key1).toBe("value1");
      expect(result.meta.key2).toBe("value2");
    });

    test("annotations are merged into meta", async () => {
      const registry = new HookRegistry();

      registry.register({
        id: "annotator",
        points: ["pre:dispatch"],
        handler: async () => ({
          action: "continue",
          annotations: { traceId: "abc-123", step: 1 },
        }),
      });

      const result = await registry.execute("pre:dispatch", makeContext());
      expect(result.meta.traceId).toBe("abc-123");
      expect(result.meta.step).toBe(1);
    });
  });

  // 10. planModeHook — built-in plan mode hook
  describe("planModeHook", () => {
    test("redirects when payload exceeds complexity threshold", async () => {
      const hook = HookRegistry.planModeHook({
        triggers: [{ kind: "complexity", threshold: 100 }],
        plannerAgentId: "planner",
      });

      const registry = new HookRegistry();
      registry.register(hook);

      // Large payload exceeds threshold of 100 chars
      const largePayload = "x".repeat(200);
      const result = await registry.execute(
        "pre:dispatch",
        makeContext({ payload: largePayload })
      );

      expect(result.action).toBe("redirect");
      expect(result.meta.redirectTo).toBe("planner");
      expect(result.meta.planMode).toBe(true);
    });

    test("continues when payload is under complexity threshold", async () => {
      const hook = HookRegistry.planModeHook({
        triggers: [{ kind: "complexity", threshold: 5000 }],
        plannerAgentId: "planner",
      });

      const registry = new HookRegistry();
      registry.register(hook);

      const result = await registry.execute(
        "pre:dispatch",
        makeContext({ payload: "short" })
      );

      expect(result.action).toBe("continue");
    });

    test("detects largeDiff trigger", async () => {
      const hook = HookRegistry.planModeHook({
        triggers: [{ kind: "largeDiff", threshold: 10 }],
        plannerAgentId: "planner",
      });

      const registry = new HookRegistry();
      registry.register(hook);

      // threshold is 10 tokens, estimatedTokens = ceil(len/4), so need > 40 chars
      const largeDiff = "a".repeat(50);
      const result = await registry.execute(
        "pre:dispatch",
        makeContext({ payload: largeDiff })
      );

      expect(result.action).toBe("redirect");
    });

    test("detects newDomain trigger via meta", async () => {
      const hook = HookRegistry.planModeHook({
        triggers: [{ kind: "newDomain" }],
        plannerAgentId: "planner",
      });

      const registry = new HookRegistry();
      registry.register(hook);

      const result = await registry.execute(
        "pre:dispatch",
        makeContext({ meta: { unknownDomain: true } })
      );

      expect(result.action).toBe("redirect");
    });

    test("custom trigger calls detect function", async () => {
      const hook = HookRegistry.planModeHook({
        triggers: [
          {
            kind: "custom",
            detect: (ctx) => ctx.agentId === "complex-agent",
          },
        ],
        plannerAgentId: "planner",
      });

      const registry = new HookRegistry();
      registry.register(hook);

      const result = await registry.execute(
        "pre:dispatch",
        makeContext({ agentId: "complex-agent" })
      );
      expect(result.action).toBe("redirect");

      const result2 = await registry.execute(
        "pre:dispatch",
        makeContext({ agentId: "simple-agent" })
      );
      expect(result2.action).toBe("continue");
    });

    test("requireApproval is passed through in annotations", async () => {
      const hook = HookRegistry.planModeHook({
        triggers: [{ kind: "complexity", threshold: 10 }],
        plannerAgentId: "planner",
        requireApproval: true,
      });

      const registry = new HookRegistry();
      registry.register(hook);

      const result = await registry.execute(
        "pre:dispatch",
        makeContext({ payload: "x".repeat(100) })
      );

      expect(result.meta.requireApproval).toBe(true);
    });

    test("hook has priority 50", () => {
      const hook = HookRegistry.planModeHook({
        triggers: [],
        plannerAgentId: "planner",
      });
      expect(hook.priority).toBe(50);
    });
  });

  // 11. budgetGuardHook
  describe("budgetGuardHook", () => {
    test("aborts when budget is exceeded", async () => {
      const tracker: TokenTracker = {
        used: 10000,
        limit: 10000,
      };

      const hook = HookRegistry.budgetGuardHook(tracker);
      const registry = new HookRegistry();
      registry.register(hook);

      const result = await registry.execute("pre:dispatch", makeContext());
      expect(result.action).toBe("abort");
      expect(result.meta.budgetExceeded).toBe(true);
      expect(result.meta.budgetUsed).toBe(10000);
      expect(result.meta.budgetLimit).toBe(10000);
    });

    test("aborts when usage exceeds limit", async () => {
      const tracker: TokenTracker = {
        used: 12000,
        limit: 10000,
      };

      const hook = HookRegistry.budgetGuardHook(tracker);
      const registry = new HookRegistry();
      registry.register(hook);

      const result = await registry.execute("pre:dispatch", makeContext());
      expect(result.action).toBe("abort");
    });

    test("continues with warning annotation when at warning threshold", async () => {
      const tracker: TokenTracker = {
        used: 8500,
        limit: 10000,
        warningThreshold: 0.8,
      };

      const hook = HookRegistry.budgetGuardHook(tracker);
      const registry = new HookRegistry();
      registry.register(hook);

      const result = await registry.execute("pre:dispatch", makeContext());
      expect(result.action).toBe("continue");
      expect(result.meta.budgetWarning).toBe(true);
      expect(result.meta.budgetRatio).toBeCloseTo(0.85, 2);
    });

    test("continues without annotation when well under budget", async () => {
      const tracker: TokenTracker = {
        used: 1000,
        limit: 10000,
      };

      const hook = HookRegistry.budgetGuardHook(tracker);
      const registry = new HookRegistry();
      registry.register(hook);

      const result = await registry.execute("pre:dispatch", makeContext());
      expect(result.action).toBe("continue");
      expect(result.meta.budgetWarning).toBeUndefined();
      expect(result.meta.budgetExceeded).toBeUndefined();
    });

    test("uses default warning threshold of 0.8 when not specified", async () => {
      const tracker: TokenTracker = {
        used: 7999,
        limit: 10000,
        // no warningThreshold => defaults to 0.8
      };

      const hook = HookRegistry.budgetGuardHook(tracker);
      const registry = new HookRegistry();
      registry.register(hook);

      const result = await registry.execute("pre:dispatch", makeContext());
      // 0.7999 < 0.8, so no warning
      expect(result.meta.budgetWarning).toBeUndefined();
    });

    test("hook has priority 10", () => {
      const tracker: TokenTracker = { used: 0, limit: 1000 };
      const hook = HookRegistry.budgetGuardHook(tracker);
      expect(hook.priority).toBe(10);
    });
  });

  // 12. autoCompactHook
  describe("autoCompactHook", () => {
    test("annotates with compaction plan when stackTokens exceeds threshold", async () => {
      const mockStrategy = {
        id: "test-strategy",
        select: (layers: any[], budget: number) => ({
          layerIds: ["layer-1"],
          reason: "over budget",
        }),
        compact: async (content: string) => content.slice(0, 100),
      };

      const hook = HookRegistry.autoCompactHook(mockStrategy as any, 5000);
      const registry = new HookRegistry();
      registry.register(hook);

      const result = await registry.execute(
        "pre:dispatch",
        makeContext({
          meta: {
            stackTokens: 8000,
            layerSnapshots: [
              { id: "layer-1", content: "test", tokens: 8000, trust: 1.0, lastAccessed: Date.now() },
            ],
          },
        })
      );

      expect(result.action).toBe("continue");
      expect(result.meta.autoCompact).toBe(true);
      expect(result.meta.compactionStrategy).toBe("test-strategy");
      expect(result.meta.stackTokens).toBe(8000);
      expect(result.meta.threshold).toBe(5000);
    });

    test("continues without annotation when under threshold", async () => {
      const mockStrategy = {
        id: "test-strategy",
        select: () => ({ layerIds: [], reason: "ok" }),
        compact: async (content: string) => content,
      };

      const hook = HookRegistry.autoCompactHook(mockStrategy as any, 10000);
      const registry = new HookRegistry();
      registry.register(hook);

      const result = await registry.execute(
        "pre:dispatch",
        makeContext({ meta: { stackTokens: 3000 } })
      );

      expect(result.action).toBe("continue");
      expect(result.meta.autoCompact).toBeUndefined();
    });

    test("treats missing stackTokens as zero", async () => {
      const mockStrategy = {
        id: "test-strategy",
        select: () => ({ layerIds: [], reason: "ok" }),
        compact: async (content: string) => content,
      };

      const hook = HookRegistry.autoCompactHook(mockStrategy as any, 5000);
      const registry = new HookRegistry();
      registry.register(hook);

      const result = await registry.execute(
        "pre:dispatch",
        makeContext({ meta: {} })
      );

      expect(result.action).toBe("continue");
      expect(result.meta.autoCompact).toBeUndefined();
    });

    test("hook has priority 20", () => {
      const mockStrategy = {
        id: "test-strategy",
        select: () => ({ layerIds: [], reason: "ok" }),
        compact: async (content: string) => content,
      };

      const hook = HookRegistry.autoCompactHook(mockStrategy as any, 5000);
      expect(hook.priority).toBe(20);
    });
  });

  // Edge cases
  describe("edge cases", () => {
    test("execute with no registered hooks returns continue", async () => {
      const registry = new HookRegistry();
      const result = await registry.execute("pre:dispatch", makeContext());
      expect(result.action).toBe("continue");
    });

    test("registering same id replaces previous handler", async () => {
      const registry = new HookRegistry();
      const order: string[] = [];

      registry.register({
        id: "same-id",
        points: ["pre:dispatch"],
        handler: async () => {
          order.push("first");
          return { action: "continue" };
        },
      });

      registry.register({
        id: "same-id",
        points: ["pre:dispatch"],
        handler: async () => {
          order.push("second");
          return { action: "continue" };
        },
      });

      await registry.execute("pre:dispatch", makeContext());
      expect(order).toEqual(["second"]);
    });
  });
});
