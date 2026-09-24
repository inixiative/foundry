import { expect, test } from "bun:test";
import { ContextStack, Harness, type LLMProvider } from "@inixiative/foundry-core";
import { buildAgents, ThreadFactory } from "../src/agents/thread-factory";
import { starterConfig } from "../src/viewer/config";

for (const output of ["", "not json", '{"destination":"missing"}', '{"destination":"classifier"}']) {
  test(`invalid production router output falls back to a real executor: ${output}`, async () => {
    const config = starterConfig("mock", "mock");
    config.agents = Object.fromEntries((["classifier", "router", "artificer"] as const).map(id => [id, {
      id, kind: id === "artificer" ? "executor" as const : id, provider: "mock", model: "mock", prompt: id,
      temperature: 0, maxTokens: 100, visibleLayers: [], peers: [], maxDepth: 1, enabled: true,
    }]));
    const stack = new ContextStack();
    const calls: string[] = [];
    const provider: LLMProvider = { id: "mock", complete: async (_messages, opts) => {
      calls.push(opts?.threadId ?? "");
      return { content: opts?.threadId?.includes(":aux:") ? output : "ACTUAL_EXECUTOR_RESULT", model: "mock" };
    } };
    const thread = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider }) }).create("route-failure");
    const harness = new Harness(thread);
    harness.setClassifier("classifier"); harness.setRouter("router"); harness.setDefaultExecutor("artificer");
    try {
      const result = await harness.send({ id: "turn", payload: "Build the sample" });
      expect(result.result.output).toBe("ACTUAL_EXECUTOR_RESULT");
      expect(result.route?.reasoning).toContain("fallback");
      expect(result.route?.confidence).toBeLessThan(0.9);
      expect(calls.filter(id => id === "route-failure")).toHaveLength(1);
    } finally { thread.dispose(); }
  });
}

for (const streaming of [false, true]) {
  test(`production ${streaming ? "streaming" : "complete"} provider errors are failures, not successful assistant text`, async () => {
    const config = starterConfig("mock", "mock");
    config.agents = { worker: { id: "worker", kind: "executor", provider: "mock", model: "mock", prompt: "Execute",
      temperature: 0, maxTokens: 100, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
    const stack = new ContextStack();
    const provider: LLMProvider = { id: "mock", complete: async () => { throw new Error("native work outcome unknown"); },
      stream: async function* () { yield { type: "error" as const, error: "native work outcome unknown" }; } };
    const thread = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider }) }).create("failed-provider");
    const harness = new Harness(thread); harness.setDefaultExecutor("worker");
    const observations: unknown[] = [];
    thread.signals.on("dispatch", signal => { observations.push(signal.content); });
    try {
      if (streaming) {
        await expect((async () => { for await (const _ of harness.sendStream({ id: "turn", payload: "Do work" })) {} })()).rejects.toThrow("outcome unknown");
      } else await expect(harness.send({ id: "turn", payload: "Do work" })).rejects.toThrow("outcome unknown");
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({ ok: false, error: "native work outcome unknown" });
    } finally { thread.dispose(); }
  });
}
