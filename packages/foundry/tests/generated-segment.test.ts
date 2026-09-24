import { test, expect } from "bun:test";
import { ContextLayer, ContextStack, SignalBus, Thread, buildInjectionArtifact, type LLMProvider } from "@inixiative/foundry-core";
import { ThreadFactory, buildAgents, buildLayers } from "../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { DomainLibrarian } from "../src/agents/domain-librarian";
import { Librarian } from "../src/agents/librarian";
import { SessionManager } from "../src/agents/session";
import { starterConfig, validateConfig } from "../src/viewer/config";

// Foundry construction sites of generated, thread-private layers carry the typed
// "thread-knowledge" segment; configured caches carry a segment only when configured.
// No model calls: the provider refuses.
const provider: LLMProvider = { id: "controlled", async complete() { throw Error("No model call authorized"); } };
const kinds = (stack: ContextStack) => Object.fromEntries(buildInjectionArtifact({ userMessage: "u", assembled: stack.assemble() }).blocks.map(b => [b.text, b.kind]));

function runtimeSetup() {
  const config = starterConfig("controlled", "controlled"); config.agents = {};
  const cache = new ContextLayer({ id: "conventions", prompt: "Configured instructions" }); cache.set("CONFIGURED_DOMAIN_FACT");
  const stack = new ContextStack([cache]);
  const runtime = new ThreadRuntimeManager({ config, llm: provider, log() {}, warn() {}, domains: [{ domain: "conventions", layerId: "conventions", guardTriggers: [] }] });
  const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider }), runtime });
  return { factory, runtime, cache };
}

test("the runtime-created thread-knowledge layer carries the segment on the actual thread stack", () => {
  const { factory, runtime } = runtimeSetup();
  try {
    const thread = factory.create("owned", { projectId: "project" });
    const lib = runtime.get("owned")!.domainLibrarians.get("conventions")!;
    expect(lib.threadKnowledge.layer.segment).toBe("thread-knowledge");
    expect(thread.stack.layers.find(l => l.id === "thread-knowledge:conventions")?.segment).toBe("thread-knowledge");
    lib.threadKnowledge.layer.set("PRIVATE_THREAD_FACT");
    expect(kinds(thread.stack)).toMatchObject({ PRIVATE_THREAD_FACT: "thread-knowledge", CONFIGURED_DOMAIN_FACT: "domain-knowledge", "Configured instructions": "instructions" });
    expect(lib.threadKnowledge.layer.snapshotInstance("owned").segment).toBe("thread-knowledge");
  } finally { runtime.disposeAll(); }
});

test("a standalone DomainLibrarian default layer and a Librarian with a custom layer id are thread knowledge by segment", () => {
  const cache = new ContextLayer({ id: "security" }); cache.set("DOMAIN");
  const lib = new DomainLibrarian({ domain: "security", cache, signals: new SignalBus(), llm: provider, guardTriggers: [] });
  expect(lib.threadKnowledge.layer.id).toBe("thread-knowledge:security");
  expect(lib.threadKnowledge.layer.segment).toBe("thread-knowledge");
  const stack = new ContextStack([cache]);
  const librarian = new Librarian({ signals: new SignalBus(), stack, layerId: "custom-state-id" });
  expect(librarian.layer.id).toBe("custom-state-id");
  expect(librarian.layer.segment).toBe("thread-knowledge");
  stack.addLayer(librarian.layer);
  const artifact = buildInjectionArtifact({ userMessage: "u", assembled: stack.assemble() });
  const stateBlocks = artifact.blocks.filter(b => b.source === "custom-state-id" && b.text !== librarian.layer.prompt);
  expect(stateBlocks.length).toBeGreaterThan(0);
  for (const block of stateBlocks) expect(block.kind).toBe("thread-knowledge"); // custom id, not the "thread-state" heuristic
  expect(artifact.blocks.find(b => b.text === "DOMAIN")?.kind).toBe("domain-knowledge");
});

test("session layer inheritance copies preserve the segment; shared layers are the same instance", () => {
  const generated = new ContextLayer({ id: "thread-knowledge:conventions", segment: "thread-knowledge" }); generated.set("PRIVATE");
  const configured = new ContextLayer({ id: "conventions" }); configured.set("DOMAIN");
  const parent = new Thread("parent", new ContextStack([generated, configured]));
  const copied = SessionManager.inheritLayers(parent, { copy: ["thread-knowledge:conventions", "conventions"] });
  expect(copied.layers.find(l => l.id === "thread-knowledge:conventions")?.segment).toBe("thread-knowledge");
  expect(copied.layers.find(l => l.id === "thread-knowledge:conventions")).not.toBe(generated);
  expect(copied.layers.find(l => l.id === "conventions")?.segment).toBeUndefined();
  expect(kinds(copied)).toEqual({ PRIVATE: "thread-knowledge", DOMAIN: "domain-knowledge" });
  const shared = SessionManager.inheritLayers(parent, { share: ["thread-knowledge:conventions"] });
  expect(shared.layers[0]).toBe(generated);
});

test("configured layers carry a segment only when configured, and an invalid configured value is refused", () => {
  const layerConfig = (segment?: "domain-knowledge" | "thread-knowledge") => ({ id: "conventions", prompt: "Configured instructions", sourceIds: [], staleness: 0, enabled: true, ...(segment ? { segment } : {}) });
  const config = starterConfig("controlled", "controlled"); config.layers = { conventions: layerConfig() };
  const legacy = buildLayers(config, { sourceResolver: () => null });
  expect(legacy.map(l => [l.id, l.segment])).toEqual([["conventions", undefined]]); // unconfigured: legacy classification unchanged
  expect(() => validateConfig(config)).not.toThrow();
  const explicit = starterConfig("controlled", "controlled"); explicit.layers = { conventions: layerConfig("domain-knowledge") };
  expect(buildLayers(explicit, { sourceResolver: () => null }).find(l => l.id === "conventions")?.segment).toBe("domain-knowledge");
  expect(() => validateConfig(explicit)).not.toThrow();
  const invalid = starterConfig("controlled", "controlled"); invalid.layers = { conventions: layerConfig() };
  (invalid.layers.conventions as { segment?: unknown }).segment = "instructions";
  expect(() => validateConfig(invalid)).toThrow('segment must be "domain-knowledge" or "thread-knowledge"');
});

test("a historical artifact keeps its recorded kinds after later assembly, and generated content never reaches another thread", () => {
  const { factory, runtime } = runtimeSetup();
  try {
    const owned = factory.create("owned", { projectId: "project" });
    const lib = runtime.get("owned")!.domainLibrarians.get("conventions")!;
    lib.threadKnowledge.layer.set("PRIVATE_THREAD_FACT");
    const historical = buildInjectionArtifact({ userMessage: "u", assembled: owned.stack.assemble() });
    const recorded = JSON.stringify(historical);
    lib.threadKnowledge.layer.set("LATER_FACT");
    const other = factory.create("other", { projectId: "project" });
    const otherArtifact = buildInjectionArtifact({ userMessage: "u", assembled: other.stack.assemble() });
    expect(JSON.stringify(historical)).toBe(recorded);
    expect(JSON.stringify(otherArtifact)).not.toContain("PRIVATE_THREAD_FACT"); expect(JSON.stringify(otherArtifact)).not.toContain("LATER_FACT");
    expect(other.stack.layers.find(l => l.id === "thread-knowledge:conventions")?.segment).toBe("thread-knowledge");
  } finally { runtime.disposeAll(); }
});
