import { describe, test, expect } from "bun:test";
import {
  ThreadFactory,
  buildLayers,
  buildAgents,
  keywordClassify,
  keywordRoute,
  parseJSON,
  type SourceResolver,
} from "../src/agents/thread-factory";
import { ContextStack } from "@inixiative/foundry-core";
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
// buildLayers()
// ---------------------------------------------------------------------------

describe("buildLayers", () => {
  test("builds layers from config", () => {
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

    const layers = buildLayers(config, { sourceResolver: noopResolver });
    expect(layers.length).toBe(2);

    const ids = layers.map((l) => l.id);
    expect(ids).toContain("system");
    expect(ids).toContain("conventions");
  });

  test("skips disabled layers", () => {
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

    const layers = buildLayers(config, { sourceResolver: noopResolver });
    expect(layers.map((l) => l.id)).not.toContain("disabled");
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

    const layers = buildLayers(config, { sourceResolver: resolver });
    const stack = new ContextStack(layers);
    await stack.warmAll();

    const docsLayer = stack.getLayer("docs");
    expect(docsLayer).toBeDefined();
    expect(docsLayer!.content).toBe("test docs content");
  });

  test("creates fallback system layer when no layers configured", () => {
    const layers = buildLayers(minimalConfig({ layers: {} }), { sourceResolver: noopResolver });
    expect(layers.length).toBe(1);
    expect(layers[0].id).toBe("system");
  });
});

// ---------------------------------------------------------------------------
// buildAgents()
// ---------------------------------------------------------------------------

describe("buildAgents", () => {
  test("builds agents from config", () => {
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

    const stack = new ContextStack(buildLayers(config, { sourceResolver: noopResolver }));
    const agents = buildAgents(config, stack, { provider: mockProvider() });

    expect(agents.size).toBe(1);
    expect(agents.has("my-executor")).toBe(true);
  });

  test("skips disabled agents", () => {
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

    const stack = new ContextStack(buildLayers(config, { sourceResolver: noopResolver }));
    const agents = buildAgents(config, stack, { provider: mockProvider() });

    expect(agents.size).toBe(1);
    expect(agents.has("active")).toBe(true);
    expect(agents.has("inactive")).toBe(false);
  });

  test("builds classifier agent kind", () => {
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

    const stack = new ContextStack(buildLayers(config, { sourceResolver: noopResolver }));
    const agents = buildAgents(config, stack, { provider: mockProvider() });
    expect(agents.has("classifier")).toBe(true);
  });

  test("builds router agent kind", () => {
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

    const stack = new ContextStack(buildLayers(config, { sourceResolver: noopResolver }));
    const agents = buildAgents(config, stack, { provider: mockProvider() });
    expect(agents.has("router")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ThreadFactory
// ---------------------------------------------------------------------------

describe("ThreadFactory", () => {
  test("creates thread with correct ID", () => {
    const config = minimalConfig();
    const stack = new ContextStack(buildLayers(config, { sourceResolver: noopResolver }));
    const agents = buildAgents(config, stack, { provider: mockProvider() });
    const factory = new ThreadFactory({ stack, agents });

    const thread = factory.create("t1");
    expect(thread.id).toBe("t1");
  });

  test("registers agents on created thread", () => {
    const config = minimalConfig();
    const stack = new ContextStack(buildLayers(config, { sourceResolver: noopResolver }));
    const agents = buildAgents(config, stack, { provider: mockProvider() });
    const factory = new ThreadFactory({ stack, agents });

    const thread = factory.create("t1");
    expect(thread.getAgent("executor-answer")).toBeDefined();
  });

  test("threads share the same stack (project-scoped)", () => {
    const config = minimalConfig();
    const stack = new ContextStack(buildLayers(config, { sourceResolver: noopResolver }));
    const agents = buildAgents(config, stack, { provider: mockProvider() });
    const factory = new ThreadFactory({ stack, agents });

    const t1 = factory.create("t1");
    const t2 = factory.create("t2");

    expect(t1.id).toBe("t1");
    expect(t2.id).toBe("t2");
    // Both threads share the same underlying stack
    expect(t1.stack).toBe(t2.stack);
  });

  test("passes thread config (description, tags)", () => {
    const config = minimalConfig();
    const stack = new ContextStack(buildLayers(config, { sourceResolver: noopResolver }));
    const agents = buildAgents(config, stack, { provider: mockProvider() });
    const factory = new ThreadFactory({ stack, agents });

    const thread = factory.create("t1", { description: "Test thread", tags: ["test"] });
    expect(thread.id).toBe("t1");
  });

  test("token tracker records usage from agent completions", async () => {
    const provider = mockProvider("hello world");
    const tracker = new TokenTracker();
    const config = minimalConfig();

    const stack = new ContextStack(buildLayers(config, { sourceResolver: noopResolver }));
    const agents = buildAgents(config, stack, { provider, tokenTracker: tracker });
    const factory = new ThreadFactory({ stack, agents });

    const thread = factory.create("t1");
    await thread.dispatch("executor-answer", "test input");

    const summary = tracker.summary();
    expect(summary.totalInput).toBe(100);
    expect(summary.totalOutput).toBe(50);
    expect(summary.byAgent.find((b) => b.key === "executor-answer")).toBeDefined();
  });

  test("executor agent calls provider with correct messages", async () => {
    const provider = mockProvider("response text");
    const config = minimalConfig();

    const stack = new ContextStack(buildLayers(config, { sourceResolver: noopResolver }));
    const agents = buildAgents(config, stack, { provider });
    const factory = new ThreadFactory({ stack, agents });

    const thread = factory.create("t1");
    await thread.dispatch("executor-answer", "user question");

    expect(provider.calls.length).toBe(1);
    const messages = provider.calls[0];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("You are a helpful assistant.");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("user question");
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

  test("routes bugs to artificer", () => {
    const route = keywordRoute({ category: "bug" }, config);
    expect(route.value.destination).toBe("artificer");
  });

  test("routes features to artificer", () => {
    const route = keywordRoute({ category: "feature" }, config);
    expect(route.value.destination).toBe("artificer");
  });

  test("routes questions to artificer", () => {
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
