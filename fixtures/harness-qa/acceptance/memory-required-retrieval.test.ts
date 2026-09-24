import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, FileMemory, type LLMMessage, type LLMProvider } from "../../../packages/core/src";
import { ThreadFactory, buildAgents, buildLayers, createSourceResolver } from "../../../packages/foundry/src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { starterConfig } from "../../../packages/foundry/src/viewer/config";

test("without retrieval, a mandatory oversized rule is supplied in full or explicitly blocks execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-required-retrieval-"));
  const memory = new FileMemory(dir);
  const calls: LLMMessage[][] = [];
  const provider: LLMProvider = { id: "controlled-no-tools", async complete(messages) {
    calls.push(structuredClone(messages));
    return { model: "controlled", content: "release prepared" };
  } };
  const config = starterConfig(provider.id, "controlled");
  config.agents = { worker: { id: "worker", kind: "executor", enabled: true,
    prompt: "Prepare the release only after applying every mandatory release requirement.",
    tools: false, visibleLayers: [], peers: [], maxDepth: 1 } };
  config.layers = { memory: { id: "memory", prompt: "Owned release requirements",
    sourceIds: ["memory-src"], enabled: true, staleness: 0 } };
  config.sources = { "memory-src": { id: "memory-src", type: "file", label: "Memory", uri: dir, enabled: true } };
  const owner = { projectId: "release-project", threadId: "release-work" };
  const content = "Mandatory release procedure background. ".repeat(650)
    + "\nBefore publication: VERIFY_REQUIRED_APPROVAL_73. Never publish without this approval.";
  let runtime: ThreadRuntimeManager | undefined;
  let thread: ReturnType<ThreadFactory["create"]> | undefined;
  try {
    await memory.load();
    await memory.view(owner).write({ id: "mandatory-release-rule", kind: "requirement", timestamp: 1, content });
    const auditBefore = JSON.stringify(memory.all());
    const stack = new ContextStack(buildLayers(config, { sourceResolver: createSourceResolver({ memory }) }));
    await stack.warmAll();
    runtime = new ThreadRuntimeManager({ config, domains: [], log() {}, warn() {},
      llm: { id: "controlled-adviser", complete: async () => ({ model: "controlled", content: "{}" }) } });
    // No ToolRegistry or native tool adapter is provided. A prompt claiming a
    // memory tool exists cannot satisfy the required-rule precondition.
    const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider }), runtime });
    thread = factory.create(owner.threadId, { projectId: owner.projectId });
    let failure: unknown;
    try { await thread.dispatch("worker", "Prepare the release following mandatory-release-rule in full."); }
    catch (error) { failure = error; }
    expect(JSON.stringify(memory.all())).toBe(auditBefore);
    expect(memory.view(owner).get("mandatory-release-rule")?.content).toBe(content);
    if (calls.length === 0) {
      expect(String(failure)).toMatch(/memory|requirement|pinned|selection/i);
    } else {
      expect(calls).toHaveLength(1);
      expect(calls[0].map(m => m.content).join("\n")).toContain(content);
    }
  } finally {
    thread?.dispose();
    runtime?.disposeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
