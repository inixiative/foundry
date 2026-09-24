import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/viewer/config";
import {
  MODEL_CAPABILITIES,
  MODEL_REGISTRY,
  modelCapabilities,
  modelHasCapability,
  modelOptionsByCapability,
  modelOptionsByTier,
  providersWithCapability,
  registryForViewer,
  registryModel,
  type ModelCapability,
} from "../src/models/registry";

describe("model registry", () => {
  test("includes current target OpenAI and Claude Code models", () => {
    expect(MODEL_REGISTRY.openai.models.map((model) => model.id)).toEqual([
      "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
      "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
    ]);

    expect(MODEL_REGISTRY.codex.models.map((model) => model.id)).toEqual([
      "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
      "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
    ]);
    expect(MODEL_REGISTRY["claude-code"].models.map((model) => model.id)).toContain("fable");
    expect(MODEL_REGISTRY.anthropic.models.map((model) => model.id)).toContain("claude-fable-5-1");
  });

  test("default config is generated from the registry", () => {
    const config = defaultConfig();

    expect(config.defaults).toMatchObject({
      provider: "claude-code",
      model: "fable",
      classifierModel: "gpt-6-luna",
    });
    expect(config.providers.openai.models.some((model) => model.id === "gpt-6-astra")).toBe(true);
    expect(config.providers.codex.models.some((model) => model.id === "gpt-6-astra")).toBe(true);
    expect(config.providers["claude-code"].models.some((model) => model.id === "fable")).toBe(true);
  });

  test("research sweeps draw from the registry", () => {
    const fastModels = modelOptionsByTier(["fast"]);
    const executionModels = modelOptionsByTier(["standard", "powerful"]);

    expect(fastModels.some((model) => model.model === "gpt-6-luna")).toBe(true);
    expect(executionModels.some((model) => model.model === "gpt-6-astra")).toBe(true);
    expect(executionModels.some((model) => model.provider === "codex" && model.model === "gpt-6-astra")).toBe(true);
    expect(executionModels.some((model) => model.provider === "claude-code" && model.model === "fable")).toBe(true);
  });

  test("viewer projection distinguishes API models from native harness aliases", () => {
    const viewer = registryForViewer();
    const claudeCode = viewer.providers.find((provider) => provider.id === "claude-code");
    const codex = viewer.providers.find((provider) => provider.id === "codex");
    const openai = viewer.providers.find((provider) => provider.id === "openai");

    expect(claudeCode?.models.find((model) => model.id === "fable")).toMatchObject({
      runtimeKind: "native-harness",
      nativeAlias: true,
    });
    expect(openai?.models.find((model) => model.id === "gpt-6-astra")).toMatchObject({
      runtimeKind: "api",
      nativeAlias: false,
    });
    expect(codex?.models.find((model) => model.id === "gpt-6-astra")).toMatchObject({
      runtimeKind: "native-harness",
      nativeAlias: false,
    });
  });
});

