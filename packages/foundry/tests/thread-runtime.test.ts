import { describe, test, expect } from "bun:test";
import {
  ContextStack,
  EventStream,
  Executor,
  newId,
  type CompletionOpts,
  type CompletionResult,
  type LLMMessage,
  type LLMProvider,
  type Signal,
  type SignalBus,
  type StreamEvent,
} from "@inixiative/foundry-core";
import { ThreadFactory, buildAgents, buildLayers, type SourceResolver } from "../src/agents/thread-factory";
import { ThreadRuntimeManager, auxiliarySessionId, type ThreadRuntimeDeps } from "../src/agents/thread-runtime";
import type { SessionAdapter } from "../src/providers/session-adapter";
import type { FoundryConfig } from "../src/viewer/config";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function config(): FoundryConfig {
  return {
    defaults: { provider: "mock", model: "mock-model", temperature: 0, maxTokens: 1024 },
    providers: {},
    agents: {
      "executor-answer": {
        id: "executor-answer", kind: "executor", prompt: "You are a helpful assistant.",
        provider: "mock", model: "mock-model", temperature: 0, maxTokens: 1024,
        visibleLayers: [], peers: [], maxDepth: 1, enabled: true,
      },
    },
    layers: {
      system: { id: "system", prompt: "System layer", sourceIds: ["system-src"], staleness: 0, maxTokens: 0, enabled: true },
      docs: { id: "docs", prompt: "Docs layer", sourceIds: ["docs-src"], staleness: 0, maxTokens: 0, enabled: true },
    },
    sources: {},
    projects: {},
  };
}

const resolver: SourceResolver = (id) => ({ id, load: async () => `${id} baseline` });

/** Records every provider call so tests can see exactly what each thread's agents saw. */
function recordingProvider(response: string): LLMProvider & { calls: LLMMessage[][]; optsLog: CompletionOpts[] } {
  const calls: LLMMessage[][] = [];
  const optsLog: CompletionOpts[] = [];
  return {
    id: "mock",
    calls,
    optsLog,
    async complete(messages: LLMMessage[], opts?: CompletionOpts): Promise<CompletionResult> {
      calls.push(messages);
      optsLog.push(opts ?? {});
      return { content: response, model: "mock-model", tokens: { input: 1, output: 1 } };
    },
  };
}

/** Minimal SessionAdapter double that records per-thread signal bindings. */
function fakeAdapter() {
  const bound = new Map<string, SignalBus>();
  const released: string[] = [];
  const adapter: SessionAdapter = {
    runtime: "fake",
    bindSignals(threadId: string, signals: SignalBus) {
      bound.set(threadId, signals);
      return () => { released.push(threadId); bound.delete(threadId); };
    },
    async createSession() { throw new Error("not used"); },
    async getExternalSessionId() { return null; },
    async clearSession() {},
  };
  return { adapter, bound, released };
}

async function setup(overrides?: Partial<ThreadRuntimeDeps>) {
  const cfg = config();
  const template = new ContextStack(buildLayers(cfg, { sourceResolver: resolver }));
  await template.warmAll();
  const executorProvider = recordingProvider("done");
  const flowLlm = recordingProvider(JSON.stringify({ layers: ["docs"], domains: ["docs"], snippets: [], confidence: 0.9 }));
  const eventStream = new EventStream();
  const manager = new ThreadRuntimeManager({
    config: cfg,
    llm: flowLlm,
    eventStream,
    domains: [{ domain: "docs", layerId: "docs", guardTriggers: ["Write"] }],
    log: () => {},
    ...overrides,
  });
  const agents = buildAgents(cfg, template, { provider: executorProvider });
  const factory = new ThreadFactory({ stack: template, agents, runtime: manager });
  return { cfg, template, factory, manager, eventStream, executorProvider, flowLlm };
}

