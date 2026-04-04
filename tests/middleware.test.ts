import { describe, test, expect } from "bun:test";
import {
  MiddlewareChain,
  type DispatchContext,
  type MiddlewareNext,
} from "../src/agents/middleware";
import type { ExecutionResult } from "../src/agents/base-agent";

function makeCtx(
  agentId: string = "test",
  annotations: Record<string, unknown> = {}
): DispatchContext {
  return { agentId, payload: "test", timestamp: Date.now(), annotations };
}

function makeHandler(output: string = "result"): MiddlewareNext {
  return async () => ({ output, contextHash: "abc" });
}

describe("MiddlewareChain", () => {
  test("executes handler when no middleware", async () => {
    const chain = new MiddlewareChain();
    const result = await chain.execute(makeCtx(), makeHandler("hello"));
    expect(result.output).toBe("hello");
  });

  test("always-on middleware wraps handler", async () => {
    const chain = new MiddlewareChain();
    const order: string[] = [];

    chain.use("logger", async (ctx, next) => {
      order.push("before");
      const result = await next();
      order.push("after");
      return result;
    });

    await chain.execute(makeCtx(), async () => {
      order.push("handler");
      return { output: "done", contextHash: "abc" };
    });

    expect(order).toEqual(["before", "handler", "after"]);
  });

  test("multiple middleware compose in order", async () => {
    const chain = new MiddlewareChain();
    const order: string[] = [];

    chain.use("first", async (ctx, next) => {
      order.push("first-before");
      const r = await next();
      order.push("first-after");
      return r;
    });
    chain.use("second", async (ctx, next) => {
      order.push("second-before");
      const r = await next();
      order.push("second-after");
      return r;
    });

    await chain.execute(makeCtx(), async () => {
      order.push("handler");
      return { output: "done", contextHash: "abc" };
    });

    expect(order).toEqual([
      "first-before",
      "second-before",
      "handler",
      "second-after",
      "first-after",
    ]);
  });

  test("conditional middleware only runs when predicate matches", async () => {
    const chain = new MiddlewareChain();
    const ran: string[] = [];

    chain.useWhen(
      "security",
      (ctx) => ctx.annotations.category === "security",
      async (ctx, next) => {
        ran.push("security");
        return next();
      }
    );

    chain.use("always", async (ctx, next) => {
      ran.push("always");
      return next();
    });

    // Without annotation
    await chain.execute(makeCtx(), makeHandler());
    expect(ran).toEqual(["always"]);

    ran.length = 0;

    // With annotation
    await chain.execute(
      makeCtx("test", { category: "security" }),
      makeHandler()
    );
    expect(ran).toEqual(["security", "always"]);
  });

  test("middleware can mutate annotations", async () => {
    const chain = new MiddlewareChain();

    chain.use("tagger", async (ctx, next) => {
      ctx.annotations.tagged = true;
      return next();
    });

    chain.use("checker", async (ctx, next) => {
      expect(ctx.annotations.tagged).toBe(true);
      return next();
    });

    await chain.execute(makeCtx(), makeHandler());
  });

  test("middleware can modify result", async () => {
    const chain = new MiddlewareChain();

    chain.use("enricher", async (ctx, next) => {
      const result = await next();
      return { ...result, meta: { enriched: true } };
    });

    const result = await chain.execute(makeCtx(), makeHandler());
    expect(result.meta).toEqual({ enriched: true });
  });

  test("remove middleware", () => {
    const chain = new MiddlewareChain();
    chain.use("a", async (ctx, next) => next());
    chain.use("b", async (ctx, next) => next());
    expect(chain.size).toBe(2);
    expect(chain.remove("a")).toBe(true);
    expect(chain.size).toBe(1);
    expect(chain.remove("nonexistent")).toBe(false);
  });

  test("byTier returns correct entries", () => {
    const chain = new MiddlewareChain();
    chain.use("a", async (ctx, next) => next());
    chain.useWhen("b", () => true, async (ctx, next) => next());
    chain.use("c", async (ctx, next) => next());

    expect(chain.byTier("always").length).toBe(2);
    expect(chain.byTier("conditional").length).toBe(1);
  });

  test("middleware error propagates", async () => {
    const chain = new MiddlewareChain();
    chain.use("boom", async () => {
      throw new Error("middleware error");
    });

    expect(chain.execute(makeCtx(), makeHandler())).rejects.toThrow(
      "middleware error"
    );
  });
});
