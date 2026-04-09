import { describe, test, expect } from "bun:test";
import {
  ThreadFactory,
  keywordClassify,
  keywordRoute,
  parseJSON,
  type SourceResolver,
} from "../src/agents/thread-factory";
import type { LLMProvider, CompletionResult, LLMMessage, CompletionOpts } from "@inixiative/foundry-core";
import { TokenTracker } from "@inixiative/foundry-core";
import type { FoundryConfig } from "../src/viewer/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProvider(response: string = '{"category":"general"}'): LLMProvider & { calls: LLMMessage[][] } {
  const calls: LLMMessage[][] = [];
  return {
    id: "mock",
    calls,
    async complete(messages: LLMMessage[], opts?: CompletionOpts): Promise<CompletionResult> {
      calls.push(messages);
      return {
        content: response,
        model: "mock-model",
        tokens: { input: 100, output: 50 },
      };
    },
  };
}

const noopResolver: SourceResolver = () => null;

function inlineResolver(content: string): SourceResolver {
  return (sourceId) => ({
    id: sourceId,
    load: async () => content,
  });
}

function minimalConfig(overrides?: Partial<FoundryConfig>): FoundryConfig {
  return {
    defaults: {
      provider: "mock",
      model: "mock-model",
      temperature: 0,
      maxTokens: 1024,
    },
    providers: {},
    agents: {
      "executor-answer": {
        id: "executor-answer",
        kind: "executor",
        prompt: "You are a helpful assistant.",
        provider: "mock",
        model: "mock-model",
        temperature: 0,
        maxTokens: 1024,
        visibleLayers: [],
        peers: [],
        maxDepth: 1,
        enabled: true,
      },
    },
    layers: {
      system: {
        id: "system",
        prompt: "System layer",
        sourceIds: [],
        trust: 1.0,
        staleness: 0,
        maxTokens: 0,
        enabled: true,
      },
    },
    sources: {},
    projects: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ThreadFactory.create()
// ---------------------------------------------------------------------------

describe("ThreadFactory", () => {
  test("creates thread with correct ID", async () => {
    const factory = new ThreadFactory({ provider: mockProvider(), sourceResolver: noopResolver });
    const { thread } = await factory.create("t1", minimalConfig());
    expect(thread.id).toBe("t1");
  });

  test("builds layers from config", async () => {
    const config = minimalConfig({
      layers: {
        system: {
          id: "system",
          prompt: "System prompt",
          sourceIds: [],
          trust: 1.0,
          staleness: 0,
          maxTokens: 0,
          enabled: true,
        },
        conventions: {
          id: "conventions",
          prompt: "Conventions",
          sourceIds: [],
          trust: 0.8,
          staleness: 0,
          maxTokens: 0,
          enabled: true,
        },
      },
    });

    const factory = new ThreadFactory({ provider: mockProvider(), sourceResolver: noopResolver });
    const { stack } = await factory.create("t1", config);

    // 2 config layers + 1 RunContext layer
    expect(stack.layers.length).toBe(3);
    expect(stack.layers.map((l) => l.id)).toContain("system");
    expect(stack.layers.map((l) => l.id)).toContain("conventions");
  });

  test("adds RunContext layer named run:<threadId>", async () => {
    const factory = new ThreadFactory({ provider: mockProvider(), sourceResolver: noopResolver });
    const { stack } = await factory.create("mythread", minimalConfig());

    const runLayer = stack.getLayer("run:mythread");
    expect(runLayer).toBeDefined();
    expect(runLayer!.trust).toBe(8);
  });

  test("skips disabled layers", async () => {
    const config = minimalConfig({
      layers: {
        system: {
          id: "system",
          prompt: "System",
          sourceIds: [],
          trust: 1.0,
          staleness: 0,
          maxTokens: 0,
          enabled: true,
        },
        disabled: {
          id: "disabled",
          prompt: "Should not appear",
          sourceIds: [],
          trust: 0.5,
          staleness: 0,
          maxTokens: 0,
          enabled: false,
        },
      },
    });

    const factory = new ThreadFactory({ provider: mockProvider(), sourceResolver: noopResolver });
    const { stack } = await factory.create("t1", config);

    expect(stack.getLayer("disabled")).toBeUndefined();
  });

  test("resolves sources via sourceResolver", async () => {
    const config = minimalConfig({
      layers: {
        docs: {
          id: "docs",
          prompt: "Documentation",
          sourceIds: ["doc-source"],
          trust: 0.9,
          staleness: 0,
          maxTokens: 0,
          enabled: true,
        },
      },
      sources: {
        "doc-source": {
          id: "doc-source",
          type: "inline",
          label: "Docs",
          uri: "test docs content",
          enabled: true,
        },
      },
    });

    const resolver: SourceResolver = (sourceId, cfg) => {
      const src = cfg.sources[sourceId];
      if (!src) return null;
      return { id: src.id, load: async () => src.uri };
    };

    const factory = new ThreadFactory({ provider: mockProvider(), sourceResolver: resolver });
    const { stack } = await factory.create("t1", config, { warm: true });

    const docsLayer = stack.getLayer("docs");
    expect(docsLayer).toBeDefined();
    expect(docsLayer!.content).toBe("test docs content");
  });

  test("creates fallback system layer when no layers configured", async () => {
    const config = minimalConfig({ layers: {} });
    const factory = new ThreadFactory({ provider: mockProvider(), sourceResolver: noopResolver });
    const { stack } = await factory.create("t1", config);

    // fallback system + RunContext
    expect(stack.layers.length).toBe(2);
    expect(stack.getLayer("system")).toBeDefined();
  });

  test("builds agents from config", async () => {
    const config = minimalConfig({
      agents: {
        "my-executor": {
          id: "my-executor",
          kind: "executor",
          prompt: "Execute tasks",
          provider: "mock",
          model: "mock-model",
          temperature: 0,
          maxTokens: 1024,
          visibleLayers: [],
          peers: [],
          maxDepth: 1,
          enabled: true,
        },
      },
    });

    const factory = new ThreadFactory({ provider: mockProvider(), sourceResolver: noopResolver });
    const { agents, thread } = await factory.create("t1", config);

    expect(agents.size).toBe(1);
    expect(agents.has("my-executor")).toBe(true);
    expect(thread.getAgent("my-executor")).toBeDefined();
  });

  test("skips disabled agents", async () => {
    const config = minimalConfig({
      agents: {
        active: {
          id: "active",
          kind: "executor",
          prompt: "Active",
          provider: "mock",
          model: "mock-model",
          temperature: 0,
          maxTokens: 1024,
          visibleLayers: [],
          peers: [],
          maxDepth: 1,
          enabled: true,
        },
        inactive: {
          id: "inactive",
          kind: "executor",
          prompt: "Inactive",
          provider: "mock",
          model: "mock-model",
          temperature: 0,
          maxTokens: 1024,
          visibleLayers: [],
          peers: [],
          maxDepth: 1,
          enabled: false,
        },
      },
    });

    const factory = new ThreadFactory({ provider: mockProvider(), sourceResolver: noopResolver });
    const { agents } = await factory.create("t1", config);

    expect(agents.size).toBe(1);
    expect(agents.has("active")).toBe(true);
    expect(agents.has("inactive")).toBe(false);
  });

  test("builds classifier agent kind", async () => {
    const config = minimalConfig({
      agents: {
        classifier: {
          id: "classifier",
          kind: "classifier",
          prompt: "",
          provider: "mock",
          model: "mock-model",
          temperature: 0,
          maxTokens: 256,
          visibleLayers: [],
          peers: [],
          maxDepth: 1,
          enabled: true,
        },
      },
    });

    const factory = new ThreadFactory({ provider: mockProvider(), sourceResolver: noopResolver });
    const { agents } = await factory.create("t1", config);
    expect(agents.has("classifier")).toBe(true);
  });

  test("builds router agent kind", async () => {
    const config = minimalConfig({
      agents: {
        router: {
          id: "router",
          kind: "router",
          prompt: "",
          provider: "mock",
          model: "mock-model",
          temperature: 0,
          maxTokens: 256,
          visibleLayers: [],
          peers: [],
          maxDepth: 1,
          enabled: true,
        },
      },
    });

    const factory = new ThreadFactory({ provider: mockProvider(), sourceResolver: noopResolver });
    const { agents } = await factory.create("t1", config);
    expect(agents.has("router")).toBe(true);
  });

  test("token tracker records usage from agent completions", async () => {
    const provider = mockProvider("hello world");
    const tracker = new TokenTracker();
    const config = minimalConfig();

    const factory = new ThreadFactory({ provider, tokenTracker: tracker, sourceResolver: noopResolver });
    const { thread } = await factory.create("t1", config);

    // Dispatch to trigger a completion
    await thread.dispatch("executor-answer", "test input");

    const summary = tracker.summary();
    expect(summary.totalInput).toBe(100);
    expect(summary.totalOutput).toBe(50);
    expect(summary.byAgent.find((b) => b.key === "executor-answer")).toBeDefined();
  });

  test("executor agent calls provider with correct messages", async () => {
    const provider = mockProvider("response text");
    const config = minimalConfig();

    const factory = new ThreadFactory({ provider, sourceResolver: noopResolver });
    const { thread } = await factory.create("t1", config);

    await thread.dispatch("executor-answer", "user question");

    expect(provider.calls.length).toBe(1);
    const messages = provider.calls[0];
    // System message includes context + agent prompt
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("You are a helpful assistant.");
    // User message is the payload
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("user question");
  });

  test("warm: false skips layer warming", async () => {
    let loadCalled = false;
    const resolver: SourceResolver = () => ({
      id: "lazy",
      load: async () => { loadCalled = true; return "data"; },
    });

    const config = minimalConfig({
      layers: {
        lazy: {
          id: "lazy",
          prompt: "Lazy layer",
          sourceIds: ["lazy-src"],
          trust: 0.5,
          staleness: 0,
          maxTokens: 0,
          enabled: true,
        },
      },
      sources: {
        "lazy-src": { id: "lazy-src", type: "inline", label: "Lazy", uri: "", enabled: true },
      },
    });

    const factory = new ThreadFactory({ provider: mockProvider(), sourceResolver: resolver });
    await factory.create("t1", config, { warm: false });

    expect(loadCalled).toBe(false);
  });

  test("creates independent instances for different threads", async () => {
    const factory = new ThreadFactory({ provider: mockProvider(), sourceResolver: noopResolver });
    const config = minimalConfig();

    const { thread: t1, stack: s1 } = await factory.create("t1", config);
    const { thread: t2, stack: s2 } = await factory.create("t2", config);

    // Different thread IDs
    expect(t1.id).toBe("t1");
    expect(t2.id).toBe("t2");

    // Independent stacks — mutating one doesn't affect the other
    const rc1 = s1.getLayer("run:t1");
    const rc2 = s2.getLayer("run:t2");
    expect(rc1).toBeDefined();
    expect(rc2).toBeDefined();

    rc1!.set("t1 only");
    expect(rc2!.content).not.toBe("t1 only");
  });

  test("adds logger middleware", async () => {
    const factory = new ThreadFactory({ provider: mockProvider(), sourceResolver: noopResolver });
    const { thread } = await factory.create("t1", minimalConfig());

    // Logger should be registered
    expect(thread.middleware.size).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Shared fallback handlers
// ---------------------------------------------------------------------------

describe("keywordClassify", () => {
  test("classifies bug-related keywords", () => {
    expect(keywordClassify("fix the auth bug").value.category).toBe("bug");
    expect(keywordClassify("there's an error").value.category).toBe("bug");
  });

  test("classifies feature-related keywords", () => {
    expect(keywordClassify("add a new feature").value.category).toBe("feature");
    expect(keywordClassify("build the dashboard").value.category).toBe("feature");
  });

  test("classifies refactor keywords", () => {
    expect(keywordClassify("refactor the auth module").value.category).toBe("refactor");
    expect(keywordClassify("clean up the code").value.category).toBe("refactor");
  });

  test("classifies question keywords", () => {
    expect(keywordClassify("how does auth work?").value.category).toBe("question");
    expect(keywordClassify("why is it slow?").value.category).toBe("question");
  });

  test("classifies convention keywords", () => {
    expect(keywordClassify("update the coding convention").value.category).toBe("convention");
    expect(keywordClassify("change the style guide").value.category).toBe("convention");
  });

  test("falls back to general", () => {
    expect(keywordClassify("hello world").value.category).toBe("general");
  });

  test("returns confidence 0.7", () => {
    expect(keywordClassify("anything").confidence).toBe(0.7);
  });
});

describe("keywordRoute", () => {
  const config = minimalConfig();

  test("routes bugs to executor-fix", () => {
    const route = keywordRoute({ category: "bug" }, config);
    expect(route.value.destination).toBe("artificer");
  });

  test("routes features to executor-build", () => {
    const route = keywordRoute({ category: "feature" }, config);
    expect(route.value.destination).toBe("artificer");
  });

  test("routes questions to executor-answer", () => {
    const route = keywordRoute({ category: "question" }, config);
    expect(route.value.destination).toBe("artificer");
  });

  test("unknown category falls back to general", () => {
    const route = keywordRoute({ category: "unknown" }, config);
    expect(route.value.destination).toBe("artificer");
  });
});

describe("parseJSON", () => {
  test("parses plain JSON", () => {
    const result = parseJSON('{"category": "bug"}');
    expect(result.category).toBe("bug");
  });

  test("parses fenced JSON", () => {
    const result = parseJSON('```json\n{"category": "feature"}\n```');
    expect(result.category).toBe("feature");
  });

  test("extracts braced JSON from surrounding text", () => {
    const result = parseJSON('Here is the result: {"category": "refactor"} done');
    expect(result.category).toBe("refactor");
  });

  test("returns fallback on garbage input", () => {
    const result = parseJSON("not json at all");
    expect(result.category).toBe("general");
    expect(result.reasoning).toBe("parse failure");
  });

  test("handles fenced block without json tag", () => {
    const result = parseJSON('```\n{"key": "value"}\n```');
    expect(result.key).toBe("value");
  });
});
