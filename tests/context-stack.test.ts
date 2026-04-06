import { describe, test, expect, beforeEach } from "bun:test";
import { ContextLayer, type ContextSource } from "../src/agents/context-layer";
import { ContextStack, type Compressor, type AssembledContext } from "../src/agents/context-stack";

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

function makeLayer(id: string, trust: number, content?: string, prompt?: string): ContextLayer {
  const layer = new ContextLayer({
    id,
    trust,
    sources: content ? [source(`${id}-src`, content)] : [],
    prompt,
  });
  if (content) layer.set(content);
  return layer;
}

describe("ContextStack", () => {
  describe("layer management", () => {
    test("addLayer and getLayers", () => {
      const stack = new ContextStack();
      const a = makeLayer("a", 5);
      const b = makeLayer("b", 10);
      stack.addLayer(a);
      stack.addLayer(b);
      expect(stack.layers.length).toBe(2);
      expect(stack.layers[0].id).toBe("a");
    });

    test("addLayer at position", () => {
      const stack = new ContextStack();
      stack.addLayer(makeLayer("a", 5));
      stack.addLayer(makeLayer("c", 5));
      stack.addLayer(makeLayer("b", 5), 1);
      expect(stack.layers.map((l) => l.id)).toEqual(["a", "b", "c"]);
    });

    test("removeLayer", () => {
      const stack = new ContextStack([makeLayer("a", 5), makeLayer("b", 10)]);
      expect(stack.removeLayer("a")).toBe(true);
      expect(stack.layers.length).toBe(1);
      expect(stack.removeLayer("nonexistent")).toBe(false);
    });

    test("getLayer", () => {
      const stack = new ContextStack([makeLayer("a", 5)]);
      expect(stack.getLayer("a")?.id).toBe("a");
      expect(stack.getLayer("nonexistent")).toBeUndefined();
    });

    test("reorder", () => {
      const stack = new ContextStack([
        makeLayer("a", 5),
        makeLayer("b", 10),
        makeLayer("c", 3),
      ]);
      stack.reorder(["c", "a"]);
      expect(stack.layers.map((l) => l.id)).toEqual(["c", "a", "b"]);
    });

    test("reorder with unknown ids ignores them", () => {
      const stack = new ContextStack([makeLayer("a", 5), makeLayer("b", 10)]);
      stack.reorder(["b", "nonexistent", "a"]);
      expect(stack.layers.map((l) => l.id)).toEqual(["b", "a"]);
    });
  });

  describe("onLayerAdded", () => {
    test("fires callback when layer added", () => {
      const stack = new ContextStack();
      const added: string[] = [];
      stack.onLayerAdded((layer) => added.push(layer.id));
      stack.addLayer(makeLayer("a", 5));
      stack.addLayer(makeLayer("b", 10));
      expect(added).toEqual(["a", "b"]);
    });

    test("unsubscribe stops callback", () => {
      const stack = new ContextStack();
      const added: string[] = [];
      const unsub = stack.onLayerAdded((layer) => added.push(layer.id));
      stack.addLayer(makeLayer("a", 5));
      unsub();
      stack.addLayer(makeLayer("b", 10));
      expect(added).toEqual(["a"]);
    });
  });

  describe("warming", () => {
    test("warmAll warms cold layers", async () => {
      const a = new ContextLayer({
        id: "a",
        sources: [source("s", "hello")],
      });
      const b = new ContextLayer({
        id: "b",
        sources: [source("s", "world")],
      });
      const stack = new ContextStack([a, b]);
      await stack.warmAll();
      expect(a.isWarm).toBe(true);
      expect(b.isWarm).toBe(true);
    });

    test("refresh only re-warms stale layers", async () => {
      const a = new ContextLayer({
        id: "a",
        staleness: 1,
        sources: [source("s", "hello")],
      });
      const b = new ContextLayer({
        id: "b",
        sources: [source("s", "world")],
      });
      const stack = new ContextStack([a, b]);
      await stack.warmAll();

      await new Promise((r) => setTimeout(r, 10));
      // a should be stale now
      await stack.refresh();
      expect(a.isWarm).toBe(true);
      expect(b.isWarm).toBe(true);
    });
  });

  describe("merge and slice", () => {
    test("merge concatenates warm layers", () => {
      const stack = new ContextStack([
        makeLayer("a", 5, "hello"),
        makeLayer("b", 10, "world"),
      ]);
      expect(stack.merge()).toBe("hello\n\nworld");
    });

    test("merge skips non-warm layers", () => {
      const a = makeLayer("a", 5, "hello");
      const b = new ContextLayer({ id: "b" }); // cold
      const stack = new ContextStack([a, b]);
      expect(stack.merge()).toBe("hello");
    });

    test("merge with filter", () => {
      const stack = new ContextStack([
        makeLayer("a", 5, "hello"),
        makeLayer("b", 10, "world"),
      ]);
      expect(stack.merge((l) => l.trust > 7)).toBe("world");
    });

    test("slice is an alias for merge with filter", () => {
      const stack = new ContextStack([
        makeLayer("a", 5, "hello"),
        makeLayer("b", 10, "world"),
      ]);
      expect(stack.slice((l) => l.trust > 7)).toBe("world");
    });

    test("sliceByIds", () => {
      const stack = new ContextStack([
        makeLayer("a", 5, "hello"),
        makeLayer("b", 10, "world"),
        makeLayer("c", 3, "foo"),
      ]);
      expect(stack.sliceByIds("a", "c")).toBe("hello\n\nfoo");
    });
  });

  describe("compression", () => {
    test("compress throws without compressor", async () => {
      const stack = new ContextStack([makeLayer("a", 5, "hello")]);
      expect(stack.compress(100)).rejects.toThrow("No compressor");
    });

    test("compress compresses lowest trust first", async () => {
      const compressor: Compressor = {
        async compress(content, ratio) {
          return content.slice(0, Math.ceil(content.length * ratio));
        },
      };

      const stack = new ContextStack(
        [
          makeLayer("low", 1, "a".repeat(100)),
          makeLayer("high", 10, "b".repeat(100)),
        ],
        compressor
      );

      // Target 40 tokens = 160 chars total. Both layers = 200 chars = 50 tokens.
      // Compressing low (trust 1) first at 0.5 ratio → 50 chars → 37.5 tokens total, done.
      await stack.compress(40);
      // Low trust should be compressed
      expect(stack.getLayer("low")!.content.length).toBeLessThan(100);
      // High trust should be untouched (we reached target after compressing low)
      expect(stack.getLayer("high")!.content.length).toBe(100);
    });

    test("compressLayer compresses specific layer", async () => {
      const compressor: Compressor = {
        async compress(content, ratio) {
          return content.slice(0, Math.ceil(content.length * ratio));
        },
      };

      const stack = new ContextStack(
        [makeLayer("a", 5, "x".repeat(100))],
        compressor
      );
      await stack.compressLayer("a", 0.3);
      expect(stack.getLayer("a")!.content.length).toBe(30);
    });
  });

  describe("snapshot", () => {
    test("produces snapshot with hashes", () => {
      const stack = new ContextStack([
        makeLayer("a", 5, "hello"),
        makeLayer("b", 10, "world"),
      ]);
      const snap = stack.snapshot();
      expect(snap.content).toBe("hello\n\nworld");
      expect(snap.hash).toBeTruthy();
      expect(snap.layerHashes["a"]).toBeTruthy();
      expect(snap.layerHashes["b"]).toBeTruthy();
      expect(snap.timestamp).toBeGreaterThan(0);
    });
  });

  describe("estimateTokens", () => {
    test("estimates ~4 chars per token", () => {
      const stack = new ContextStack([makeLayer("a", 5, "a".repeat(400))]);
      expect(stack.estimateTokens()).toBe(100);
    });
  });

  describe("invalidateAll", () => {
    test("invalidates all warm layers", () => {
      const stack = new ContextStack([
        makeLayer("a", 5, "hello"),
        makeLayer("b", 10, "world"),
      ]);
      stack.invalidateAll();
      expect(stack.getLayer("a")!.state).toBe("stale");
      expect(stack.getLayer("b")!.state).toBe("stale");
    });
  });

  describe("assemble", () => {
    test("assembles with agent prompt and layer prompts", () => {
      const stack = new ContextStack([
        makeLayer("conventions", 10, "Use TypeScript strict mode", "These are project conventions. Follow them strictly."),
        makeLayer("taxonomy", 8, "bug | feature | chore", "Use this taxonomy to classify incoming messages."),
      ]);

      const assembled = stack.assemble("You are a classifier agent.");

      expect(assembled.blocks.length).toBe(5); // system + 2*(prompt + content)
      expect(assembled.blocks[0]).toEqual({ role: "system", text: "You are a classifier agent." });
      expect(assembled.blocks[1]).toEqual({ role: "layer", id: "conventions", text: "These are project conventions. Follow them strictly." });
      expect(assembled.blocks[2]).toEqual({ role: "content", id: "conventions", text: "Use TypeScript strict mode" });
      expect(assembled.blocks[3]).toEqual({ role: "layer", id: "taxonomy", text: "Use this taxonomy to classify incoming messages." });
      expect(assembled.blocks[4]).toEqual({ role: "content", id: "taxonomy", text: "bug | feature | chore" });
    });

    test("assembles without agent prompt", () => {
      const stack = new ContextStack([
        makeLayer("docs", 5, "API docs here", "Reference documentation."),
      ]);

      const assembled = stack.assemble();
      expect(assembled.blocks.length).toBe(2);
      expect(assembled.blocks[0].role).toBe("layer");
      expect(assembled.blocks[1].role).toBe("content");
    });

    test("assembles layers without prompts as content-only", () => {
      const stack = new ContextStack([
        makeLayer("with-prompt", 5, "content A", "instruction A"),
        makeLayer("no-prompt", 5, "content B"),
      ]);

      const assembled = stack.assemble();
      expect(assembled.blocks.length).toBe(3); // prompt+content for first, content-only for second
      expect(assembled.blocks[0]).toEqual({ role: "layer", id: "with-prompt", text: "instruction A" });
      expect(assembled.blocks[1]).toEqual({ role: "content", id: "with-prompt", text: "content A" });
      expect(assembled.blocks[2]).toEqual({ role: "content", id: "no-prompt", text: "content B" });
    });

    test("assemble skips cold and empty layers", () => {
      const cold = new ContextLayer({ id: "cold", prompt: "should not appear" });
      const warm = makeLayer("warm", 5, "visible", "instruction");
      const stack = new ContextStack([cold, warm]);

      const assembled = stack.assemble();
      expect(assembled.blocks.length).toBe(2);
      expect(assembled.blocks[0].id).toBe("warm");
    });

    test("assemble respects filter", () => {
      const stack = new ContextStack([
        makeLayer("a", 5, "content A", "prompt A"),
        makeLayer("b", 10, "content B", "prompt B"),
      ]);

      const assembled = stack.assemble("system", (l) => l.trust > 7);
      expect(assembled.blocks.length).toBe(3); // system + prompt B + content B
      expect(assembled.blocks[1].id).toBe("b");
    });

    test("assemble text joins all blocks", () => {
      const stack = new ContextStack([
        makeLayer("a", 5, "content A", "prompt A"),
      ]);

      const assembled = stack.assemble("system");
      expect(assembled.text).toBe("system\n\nprompt A\n\ncontent A");
    });

    test("assemble with empty stack returns only system prompt", () => {
      const stack = new ContextStack();
      const assembled = stack.assemble("You are a router.");
      expect(assembled.blocks.length).toBe(1);
      expect(assembled.blocks[0].role).toBe("system");
      expect(assembled.text).toBe("You are a router.");
    });

    test("assemble with no prompt and empty stack returns empty", () => {
      const stack = new ContextStack();
      const assembled = stack.assemble();
      expect(assembled.blocks.length).toBe(0);
      expect(assembled.text).toBe("");
    });
  });
});
