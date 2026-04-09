import { describe, test, expect } from "bun:test";
import { ContextLayer, type ContextSource } from "../src/context-layer";
import { ContextStack } from "../src/context-stack";
import { Executor } from "../src/executor";
import { Decider, type Decision } from "../src/decider";
import { Classifier, type Classification } from "../src/classifier";
import { Router, type Route } from "../src/router";

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

function makeStack(...layers: [string, number, string][]): ContextStack {
  return new ContextStack(
    layers.map(([id, trust, content]) => {
      const l = new ContextLayer({ id, trust, sources: [source(id, content)] });
      l.set(content);
      return l;
    })
  );
}

describe("Executor", () => {
  test("runs handler with merged context", async () => {
    const stack = makeStack(["docs", 10, "Use TypeScript"]);
    const executor = new Executor({
      id: "writer",
      stack,
      handler: async (context, payload: string) => {
        return `Context: ${context}, Payload: ${payload}`;
      },
    });

    const result = await executor.run("write code");
    expect(result.output).toBe("Context: Use TypeScript, Payload: write code");
    expect(result.contextHash).toBeTruthy();
  });

  test("respects filterOverride", async () => {
    const stack = makeStack(
      ["docs", 10, "docs content"],
      ["memory", 3, "memory content"]
    );
    const executor = new Executor({
      id: "writer",
      stack,
      handler: async (context, _payload: string) => context,
    });

    const result = await executor.run("test", (l) => l.id === "docs");
    expect(result.output).toBe("docs content");
    expect(result.output).not.toContain("memory content");
  });

  test("respects layerFilter from config", async () => {
    const stack = makeStack(
      ["docs", 10, "docs content"],
      ["memory", 3, "memory content"]
    );
    const executor = new Executor({
      id: "writer",
      stack,
      layerFilter: (l) => l.trust > 5,
      handler: async (context, _payload: string) => context,
    });

    const result = await executor.run("test");
    expect(result.output).toBe("docs content");
  });
});

describe("Decider", () => {
  test("returns decision without leaking context", async () => {
    const stack = makeStack(["taxonomy", 10, "Big secret taxonomy"]);
    const decider = new Decider({
      id: "priority",
      stack,
      handler: async (context, payload: string) => ({
        value: payload.includes("urgent") ? "high" : "low",
        confidence: 0.9,
        reasoning: "pattern match",
      }),
    });

    const result = await decider.run("urgent request");
    expect(result.output.value).toBe("high");
    expect(result.output.confidence).toBe(0.9);
    expect(result.output.reasoning).toBe("pattern match");
    // The context is used but not returned
    expect(JSON.stringify(result)).not.toContain("Big secret taxonomy");
  });

  test("decision can be any type", async () => {
    const stack = makeStack(["docs", 10, "docs"]);
    const decider = new Decider<string, { score: number; label: string }>({
      id: "scorer",
      stack,
      handler: async (_ctx, _payload) => ({
        value: { score: 42, label: "good" },
      }),
    });

    const result = await decider.run("test");
    expect(result.output.value.score).toBe(42);
    expect(result.output.value.label).toBe("good");
  });
});

describe("Classifier", () => {
  test("returns classification", async () => {
    const stack = makeStack(["taxonomy", 10, "Categories: bug, feature, question"]);
    const classifier = new Classifier({
      id: "classifier",
      stack,
      handler: async (context, payload: string) => ({
        value: {
          category: "bug",
          subcategory: "regression",
          tags: ["p0", "auth"],
        },
        confidence: 0.95,
      }),
    });

    const result = await classifier.run("auth login broken");
    expect(result.output.value.category).toBe("bug");
    expect(result.output.value.subcategory).toBe("regression");
    expect(result.output.value.tags).toEqual(["p0", "auth"]);
    expect(result.output.confidence).toBe(0.95);
  });

  test("classification with minimal fields", async () => {
    const stack = makeStack(["docs", 5, "docs"]);
    const classifier = new Classifier({
      id: "simple",
      stack,
      handler: async () => ({
        value: { category: "general" },
      }),
    });

    const result = await classifier.run("hello");
    expect(result.output.value.category).toBe("general");
    expect(result.output.value.subcategory).toBeUndefined();
    expect(result.output.value.tags).toBeUndefined();
  });
});

describe("Agent prompt-layer pairing", () => {
  test("assembleContext includes agent prompt and layer prompts", () => {
    const stack = new ContextStack(
      [
        ["conventions", 10, "Use TypeScript strict mode"],
        ["taxonomy", 8, "bug | feature | chore"],
      ].map(([id, trust, content]) => {
        const l = new ContextLayer({
          id: id as string,
          trust: trust as number,
          sources: [source(id as string, content as string)],
          prompt:
            id === "conventions"
              ? "Follow these project conventions."
              : "Classify using this taxonomy.",
        });
        l.set(content as string);
        return l;
      })
    );

    const executor = new Executor({
      id: "classifier",
      stack,
      prompt: "You are a message classifier.",
      handler: async (context, payload: string) => context,
    });

    const assembled = executor.assembleContext();
    expect(assembled.blocks[0]).toEqual({
      role: "system",
      text: "You are a message classifier.",
    });
    expect(assembled.blocks.length).toBe(5);
    expect(assembled.text).toContain("You are a message classifier.");
    expect(assembled.text).toContain("Follow these project conventions.");
    expect(assembled.text).toContain("Use TypeScript strict mode");
  });

  test("assembleContext respects filterOverride", () => {
    const stack = makeStack(
      ["docs", 10, "docs content"],
      ["memory", 3, "memory content"]
    );
    // Add prompt to docs layer
    stack.getLayer("docs")!.prompt = "Reference documentation.";

    const executor = new Executor({
      id: "writer",
      stack,
      prompt: "You are a writer.",
      handler: async (ctx) => ctx,
    });

    const assembled = executor.assembleContext((l) => l.id === "docs");
    expect(assembled.blocks.length).toBe(3); // system + layer prompt + content
    expect(assembled.text).not.toContain("memory content");
    expect(assembled.text).toContain("Reference documentation.");
  });

  test("assembleContext without agent prompt", () => {
    const stack = makeStack(["docs", 10, "docs content"]);
    stack.getLayer("docs")!.prompt = "Reference docs.";

    const executor = new Executor({
      id: "writer",
      stack,
      handler: async (ctx) => ctx,
    });

    const assembled = executor.assembleContext();
    expect(assembled.blocks[0].role).toBe("layer");
    expect(assembled.blocks.length).toBe(2);
  });
});

describe("Router", () => {
  test("returns route decision", async () => {
    const stack = makeStack(["topology", 10, "Agents: fix, build, answer"]);
    const router = new Router({
      id: "router",
      stack,
      handler: async (context, payload: { category: string }) => ({
        value: {
          destination: `executor-${payload.category}`,
          priority: 10,
          contextSlice: ["docs", "conventions"],
        },
        confidence: 0.9,
      }),
    });

    const result = await router.run({ category: "fix" });
    expect(result.output.value.destination).toBe("executor-fix");
    expect(result.output.value.priority).toBe(10);
    expect(result.output.value.contextSlice).toEqual(["docs", "conventions"]);
  });

  test("route with minimal fields", async () => {
    const stack = makeStack(["docs", 5, "docs"]);
    const router = new Router({
      id: "simple-router",
      stack,
      handler: async () => ({
        value: { destination: "default" },
      }),
    });

    const result = await router.run("test");
    expect(result.output.value.destination).toBe("default");
  });
});
