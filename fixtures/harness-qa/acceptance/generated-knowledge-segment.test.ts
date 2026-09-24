import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, buildInjectionArtifact, type LLMProvider } from "../../../packages/core/src";
import { ThreadFactory, buildAgents } from "../../../packages/foundry/src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { starterConfig } from "../../../packages/foundry/src/viewer/config";

// This tests the runtime-created layer's reading-view provenance, not learning
// or native execution. Injected private knowledge must not acquire domain scope.
function setup() {
  const config = starterConfig("controlled", "controlled");
  config.agents = {};
  const cache = new ContextLayer({ id: "conventions", prompt: "Configured instructions" });
  cache.set("CONFIGURED_DOMAIN_FACT");
  const stack = new ContextStack([cache]);
  const provider: LLMProvider = { id: "controlled", async complete() { throw Error("No model call authorized"); } };
  const runtime = new ThreadRuntimeManager({ config, llm: provider, log() {}, warn() {},
    domains: [{ domain: "conventions", layerId: "conventions", guardTriggers: [] }] });
  const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider }), runtime });
  return { factory, runtime };
}

test("runtime generated thread knowledge keeps its semantic segment in the actual assembled reading view", () => {
  const { factory, runtime } = setup();
  try {
    const thread = factory.create("owned", { projectId: "project" });
    runtime.get("owned")!.domainLibrarians.get("conventions")!.threadKnowledge.layer.set("PRIVATE_THREAD_FACT");
    const artifact = buildInjectionArtifact({ userMessage: "Continue", assembled: thread.stack.assemble() });
    const generated = artifact.blocks.filter(block => block.text.includes("PRIVATE_THREAD_FACT"));
    expect(generated).toHaveLength(1);
    expect(generated[0].kind).toBe("thread-knowledge");
    expect(artifact.blocks.find(block => block.text === "CONFIGURED_DOMAIN_FACT")?.kind).toBe("domain-knowledge");
    expect(artifact.blocks.find(block => block.text === "Configured instructions")?.kind).toBe("instructions");
  } finally { runtime.disposeAll(); }
});

test("reading-view assembly does not leak the generated content into another owned thread", () => {
  const { factory, runtime } = setup();
  try {
    factory.create("owned", { projectId: "project" });
    runtime.get("owned")!.domainLibrarians.get("conventions")!.threadKnowledge.layer.set("PRIVATE_THREAD_FACT");
    const other = factory.create("other", { projectId: "project" });
    const artifact = buildInjectionArtifact({ userMessage: "Continue", assembled: other.stack.assemble() });
    expect(JSON.stringify(artifact)).not.toContain("PRIVATE_THREAD_FACT");
    expect(artifact.blocks.find(block => block.text === "CONFIGURED_DOMAIN_FACT")?.kind).toBe("domain-knowledge");
  } finally { runtime.disposeAll(); }
});
