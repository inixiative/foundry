import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeProvider } from "../src/providers/claude-code";
import { AnthropicProvider } from "../src/providers/anthropic";

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 200 },
  output_tokens_details: { thinking_tokens: 12 }, service_tier: "standard", future_tag: true };
const expected = { input: 10, output: 20, cacheRead: 1000, cacheWrite: 200,
  cacheWrite1h: 200, thinking: 12, providerUsage: usage };

describe("Claude provider usage", () => {
  test("CLI object/array results and streaming preserve usage and apply native context policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "foundry-claude-usage-"));
    try {
      for (const array of [false, true]) {
        const bin = join(dir, "claude");
        await writeFile(bin, `#!/usr/bin/env bun\nconst result = { type: "result", subtype: "success", result: "done", usage: ${JSON.stringify(usage)}, testEnv: { window: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, pct: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE }, session_id: "test-id" };\nconsole.log(JSON.stringify(process.argv.includes("stream-json") ? result : ${array} ? [result] : result));\n`, { mode: 0o755 });
        const provider = new ClaudeCodeProvider({ bin, cwd: dir });
        const result = await provider.complete([{ role: "user", content: "test" }]);
        expect(result.tokens).toEqual(expected);
        expect(result.raw).toMatchObject({ testEnv: { window: "200000", pct: "80" } });
        const events = await Array.fromAsync(provider.stream([{ role: "user", content: "test" }]));
        expect(events.find(e => e.type === "usage")?.tokens).toEqual(expected);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("Anthropic completion and SSE preserve cache-only usage across split chunks", async () => {
    const originalFetch = globalThis.fetch;
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({ content: [], model: "test-model", usage, stop_reason: "end_turn" }))) as typeof fetch;
      expect((await provider.complete([{ role: "user", content: "test" }])).tokens).toEqual(expected);
      const cacheOnly = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 500, service_tier: "standard" };
      const chunks = ["event: message_start\n", `data: ${JSON.stringify({ message: { usage: cacheOnly } })}\n\n`, "event: message_delta\n", `data: ${JSON.stringify({ usage: { output_tokens: 0 }, delta: { stop_reason: "end_turn" } })}\n\n`];
      globalThis.fetch = (async () => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }))) as typeof fetch;
      const events = await Array.fromAsync(provider.stream([{ role: "user", content: "test" }]));
      expect(events.find(e => e.type === "usage")?.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 500, providerUsage: cacheOnly });
    } finally { globalThis.fetch = originalFetch; }
  });
});
