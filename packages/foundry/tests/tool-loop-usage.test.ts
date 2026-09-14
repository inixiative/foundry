import { describe, expect, test } from "bun:test";
import { ToolRegistry, type LLMProvider, type ScriptTool } from "@inixiative/foundry-core";
import { toolUseLoop } from "../src/agents/tool-loop";

describe("tool-loop token usage", () => {
  for (const maxIterations of [1, 3]) {
    test(`preserves cache-only usage through ${maxIterations === 1 ? "forced" : "normal"} completion`, async () => {
      const tools = new ToolRegistry();
      const tool: ScriptTool = { id: "script", kind: "script", capability: "exec:process",
        async evaluate() { return { ok: true, summary: "done", data: { result: 1, logs: [], durationMs: 0 } }; } };
      tools.register(tool, "Evaluate script");
      let calls = 0;
      const provider: LLMProvider = { id: "test", async complete() {
        calls++;
        return { content: "done", model: "test-model", tokens: { input: 0, output: 0, cacheRead: 1000, cacheWrite: 200, cacheWrite1h: 200 },
          toolCalls: calls === 1 ? [{ id: "call", name: "script_evaluate", input: { code: "1" } }] : undefined };
      } };
      const result = await toolUseLoop(provider, [{ role: "user", content: "test" }], tools, { maxIterations });
      expect(calls).toBe(2);
      expect(result.tokens).toEqual({ input: 0, output: 0, cacheRead: 2000, cacheWrite: 400, cacheWrite1h: 400 });
    });
  }
});
