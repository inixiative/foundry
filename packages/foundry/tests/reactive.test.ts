import { describe, test, expect } from "bun:test";
import {
  ContextLayer,
  type ContextSource,
  ContextStack,
  Thread,
  Executor,
  SignalBus,
  type Signal,
} from "@inixiative/foundry-core";
import {
  ReactiveMiddleware,
  lowConfidenceRule,
  classificationOverrideRule,
  rewarmOnAgentRule,
  emitOnPatternRule,
  type ReactionRule,
} from "../src/agents/reactive";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

function makeEnv(threadId: string = "test") {
  const sysLayer = new ContextLayer({
    id: "system",
    trust: 10,
    sources: [source("system", "system context")],
  });
  sysLayer.set("system context");

  const runLayer = new ContextLayer({
    id: `run:${threadId}`,
    trust: 8,
  });

  const stack = new ContextStack([sysLayer, runLayer]);
  const signals = new SignalBus();
  const thread = new Thread(threadId, stack);

  return { stack, signals, thread, runLayer };
}

function registerExecutor(
  thread: Thread,
  stack: ContextStack,
  id: string,
  output: unknown = "done",
) {
  thread.register(
    new Executor({
      id,
      stack,
      handler: async () => output,
    }),
  );
}

// ---------------------------------------------------------------------------
// ReactiveMiddleware — core behavior
// ---------------------------------------------------------------------------

