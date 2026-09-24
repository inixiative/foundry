import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, FileMemory, type InjectionArtifact } from "../../../packages/core/src";
import { ThreadFactory, buildAgents, buildLayers, createSourceResolver } from "../../../packages/foundry/src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { starterConfig } from "../../../packages/foundry/src/viewer/config";

const query = "Inspect Zephyr rollback migration evidence.";
const owner = { projectId: "project", threadId: "work" };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "foundry-current-admission-"));
  const memory = new FileMemory(dir);
  await memory.load();
  const config = starterConfig("controlled", "fixture");
  config.agents = { worker: { id: "worker", kind: "executor", enabled: true, prompt: "Use owned evidence.",
    visibleLayers: [], peers: [], maxDepth: 1 } };
  config.layers = { memory: { id: "memory", prompt: "Owned memory", enabled: true, staleness: 0, sourceIds: ["memory"] } };
  config.sources = { memory: { id: "memory", type: "file", label: "Memory", uri: dir, enabled: true } };
  const stack = new ContextStack(buildLayers(config, { sourceResolver: createSourceResolver({ memory }) }));
  await stack.warmAll();
  const runtime = new ThreadRuntimeManager({ config, domains: [], log() {}, warn() {},
    llm: { id: "controlled", complete: async () => ({ model: "fixture", content: "{}" }) } });
  const factory = new ThreadFactory({ stack, runtime, agents: buildAgents(config, stack, {
    provider: { id: "controlled", complete: async () => ({ model: "fixture", content: "Observed" }) },
  }) });
  const thread = factory.create(owner.threadId, { projectId: owner.projectId });
  const artifacts: InjectionArtifact[] = [];
  return { memory, artifacts,
    async seed(id: string, messageId: string, agentId = "classifier", kind = "dispatch") {
      await memory.view(owner).write({ id, kind, timestamp: 1,
        content: JSON.stringify({ threadId: owner.threadId, messageId, dispatchId: `dispatch-${id}`, agentId, payload: query }) });
    },
    async run(messageId: string) {
      await thread.dispatch("worker", query, undefined, { messageId, recordInjection: a => artifacts.push(a) });
      const reports = artifacts.at(-1)?.layers?.find(l => l.id === "memory")?.selection?.sources.map(s => s.report) ?? [];
      expect(reports.length).toBeGreaterThan(0);
      return { selected: reports.flatMap(r => r.selected.map(s => s.id)), omitted: reports.flatMap(r => r.omitted.map(s => s.id)) };
    },
    close() { thread.dispose(); runtime.disposeAll(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("current admission audit is omitted without deleting it or losing identical prior evidence and mandatory context", async () => {
  const f = await fixture();
  try {
    await f.seed("current-classifier", "turn-current");
    await f.seed("current-router", "turn-current", "router");
    await f.seed("prior-identical-request", "turn-prior");
    await f.seed("current-explicit-rule", "turn-current", "operator", "requirement");
    const before = JSON.stringify(f.memory.all());
    const report = await f.run("turn-current");
    expect(report.selected).not.toContain("current-classifier");
    expect(report.selected).not.toContain("current-router");
    expect(report.omitted).toContain("current-classifier");
    expect(report.omitted).toContain("current-router");
    expect(report.selected).toContain("prior-identical-request");
    expect(report.selected).toContain("current-explicit-rule");
    expect(JSON.stringify(f.memory.all())).toBe(before);
  } finally { f.close(); }
});

test("identical message text with a different admission recomputes selection while retaining historical provenance", async () => {
  const f = await fixture();
  try {
    await f.seed("first-audit", "turn-first");
    await f.seed("second-audit", "turn-second");
    const first = await f.run("turn-first");
    const historical = JSON.stringify(f.artifacts[0]);
    const second = await f.run("turn-second");
    expect(first.selected).not.toContain("first-audit");
    expect(first.selected).toContain("second-audit");
    expect(second.selected).not.toContain("second-audit");
    expect(second.selected).toContain("first-audit");
    expect(JSON.stringify(f.artifacts[0])).toBe(historical);
    expect(f.memory.all()).toHaveLength(2);
  } finally { f.close(); }
});
