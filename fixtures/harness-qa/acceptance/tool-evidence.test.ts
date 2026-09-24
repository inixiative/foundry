import { afterEach, expect, test } from "bun:test";
import { ContextLayer, ContextStack, ToolRegistry, type LLMProvider } from "../../../packages/core/src";
import { buildAgents, ThreadFactory } from "../../../packages/foundry/src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { starterConfig } from "../../../packages/foundry/src/viewer/config";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function setup() {
  const config = starterConfig("mock", "mock");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "mock", model: "mock",
    prompt: "Execute", temperature: 0, maxTokens: 256, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const layer = new ContextLayer({ id: "security" }); layer.set("Security domain");
  const stack = new ContextStack([layer]);
  const reviews: string[] = [];
  const runtime = new ThreadRuntimeManager({ config, log: () => {}, warn: () => {},
    domains: [{ domain: "security", layerId: "security", guardTriggers: [] }],
    llm: { id: "flow", complete: async messages => {
      const text = messages.filter(m => m.role === "user").map(m => m.content).join("\n");
      if (text.includes("## Completed work")) {
        reviews.push(text);
        return { model: "mock", content: '{"decision":"abstain","reason":"observed"}' };
      }
      return { model: "mock", content: '{"layers":["security"],"domains":["security"],"snippets":[],"confidence":1}' };
    } },
  });
  cleanup.push(() => runtime.disposeAll());
  const tools = new ToolRegistry();
  tools.register({ id: "fixture", kind: "shell", capability: "exec:shell",
    exec: async () => ({ ok: true, summary: "OBSERVED-RESULT-SENTINEL" }),
    run: async () => "", which: async () => null,
  }, "Deterministic fixture; no shell process");
  let call = 0;
  const provider: LLMProvider = { id: "mock", complete: async () => ++call === 1
    ? { model: "mock", content: "", toolCalls: [{ id: "call-1", name: "fixture_exec", input: { command: "inspect" } }] }
    : { model: "mock", content: "Work complete" } };
  const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider, tools }), runtime });
  const thread = factory.create("owned", { projectId: "P" });
  return { thread, owned: runtime.get(thread.id)!, reviews };
}

test("G3/G5: production tool result evidence reaches the domain reviewer, not just its invocation", async () => {
  const { thread, owned, reviews } = setup();
  await thread.dispatch("worker", "Inspect the project");
  await owned.learningSettled();
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toContain("OBSERVED-RESULT-SENTINEL");
});

test("G3/G5: a tool observation with no outcome is never manufactured into a success", async () => {
  const { thread, owned } = setup();
  await thread.signals.emit({ id: "unknown-outcome", source: "native-hook", kind: "tool_observation", timestamp: Date.now(),
    content: { tool: "Read", input: { path: "evidence.txt" } } });
  expect(owned.toolEvidence.uncorrelated).toHaveLength(1);
  expect(owned.toolEvidence.uncorrelated[0].ok).not.toBe(true);
});

test("G3/G5: external observation summaries are bounded at the receiving boundary", async () => {
  const { thread, owned } = setup();
  await thread.signals.emit({ id: "oversized-observation", source: "native-hook", kind: "tool_observation", timestamp: Date.now(),
    content: { tool: "Read", inputSummary: "i".repeat(100_000), outputSummary: "o".repeat(100_000),
      error: "e".repeat(100_000), ok: false } });
  const evidence = owned.toolEvidence.uncorrelated[0];
  expect(evidence.inputSummary.length).toBeLessThanOrEqual(1024);
  expect(evidence.outputSummary?.length ?? 0).toBeLessThanOrEqual(1024);
  expect(evidence.error?.length ?? 0).toBeLessThanOrEqual(1024);
});
