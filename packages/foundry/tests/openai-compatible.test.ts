import { describe, expect, test } from "bun:test";
import { openAiApiRoot, OpenAIProvider } from "../src/providers/openai";
import { createRegisteredProvider, providerApiKey, providerApiRoot, providerReasoning } from "../src/providers/openai-compatible";
import { MODEL_REGISTRY, registryModel } from "../src/models/registry";

function captureRequest() {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], model: "m" });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe("base URL resolution", () => {
  test("a bare origin gains exactly one version segment", () => {
    expect(openAiApiRoot("https://api.openai.com")).toBe("https://api.openai.com/v1");
    expect(openAiApiRoot("https://api.openai.com/")).toBe("https://api.openai.com/v1");
    expect(openAiApiRoot("http://localhost:11434")).toBe("http://localhost:11434/v1");
  });

  test("an already versioned base is left alone rather than doubled", () => {
    expect(openAiApiRoot("https://api.x.ai/v1")).toBe("https://api.x.ai/v1");
    expect(openAiApiRoot("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
    expect(openAiApiRoot("https://api.z.ai/api/paas/v4")).toBe("https://api.z.ai/api/paas/v4");
    expect(openAiApiRoot("https://dashscope-intl.aliyuncs.com/compatible-mode/v1")).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
  });

  test("the adapter posts to the resolved root", async () => {
    const { calls, restore } = captureRequest();
    try {
      await new OpenAIProvider({ apiKey: "k" }).complete([{ role: "user", content: "hi" }]);
      await new OpenAIProvider({ apiKey: "k", baseUrl: "http://localhost:11434/v1" }).complete([{ role: "user", content: "hi" }]);
      expect(calls.map(call => call.url)).toEqual([
        "https://api.openai.com/v1/chat/completions",
        "http://localhost:11434/v1/chat/completions",
      ]);
    } finally { restore(); }
  });

  test("registry roots are used verbatim and an override is normalized", () => {
    expect(providerApiRoot("deepseek")).toBe("https://api.deepseek.com");
    expect(providerApiRoot("glm")).toBe("https://api.z.ai/api/paas/v4");
    expect(providerApiRoot("glm", "https://open.bigmodel.cn/api/paas/v4")).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(providerApiRoot("ollama", "http://10.0.0.2:11434")).toBe("http://10.0.0.2:11434/v1");
    expect(() => providerApiRoot("gemini")).toThrow("no OpenAI-compatible endpoint");
    expect(() => providerApiRoot("nope")).toThrow("Unregistered provider");
  });
});

describe("registered OpenAI-compatible providers", () => {
  test("one adapter serves the compatible family, keyed and keyless alike", async () => {
    const { calls, restore } = captureRequest();
    try {
      const deepseek = createRegisteredProvider("deepseek", { apiKey: "PRIVATE_DS" });
      const ollama = createRegisteredProvider("ollama");
      expect(deepseek).toBeInstanceOf(OpenAIProvider);
      expect(ollama).toBeInstanceOf(OpenAIProvider);
      await deepseek.complete([{ role: "user", content: "hi" }]);
      await ollama.complete([{ role: "user", content: "hi" }]);
      expect(calls[0].url).toBe("https://api.deepseek.com/chat/completions");
      expect(calls[0].body.model).toBe("deepseek-flash");
      expect(calls[1].url).toBe("http://localhost:11434/v1/chat/completions");
      expect(calls[1].body.model).toBe("llama3.2:3b");
      expect(calls[1].headers.authorization).toBe("Bearer local");
      expect(deepseek.id).toBe("deepseek");
    } finally { restore(); }
  });

  test("an api-key provider refuses to construct without its credential", () => {
    expect(() => createRegisteredProvider("deepseek")).toThrow("DEEPSEEK_API_KEY");
    expect(() => createRegisteredProvider("gemini", { apiKey: "k" })).toThrow("not OpenAI-compatible");
    expect(() => createRegisteredProvider("typesafe", { apiKey: "k" })).toThrow("not OpenAI-compatible");
  });

  test("reasoning shape comes from the registry map, not from the model name", async () => {
    const { calls, restore } = captureRequest();
    try {
      expect(providerReasoning("deepseek")("deepseek-flash")).toMatchObject({ param: "reasoning_effort" });
      expect(providerReasoning("openrouter")("meta-llama/llama-3.3-70b-instruct")).toBeUndefined();
      await createRegisteredProvider("deepseek", { apiKey: "k" }).complete([{ role: "user", content: "hi" }], { maxTokens: 32 });
      await createRegisteredProvider("openrouter", { apiKey: "k" }).complete([{ role: "user", content: "hi" }], { maxTokens: 32 });
      expect(calls[0].body.reasoning_effort).toBe("low");
      expect(calls[0].body.max_tokens).toBe(32);
      expect(calls[1].body.reasoning_effort).toBeUndefined();
      expect(calls[1].body.max_tokens).toBe(32);
      expect(calls[1].headers["HTTP-Referer"]).toBeString();
    } finally { restore(); }
  });

  test("a model whose ladder has no \"none\" is never asked for no thinking", async () => {
    const { calls, restore } = captureRequest();
    try {
      expect(registryModel("kimi", "kimi-k3")!.reasoning!.efforts).not.toContain("none");
      const kimi = createRegisteredProvider("kimi", { apiKey: "k" });
      await kimi.complete([{ role: "user", content: "hi" }]);
      await kimi.complete([{ role: "user", content: "hi" }], { thinking: "none" });
      await kimi.complete([{ role: "user", content: "hi" }], { thinking: "high" });
      expect(calls.map(call => call.body.reasoning_effort)).toEqual(["medium", "medium", "high"]);
    } finally { restore(); }
  });

  test("Grok's nested effort, dropped stop and max_tokens come from the map, not a subclass", async () => {
    const { calls, restore } = captureRequest();
    try {
      const grok = createRegisteredProvider("xai", { apiKey: "k" });
      expect(grok).toBeInstanceOf(OpenAIProvider);
      await grok.complete([{ role: "user", content: "hi" }], { model: "grok-4.7", thinking: "high", maxTokens: 64, stop: ["END"] });
      await grok.complete([{ role: "user", content: "hi" }], { model: "grok-build-0.1", maxTokens: 64, stop: ["END"] });
      expect(calls[0].url).toBe("https://api.x.ai/v1/chat/completions");
      expect(calls[0].body.reasoning).toEqual({ effort: "high" });
      expect(calls[0].body.reasoning_effort).toBeUndefined();
      expect(calls[0].body.max_completion_tokens).toBeUndefined();
      expect(calls[0].body.max_tokens).toBe(64);
      expect(calls[0].body.stop).toBeUndefined();
      expect(calls[1].body.reasoning).toBeUndefined();
      expect(calls[1].body.stop).toEqual(["END"]);
    } finally { restore(); }
  });

  test("an unregistered model id gets no reasoning parameters at all", async () => {
    const { calls, restore } = captureRequest();
    try {
      await new OpenAIProvider({ apiKey: "k" }).complete([{ role: "user", content: "hi" }], { model: "gpt-4o", maxTokens: 64, thinking: "high" });
      expect(calls[0].body.reasoning_effort).toBeUndefined();
      expect(calls[0].body.reasoning).toBeUndefined();
      expect(calls[0].body.max_tokens).toBe(64);
    } finally { restore(); }
  });

  test("credentials are read from the registered environment variable only", () => {
    expect(providerApiKey("deepseek", { DEEPSEEK_API_KEY: "PRIVATE_DS" })).toBe("PRIVATE_DS");
    expect(providerApiKey("deepseek", { DEEPSEEK_API_KEY: "  " })).toBeUndefined();
    expect(providerApiKey("ollama", { DEEPSEEK_API_KEY: "PRIVATE_DS" })).toBeUndefined();
    expect(MODEL_REGISTRY.ollama.envKey).toBeUndefined();
  });
});