describe("ReactiveMiddleware", () => {
  test("addRule and removeRule", () => {
    const { stack, signals } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    const rule: ReactionRule = {
      id: "test-rule",
      when: () => true,
      act: () => {},
    };

    reactive.addRule(rule);
    expect(reactive.rules.length).toBe(1);
    expect(reactive.rules[0].id).toBe("test-rule");

    expect(reactive.removeRule("test-rule")).toBe(true);
    expect(reactive.rules.length).toBe(0);
    expect(reactive.removeRule("nonexistent")).toBe(false);
  });

  test("fires matching rules after dispatch", async () => {
    const { stack, signals, thread } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    const fired: string[] = [];
    reactive.addRule({
      id: "always-fire",
      when: () => true,
      act: () => { fired.push("fired"); },
    });

    thread.middleware.use("reactive", reactive.asMiddleware());
    registerExecutor(thread, stack, "worker");

    await thread.dispatch("worker", "hello");
    expect(fired).toEqual(["fired"]);
  });

  test("does not fire rules that return false", async () => {
    const { stack, signals, thread } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    const fired: string[] = [];
    reactive.addRule({
      id: "never-fire",
      when: () => false,
      act: () => { fired.push("should-not-appear"); },
    });

    thread.middleware.use("reactive", reactive.asMiddleware());
    registerExecutor(thread, stack, "worker");

    await thread.dispatch("worker", "hello");
    expect(fired).toEqual([]);
  });

  test("fires multiple rules in order", async () => {
    const { stack, signals, thread } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    const order: string[] = [];
    reactive.addRule({ id: "first", when: () => true, act: () => { order.push("first"); } });
    reactive.addRule({ id: "second", when: () => true, act: () => { order.push("second"); } });

    thread.middleware.use("reactive", reactive.asMiddleware());
    registerExecutor(thread, stack, "worker");

    await thread.dispatch("worker", "hello");
    expect(order).toEqual(["first", "second"]);
  });

  test("rule errors do not break the pipeline", async () => {
    const { stack, signals, thread } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    const fired: string[] = [];
    reactive.addRule({
      id: "exploder",
      when: () => true,
      act: () => { throw new Error("rule blew up"); },
    });
    reactive.addRule({
      id: "survivor",
      when: () => true,
      act: () => { fired.push("survived"); },
    });

    thread.middleware.use("reactive", reactive.asMiddleware());
    registerExecutor(thread, stack, "worker");

    // Should not throw — errors are caught
    const result = await thread.dispatch("worker", "hello");
    expect(result.output).toBe("done");
    expect(fired).toEqual(["survived"]);
  });

  test("passes correct dispatch context to when/act", async () => {
    const { stack, signals, thread } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    let capturedAgentId: string | undefined;
    let capturedOutput: unknown;

    reactive.addRule({
      id: "inspector",
      when: (ctx) => {
        capturedAgentId = ctx.agentId;
        return true;
      },
      act: (ctx) => {
        capturedOutput = ctx.result.output;
      },
    });

    thread.middleware.use("reactive", reactive.asMiddleware());
    registerExecutor(thread, stack, "my-agent", "my-output");

    await thread.dispatch("my-agent", "payload");
    expect(capturedAgentId).toBe("my-agent");
    expect(capturedOutput).toBe("my-output");
  });

  test("appendRunContext writes to the RunContext layer", async () => {
    const { stack, signals, thread, runLayer } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    reactive.addRule({
      id: "writer",
      when: () => true,
      act: (ctx) => { ctx.appendRunContext("observation: something happened"); },
    });

    thread.middleware.use("reactive", reactive.asMiddleware());
    registerExecutor(thread, stack, "worker");

    await thread.dispatch("worker", "hello");
    expect(runLayer.content).toContain("observation: something happened");
  });

  test("appendRunContext accumulates across dispatches", async () => {
    const { stack, signals, thread, runLayer } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    let callCount = 0;
    reactive.addRule({
      id: "counter",
      when: () => true,
      act: (ctx) => { ctx.appendRunContext(`call-${++callCount}`); },
    });

    thread.middleware.use("reactive", reactive.asMiddleware());
    registerExecutor(thread, stack, "worker");

    await thread.dispatch("worker", "a");
    await thread.dispatch("worker", "b");

    expect(runLayer.content).toContain("call-1");
    expect(runLayer.content).toContain("call-2");
  });

  test("setLayer updates a layer's content directly", async () => {
    const { stack, signals, thread } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    reactive.addRule({
      id: "setter",
      when: () => true,
      act: (ctx) => { ctx.setLayer("system", "overridden content"); },
    });

    thread.middleware.use("reactive", reactive.asMiddleware());
    registerExecutor(thread, stack, "worker");

    await thread.dispatch("worker", "hello");
    expect(stack.getLayer("system")!.content).toBe("overridden content");
  });

  test("emit sends signals through the bus", async () => {
    const { stack, signals, thread } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    const received: Signal[] = [];
    signals.onAny((signal) => { received.push(signal); });

    reactive.addRule({
      id: "emitter",
      when: () => true,
      act: (ctx) => {
        ctx.emit({ kind: "correction", source: "test", content: { note: "fixed" }, confidence: 0.9 });
      },
    });

    thread.middleware.use("reactive", reactive.asMiddleware());
    registerExecutor(thread, stack, "worker");

    await thread.dispatch("worker", "hello");
    expect(received.length).toBe(1);
    expect(received[0].kind).toBe("correction");
    expect(received[0].id).toBeTruthy();
    expect(received[0].timestamp).toBeGreaterThan(0);
  });

  test("rewarmLayer invalidates and re-warms a layer", async () => {
    const { stack, signals, thread } = makeEnv();

    let loadCount = 0;
    const refreshable = new ContextLayer({
      id: "refreshable",
      trust: 5,
      sources: [{
        id: "counter",
        load: async () => `loaded-${++loadCount}`,
      }],
    });
    // Manually warm it once
    await refreshable.warm();
    expect(refreshable.content).toBe("loaded-1");

    // Replace the stack's layers by building a new env
    const fullStack = new ContextStack([
      stack.getLayer("system")!,
      stack.getLayer("run:test")!,
      refreshable,
    ]);

    const thread2 = new Thread("test", fullStack);
    const reactive = new ReactiveMiddleware({ stack: fullStack, signals, threadId: "test" });

    reactive.addRule({
      id: "rewarmer",
      when: () => true,
      act: async (ctx) => { await ctx.rewarmLayer("refreshable"); },
    });

    thread2.middleware.use("reactive", reactive.asMiddleware());
    registerExecutor(thread2, fullStack, "worker");

    await thread2.dispatch("worker", "hello");
    expect(refreshable.content).toBe("loaded-2");
  });
});

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

describe("lowConfidenceRule", () => {
  test("fires when confidence below threshold", async () => {
    const { stack, signals, thread, runLayer } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    reactive.addRule(lowConfidenceRule(0.5));

    thread.middleware.use("reactive", reactive.asMiddleware());
    thread.register(
      new Executor({
        id: "uncertain",
        stack,
        handler: async () => ({ confidence: 0.3, reasoning: "not sure" }),
      }),
    );

    await thread.dispatch("uncertain", "test");
    expect(runLayer.content).toContain("[low-confidence]");
    expect(runLayer.content).toContain("uncertain");
    expect(runLayer.content).toContain("0.3");
  });

  test("does not fire when confidence above threshold", async () => {
    const { stack, signals, thread, runLayer } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    reactive.addRule(lowConfidenceRule(0.5));

    thread.middleware.use("reactive", reactive.asMiddleware());
    thread.register(
      new Executor({
        id: "confident",
        stack,
        handler: async () => ({ confidence: 0.9, reasoning: "very sure" }),
      }),
    );

    await thread.dispatch("confident", "test");
    expect(runLayer.content).toBeFalsy();
  });

  test("does not fire when output has no confidence field", async () => {
    const { stack, signals, thread, runLayer } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    reactive.addRule(lowConfidenceRule(0.5));

    thread.middleware.use("reactive", reactive.asMiddleware());
    registerExecutor(thread, stack, "worker", "plain string output");

    await thread.dispatch("worker", "test");
    expect(runLayer.content).toBeFalsy();
  });
});

