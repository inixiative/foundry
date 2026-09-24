import { expect, test } from "bun:test";
import { createDecisionProvider } from "../src/providers/decision-provider";
import { OpenAIProvider } from "../src/providers/openai";

test("decisions fail before making requests when disabled or missing a credential", () => {
  expect(() => createDecisionProvider(false, "controlled-key")).toThrow("worker model will not be used");
  for (const key of [undefined, "", " "]) expect(() => createDecisionProvider(true, key)).toThrow("OPENAI_API_KEY");
});

test("decision and OpenAI worker identities coexist and decisions retain Luna", async () => {
  const original = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string); models.push(body.model);
    return Response.json({ choices: [{ message: { content: "ok" } }], model: body.model });
  }) as typeof fetch;
  try {
    const decisions = createDecisionProvider(true, "controlled-key");
    const worker = new OpenAIProvider({ apiKey: "controlled-key", defaultModel: "gpt-5.6-sol" });
    const providers = new Map([[decisions.id, decisions], [worker.id, worker]]);
    expect(providers.size).toBe(2);
    await providers.get(decisions.id)!.complete([{ role: "user", content: "decide" }], { maxTokens: 16 });
    await providers.get(worker.id)!.complete([{ role: "user", content: "work" }], { maxTokens: 16 });
    expect(models).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
  } finally { globalThis.fetch = original; }
});
