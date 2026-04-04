import { describe, test, expect } from "bun:test";
import { ContextLayer, type ContextSource } from "../src/agents/context-layer";
import { ContextStack } from "../src/agents/context-stack";
import { Thread } from "../src/agents/thread";
import { Executor } from "../src/agents/executor";
import { Classifier, type Classification } from "../src/agents/classifier";
import { Router, type Route } from "../src/agents/router";
import { Harness, type Message } from "../src/agents/harness";

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

function makeHarness(): {
  harness: Harness;
  thread: Thread;
  stack: ContextStack;
} {
  const stack = new ContextStack([
    (() => {
      const l = new ContextLayer({
        id: "docs",
        trust: 10,
        sources: [source("docs", "test docs")],
      });
      l.set("test docs");
      return l;
    })(),
  ]);
  const thread = new Thread("main", stack);

  // Register agents
  thread.register(
    new Classifier({
      id: "classifier",
      stack,
      handler: async (ctx, payload: unknown) => ({
        value: { category: "bug", tags: ["auth"] },
        confidence: 0.9,
      }),
    })
  );

  thread.register(
    new Router({
      id: "router",
      stack,
      handler: async (ctx, payload: any) => ({
        value: {
          destination: "executor-fix",
          priority: 10,
          contextSlice: ["docs"],
        },
        confidence: 0.85,
      }),
    })
  );

  thread.register(
    new Executor({
      id: "executor-fix",
      stack,
      handler: async (ctx, payload: unknown) => `fixed: ${payload}`,
    })
  );

  thread.register(
    new Executor({
      id: "executor-answer",
      stack,
      handler: async (ctx, payload: unknown) => `answered: ${payload}`,
    })
  );

  const harness = new Harness(thread);
  harness.setClassifier("classifier");
  harness.setRouter("router");
  harness.setDefaultExecutor("executor-answer");

  return { harness, thread, stack };
}

describe("Harness", () => {
  test("full pipeline: classify → route → dispatch", async () => {
    const { harness } = makeHarness();

    const result = await harness.send({
      id: "msg-1",
      payload: "fix the auth bug",
    });

    expect(result.messageId).toBe("msg-1");
    expect(result.classification).toBeDefined();
    expect(result.classification!.value.category).toBe("bug");
    expect(result.route).toBeDefined();
    expect(result.route!.value.destination).toBe("executor-fix");
    expect(result.result.output).toBe("fixed: fix the auth bug");
    expect(result.trace).toBeDefined();
    expect(result.timestamp).toBeGreaterThan(0);
  });

  test("trace records classify, route, dispatch spans", async () => {
    const { harness } = makeHarness();
    const result = await harness.send({ id: "msg-1", payload: "test" });

    const summary = result.trace.summary();
    const kinds = summary.stages.map((s) => s.kind);
    expect(kinds).toContain("ingress");
    expect(kinds).toContain("classify");
    expect(kinds).toContain("route");
    expect(kinds).toContain("dispatch");
  });

  test("works without classifier", async () => {
    const { harness, thread, stack } = makeHarness();
    const h = new Harness(thread);
    h.setRouter("router");
    h.setDefaultExecutor("executor-answer");

    const result = await h.send({ id: "msg-1", payload: "hello" });
    expect(result.classification).toBeUndefined();
    expect(result.route).toBeDefined();
  });

  test("works without router (uses default executor)", async () => {
    const { thread } = makeHarness();
    const h = new Harness(thread);
    h.setDefaultExecutor("executor-answer");

    const result = await h.send({ id: "msg-1", payload: "hello" });
    expect(result.classification).toBeUndefined();
    expect(result.route).toBeUndefined();
    expect(result.result.output).toBe("answered: hello");
  });

  test("throws without executor or router", async () => {
    const { thread } = makeHarness();
    const h = new Harness(thread);

    expect(h.send({ id: "msg-1", payload: "hello" })).rejects.toThrow(
      "No target agent"
    );
  });

  test("error in pipeline records trace", async () => {
    const { thread, stack } = makeHarness();
    thread.register(
      new Executor({
        id: "failing",
        stack,
        handler: async () => {
          throw new Error("execution failed");
        },
      })
    );

    const h = new Harness(thread);
    h.setDefaultExecutor("failing");

    try {
      await h.send({ id: "msg-1", payload: "test" });
    } catch (e) {
      expect((e as Error).message).toBe("execution failed");
    }

    // Trace should still be recorded
    expect(h.traces.length).toBe(1);
    const trace = h.traces[0];
    expect(trace.endedAt).toBeDefined();
  });

  test("trace history is bounded", async () => {
    const { thread, stack } = makeHarness();
    const h = new Harness(thread, { maxTraces: 3 });
    h.setDefaultExecutor("executor-answer");

    for (let i = 0; i < 5; i++) {
      await h.send({ id: `msg-${i}`, payload: "test" });
    }

    expect(h.traces.length).toBe(3);
    // Most recent should be kept
    expect(h.traces[h.traces.length - 1].messageId).toBe("msg-4");
  });

  test("getTrace and getTraceForMessage", async () => {
    const { harness } = makeHarness();
    const result = await harness.send({ id: "msg-1", payload: "test" });

    expect(harness.getTrace(result.trace.id)).toBe(result.trace);
    expect(harness.getTraceForMessage("msg-1")).toBe(result.trace);
    expect(harness.getTrace("nonexistent")).toBeUndefined();
    expect(harness.getTraceForMessage("nonexistent")).toBeUndefined();
  });

  test("direct dispatch bypasses classify/route", async () => {
    const { harness } = makeHarness();
    const result = await harness.dispatch("executor-answer", "hello");
    expect(result.output).toBe("answered: hello");
  });

  test("fan dispatches to multiple agents", async () => {
    const { harness } = makeHarness();
    const results = await harness.fan(
      ["executor-fix", "executor-answer"],
      "test"
    );
    expect(results.length).toBe(2);
    expect(results[0].result?.output).toBe("fixed: test");
    expect(results[1].result?.output).toBe("answered: test");
  });
});
