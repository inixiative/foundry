import { expect, test } from "bun:test";
import { ContextStack, Harness, type LLMProvider } from "@inixiative/foundry-core";
import { buildAgents, ThreadFactory } from "../src/agents/thread-factory";
import { defaultProjectAgents, starterConfig } from "../src/viewer/config";

function setup() {
  const config = starterConfig("claude-code", "haiku");
  config.agents = defaultProjectAgents("claude-code", "haiku");
  config.agents.artificer.provider = "codex";
  config.agents.artificer.model = "gpt-6-astra";
  const calls: Array<{ provider: string; threadId?: string; model?: string }> = [];
  function provider(id: string): LLMProvider {
    return { id, async complete(_messages, opts) {
      calls.push({ provider: id, threadId: opts?.threadId, model: opts?.model });
      return { model: opts?.model ?? id, content: id === "codex" ? "ASTRA_EXECUTED"
        : opts?.threadId?.includes("classifier") ? '{"category":"general"}'
        : '{"destination":"artificer","contextSlice":[],"priority":1}' };
    } };
  }
  return { config, calls, claude: provider("claude-code"), codex: provider("codex") };
}

test("configured providers execute their own cloned agents with separate auxiliary identity", async () => {
  const { config, calls, claude, codex } = setup();
  const stack = new ContextStack();
  const agents = buildAgents(config, stack, { provider: claude,
    providers: new Map([[claude.id, claude], [codex.id, codex]]) });
  const thread = new ThreadFactory({ stack, agents }).create("lead", { cwd: "/tmp" });
  const harness = new Harness(thread);
  harness.setClassifier("classifier");
  harness.setRouter("router");
  harness.setDefaultExecutor("artificer");
  try {
    const result = await harness.send("Inspect the work plan");
    expect(result.result.output).toBe("ASTRA_EXECUTED");
    expect(calls.filter(c => c.provider === "codex")).toEqual([
      { provider: "codex", threadId: "lead", model: "gpt-6-astra" },
    ]);
    expect(calls.filter(c => c.provider === "claude-code")).toHaveLength(2);
    expect(calls.filter(c => c.provider === "claude-code").every(c => c.threadId?.includes(":aux:"))).toBe(true);
  } finally { thread.dispose(); }
});

test("an explicit provider registry fails closed for missing configured providers", () => {
  const { config, claude } = setup();
  expect(() => buildAgents(config, new ContextStack(), {
    provider: claude, providers: new Map([[claude.id, claude]]),
  })).toThrow("codex");
});