function signal(kind: string, content: unknown, source = "test"): Signal {
  return { id: newId("sig"), kind, source, content, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ThreadRuntimeManager", () => {
  test("factory-created threads each get their own Librarian, orchestrator and thread-state", async () => {
    const { factory, manager } = await setup();
    const a = factory.create("a");
    const b = factory.create("b");

    const ra = manager.get("a")!;
    const rb = manager.get("b")!;
    expect(ra).toBeDefined();
    expect(rb).toBeDefined();
    expect(ra.librarian).not.toBe(rb.librarian);
    expect(ra.flowOrchestrator).not.toBe(rb.flowOrchestrator);
    expect(ra.cartographer).not.toBe(rb.cartographer);
    expect(ra.domainLibrarians.get("docs")).not.toBe(rb.domainLibrarians.get("docs"));
    expect(ra.domainLibrarians.get("docs")!.cache).toBe(a.stack.getLayer("docs"));

    expect(a.stack.getLayer("thread-state")).toBe(ra.librarian.layer);
    expect(b.stack.getLayer("thread-state")).toBe(rb.librarian.layer);
    expect(a.stack.getLayer("thread-state")).not.toBe(b.stack.getLayer("thread-state"));
  });

  test("distinct signals reconcile only into their own thread's state", async () => {
    const { factory } = await setup();
    const a = factory.create("a");
    const b = factory.create("b");

    await a.signals.emit(signal("architecture_observation", "cross-module import in A"));
    await b.signals.emit(signal("correction", "B prefers tabs"));

    const stateA = JSON.parse(a.stack.getLayer("thread-state")!.content);
    const stateB = JSON.parse(b.stack.getLayer("thread-state")!.content);
    expect(stateA.flags).toContain("cross-module");
    expect(stateA.recentActivity.join("\n")).toContain("cross-module import in A");
    expect(stateA.recentActivity.join("\n")).not.toContain("tabs");
    expect(stateB.flags).not.toContain("cross-module");
    expect(stateB.recentActivity.join("\n")).toContain("B prefers tabs");
  });

  test("events are bridged to the EventStream with the emitting thread's id", async () => {
    const { factory, eventStream } = await setup();
    const a = factory.create("a");
    const b = factory.create("b");

    await a.signals.emit(signal("info", "from a"));
    await b.signals.emit(signal("info", "from b"));
    b.stack.getLayer("docs")!.invalidate(); // warm → stale is a lifecycle transition
    await new Promise((r) => setTimeout(r, 0));

    const signalEvents = eventStream.recent({ kind: "signal" }) as Extract<StreamEvent, { kind: "signal" }>[];
    expect(signalEvents.map((e) => [e.threadId, e.signal.content])).toEqual(
      expect.arrayContaining([["a", "from a"], ["b", "from b"]]),
    );
    expect(signalEvents.find((e) => e.signal.content === "from a")!.threadId).toBe("a");

    const layerEvents = eventStream.recent({ kind: "layer", threadId: "b" }) as Extract<StreamEvent, { kind: "layer" }>[];
    expect(layerEvents.some((e) => e.event.layerId === "docs")).toBe(true);
    expect(eventStream.recent({ kind: "layer", threadId: "a" }).some((e) => e.kind === "layer" && e.event.layerId === "docs")).toBe(false);

    const sessionEvents = eventStream.recent({ kind: "session" }) as Extract<StreamEvent, { kind: "session" }>[];
    expect(sessionEvents.map((e) => [e.event.type, e.event.threadId])).toEqual(
      expect.arrayContaining([["thread:added", "a"], ["thread:added", "b"]]),
    );
  });

  test("attach is idempotent", async () => {
    const { factory, manager, eventStream } = await setup();
    const a = factory.create("a");
    const first = manager.get("a")!;
    const middlewareBefore = a.middleware.size;

    const again = manager.attach(a);

    expect(again).toBe(first);
    expect(a.middleware.size).toBe(middlewareBefore);
    expect(a.stack.layers.filter((l) => l.id === "thread-state")).toHaveLength(1);
    expect(eventStream.recent({ kind: "session" }).filter((e) => e.kind === "session" && e.event.threadId === "a")).toHaveLength(1);
  });

  test("pre-message routing runs per thread against that thread's own state", async () => {
    const { factory, flowLlm } = await setup();
    const a = factory.create("a");
    const b = factory.create("b");
    await a.signals.emit(signal("correction", "SENTINEL-A-CORRECTION"));
    await b.signals.emit(signal("correction", "SENTINEL-B-CORRECTION"));

    await a.dispatch("executor-answer", "route me");

    expect(flowLlm.calls.length).toBeGreaterThan(0);
    const routed = flowLlm.calls.map((m) => m.map((x) => x.content).join("\n")).join("\n");
    expect(routed).toContain("SENTINEL-A-CORRECTION");
    expect(routed).not.toContain("SENTINEL-B-CORRECTION");
  });

  test("dispose detaches subscriptions, middleware, lifecycle and the thread-state layer", async () => {
    const { factory, manager, eventStream } = await setup();
    const a = factory.create("a");
    const runtime = manager.get("a")!;
    const middlewareBefore = a.middleware.size;

    expect(manager.dispose("a")).toBe(true);

    expect(runtime.disposed).toBe(true);
    expect(manager.get("a")).toBeUndefined();
    expect(a.stack.getLayer("thread-state")).toBeUndefined();
    expect(a.middleware.size).toBe(middlewareBefore - 2);

    const eventsBefore = eventStream.recent({ limit: 1000 }).length;
    await a.signals.emit(signal("correction", "after dispose"));
    a.stack.getLayer("docs")!.invalidate();
    await new Promise((r) => setTimeout(r, 0));
    const after = eventStream.recent({ limit: 1000 }).slice(eventsBefore);
    expect(after.filter((e) => e.kind === "signal" || e.kind === "layer")).toHaveLength(0);
    expect(runtime.librarian.layer.content).not.toContain("after dispose");

    const sessionEvents = eventStream.recent({ kind: "session" }) as Extract<StreamEvent, { kind: "session" }>[];
    expect(sessionEvents.some((e) => e.event.type === "thread:removed" && e.event.threadId === "a")).toBe(true);

    expect(manager.dispose("a")).toBe(false);
    runtime.dispose();
    expect(runtime.disposed).toBe(true);
  });

  test("archiving a thread runs its owned disposer", async () => {
    const { factory, manager } = await setup();
    const a = factory.create("a");
    const runtime = manager.get("a")!;

    a.archive();

    expect(a.meta.status).toBe("archived");
    expect(runtime.disposed).toBe(true);
    expect(manager.get("a")).toBeUndefined();
    expect(a.stack.getLayer("thread-state")).toBeUndefined();
  });

  test("disposeAll disposes every attached thread once", async () => {
    const { factory, manager } = await setup();
    const a = factory.create("a");
    const b = factory.create("b");
    const ra = manager.get("a")!;
    const rb = manager.get("b")!;

    manager.disposeAll();

    expect(ra.disposed).toBe(true);
    expect(rb.disposed).toBe(true);
    expect(manager.runtimes.size).toBe(0);
    expect(a.stack.getLayer("thread-state")).toBeUndefined();
    expect(b.stack.getLayer("thread-state")).toBeUndefined();
  });

  test("signal sinks apply to existing and future threads", async () => {
    const { factory, manager } = await setup();
    const a = factory.create("a");
    const seen: Array<[string, unknown]> = [];
    const unsubscribe = manager.addSignalSink(async (s) => { seen.push([s.source, s.content]); });
    const b = factory.create("b");

    await a.signals.emit(signal("info", "a-signal", "a"));
    await b.signals.emit(signal("info", "b-signal", "b"));
    expect(seen).toEqual(expect.arrayContaining([["a", "a-signal"], ["b", "b-signal"]]));
    expect(seen.filter(([, c]) => c === "a-signal")).toHaveLength(1);

    unsubscribe();
    await a.signals.emit(signal("info", "after-unsub", "a"));
    expect(seen.some(([, c]) => c === "after-unsub")).toBe(false);
  });

  test("readiness resolves even when the atlas root cannot be loaded", async () => {
    const { factory, manager } = await setup({ atlasRoot: "/nonexistent/foundry-atlas-root" });
    factory.create("a");
    await expect(manager.get("a")!.ready).resolves.toBeUndefined();
  });

  test("live stacks map tracks attach and dispose", async () => {
    const { factory, manager } = await setup();
    const a = factory.create("a");
    const b = factory.create("b");
    expect(manager.stacks.get("a")).toBe(a.stack);
    expect(manager.stacks.get("b")).toBe(b.stack);

    manager.dispose("a");
    expect(manager.stacks.has("a")).toBe(false);
    expect(manager.stacks.get("b")).toBe(b.stack);
  });

  test("archiving during active work keeps the thread archived and blocks later dispatch", async () => {
    const { factory, manager } = await setup();
    const a = factory.create("a");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    a.register(new Executor({ id: "slow", stack: a.stack, handler: async () => { await gate; return "late"; } }));

    const inFlight = a.dispatch("slow", "go");
    a.archive();
    expect(manager.has("a")).toBe(false);
    release();
    expect((await inFlight).output).toBe("late");
    expect(a.meta.status).toBe("archived");
    await expect(a.dispatch("executor-answer", "again")).rejects.toThrow(/archived/);
  });

  test("session adapter signals are bound per thread and released on dispose", async () => {
    const { adapter, bound, released } = fakeAdapter();
    const { factory, manager } = await setup({ sessionAdapter: adapter });
    const a = factory.create("a");
    const b = factory.create("b");

    expect(bound.get("a")).toBe(a.signals);
    expect(bound.get("b")).toBe(b.signals);
    expect(bound.get(auxiliarySessionId("a", "cartographer"))).toBeDefined();
    expect(bound.get(auxiliarySessionId("a", "domain:docs"))).toBeDefined();
    expect(bound.get(auxiliarySessionId("a", "cartographer"))).not.toBe(a.signals);

    manager.dispose("a");
    expect(released).toContain("a");
    expect(released).toContain(auxiliarySessionId("a", "cartographer"));
    expect(bound.has("a")).toBe(false);
    expect(bound.get("b")).toBe(b.signals);
  });

  test("auxiliary compaction is observable but never clears the central injection ledger", async () => {
    const { adapter, bound } = fakeAdapter();
    const { factory, manager } = await setup({ sessionAdapter: adapter });
    const a = factory.create("a");
    const runtime = manager.get("a")!;
    const plan = await runtime.flowOrchestrator.preMessage("warm the plan");
    const prepared = await runtime.flowOrchestrator.hydrateDelta(plan);
    await runtime.flowOrchestrator.commitDelivery({ layers: prepared.pending });
    expect(runtime.librarian.state.injectedLayers.map((r) => r.id)).toEqual(["docs"]);

    const auxBus = bound.get(auxiliarySessionId("a", "cartographer"))!;
    await auxBus.emit(signal("session_compacted", { source: "fake", threadId: auxiliarySessionId("a", "cartographer") }, "session-adapter:fake"));

    expect(runtime.librarian.state.injectedLayers.map((r) => r.id)).toEqual(["docs"]);
    expect(runtime.flowOrchestrator.isInvalidated).toBe(false);
    expect(a.signals.recent("auxiliary_session_compacted")).toHaveLength(1);

    await a.signals.emit(signal("session_compacted", { source: "fake", threadId: "a" }, "session-adapter:fake"));
    expect(runtime.librarian.state.injectedLayers).toEqual([]);
    expect(runtime.flowOrchestrator.isInvalidated).toBe(true);
  });

  test("flow LLM calls carry per-thread per-domain auxiliary identity and the thread cwd", async () => {
    const { factory, flowLlm } = await setup();
    const a = factory.create("a", { cwd: "/work/a" });
    const b = factory.create("b", { cwd: "/work/b" });

    await a.dispatch("executor-answer", "route me");
    await b.dispatch("executor-answer", "route me too");

    const ids = flowLlm.optsLog.map((o) => `${o.threadId}@${o.cwd}`);
    expect(ids).toContain(`${auxiliarySessionId("a", "cartographer")}@/work/a`);
    expect(ids).toContain(`${auxiliarySessionId("a", "domain:docs")}@/work/a`);
    expect(ids).toContain(`${auxiliarySessionId("b", "cartographer")}@/work/b`);
    expect(ids).toContain(`${auxiliarySessionId("b", "domain:docs")}@/work/b`);
    expect(flowLlm.optsLog.every((o) => o.threadId && o.threadId !== "a" && o.threadId !== "b")).toBe(true);
  });

  test("a factory without a runtime manager still creates isolated but unwired threads", async () => {
    const cfg = config();
    const template = new ContextStack(buildLayers(cfg, { sourceResolver: resolver }));
    const factory = new ThreadFactory({ stack: template, agents: buildAgents(cfg, template, { provider: recordingProvider("ok") }) });
    const a = factory.create("a");
    expect(a.stack.getLayer("thread-state")).toBeUndefined();
    expect(a.middleware.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Disposal closes the Thread object (G2 lifecycle closure)
// ---------------------------------------------------------------------------

describe("ThreadRuntimeManager disposal", () => {
  for (const path of ["thread", "runtime", "manager"] as const) {
    test(`${path} disposal permanently closes the thread to dispatch and attachment`, async () => {
      const { factory, manager } = await setup();
      const a = factory.create("a");
      const owned = manager.get("a")!;
      if (path === "thread") a.dispose();
      else if (path === "runtime") owned.dispose();
      else expect(manager.dispose("a")).toBe(true);

      expect(a.disposed).toBe(true);
      expect(owned.disposed).toBe(true);
      expect(manager.has("a")).toBe(false);
      expect(a.middleware.size).toBe(0);
      await expect(a.dispatch("executor-answer", "must not run")).rejects.toThrow(/disposed|archived/);
      expect(() => manager.attach(a)).toThrow(/disposed/);
      expect(manager.dispose("a")).toBe(false);
      owned.dispose();
      a.dispose();
      expect(manager.has("a")).toBe(false);
    });
  }

  test("restore after disposal is an explicitly new thread and runtime, never the disposed object", async () => {
    const { factory, manager } = await setup();
    const first = factory.create("a");
    const firstRuntime = manager.get("a")!;
    first.archive();

    const second = factory.create("a");
    expect(second).not.toBe(first);
    expect(manager.get("a")).not.toBe(firstRuntime);
    expect(manager.get("a")!.thread).toBe(second);
    expect(second.disposed).toBe(false);
    expect(second.meta.status).toBe("idle");
    expect((await second.dispatch("executor-answer", "hello")).output).toBe("done");
    expect(first.meta.status).toBe("archived");
    manager.disposeAll();
  });

  test("a dispatch failure is observed once as a failure in the owning thread's knowledge only", async () => {
    const { factory, manager } = await setup();
    const a = factory.create("a");
    const b = factory.create("b");
    a.register(new Executor({ id: "boom", stack: a.stack, handler: async () => { throw new Error("tool blew up"); } }));
    const observed: Signal[] = [];
    a.signals.on("dispatch", (s) => { observed.push(s); });

    await expect(a.dispatch("boom", "risky")).rejects.toThrow("tool blew up");
    expect(observed).toHaveLength(1);
    expect(observed[0].content).toMatchObject({ threadId: "a", agentId: "boom", ok: false, error: "tool blew up" });
    const activity = manager.get("a")!.librarian.state.recentActivity;
    expect(activity.filter((line) => line.startsWith("Failed: boom"))).toHaveLength(1);
    expect(activity.filter((line) => line.includes("boom"))).toHaveLength(1);
    expect(manager.get("b")!.librarian.state.recentActivity.some((line) => line.includes("boom"))).toBe(false);
    expect(a.meta.status).toBe("idle");
    expect(b.meta.status).toBe("idle");
    manager.disposeAll();
  });

  test("concurrent dispatches keep the thread active until the last one finishes", async () => {
    const { factory, manager } = await setup();
    const a = factory.create("a");
    const gates: Array<() => void> = [];
    a.register(new Executor({ id: "slow", stack: a.stack, handler: async () => {
      await new Promise<void>((r) => gates.push(r));
      return "ok";
    } }));
    const first = a.dispatch("slow", "1");
    const second = a.dispatch("slow", "2");
    await new Promise((r) => setTimeout(r, 0));
    expect(gates).toHaveLength(2);
    gates[0]();
    await first;
    expect(a.meta.status).toBe("active");
    expect(a.activeDispatches).toBe(1);
    gates[1]();
    await second;
    expect(a.meta.status).toBe("idle");
    manager.disposeAll();
  });
});
