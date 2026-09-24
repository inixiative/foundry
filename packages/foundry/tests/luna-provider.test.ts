import { expect, test } from "bun:test";
import { OpenAIProvider } from "../src/providers/openai";

test("Luna decisions bound completion tokens and preserve non-reasoning latency in complete and stream", async () => {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string); bodies.push(body);
    return body.stream
      ? new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      : Response.json({ choices: [{ message: { content: "ok" } }], model: body.model });
  }) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ apiKey: "controlled-key" });
    await provider.complete([{ role: "user", content: "Decide" }], { maxTokens: 256 });
    for await (const _event of provider.stream([{ role: "user", content: "Decide" }], { maxTokens: 256 })) {}
    for (const body of bodies) {
      expect(body.model).toBe("gpt-5.6-luna");
      expect(body.reasoning_effort).toBe("none");
      expect(body.max_completion_tokens).toBe(256);
      expect(body.max_tokens).toBeUndefined();
    }
    await provider.complete([{ role: "user", content: "Legacy" }], { model: "gpt-4o", maxTokens: 128 });
    expect(bodies[2].max_tokens).toBe(128);
    expect(bodies[2].reasoning_effort).toBeUndefined();
  } finally { globalThis.fetch = original; }
});

test("provider rejection does not echo response secrets and remains settled", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("PRIVATE_PROVIDER_RESPONSE", { status: 401 })) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ apiKey: "controlled-key" });
    const error = await provider.complete([{ role: "user", content: "Decide" }]).catch(error => error);
    expect(error.message).toBe("OpenAI API 401");
    expect(provider.completionLifecycle.settlement({ error })).toBe("settled");
  } finally { globalThis.fetch = original; }
});


test("native-style zero timeout does not immediately abort API knowledge reviews", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    await Bun.sleep(5);
    expect(init.signal?.aborted).toBe(false);
    const body = JSON.parse(init.body as string);
    return body.stream ? new Response('data: [DONE]\n\n') : Response.json({choices:[{message:{content:"ok"}}],model:body.model});
  }) as typeof fetch;
  try {
    const provider = new OpenAIProvider({apiKey:"controlled-key"});
    await provider.complete([{role:"user",content:"Review"}],{maxTokens:1600,timeout:0});
    for await (const _event of provider.stream([{role:"user",content:"Review"}],{maxTokens:1600,timeout:0})) {}
  } finally { globalThis.fetch=original; }
});
