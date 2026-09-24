import { describe, test, expect } from "bun:test";
import { ContextLayer, type ContextSource } from "../src/context-layer";
import { ContextStack } from "../src/context-stack";
import { Executor } from "../src/executor";
import { Decider } from "../src/decider";
import { Classifier } from "../src/classifier";
import { Router } from "../src/router";

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

describe("ContextLayer.clone", () => {
  test("copies definition and warm state into an independent instance", async () => {
    const original = new ContextLayer({
      id: "docs",
      prompt: "Read the docs",
      staleness: 5_000,
      maxTokens: 400,
      sources: [source("docs-src", "Original docs")],
    });
    await original.warm();

    const copy = original.clone();

    expect(copy).not.toBe(original);
    expect(copy.id).toBe("docs");
    expect(copy.prompt).toBe("Read the docs");
    expect(copy.staleness).toBe(5_000);
    expect(copy.maxTokens).toBe(400);
    expect(copy.sources.map((s) => s.id)).toEqual(["docs-src"]);
    expect(copy.content).toBe("Original docs");
    expect(copy.hash).toBe(original.hash);
    expect(copy.isWarm).toBe(true);
    expect(copy.lastWarmed).toBe(original.lastWarmed);
  });

  test("mutating the clone does not touch the original, and vice versa", async () => {
    const original = new ContextLayer({ id: "docs", sources: [source("s", "Original")] });
    await original.warm();
    const copy = original.clone();

    copy.set("Changed in clone");
    expect(original.content).toBe("Original");

    original.set("Changed in original");
    expect(copy.content).toBe("Changed in clone");

    original.invalidate();
    expect(copy.isWarm).toBe(true);
  });

  test("clone does not inherit the original's listeners", async () => {
    const original = new ContextLayer({ id: "docs", sources: [source("s", "Original")] });
    await original.warm();
    const seen: string[] = [];
    original.onMutation((event) => { seen.push(`${event.layerId}:${event.field}`); });

    const copy = original.clone();
    copy.set("Clone write");

    expect(seen).toEqual([]);
  });

  test("cold layers clone as cold", () => {
    const original = new ContextLayer({ id: "docs", sources: [source("s", "Original")] });
    const copy = original.clone();
    expect(copy.state).toBe("cold");
    expect(copy.content).toBe("");
  });
});

describe("ContextStack.clone", () => {
  test("clones every layer in order without sharing instances", async () => {
    const a = new ContextLayer({ id: "a", sources: [source("a", "A content")] });
    const b = new ContextLayer({ id: "b", sources: [source("b", "B content")] });
    const stack = new ContextStack([a, b]);
    await stack.warmAll();

    const copy = stack.clone();

    expect(copy).not.toBe(stack);
    expect(copy.layers.map((l) => l.id)).toEqual(["a", "b"]);
    expect(copy.getLayer("a")).not.toBe(a);
    expect(copy.getLayer("a")!.content).toBe("A content");

    copy.getLayer("b")!.set("B changed");
    expect(b.content).toBe("B content");

    copy.addLayer(new ContextLayer({ id: "private" }));
    expect(stack.getLayer("private")).toBeUndefined();
  });
});

describe("BaseAgent.withStack", () => {
  test("Executor clone binds to the new stack and keeps its handler and config", async () => {
    const stackA = new ContextStack([new ContextLayer({ id: "docs" })]);
    stackA.getLayer("docs")!.set("A docs");
    const stackB = new ContextStack([new ContextLayer({ id: "docs" })]);
    stackB.getLayer("docs")!.set("B docs");

    const executor = new Executor<string, string>({
      id: "worker",
      stack: stackA,
      prompt: "Be brief",
      llm: { provider: "mock", model: "m" },
      peers: ["helper"],
      handler: async (context, payload) => `${context} | ${payload}`,
    });

    const cloned = executor.withStack(stackB);

    expect(cloned).not.toBe(executor);
    expect(cloned).toBeInstanceOf(Executor);
    expect(cloned.id).toBe("worker");
    expect(cloned.prompt).toBe("Be brief");
    expect(cloned.llm).toEqual({ provider: "mock", model: "m" });
    expect(cloned.peers).toEqual(["helper"]);

    const [fromA, fromB] = await Promise.all([
      executor.run("go"),
      cloned.run("go"),
    ]);
    expect(fromA.output).toContain("A docs");
    expect(fromA.output).not.toContain("B docs");
    expect(fromB.output).toContain("B docs");
    expect(fromB.output).not.toContain("A docs");
  });

  test("Executor clone keeps the configured layer filter", async () => {
    const stack = new ContextStack([
      new ContextLayer({ id: "docs" }),
      new ContextLayer({ id: "memory" }),
    ]);
    stack.getLayer("docs")!.set("docs content");
    stack.getLayer("memory")!.set("memory content");

    const executor = new Executor<string, string>({
      id: "worker",
      stack: new ContextStack(),
      layerFilter: (l) => l.id === "docs",
      handler: async (context) => context,
    });

    const result = await executor.withStack(stack).run("go");
    expect(result.output).toBe("docs content");
  });

  test("Classifier, Router and Decider clones preserve their class", async () => {
    const stack = new ContextStack([new ContextLayer({ id: "docs" })]);
    stack.getLayer("docs")!.set("taxonomy");

    const classifier = new Classifier<string>({
      id: "c", stack: new ContextStack(),
      handler: async (context) => ({ value: { category: context } }),
    });
    const router = new Router<string>({
      id: "r", stack: new ContextStack(),
      handler: async (context) => ({ value: { destination: context } }),
    });
    const decider = new Decider<string, string>({
      id: "d", stack: new ContextStack(),
      handler: async (context) => ({ value: context }),
    });

    const c2 = classifier.withStack(stack);
    const r2 = router.withStack(stack);
    const d2 = decider.withStack(stack);

    expect(c2).toBeInstanceOf(Classifier);
    expect(r2).toBeInstanceOf(Router);
    expect(d2).toBeInstanceOf(Decider);
    expect(d2).not.toBeInstanceOf(Classifier);

    expect((await c2.run("x")).output.value.category).toBe("taxonomy");
    expect((await r2.run("x")).output.value.destination).toBe("taxonomy");
    expect((await d2.run("x")).output.value).toBe("taxonomy");
    expect((await classifier.run("x")).output.value.category).toBe("");
  });
});
