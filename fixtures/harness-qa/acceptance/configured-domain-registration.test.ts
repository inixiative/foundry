import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, type LLMMessage, type LLMProvider } from "../../../packages/core/src";
import { buildAgents, buildLayers, ThreadFactory } from "../../../packages/foundry/src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { ConfigStore, starterConfig } from "../../../packages/foundry/src/viewer/config";

test("a saved custom expert participates and learns without a hard-coded runtime domain entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-configured-domain-"));
  let runtime: ThreadRuntimeManager | undefined;
  try {
    const config = starterConfig("controlled", "controlled");
    config.layers = {
      "compatibility-reference": { id: "compatibility-reference", domain: "compatibility",
        prompt: "Preserve compatibility with old readers", segment: "domain-knowledge",
        sourceIds: ["compatibility-source"], staleness: 0, enabled: true,
        writers: ["compatibility-expert"] },
      "passive-reference": { id: "passive-reference", prompt: "Shared factual evidence",
        sourceIds: [], staleness: 0, enabled: true },
    };
    config.agents = {
      worker: { id: "worker", kind: "executor", prompt: "Implement the requested change",
        provider: "controlled", model: "controlled", visibleLayers: [], peers: [], maxDepth: 1, enabled: true },
      "compatibility-expert": { id: "compatibility-expert", kind: "decider", flowRole: "domain-advising",
        domain: "compatibility", prompt: "Assess compatibility evidence for this message",
        provider: "controlled", model: "controlled", visibleLayers: ["compatibility-reference"],
        ownedLayers: ["compatibility-reference"], peers: [], maxDepth: 1, enabled: true, tools: false },
    };
    const store = new ConfigStore(dir);
    await store.save(config);
    const restored = await new ConfigStore(dir).load();
    const stack = new ContextStack(buildLayers(restored, { sourceResolver: id => id === "compatibility-source"
      ? { id, load: async () => "Old schema readers must continue to work" } : null }));
    await stack.warmAll();
    const centralInputs: LLMMessage[][] = [];
    const hookOwners: string[] = [];
    const llm: LLMProvider = { id: "controlled", async complete(messages, opts) {
      const owner = opts?.threadId ?? "";
      if (owner.includes(":aux:")) {
        hookOwners.push(owner);
        if (owner.endsWith(":cartographer")) return { model: "controlled", content: JSON.stringify({
          domains: ["compatibility"], layers: ["compatibility-reference"], confidence: 1 }) };
        const review = messages.some(message => message.role === "user" && message.content.includes("## Completed work"));
        return { model: "controlled", content: JSON.stringify(review
          ? { decision: "learn", knowledge: "PRIVATE_COMPATIBILITY: additive migration verified", facts: [], reason: "Observed completed work" }
          : { layers: ["compatibility-reference"], snippets: [], confidence: 1 }) };
      }
      centralInputs.push(structuredClone(messages));
      return { model: "controlled", content: "Additive migration completed and old reader verified" };
    } };
    // Deliberately no deps.domains: saved operator configuration must be sufficient.
    runtime = new ThreadRuntimeManager({ config: restored, llm, log() {}, warn() {}, learning: { timeoutMs: 1000 } });
    const factory = new ThreadFactory({ stack, agents: buildAgents(restored, stack, { provider: llm }), runtime });
    const thread = factory.create("configured-source", { projectId: "configured-project" });
    const owned = runtime.get(thread.id)!;
    expect([...owned.domainLibrarians.keys()]).toEqual(["compatibility"]);
    await thread.dispatch("worker", "Implement the migration");
    await owned.learningSettled();
    expect(owned.domainLibrarians.get("compatibility")!.threadKnowledge.content).toContain("PRIVATE_COMPATIBILITY");
    await thread.dispatch("worker", "Continue");
    await owned.learningSettled();
    expect(hookOwners.some(id => id.endsWith(":domain:compatibility"))).toBe(true);
    expect(JSON.stringify(centralInputs.at(-1))).toContain("PRIVATE_COMPATIBILITY");
    const unrelated = factory.create("configured-unrelated", { projectId: "configured-project" });
    expect(runtime.get(unrelated.id)!.domainLibrarians.get("compatibility")!.threadKnowledge.content).toBe("");
    expect(stack.getLayer("thread-knowledge:compatibility")).toBeUndefined();
  } finally {
    if (runtime) {
      for (const owned of runtime.runtimes.values()) await owned.learningSettled();
      runtime.disposeAll();
    }
    await rm(dir, { recursive: true, force: true });
  }
});
