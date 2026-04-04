import { describe, test, expect } from "bun:test";
import { ContextLayer, type ContextSource } from "../src/agents/context-layer";
import { ContextStack } from "../src/agents/context-stack";
import { Thread } from "../src/agents/thread";
import { Executor } from "../src/agents/executor";
import { Decider } from "../src/agents/decider";

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

function makeThread(id: string = "test"): Thread {
  const layer = new ContextLayer({
    id: "docs",
    trust: 10,
    sources: [source("docs", "test context")],
  });
  layer.set("test context");
  const stack = new ContextStack([layer]);
  return new Thread(id, stack, {
    description: "test thread",
    tags: ["test"],
  });
}

describe("Thread", () => {
  describe("construction and metadata", () => {
    test("initializes with correct metadata", () => {
      const thread = makeThread();
      expect(thread.id).toBe("test");
      expect(thread.meta.description).toBe("test thread");
      expect(thread.meta.tags).toEqual(["test"]);
      expect(thread.meta.status).toBe("idle");
      expect(thread.meta.createdAt).toBeGreaterThan(0);
    });

    test("describe updates description", () => {
      const thread = makeThread();
      thread.describe("new description");
      expect(thread.meta.description).toBe("new description");
    });

    test("tag adds unique tags", () => {
      const thread = makeThread();
      thread.tag("a", "b");
      thread.tag("a", "c"); // "a" should not duplicate
      expect(thread.meta.tags).toEqual(["test", "a", "b", "c"]);
    });

    test("archive sets status and timestamp", () => {
      const thread = makeThread();
      thread.archive();
      expect(thread.meta.status).toBe("archived");
      expect(thread.meta.archivedAt).toBeDefined();
    });
  });

  describe("agent management", () => {
    test("register and getAgent", () => {
      const thread = makeThread();
      const executor = new Executor({
        id: "worker",
        stack: thread.stack,
        handler: async (ctx, p) => "done",
      });
      thread.register(executor);
      expect(thread.getAgent("worker")).toBe(executor);
      expect(thread.agents.size).toBe(1);
    });

    test("unregister removes agent", () => {
      const thread = makeThread();
      const executor = new Executor({
        id: "worker",
        stack: thread.stack,
        handler: async () => "done",
      });
      thread.register(executor);
      expect(thread.unregister("worker")).toBe(true);
      expect(thread.getAgent("worker")).toBeUndefined();
      expect(thread.unregister("nonexistent")).toBe(false);
    });
  });

  describe("dispatch", () => {
    test("dispatches to registered agent", async () => {
      const thread = makeThread();
      thread.register(
        new Executor({
          id: "worker",
          stack: thread.stack,
          handler: async (ctx, payload: string) => `processed: ${payload}`,
        })
      );

      const result = await thread.dispatch("worker", "hello");
      expect(result.output).toBe("processed: hello");
      expect(result.contextHash).toBeTruthy();
    });

    test("throws for unknown agent", async () => {
      const thread = makeThread();
      expect(thread.dispatch("nonexistent", "hello")).rejects.toThrow(
        "Agent not found"
      );
    });

    test("status returns to idle after dispatch", async () => {
      const thread = makeThread();
      thread.register(
        new Executor({
          id: "worker",
          stack: thread.stack,
          handler: async () => "done",
        })
      );

      await thread.dispatch("worker", "test");
      expect(thread.meta.status).toBe("idle");
    });

    test("status returns to idle even on error", async () => {
      const thread = makeThread();
      thread.register(
        new Executor({
          id: "boom",
          stack: thread.stack,
          handler: async () => {
            throw new Error("handler error");
          },
        })
      );

      try {
        await thread.dispatch("boom", "test");
      } catch {}
      expect(thread.meta.status).toBe("idle");
    });

    test("records dispatch history", async () => {
      const thread = makeThread();
      thread.register(
        new Executor({
          id: "worker",
          stack: thread.stack,
          handler: async () => "done",
        })
      );

      await thread.dispatch("worker", "a");
      await thread.dispatch("worker", "b");
      expect(thread.dispatches.length).toBe(2);
      expect(thread.dispatches[0].agentId).toBe("worker");
    });

    test("dispatch runs through middleware", async () => {
      const thread = makeThread();
      const order: string[] = [];

      thread.middleware.use("logger", async (ctx, next) => {
        order.push("before");
        const r = await next();
        order.push("after");
        return r;
      });

      thread.register(
        new Executor({
          id: "worker",
          stack: thread.stack,
          handler: async () => {
            order.push("handler");
            return "done";
          },
        })
      );

      await thread.dispatch("worker", "test");
      expect(order).toEqual(["before", "handler", "after"]);
    });

    test("updates lastActiveAt on dispatch", async () => {
      const thread = makeThread();
      const before = thread.meta.lastActiveAt;
      thread.register(
        new Executor({
          id: "worker",
          stack: thread.stack,
          handler: async () => "done",
        })
      );

      await new Promise((r) => setTimeout(r, 5));
      await thread.dispatch("worker", "test");
      expect(thread.meta.lastActiveAt).toBeGreaterThan(before);
    });
  });

  describe("fan", () => {
    test("dispatches to multiple agents in parallel", async () => {
      const thread = makeThread();
      thread.register(
        new Executor({
          id: "a",
          stack: thread.stack,
          handler: async () => "result-a",
        })
      );
      thread.register(
        new Executor({
          id: "b",
          stack: thread.stack,
          handler: async () => "result-b",
        })
      );

      const results = await thread.fan(["a", "b"], "test");
      expect(results.length).toBe(2);
      expect(results[0].status).toBe("fulfilled");
      expect(results[0].result?.output).toBe("result-a");
      expect(results[1].status).toBe("fulfilled");
      expect(results[1].result?.output).toBe("result-b");
    });

    test("partial failure does not kill others", async () => {
      const thread = makeThread();
      thread.register(
        new Executor({
          id: "ok",
          stack: thread.stack,
          handler: async () => "ok",
        })
      );
      thread.register(
        new Executor({
          id: "fail",
          stack: thread.stack,
          handler: async () => {
            throw new Error("boom");
          },
        })
      );

      const results = await thread.fan(["ok", "fail"], "test");
      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("rejected");
      expect(results[1].error).toBeTruthy();
    });
  });
});
