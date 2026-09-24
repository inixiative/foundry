import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, FileMemory, type InjectionArtifact } from "../../../packages/core/src";
import { ThreadFactory, buildAgents, buildLayers, createSourceResolver } from "../../../packages/foundry/src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { SessionBackedProvider } from "../../../packages/foundry/src/providers/session-backed";
import { ConfigStore, starterConfig } from "../../../packages/foundry/src/viewer/config";

for (const scope of ["global", "project"] as const) {
  test(`loading an invalid ${scope} memory policy preserves the last working live configuration`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-selection-load-"));
    try {
      const store = new ConfigStore(dir);
      const config = starterConfig("mock", "controlled");
      const source = { id: "memory", type: "file" as const, label: "Memory", uri: "memory", enabled: true,
        selection: { budgetChars: 6000 } };
      config.sources.memory = source;
      config.projects.project = { id: "project", label: "Project", path: dir, sources: { memory: structuredClone(source) } };
      await store.save(config);
      await store.load();
      const before = structuredClone(store.config);
      const invalid = JSON.parse(await Bun.file(join(dir, "settings.json")).text());
      const target = scope === "global" ? invalid.sources : invalid.projects.project.sources;
      target.memory.selection.budgetChars = "invalid";
      const persisted = JSON.stringify(invalid);
      await Bun.write(join(dir, "settings.json"), persisted);
      await expect(store.load()).rejects.toThrow(/selection|policy|budgetChars/i);
      expect(store.config).toEqual(before);
      expect(await Bun.file(join(dir, "settings.json")).text()).toBe(persisted);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("required-context block protects the native provider path before session creation and retains input evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-native-memory-guard-"));
  let nativeCreations = 0;
  const provider = new SessionBackedProvider({ id: "claude-code", defaultModel: "controlled",
    adapter: { runtime: "controlled-native", async createSession() {
      nativeCreations++;
      throw Error("NATIVE_CREATION_MUST_NOT_BE_REACHED");
    }, async getExternalSessionId() { return null; }, async clearSession() {} } });
  const config = starterConfig("claude-code", "controlled");
  config.agents = { worker: { id: "worker", kind: "executor", enabled: true, prompt: "Apply mandatory requirements.",
    tools: true, visibleLayers: [], peers: [], maxDepth: 1 } };
  config.layers = { memory: { id: "memory", prompt: "Owned requirements", sourceIds: ["memory"], enabled: true, staleness: 0 } };
  config.sources = { memory: { id: "memory", type: "file", label: "Memory", uri: dir, enabled: true,
    selection: { oversizedPinned: "block" } } };
  let runtime: ThreadRuntimeManager | undefined;
  let thread: ReturnType<ThreadFactory["create"]> | undefined;
  let captured: InjectionArtifact | undefined;
  try {
    const memory = new FileMemory(dir);
    await memory.load();
    await memory.view({ threadId: "work" }).write({ id: "required-record", kind: "requirement", timestamp: 1,
      content: "Mandatory requirements. ".repeat(1500) });
    const stack = new ContextStack(buildLayers(config, { sourceResolver: createSourceResolver({ memory }) }));
    await stack.warmAll();
    runtime = new ThreadRuntimeManager({ config, domains: [], log() {}, warn() {},
      llm: { id: "controlled-adviser", complete: async () => ({ model: "controlled", content: "{}" }) } });
    const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider }), runtime });
    thread = factory.create("work");
    await expect(thread.dispatch("worker", "Execute under required-record.", undefined,
      { recordInjection: artifact => { captured = artifact; } })).rejects.toThrow(/Required memory context blocked/);
    expect(nativeCreations).toBe(0);
    expect(captured).toBeDefined();
    expect(captured?.providerMessages).toBeUndefined();
    const conflicts = captured?.layers?.flatMap(layer => layer.selection?.sources.flatMap(source => source.report.conflicts) ?? []);
    expect(conflicts?.some(conflict => conflict.kind === "required-context-blocked" && conflict.ids.includes("required-record"))).toBe(true);
  } finally {
    thread?.dispose(); runtime?.disposeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
