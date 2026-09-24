import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/viewer/config";
import { MODEL_REGISTRY, modelOptionsByTier, registryForViewer } from "../src/models/registry";

describe("model registry", () => {
  test("includes current target OpenAI and Claude Code models", () => {
    expect(MODEL_REGISTRY.openai.models.map((model) => model.id)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);

    expect(MODEL_REGISTRY.codex.models.map((model) => model.id)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(MODEL_REGISTRY["claude-code"].models.map((model) => model.id)).toContain("fable");
    expect(MODEL_REGISTRY.anthropic.models.map((model) => model.id)).toContain("claude-fable-5-1");
  });

  test("default config is generated from the registry", () => {
    const config = defaultConfig();

    expect(config.defaults).toMatchObject({
      provider: "claude-code",
      model: "fable",
    });
    expect(config.providers.openai.models.some((model) => model.id === "gpt-6-astra")).toBe(true);
    expect(config.providers.codex.models.some((model) => model.id === "gpt-6-astra")).toBe(true);
    expect(config.providers["claude-code"].models.some((model) => model.id === "fable")).toBe(true);
  });

  test("research sweeps draw from the registry", () => {
    const fastModels = modelOptionsByTier(["fast"]);
    const executionModels = modelOptionsByTier(["standard", "powerful"]);

    expect(fastModels.some((model) => model.model === "gpt-5.6-luna")).toBe(true);
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
