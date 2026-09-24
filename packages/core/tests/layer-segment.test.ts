import { test, expect } from "bun:test";
import { ContextLayer, ContextStack, buildInjectionArtifact, isLayerSegment, LAYER_SEGMENTS, type LayerDefinition } from "../src";

// Semantic content segment of a layer: typed construction metadata, carried through
// definition, config, factory, clone, snapshot and assembly. Prompts stay instructions;
// legacy layers without a segment keep the artifact builder's id heuristic.

const definition: LayerDefinition = { id: "conventions", prompt: "Configured instructions", segment: "domain-knowledge" };
const warm = (layer: ContextLayer, content: string) => { layer.set(content); return layer; };
const kinds = (stack: ContextStack) => Object.fromEntries(buildInjectionArtifact({ userMessage: "u", assembled: stack.assemble() }).blocks.map(b => [b.text, b.kind]));

test("segment comes from the definition, can be overridden by config, and is validated", () => {
  expect(new ContextLayer({ id: "c", definition }).segment).toBe("domain-knowledge");
  expect(new ContextLayer({ id: "c", definition, segment: "thread-knowledge" }).segment).toBe("thread-knowledge");
  expect(new ContextLayer({ id: "c" }).segment).toBeUndefined();
  expect(ContextLayer.fromDefinition(definition, []).segment).toBe("domain-knowledge");
  expect(ContextLayer.fromDefinition(definition, [], { segment: "thread-knowledge" }).segment).toBe("thread-knowledge");
  expect(() => new ContextLayer({ id: "c", segment: "instructions" as never })).toThrow("Unknown layer segment");
  expect(() => new ContextLayer({ id: "c", definition: { id: "c", segment: "private" as never } })).toThrow("Unknown layer segment");
  expect(LAYER_SEGMENTS).toEqual(["domain-knowledge", "thread-knowledge"]);
  expect(isLayerSegment("thread-knowledge")).toBe(true); expect(isLayerSegment("instructions")).toBe(false); expect(isLayerSegment(undefined)).toBe(false);
});

test("assembly attaches the segment to the content block only; the prompt block stays an instruction", () => {
  const generated = warm(new ContextLayer({ id: "thread-knowledge:conventions", prompt: "Generated prompt", segment: "thread-knowledge" }), "PRIVATE_FACT");
  const configured = warm(new ContextLayer({ id: "conventions", prompt: "Configured prompt", segment: "domain-knowledge" }), "DOMAIN_FACT");
  const blocks = new ContextStack([configured, generated]).assemble("System").blocks;
  expect(blocks).toEqual([
    { role: "system", text: "System" },
    { role: "layer", id: "conventions", text: "Configured prompt" },
    { role: "content", id: "conventions", text: "DOMAIN_FACT", segment: "domain-knowledge" },
    { role: "layer", id: "thread-knowledge:conventions", text: "Generated prompt" },
    { role: "content", id: "thread-knowledge:conventions", text: "PRIVATE_FACT", segment: "thread-knowledge" },
  ]);
  expect(kinds(new ContextStack([configured, generated]))).toEqual({
    "Configured prompt": "instructions", "DOMAIN_FACT": "domain-knowledge", "Generated prompt": "instructions", "PRIVATE_FACT": "thread-knowledge",
  });
});

test("a generated layer with a domain-looking id is thread knowledge because of its segment, not its name", () => {
  const layer = warm(new ContextLayer({ id: "conventions", segment: "thread-knowledge" }), "PRIVATE_FACT");
  expect(kinds(new ContextStack([layer]))).toEqual({ PRIVATE_FACT: "thread-knowledge" });
  const custom = warm(new ContextLayer({ id: "my-custom-state-id", prompt: "State", segment: "thread-knowledge" }), "STATE");
  expect(kinds(new ContextStack([custom]))).toEqual({ State: "instructions", STATE: "thread-knowledge" });
});

test("legacy layers without a segment keep the exact prior classification and block shape", () => {
  const legacyDomain = warm(new ContextLayer({ id: "docs" }), "DOCS");
  const legacyState = warm(new ContextLayer({ id: "thread-state" }), "STATE");
  const legacyMemory = warm(new ContextLayer({ id: "memory" }), "MEMORY");
  const blocks = new ContextStack([legacyDomain, legacyState, legacyMemory]).assemble().blocks;
  expect(blocks).toEqual([
    { role: "content", id: "docs", text: "DOCS" }, { role: "content", id: "thread-state", text: "STATE" }, { role: "content", id: "memory", text: "MEMORY" },
  ]);
  expect(blocks.every(b => !("segment" in b))).toBe(true);
  expect(kinds(new ContextStack([legacyDomain, legacyState, legacyMemory]))).toEqual({ DOCS: "domain-knowledge", STATE: "thread-knowledge", MEMORY: "thread-knowledge" });
});

test("clone preserves the segment across scopes and the snapshot records it only when present", () => {
  const layer = warm(new ContextLayer({ id: "thread-knowledge:memory", prompt: "P", segment: "thread-knowledge" }), "FACT");
  const clone = layer.clone({ threadId: "other", projectId: "p" });
  expect(clone.segment).toBe("thread-knowledge"); expect(clone.content).toBe("FACT");
  expect(layer.snapshotInstance("t")).toMatchObject({ definitionId: "thread-knowledge:memory", threadId: "t", segment: "thread-knowledge", content: "FACT" });
  const legacy = warm(new ContextLayer({ id: "docs" }), "DOCS");
  expect("segment" in legacy.snapshotInstance()).toBe(false);
  expect(legacy.clone().segment).toBeUndefined();
});

test("restore never rewrites the segment: a legacy snapshot restored into a segmented layer keeps the layer's segment, and vice versa", () => {
  const segmented = new ContextLayer({ id: "k", segment: "thread-knowledge" });
  segmented.restoreInstance({ definitionId: "k", content: "OLD", hash: "h", state: "warm", lastWarmed: 1, lastAccessed: 1 });
  expect(segmented.segment).toBe("thread-knowledge"); expect(segmented.content).toBe("OLD");
  const legacy = new ContextLayer({ id: "k" });
  legacy.restoreInstance({ definitionId: "k", segment: "thread-knowledge", content: "NEW", hash: "h", state: "warm", lastWarmed: 1, lastAccessed: 1 });
  expect(legacy.segment).toBeUndefined(); // a snapshot cannot grant provenance the instance never had
  expect(kinds(new ContextStack([legacy]))).toEqual({ NEW: "domain-knowledge" });
});

test("a historical artifact is not changed by later assembly or later content", () => {
  const layer = warm(new ContextLayer({ id: "thread-knowledge:conventions", segment: "thread-knowledge" }), "FIRST");
  const stack = new ContextStack([layer]);
  const first = buildInjectionArtifact({ userMessage: "u", assembled: stack.assemble() });
  const before = JSON.stringify(first);
  layer.set("SECOND");
  const second = buildInjectionArtifact({ userMessage: "u", assembled: stack.assemble() });
  expect(JSON.stringify(first)).toBe(before);
  expect(second.blocks.map(b => [b.text, b.kind])).toEqual([["SECOND", "thread-knowledge"]]);
});
