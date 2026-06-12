import { describe, test, expect } from "bun:test";
import { AnthropicProvider } from "../../src/providers/anthropic";
import { GeminiProvider } from "../../src/providers/gemini";

// Live provider smoke tests — real API calls, a few hundred tokens total.
// Excluded from the default suite (which globs tests/*.test.ts only).
// Run with: bun run test:live
// Each block skips itself when its key is absent, so this file is safe to run
// in any environment.

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const geminiKey = process.env.GEMINI_API_KEY;

describe("AnthropicProvider (live)", () => {
  test.skipIf(!anthropicKey)("complete() returns content and usage", async () => {
    const provider = new AnthropicProvider({
      apiKey: anthropicKey!,
      defaultModel: "claude-haiku-4-5-20251001",
      defaultMaxTokens: 64,
    });

    const result = await provider.complete([
      { role: "user", content: "Reply with exactly the word: pong" },
    ]);

    expect(result.content.toLowerCase()).toContain("pong");
    expect(result.model).toContain("haiku");
    expect(result.tokens.input).toBeGreaterThan(0);
    expect(result.tokens.output).toBeGreaterThan(0);
    expect(result.finishReason).toBe("end_turn");
  }, 30_000);

  test.skipIf(!anthropicKey)("stream() yields text, usage, and done", async () => {
    const provider = new AnthropicProvider({
      apiKey: anthropicKey!,
      defaultModel: "claude-haiku-4-5-20251001",
      defaultMaxTokens: 64,
    });

    let text = "";
    let usage: { input: number; output: number } | undefined;
    let done = false;

    for await (const event of provider.stream([
      { role: "user", content: "Reply with exactly the word: pong" },
    ])) {
      if (event.type === "text") text += event.text;
      if (event.type === "usage") usage = event.tokens;
      if (event.type === "done") done = true;
      if (event.type === "error") throw new Error(event.error);
    }

    expect(text.toLowerCase()).toContain("pong");
    expect(usage?.output).toBeGreaterThan(0);
    expect(done).toBe(true);
  }, 30_000);

  test.skipIf(!anthropicKey)("bad key surfaces a 401, not a hang", async () => {
    const provider = new AnthropicProvider({
      apiKey: "sk-ant-invalid-key-for-test",
      defaultModel: "claude-haiku-4-5-20251001",
    });

    expect(
      provider.complete([{ role: "user", content: "hi" }])
    ).rejects.toThrow(/401/);
  }, 30_000);
});

describe("GeminiProvider (live)", () => {
  test.skipIf(!geminiKey)("complete() returns content and usage", async () => {
    const provider = new GeminiProvider({ apiKey: geminiKey! });

    const result = await provider.complete([
      { role: "user", content: "Reply with exactly the word: pong" },
    ]);

    expect(result.content.toLowerCase()).toContain("pong");
    expect(result.tokens.output).toBeGreaterThan(0);
  }, 30_000);
});
