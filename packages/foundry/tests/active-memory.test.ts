import { describe, test, expect } from "bun:test";
import {
  ContextLayer,
  type ContextSource,
  ContextStack,
  CacheLifecycle,
  SignalBus,
  type Signal,
} from "@inixiative/foundry-core";
import {
  ActiveMemory,
  type AccessRecord,
  type ActiveMemoryConfig,
} from "../src/agents/active-memory";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

function makeLayer(id: string, content: string, trust = 50): ContextLayer {
  const layer = new ContextLayer({
    id,
    sources: [source(`src-${id}`, content)],
    trust,
  });
  layer.set(content);
  return layer;
}

function setup(config?: ActiveMemoryConfig) {
  const stack = new ContextStack();
  const lifecycle = new CacheLifecycle(stack);
  const memory = new ActiveMemory(stack, lifecycle, config);
  return { stack, lifecycle, memory };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ActiveMemory", () => {
  test("recordAccess 'used' increases trust", () => {
    const { stack, memory } = setup();
    const layer = makeLayer("a", "use arrow functions", 50);
    stack.addLayer(layer);

    memory.recordAccess({
      layerId: "a",
      timestamp: Date.now(),
      outcome: "used",
    });

    expect(layer.trust).toBe(51); // default useBoost = 1
  });

  test("recordAccess 'overridden' decreases trust", () => {
    const { stack, memory } = setup();
    const layer = makeLayer("a", "use var declarations", 50);
    stack.addLayer(layer);

    memory.recordAccess({
      layerId: "a",
      timestamp: Date.now(),
      outcome: "overridden",
    });

    expect(layer.trust).toBe(47); // default overridePenalty = 3
  });

  test("recordAccess 'ignored' slightly decreases trust", () => {
    const { stack, memory } = setup();
    const layer = makeLayer("a", "prefer const", 50);
    stack.addLayer(layer);

    memory.recordAccess({
      layerId: "a",
      timestamp: Date.now(),
      outcome: "ignored",
    });

    expect(layer.trust).toBe(49.5); // default ignorePenalty = 0.5
  });

  test("trust is capped at 0 (floor)", () => {
    const { stack, memory } = setup({ overridePenalty: 100 });
    const layer = makeLayer("a", "bad convention", 5);
    stack.addLayer(layer);

    memory.recordAccess({
      layerId: "a",
      timestamp: Date.now(),
      outcome: "overridden",
    });

    expect(layer.trust).toBe(0);
  });

  test("trust is capped at 100 (ceiling)", () => {
    const { stack, memory } = setup({ useBoost: 50 });
    const layer = makeLayer("a", "great convention", 90);
    stack.addLayer(layer);

    memory.recordAccess({
      layerId: "a",
      timestamp: Date.now(),
      outcome: "used",
    });

    expect(layer.trust).toBe(100);
  });

  test("dissolve() removes layers below threshold", () => {
    const { stack, lifecycle, memory } = setup({ dissolutionThreshold: 10 });
    lifecycle.start();

    const low = makeLayer("low", "forgotten rule", 3);
    const high = makeLayer("high", "important rule", 80);
    stack.addLayer(low);
    stack.addLayer(high);

    const removed = memory.dissolve();

    expect(removed).toEqual(["low"]);
    expect(stack.layers.length).toBe(1);
    expect(stack.getLayer("high")).toBeDefined();
    expect(stack.getLayer("low")).toBeUndefined();
  });

  test("compete() transfers trust between overlapping layers", () => {
    const { stack, memory } = setup();

    // Two layers with significant word overlap
    const a = makeLayer(
      "a",
      "always use arrow functions for callbacks and handlers in the codebase",
      50
    );
    const b = makeLayer(
      "b",
      "always use arrow functions for callbacks and event handlers in the project",
      50
    );
    stack.addLayer(a);
    stack.addLayer(b);

    // Give layer "a" more accesses so it wins
    for (let i = 0; i < 5; i++) {
      memory.recordAccess({
        layerId: "a",
        timestamp: Date.now(),
        outcome: "used",
      });
    }
    memory.recordAccess({
      layerId: "b",
      timestamp: Date.now(),
      outcome: "used",
    });

    const results = memory.compete();

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].winner).toBe("a");
    expect(results[0].loser).toBe("b");
    expect(results[0].trustDelta).toBeGreaterThan(0);

    // Winner gained, loser lost
    expect(a.trust).toBeGreaterThan(55); // was 55 from 5 uses, then gained from competition
    expect(b.trust).toBeLessThan(51); // was 51 from 1 use, then lost from competition
  });

  test("connectSignals auto-processes correction signals", async () => {
    const { stack, memory } = setup();
    const signals = new SignalBus();

    const layer = makeLayer("target", "old convention", 50);
    stack.addLayer(layer);

    // Record an initial access so the layer is tracked
    memory.recordAccess({
      layerId: "target",
      timestamp: Date.now(),
      outcome: "used",
    });

    const unsub = memory.connectSignals(signals);

    await signals.emit({
      id: "sig-1",
      kind: "correction",
      source: "user",
      content: "actually use const, not let",
      timestamp: Date.now(),
      refs: [{ system: "layer", locator: "target" }],
    });

    // Trust should have decreased from the correction
    expect(layer.trust).toBeLessThan(51); // was 51 after "used", then -3 from correction = 48
    expect(layer.trust).toBe(48);

    unsub();
  });

  test("stats() returns correct counts", () => {
    const { stack, memory } = setup();
    const layer = makeLayer("s", "some content", 50);
    stack.addLayer(layer);

    const now = Date.now();
    memory.recordAccess({ layerId: "s", timestamp: now, outcome: "used" });
    memory.recordAccess({
      layerId: "s",
      timestamp: now + 1,
      outcome: "used",
    });
    memory.recordAccess({
      layerId: "s",
      timestamp: now + 2,
      outcome: "overridden",
    });
    memory.recordAccess({
      layerId: "s",
      timestamp: now + 3,
      outcome: "ignored",
    });

    const s = memory.stats("s");

    expect(s.accessCount).toBe(4);
    expect(s.useCount).toBe(2);
    expect(s.overrideCount).toBe(1);
    expect(s.ignoreCount).toBe(1);
    expect(s.lastAccessed).toBe(now + 3);
    expect(s.currentTrust).toBe(50 + 1 + 1 - 3 - 0.5); // 48.5
  });

  test("trustTrajectory is 'falling' after multiple overrides", () => {
    const { stack, memory } = setup();
    const layer = makeLayer("f", "doomed convention", 50);
    stack.addLayer(layer);

    for (let i = 0; i < 4; i++) {
      memory.recordAccess({
        layerId: "f",
        timestamp: Date.now(),
        outcome: "overridden",
      });
    }

    const s = memory.stats("f");
    expect(s.trustTrajectory).toBe("falling");
  });

  test("trustTrajectory is 'dissolving' when trust below threshold", () => {
    const { stack, memory } = setup({ dissolutionThreshold: 10 });
    const layer = makeLayer("d", "dying convention", 3);
    stack.addLayer(layer);

    const s = memory.stats("d");
    expect(s.trustTrajectory).toBe("dissolving");
  });

  test("connectLifecycle tracks layer warm events", async () => {
    const layer = new ContextLayer({
      id: "lc",
      sources: [source("s", "lifecycle content")],
      trust: 50,
    });
    const stack = new ContextStack([layer]);
    const lifecycle = new CacheLifecycle(stack);
    const memory = new ActiveMemory(stack, lifecycle);

    lifecycle.start();
    const unsub = memory.connectLifecycle();

    // Warm the layer — triggers lifecycle event
    await layer.warm();

    // Wait for microtask drain
    await new Promise((r) => setTimeout(r, 50));

    const s = memory.stats("lc");
    expect(s.accessCount).toBeGreaterThanOrEqual(1);

    unsub();
    lifecycle.stop();
  });

  test("dissolving getter returns layers below threshold", () => {
    const { stack, memory } = setup({ dissolutionThreshold: 20 });

    stack.addLayer(makeLayer("ok", "good rule", 50));
    stack.addLayer(makeLayer("low1", "weak rule", 10));
    stack.addLayer(makeLayer("low2", "weaker rule", 5));

    const dissolving = memory.dissolving;
    expect(dissolving.length).toBe(2);
    expect(dissolving.map((l) => l.id).sort()).toEqual(["low1", "low2"]);
  });

  test("custom config values are respected", () => {
    const { stack, memory } = setup({
      useBoost: 5,
      overridePenalty: 10,
      ignorePenalty: 2,
    });

    const layer = makeLayer("c", "custom config test", 50);
    stack.addLayer(layer);

    memory.recordAccess({
      layerId: "c",
      timestamp: Date.now(),
      outcome: "used",
    });
    expect(layer.trust).toBe(55);

    memory.recordAccess({
      layerId: "c",
      timestamp: Date.now(),
      outcome: "overridden",
    });
    expect(layer.trust).toBe(45);

    memory.recordAccess({
      layerId: "c",
      timestamp: Date.now(),
      outcome: "ignored",
    });
    expect(layer.trust).toBe(43);
  });
});