describe("classificationOverrideRule", () => {
  test("fires when router has classifierCategory annotation", async () => {
    const { stack, signals, thread, runLayer } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    reactive.addRule(classificationOverrideRule());

    // Use a pre-middleware to inject the annotation (simulating harness behavior)
    thread.middleware.use("inject-annotation", async (ctx, next) => {
      ctx.annotations["classifierCategory"] = "bug";
      return next();
    });
    thread.middleware.use("reactive", reactive.asMiddleware());

    thread.register(
      new Executor({
        id: "smart-router",
        stack,
        // Return shape matching Router's Decision<Route> output
        handler: async () => ({ value: { destination: "executor-build", priority: 5 }, confidence: 0.9 }),
      }),
    );

    await thread.dispatch("smart-router", "test");

    expect(runLayer.content).toContain("[override]");
    expect(runLayer.content).toContain("bug");
    expect(runLayer.content).toContain("executor-build");
  });
});

describe("rewarmOnAgentRule", () => {
  test("rearms layer when specific agent runs", async () => {
    const { signals } = makeEnv();

    let loadCount = 0;
    const dynamic = new ContextLayer({
      id: "dynamic",
      trust: 5,
      sources: [{ id: "src", load: async () => `v${++loadCount}` }],
    });
    await dynamic.warm();
    expect(dynamic.content).toBe("v1");

    const sysLayer = new ContextLayer({
      id: "system",
      trust: 10,
      sources: [source("system", "ctx")],
    });
    sysLayer.set("ctx");

    const runLayer = new ContextLayer({ id: "run:test", trust: 8 });
    const stack = new ContextStack([sysLayer, runLayer, dynamic]);
    const thread = new Thread("test", stack);

    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });
    reactive.addRule(rewarmOnAgentRule("trigger-agent", "dynamic"));

    thread.middleware.use("reactive", reactive.asMiddleware());
    registerExecutor(thread, stack, "trigger-agent");
    registerExecutor(thread, stack, "other-agent");

    // Other agent should NOT trigger rewarm
    await thread.dispatch("other-agent", "test");
    expect(dynamic.content).toBe("v1");

    // Target agent SHOULD trigger rewarm
    await thread.dispatch("trigger-agent", "test");
    expect(dynamic.content).toBe("v2");
  });
});

describe("emitOnPatternRule", () => {
  test("emits signal when agent output matches pattern", async () => {
    const { stack, signals, thread } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    const received: Signal[] = [];
    signals.onAny((s) => { received.push(s); });

    reactive.addRule(emitOnPatternRule("detector", /CONVENTION:/, "convention"));

    thread.middleware.use("reactive", reactive.asMiddleware());
    thread.register(
      new Executor({
        id: "detector",
        stack,
        handler: async () => "Found CONVENTION: use camelCase for variables",
      }),
    );

    await thread.dispatch("detector", "check code style");
    expect(received.length).toBe(1);
    expect(received[0].kind).toBe("convention");
    expect((received[0].content as any).match).toContain("CONVENTION:");
  });

  test("does not emit when pattern does not match", async () => {
    const { stack, signals, thread } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    const received: Signal[] = [];
    signals.onAny((s) => { received.push(s); });

    reactive.addRule(emitOnPatternRule("detector", /CONVENTION:/, "convention"));

    thread.middleware.use("reactive", reactive.asMiddleware());
    thread.register(
      new Executor({
        id: "detector",
        stack,
        handler: async () => "nothing special here",
      }),
    );

    await thread.dispatch("detector", "check");
    expect(received.length).toBe(0);
  });

  test("ignores dispatches from other agents", async () => {
    const { stack, signals, thread } = makeEnv();
    const reactive = new ReactiveMiddleware({ stack, signals, threadId: "test" });

    const received: Signal[] = [];
    signals.onAny((s) => { received.push(s); });

    reactive.addRule(emitOnPatternRule("detector", /CONVENTION:/, "convention"));

    thread.middleware.use("reactive", reactive.asMiddleware());
    thread.register(
      new Executor({
        id: "other",
        stack,
        handler: async () => "CONVENTION: this should not trigger",
      }),
    );

    await thread.dispatch("other", "check");
    expect(received.length).toBe(0);
  });
});
