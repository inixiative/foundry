import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  ContextLayer,
  computeHash,
  type ContextSource,
} from "../src/context-layer";

// -- Helpers --

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

function failingSource(id: string, error: string): ContextSource {
  return {
    id,
    load: async () => {
      throw new Error(error);
    },
  };
}

function slowSource(id: string, content: string, ms: number): ContextSource {
  return {
    id,
    load: () => new Promise((resolve) => setTimeout(() => resolve(content), ms)),
  };
}

// -- Tests --

describe("computeHash", () => {
  test("returns consistent hash for same content", () => {
    expect(computeHash("hello")).toBe(computeHash("hello"));
  });

  test("returns different hash for different content", () => {
    expect(computeHash("hello")).not.toBe(computeHash("world"));
  });

  test("returns 16-char hex string", () => {
    const hash = computeHash("test");
    expect(hash.length).toBeLessThanOrEqual(16);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });
});

describe("ContextLayer", () => {
  describe("construction", () => {
    test("starts cold with empty content", () => {
      const layer = new ContextLayer({ id: "test" });
      expect(layer.state).toBe("cold");
      expect(layer.content).toBe("");
      expect(layer.hash).toBe("");
      expect(layer.isWarm).toBe(false);
      expect(layer.lastWarmed).toBeNull();
    });

    test("uses provided config", () => {
      const layer = new ContextLayer({
        id: "test",
        trust: 8,
        staleness: 5000,
        maxTokens: 1000,
      });
      expect(layer.id).toBe("test");
      expect(layer.trust).toBe(8);
      expect(layer.staleness).toBe(5000);
      expect(layer.maxTokens).toBe(1000);
    });

    test("defaults trust to 0", () => {
      const layer = new ContextLayer({ id: "test" });
      expect(layer.trust).toBe(0);
    });
  });

  describe("warm()", () => {
    test("loads content from sources", async () => {
      const layer = new ContextLayer({
        id: "test",
        sources: [source("a", "hello"), source("b", "world")],
      });
      await layer.warm();
      expect(layer.content).toBe("hello\n\nworld");
      expect(layer.isWarm).toBe(true);
      expect(layer.state).toBe("warm");
      expect(layer.hash).not.toBe("");
      expect(layer.lastWarmed).not.toBeNull();
    });

    test("works with no sources", async () => {
      const layer = new ContextLayer({ id: "test" });
      await layer.warm();
      expect(layer.content).toBe("");
      expect(layer.isWarm).toBe(true);
    });

    test("transitions through warming state", async () => {
      const states: string[] = [];
      const layer = new ContextLayer({
        id: "test",
        sources: [source("a", "hello")],
      });
      layer.onStateChange((state) => states.push(state));
      await layer.warm();
      expect(states).toContain("warming");
      expect(states).toContain("warm");
    });

    test("reverts state on source failure", async () => {
      const layer = new ContextLayer({
        id: "test",
        sources: [failingSource("a", "boom")],
      });
      try {
        await layer.warm();
      } catch (e) {
        expect((e as Error).message).toBe("boom");
      }
      expect(layer.state).toBe("cold");
    });

    test("reverts to stale if was stale before failure", async () => {
      const layer = new ContextLayer({
        id: "test",
        sources: [source("a", "hello")],
      });
      await layer.warm();
      layer.invalidate();
      expect(layer.state).toBe("stale");

      // Replace source with failing one
      layer.removeSource("a");
      layer.addSource(failingSource("b", "fail"));
      try {
        await layer.warm();
      } catch {}
      expect(layer.state).toBe("stale");
    });

    test("coalesces concurrent warm() calls", async () => {
      let callCount = 0;
      const countingSource: ContextSource = {
        id: "counter",
        async load() {
          callCount++;
          await new Promise((r) => setTimeout(r, 50));
          return "data";
        },
      };
      const layer = new ContextLayer({
        id: "test",
        sources: [countingSource],
      });

      // Fire 3 concurrent warms
      await Promise.all([layer.warm(), layer.warm(), layer.warm()]);
      expect(callCount).toBe(1);
      expect(layer.isWarm).toBe(true);
    });
  });

  describe("set()", () => {
    test("directly sets content and transitions to warm", () => {
      const layer = new ContextLayer({ id: "test" });
      layer.set("direct content");
      expect(layer.content).toBe("direct content");
      expect(layer.isWarm).toBe(true);
      expect(layer.hash).toBe(computeHash("direct content"));
    });
  });

  describe("invalidate()", () => {
    test("transitions warm to stale", async () => {
      const layer = new ContextLayer({
        id: "test",
        sources: [source("a", "hello")],
      });
      await layer.warm();
      layer.invalidate();
      expect(layer.state).toBe("stale");
    });

    test("no-op when cold", () => {
      const layer = new ContextLayer({ id: "test" });
      layer.invalidate();
      expect(layer.state).toBe("cold");
    });
  });

  describe("clear()", () => {
    test("resets everything to cold", async () => {
      const layer = new ContextLayer({
        id: "test",
        sources: [source("a", "hello")],
      });
      await layer.warm();
      layer.clear();
      expect(layer.state).toBe("cold");
      expect(layer.content).toBe("");
      expect(layer.hash).toBe("");
      expect(layer.lastWarmed).toBeNull();
    });
  });

  describe("staleness", () => {
    test("checkStaleness transitions warm to stale after threshold", async () => {
      const layer = new ContextLayer({
        id: "test",
        staleness: 1, // 1ms
        sources: [source("a", "hello")],
      });
      await layer.warm();
      await new Promise((r) => setTimeout(r, 10));
      expect(layer.checkStaleness()).toBe("stale");
      expect(layer.state).toBe("stale");
    });

    test("checkStaleness does not affect non-warm layers", () => {
      const layer = new ContextLayer({ id: "test", staleness: 1 });
      expect(layer.checkStaleness()).toBe("cold");
    });

    test("isStale triggers checkStaleness", async () => {
      const layer = new ContextLayer({
        id: "test",
        staleness: 1,
        sources: [source("a", "hello")],
      });
      await layer.warm();
      await new Promise((r) => setTimeout(r, 10));
      expect(layer.isStale).toBe(true);
    });

    test("no staleness config means never stale", async () => {
      const layer = new ContextLayer({
        id: "test",
        sources: [source("a", "hello")],
      });
      await layer.warm();
      await new Promise((r) => setTimeout(r, 10));
      expect(layer.checkStaleness()).toBe("warm");
    });
  });

  describe("sources", () => {
    test("addSource and removeSource", async () => {
      const layer = new ContextLayer({ id: "test" });
      layer.addSource(source("a", "hello"));
      await layer.warm();
      expect(layer.content).toBe("hello");

      layer.removeSource("a");
      layer.invalidate();
      await layer.warm();
      expect(layer.content).toBe("");
    });

    test("removeSource returns false for missing", () => {
      const layer = new ContextLayer({ id: "test" });
      expect(layer.removeSource("nonexistent")).toBe(false);
    });
  });

  describe("observation", () => {
    test("onStateChange fires on transitions", async () => {
      const events: string[] = [];
      const layer = new ContextLayer({
        id: "test",
        sources: [source("a", "hello")],
      });
      layer.onStateChange((state) => events.push(state));
      await layer.warm();
      expect(events).toEqual(["warming", "warm"]);
    });

    test("unsubscribe stops notifications", async () => {
      const events: string[] = [];
      const layer = new ContextLayer({
        id: "test",
        sources: [source("a", "hello")],
      });
      const unsub = layer.onStateChange((state) => events.push(state));
      unsub();
      await layer.warm();
      expect(events).toEqual([]);
    });

    test("does not fire when state unchanged", () => {
      const events: string[] = [];
      const layer = new ContextLayer({ id: "test" });
      layer.onStateChange((state) => events.push(state));
      // Cold -> clear() still cold -> no event
      layer.clear();
      // State was cold, clear sets to cold, _setState skips if same
      expect(events).toEqual([]);
    });
  });

  describe("configuration setters", () => {
    test("can update trust", () => {
      const layer = new ContextLayer({ id: "test", trust: 5 });
      layer.trust = 10;
      expect(layer.trust).toBe(10);
    });

    test("can update staleness", () => {
      const layer = new ContextLayer({ id: "test" });
      expect(layer.staleness).toBeUndefined();
      layer.staleness = 5000;
      expect(layer.staleness).toBe(5000);
    });

    test("can update maxTokens", () => {
      const layer = new ContextLayer({ id: "test" });
      layer.maxTokens = 1000;
      expect(layer.maxTokens).toBe(1000);
    });
  });
});