describe("capability tags", () => {
  test("every model is a judgment client and every capability is in the vocabulary", () => {
    const vocabulary = new Set<ModelCapability>(MODEL_CAPABILITIES);
    for (const provider of Object.values(MODEL_REGISTRY)) {
      expect(provider.models.length).toBeGreaterThan(0);
      for (const model of provider.models) {
        expect(model.capabilities).toContain("judgment");
        expect(new Set(model.capabilities).size).toBe(model.capabilities.length);
        for (const capability of model.capabilities) expect(vocabulary.has(capability)).toBe(true);
      }
    }
    expect(modelOptionsByCapability("judgment").length).toBe(
      Object.values(MODEL_REGISTRY).reduce((total, provider) => total + provider.models.length, 0),
    );
  });

  test("a credential is declared for every provider and envKey follows it", () => {
    for (const provider of Object.values(MODEL_REGISTRY)) {
      expect(["api-key", "subscription", "local"]).toContain(provider.credential);
      expect(!!provider.envKey).toBe(provider.credential === "api-key");
    }
    expect(MODEL_REGISTRY.ollama.credential).toBe("local");
    expect(MODEL_REGISTRY.vllm.credential).toBe("local");
    expect(MODEL_REGISTRY["claude-code"].credential).toBe("subscription");
    expect(MODEL_REGISTRY.codex.credential).toBe("subscription");
  });

  test("capability lookup answers per provider and model", () => {
    expect(modelCapabilities("openai", "gpt-5.6-luna")).toContain("judgment");
    expect(modelHasCapability("openai", "gpt-5.6-luna", "execution")).toBe(false);
    expect(modelHasCapability("openai", "gpt-6-astra", "execution")).toBe(true);
    expect(modelHasCapability("typesafe", "jev-latest", "judgment")).toBe(true);
    expect(modelHasCapability("typesafe", "jev-latest", "execution")).toBe(false);
    expect(modelCapabilities("openai", "no-such-model")).toEqual([]);
    expect(modelCapabilities("no-such-provider", "gpt-6-astra")).toEqual([]);
  });

  test("a keyless local model can serve judgment, which is the point of registering one", () => {
    const local = modelOptionsByCapability("judgment").filter(option => ["ollama", "vllm"].includes(option.provider));
    expect(local.length).toBeGreaterThan(0);
    expect(local.some(option => option.model === "llama3.2:3b")).toBe(true);
    expect(providersWithCapability("judgment").map(provider => provider.id)).toContain("ollama");
    expect(providersWithCapability("execution").map(provider => provider.id)).not.toContain("typesafe");
  });

  test("capabilities and the API root reach the saved config and the viewer", () => {
    const config = defaultConfig();
    expect(config.providers.ollama.baseUrl).toBe("http://localhost:11434/v1");
    expect(config.providers.deepseek.models[0].capabilities).toContain("judgment");
    expect(config.providers.gemini.baseUrl).toBeUndefined();
    const viewer = registryForViewer();
    const ollama = viewer.providers.find(provider => provider.id === "ollama");
    expect(ollama).toMatchObject({ credential: "local", envKey: "" });
    expect(ollama?.models[0]?.capabilities).toContain("judgment");
    expect(viewer.providers.find(provider => provider.id === "typesafe")?.models[0]?.runtimeKind).toBe("typed-decision");
  });
});

describe("the map, not the model name, decides request shape", () => {
  test("the reasoning capability and the reasoning shape always agree", () => {
    for (const provider of Object.values(MODEL_REGISTRY)) {
      for (const model of provider.models) {
        expect(model.capabilities.includes("reasoning")).toBe(model.reasoning !== undefined);
        if (!model.reasoning) continue;
        expect(model.reasoning.efforts).toContain(model.reasoning.fallback);
        expect(model.reasoning.efforts.length).toBeGreaterThan(0);
      }
    }
  });

  test("models of one generation do not share one effort ladder", () => {
    // gpt-6-astra rejects "none"; its siblings accept it. A name prefix cannot express that.
    expect(registryModel("openai", "gpt-6-astra")!.reasoning!.efforts).not.toContain("none");
    expect(registryModel("openai", "gpt-6-luna")!.reasoning!.efforts).toContain("none");
    expect(registryModel("openai", "gpt-5.5")!.reasoning!.efforts).not.toContain("max");
    expect(registryModel("xai", "grok-4.7")!.reasoning!.param).toBe("reasoning.effort");
    expect(registryModel("openai", "gpt-6-luna")!.reasoning!.param).toBe("reasoning_effort");
  });

  test("the GPT-6 family is registered on both paths with the credential kinds kept apart", () => {
    for (const id of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
      expect(registryModel("codex", id)!.runtimeKind).toBe("native-harness");
      expect(registryModel("openai", id)!.runtimeKind).toBe("api");
    }
    expect(MODEL_REGISTRY.codex.credential).toBe("subscription");
    expect(MODEL_REGISTRY.codex.envKey).toBeUndefined();
    expect(MODEL_REGISTRY.openai.credential).toBe("api-key");
  });

  test("shut-down model ids are not served to users", () => {
    // Google lists these under "Previous models (Shut down)".
    for (const id of ["gemini-3.1-flash-lite-preview", "gemini-3-pro-preview", "gemini-2.0-flash"])
      expect(registryModel("gemini", id)).toBeUndefined();
    expect(registryModel("gemini", "gemini-3.1-flash-lite")).toBeDefined();
  });
});

test("each vendor's own effort field is recorded, not flattened into OpenAI's", () => {
  expect(registryModel("anthropic", "claude-opus-5")!.reasoning!.param).toBe("output_config.effort");
  expect(registryModel("gemini", "gemini-3.8-flash")!.reasoning!.param).toBe("thinking_level");
  expect(registryModel("kimi", "kimi-k3")!.reasoning!.param).toBe("reasoning_effort");
});
