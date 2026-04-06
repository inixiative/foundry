import { describe, test, expect } from "bun:test";
import { ContextLayer, type ContextSource } from "../src/agents/context-layer";
import { ContextStack } from "../src/agents/context-stack";
import { CacheLifecycle, type LifecycleRule } from "../src/agents/cache-lifecycle";

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

describe("CacheLifecycle", () => {
  test("start observes layer state changes", async () => {
    const layer = new ContextLayer({
      id: "test",
      sources: [source("s", "hello")],
    });
    const stack = new ContextStack([layer]);
    const lifecycle = new CacheLifecycle(stack);

    const events: string[] = [];
    lifecycle.on("layer:warming", (e) => {
      events.push(e.type);
    });
    lifecycle.on("layer:warm", (e) => {
      events.push(e.type);
    });

    lifecycle.start();
    await layer.warm();

    // Events are queued via microtask, wait for them
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toContain("layer:warming");
    expect(events).toContain("layer:warm");
  });

  test("rules fire when triggers match", async () => {
    const layer = new ContextLayer({
      id: "test",
      staleness: 1,
      sources: [source("s", "hello")],
    });
    const stack = new ContextStack([layer]);
    const lifecycle = new CacheLifecycle(stack);

    let ruleRan = false;
    lifecycle.addRule({
      id: "auto-warm",
      triggers: ["stale"],
      async action(layer, state, stack) {
        ruleRan = true;
        await layer.warm();
      },
    });

    lifecycle.start();
    await layer.warm();
    await new Promise((r) => setTimeout(r, 10));

    // Make stale
    layer.checkStaleness();
    await new Promise((r) => setTimeout(r, 50));
    expect(ruleRan).toBe(true);
  });

  test("rules only fire for specified layerIds", async () => {
    const a = new ContextLayer({
      id: "a",
      sources: [source("s", "hello")],
    });
    const b = new ContextLayer({
      id: "b",
      sources: [source("s", "world")],
    });
    const stack = new ContextStack([a, b]);
    const lifecycle = new CacheLifecycle(stack);

    const triggered: string[] = [];
    lifecycle.addRule({
      id: "specific",
      triggers: ["warm"],
      layerIds: ["a"],
      async action(layer) {
        triggered.push(layer.id);
      },
    });

    lifecycle.start();
    await a.warm();
    await b.warm();
    await new Promise((r) => setTimeout(r, 50));

    expect(triggered).toEqual(["a"]);
  });

  test("removeRule stops rule from firing", async () => {
    const layer = new ContextLayer({
      id: "test",
      sources: [source("s", "hello")],
    });
    const stack = new ContextStack([layer]);
    const lifecycle = new CacheLifecycle(stack);

    let ruleRan = false;
    lifecycle.addRule({
      id: "to-remove",
      triggers: ["warm"],
      async action() {
        ruleRan = true;
      },
    });

    lifecycle.removeRule("to-remove");
    lifecycle.start();
    await layer.warm();
    await new Promise((r) => setTimeout(r, 50));

    expect(ruleRan).toBe(false);
  });

  test("stop unsubscribes from layers", async () => {
    const layer = new ContextLayer({
      id: "test",
      sources: [source("s", "hello")],
    });
    const stack = new ContextStack([layer]);
    const lifecycle = new CacheLifecycle(stack);

    const events: string[] = [];
    lifecycle.on("layer:warm", (e) => {
      events.push(e.type);
    });

    lifecycle.start();
    lifecycle.stop();
    await layer.warm();
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toEqual([]);
  });

  test("auto-observes layers added after start", async () => {
    const stack = new ContextStack();
    const lifecycle = new CacheLifecycle(stack);

    const events: string[] = [];
    lifecycle.on("layer:warm", (e) => {
      events.push(e.layerId);
    });

    lifecycle.start();

    // Add layer AFTER start
    const layer = new ContextLayer({
      id: "late",
      sources: [source("s", "hello")],
    });
    stack.addLayer(layer);
    await layer.warm();
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toContain("late");
  });

  test("rule errors emit rule:error event", async () => {
    const layer = new ContextLayer({
      id: "test",
      sources: [source("s", "hello")],
    });
    const stack = new ContextStack([layer]);
    const lifecycle = new CacheLifecycle(stack);

    lifecycle.addRule({
      id: "bad-rule",
      triggers: ["warm"],
      async action() {
        throw new Error("rule failed");
      },
    });

    const errors: string[] = [];
    lifecycle.on("rule:error", (e) => {
      errors.push((e.meta as any).ruleId);
    });

    lifecycle.start();
    await layer.warm();
    await new Promise((r) => setTimeout(r, 50));

    expect(errors).toEqual(["bad-rule"]);
  });
});
