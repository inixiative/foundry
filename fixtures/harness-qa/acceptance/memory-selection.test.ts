import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, FileMemory, type LLMMessage, type LLMProvider } from "../../../packages/core/src";
import { ThreadFactory, buildAgents, buildLayers, createSourceResolver } from "../../../packages/foundry/src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import type { FoundryConfig } from "../../../packages/foundry/src/viewer/config";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "foundry-independent-selection-"));
  const memory = new FileMemory(dir);
  await memory.load();
  const calls: LLMMessage[][] = [];
  const provider: LLMProvider = {
    id: "acceptance",
    async complete(messages) {
      calls.push(structuredClone(messages));
      return { model: "fixture", content: "checked" };
    },
  };
  const config: FoundryConfig = {
    defaults: { provider: "acceptance", model: "fixture" }, providers: {}, projects: {},
    agents: { worker: {
      id: "worker", kind: "executor", provider: "acceptance", model: "fixture",
      prompt: "Follow explicit conventions and answer using selected evidence.",
      temperature: 0, maxTokens: 100, visibleLayers: [], peers: [], maxDepth: 1, enabled: true,
    } },
    layers: { memory: {
      id: "memory", prompt: "Owned memory", sourceIds: ["memory-src"], staleness: 0, enabled: true,
    } },
    sources: { "memory-src": {
      id: "memory-src", type: "file", label: "Memory", uri: dir, enabled: true,
    } },
  };
  const stack = new ContextStack(buildLayers(config, { sourceResolver: createSourceResolver({ memory }) }));
  await stack.warmAll();
  const runtime = new ThreadRuntimeManager({
    config, domains: [], log() {}, warn() {},
    llm: { id: "fixture-adviser", complete: async () => ({ model: "fixture", content: "{}" }) },
  });
  const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider }), runtime });
  return {
    memory, factory, calls,
    cleanup() { runtime.disposeAll(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const owner = { projectId: "sample-project", threadId: "work" };
const query = "What is the Zephyr migration rollback marker? Apply the release convention.";
const input = (messages: LLMMessage[]) => messages.map(m => m.content).join("\n");
const audit = (memory: FileMemory) => JSON.stringify(memory.all().sort((a, b) => a.id.localeCompare(b.id)));

test("actual provider input stays bounded while retaining old relevant evidence and an explicit convention", async () => {
  const f = await fixture();
  try {
    const own = f.memory.view(owner);
    await own.write({ id: "old-fact", kind: "observation", timestamp: 1,
      content: "Zephyr migration rollback marker: ZEPHYR_RESTORE_17." });
    await own.write({ id: "release-rule", kind: "convention", timestamp: 2,
      content: "Release convention: ALWAYS_INCLUDE_ROLLBACK_MARKER in migration reports." });
    const thread = f.factory.create(owner.threadId, { projectId: owner.projectId });
    const sizes: number[] = [];
    for (const [start, end] of [[0, 20], [20, 160]]) {
      for (let i = start; i < end; i++) await own.write({
        id: `noise-${i}`, kind: "tool_result", timestamp: 100 + i,
        content: `Unrelated inventory ${i}: ` + "wheel spoke spindle bearing axle. ".repeat(40),
      });
      const before = audit(f.memory);
      await thread.stack.getLayer("memory")!.warm();
      await thread.dispatch("worker", query);
      const delivered = input(f.calls.at(-1)!);
      expect(delivered).toContain("ZEPHYR_RESTORE_17");
      expect(delivered).toContain("ALWAYS_INCLUDE_ROLLBACK_MARKER");
      expect(audit(f.memory)).toBe(before);
      sizes.push(delivered.length);
    }
    expect(f.calls).toHaveLength(2);
    expect(f.memory.view(owner).search("ZEPHYR_RESTORE_17").map(e => e.id)).toEqual(["old-fact"]);
    expect(f.memory.all()).toHaveLength(162);
    // A deliberately generous character ceiling; this is not a tokenizer claim.
    expect(sizes[1]).toBeLessThan(32_000);
    expect(sizes[1] - sizes[0]).toBeLessThan(8_000);
  } finally { f.cleanup(); }
});

test("provider selection excludes a same-named foreign thread and unowned records without deleting them", async () => {
  const f = await fixture();
  try {
    await f.memory.view(owner).write({ id: "own", kind: "convention", timestamp: 1, content: "OWN_RULE_ALPHA" });
    await f.memory.view({ ...owner, projectId: "foreign-project" }).write({
      id: "foreign", kind: "convention", timestamp: 2, content: "FOREIGN_PRIVATE_BETA",
    });
    await f.memory.write({ id: "unowned", kind: "convention", timestamp: 3, content: "UNOWNED_PRIVATE_GAMMA" });
    await f.memory.view({ ...owner, projectId: "foreign-project" }).write({
      id: "published", kind: "convention", timestamp: 4, visibility: "global", content: "GLOBAL_RULE_DELTA",
    });
    const before = audit(f.memory);
    const thread = f.factory.create(owner.threadId, { projectId: owner.projectId });
    await thread.stack.getLayer("memory")!.warm();
    await thread.dispatch("worker", "Apply the available conventions.");
    expect(f.calls).toHaveLength(1);
    const delivered = input(f.calls[0]);
    expect(delivered).toContain("OWN_RULE_ALPHA");
    expect(delivered).toContain("GLOBAL_RULE_DELTA");
    expect(delivered).not.toContain("FOREIGN_PRIVATE_BETA");
    expect(delivered).not.toContain("UNOWNED_PRIVATE_GAMMA");
    expect(audit(f.memory)).toBe(before);
  } finally { f.cleanup(); }
});

test("an explicit requirement that fits the source budget is not reduced to its introductory prefix", async () => {
  const f = await fixture();
  try {
    const content = "Background notes. ".repeat(100) + "\nMandatory release requirement: VERIFY_TAIL_REQUIREMENT_91 before publication.";
    await f.memory.view(owner).write({ id: "long-requirement", kind: "requirement", timestamp: 1, content });
    const thread = f.factory.create(owner.threadId, { projectId: owner.projectId });
    await thread.stack.getLayer("memory")!.warm();
    await thread.dispatch("worker", "Prepare the release and follow its mandatory requirements.");
    expect(f.calls).toHaveLength(1);
    expect(input(f.calls[0])).toContain("VERIFY_TAIL_REQUIREMENT_91");
    expect(f.memory.get("long-requirement")?.content).toBe(content);
  } finally { f.cleanup(); }
});

test("retrieving a long observation includes the matching evidence, not only an unrelated prefix", async () => {
  const f = await fixture();
  try {
    const content = "Unrelated preliminary inventory notes. ".repeat(60)
      + "\nZephyr migration rollback marker: ZEPHYR_RELEVANT_TAIL_42.\n"
      + "Unrelated appendix. ".repeat(30);
    await f.memory.view(owner).write({ id: "long-observation", kind: "observation", timestamp: 1, content });
    const thread = f.factory.create(owner.threadId, { projectId: owner.projectId });
    await thread.stack.getLayer("memory")!.warm();
    await thread.dispatch("worker", query);
    expect(f.calls).toHaveLength(1);
    expect(input(f.calls[0])).toContain("ZEPHYR_RELEVANT_TAIL_42");
    expect(f.memory.get("long-observation")?.content).toBe(content);
  } finally { f.cleanup(); }
});
