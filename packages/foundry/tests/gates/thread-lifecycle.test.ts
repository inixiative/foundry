import { expect, test } from "bun:test";
import { Classifier, ContextLayer, ContextStack, EventStream, Executor, Harness, type BaseAgent, type Signal } from "@inixiative/foundry-core";
import { ThreadFactory } from "../../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../src/agents/thread-runtime";
import { starterConfig } from "../../src/viewer/config";

function setup() {
  const config = starterConfig("mock", "mock");
  const settings = { provider: "mock", model: "mock", temperature: 0, maxTokens: 256, visibleLayers: [], peers: [], maxDepth: 1, enabled: true };
  config.agents = {
    classifier: { ...settings, id: "classifier", kind: "classifier", prompt: "Classify" },
    worker: { ...settings, id: "worker", kind: "executor", prompt: "Execute" },
  };
  const layer = new ContextLayer({ id: "system" });
  layer.set("Project baseline");
  const stack = new ContextStack([layer]);
  const agents = new Map<string, BaseAgent>([
    ["classifier", new Classifier({ id: "classifier", stack, handler: async () => ({ value: { category: "bug", tags: ["qa"] }, confidence: 1 }) })],
    ["worker", new Executor({ id: "worker", stack, handler: async () => "done" })],
  ]);
  const events = new EventStream();
  const runtime = new ThreadRuntimeManager({ config, eventStream: events, domains: [], log: () => {}, warn: () => {},
    llm: { id: "mock", complete: async () => ({ model: "mock", content: '{"domains":[],"layers":[],"confidence":1}' }) },
  });
  const factory = new ThreadFactory({ stack, agents, runtime });
  return { factory, runtime, events };
}

const signal = (id: string): Signal => ({ id, kind: "classification", source: "qa", content: { category: id }, timestamp: Date.now() });

test("G2: each production thread receives exactly one isolated runtime", async () => {
  const { factory, runtime, events } = setup();
  try {
    const a = factory.create("a");
    const b = factory.create("b");
    const before = b.middleware.size;
    expect(runtime.attach(b)).toBe(runtime.get("b")!);
    expect(b.middleware.size).toBe(before);
    expect(b.stack.layers.filter(layer => layer.id === "thread-state")).toHaveLength(1);
    expect(runtime.get("a")!.librarian).not.toBe(runtime.get("b")!.librarian);
    await a.signals.emit(signal("PRIVATE-A"));
    expect(runtime.get("a")!.librarian.state.messageCount).toBe(1);
    expect(runtime.get("b")!.librarian.state.messageCount).toBe(0);
    expect(b.stack.getLayer("thread-state")!.content).not.toContain("PRIVATE-A");
    const observed = events.recent({ kind: "signal" });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ threadId: "a", signal: { id: "PRIVATE-A" } });
  } finally { runtime.disposeAll(); }
});

test("G2: archive stops knowledge and event subscribers", async () => {
  const { factory, runtime, events } = setup();
  try {
    const a = factory.create("a");
    const owned = runtime.get("a")!;
    await a.signals.emit(signal("before"));
    a.archive();
    const before = events.recent().length;
    await a.signals.emit(signal("after"));
    expect(owned.disposed).toBe(true);
    expect(runtime.has("a")).toBe(false);
    expect(owned.librarian.state.messageCount).toBe(1);
    expect(events.recent()).toHaveLength(before);
    expect(a.middleware.size).toBe(0);
  } finally { runtime.disposeAll(); }
});

test("G2: removing a sink also detaches threads created after sink registration", async () => {
  const { factory, runtime } = setup();
  try {
    const received: string[] = [];
    const remove = runtime.addSignalSink(event => { received.push(event.id); });
    const a = factory.create("a");
    await a.signals.emit(signal("before"));
    remove();
    await a.signals.emit(signal("after"));
    const b = factory.create("b");
    await b.signals.emit(signal("later"));
    expect(received).toEqual(["before"]);
  } finally { runtime.disposeAll(); }
});

test("G2: a duplicate live thread id cannot silently reuse a different object's runtime", () => {
  const { factory, runtime } = setup();
  try {
    factory.create("same");
    expect(() => factory.create("same")).toThrow();
  } finally { runtime.disposeAll(); }
});

test("G2: a real classified turn updates its own thread knowledge and activity", async () => {
  const { factory, runtime } = setup();
  try {
    const a = factory.create("a");
    factory.create("b");
    const harness = new Harness(a);
    harness.setClassifier("classifier");
    harness.setDefaultExecutor("worker");
    await harness.send({ id: "turn-a", payload: "Fix the bug" });
    const state = runtime.get("a")!.librarian.state;
    expect(state.messageCount).toBe(1);
    expect(state.lastClassification?.category).toBe("bug");
    expect(state.recentActivity.some(entry => entry.includes("worker"))).toBe(true);
    expect(runtime.get("b")!.librarian.state.messageCount).toBe(0);
  } finally { runtime.disposeAll(); }
});

for (const path of ["thread", "runtime", "manager"] as const) {
  test(`G2: ${path} disposal closes dispatch instead of bypassing middleware`, async () => {
    const { factory, runtime } = setup();
    try {
      const a = factory.create("a");
      if (path === "thread") a.dispose();
      else if (path === "runtime") runtime.get("a")!.dispose();
      else runtime.dispose("a");
      await expect(a.dispatch("worker", "must not execute")).rejects.toThrow();
      expect(runtime.has("a")).toBe(false);
      expect(() => runtime.attach(a)).toThrow();
    } finally { runtime.disposeAll(); }
  });
}

test("G2: direct and background dispatches each emit one scoped observation", async () => {
  const { factory, runtime } = setup();
  try {
    const a = factory.create("a");
    const b = factory.create("b");
    const observed: Signal[] = [];
    const other: Signal[] = [];
    a.signals.on("dispatch", event => { observed.push(event); });
    b.signals.on("dispatch", event => { other.push(event); });
    await a.dispatch("worker", "direct");
    await a.dispatchBackground("worker", "background").promise;
    expect(observed).toHaveLength(2);
    expect(other).toHaveLength(0);
    expect(runtime.get("a")!.librarian.state.recentActivity.filter(entry => entry.includes("worker"))).toHaveLength(2);
  } finally { runtime.disposeAll(); }
});

test("G2: harness stages do not duplicate dispatch observations", async () => {
  const { factory, runtime } = setup();
  try {
    const a = factory.create("a");
    const observed: Signal[] = [];
    a.signals.on("dispatch", event => { observed.push(event); });
    const harness = new Harness(a);
    harness.setClassifier("classifier");
    harness.setDefaultExecutor("worker");
    await harness.send({ id: "dedup-turn", payload: "Fix it" });
    expect(observed).toHaveLength(2);
    expect(observed.map(event => (event.content as { agentId: string }).agentId).sort()).toEqual(["classifier", "worker"]);
    expect(runtime.get("a")!.librarian.state.messageCount).toBe(1);
  } finally { runtime.disposeAll(); }
});
