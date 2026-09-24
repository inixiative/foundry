import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  ContextStack,
  Classifier,
  FileMemory,
  Harness,
  Router,
  ToolRegistry,
  type InjectionArtifact,
  type LLMMessage,
  type LLMProvider,
  type Signal,
} from "@inixiative/foundry-core";
import { ThreadFactory, buildAgents, buildLayers, createSourceResolver } from "../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { MemoryToolAdapter } from "../src/tools/memory-adapter";
import type { FoundryConfig } from "../src/viewer/config";

// G3/G7 memory selection through the production factory, runtime and executor.
// The owned audit log stays complete and searchable; what the executor's
// provider actually receives is a bounded, deterministic, inspectable selection.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const agentSettings = { provider: "mock", model: "mock", temperature: 0, maxTokens: 256, visibleLayers: [], peers: [], maxDepth: 1, enabled: true };

function makeConfig(dir: string, sourceExtras: Record<string, unknown> = {}): FoundryConfig {
  return {
    defaults: { provider: "mock", model: "mock" },
    providers: {},
    agents: { worker: { ...agentSettings, id: "worker", kind: "executor", prompt: "Execute" } },
    layers: {
      system: { id: "system", prompt: "Core instructions.", sourceIds: ["system-src"], staleness: 0, enabled: true },
      memory: { id: "memory", prompt: "Working memory", sourceIds: ["memory-src"], staleness: 0, enabled: true },
    },
    sources: {
      "system-src": { id: "system-src", type: "inline", label: "System", uri: "You are the worker.", enabled: true },
      "memory-src": { id: "memory-src", type: "file", label: "Working memory", uri: dir, enabled: true, ...sourceExtras } as FoundryConfig["sources"][string],
    },
    projects: {},
  };
}

interface Captured { system: string; user: string }

async function setup(opts: { dir?: string; sourceExtras?: Record<string, unknown> } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "foundry-memory-selection-"));
  if (!opts.dir) dirs.push(dir);
  const memory = new FileMemory(dir);
  await memory.load();
  const config = makeConfig(dir, opts.sourceExtras);
  const captured: Captured[] = [];
  const provider: LLMProvider = {
    id: "mock",
    complete: async (messages: LLMMessage[]) => {
      captured.push({ system: String(messages.find((m) => m.role === "system")?.content ?? ""), user: String(messages.at(-1)?.content ?? "") });
      return { model: "mock", content: "ok" };
    },
  };
  const tools = new ToolRegistry();
  tools.register(MemoryToolAdapter.fromFileMemory(memory), "memory");
  const template = new ContextStack(buildLayers(config, { sourceResolver: createSourceResolver({ memory }) }));
  await template.warmAll();
  const agents = buildAgents(config, template, { provider, tools });
  const runtime = new ThreadRuntimeManager({
    config, domains: [], log: () => {}, warn: () => {},
    llm: { id: "mock", complete: async () => ({ model: "mock", content: "{}" }) },
    signalSinks: [memory.signalWriter()],
  });
  const factory = new ThreadFactory({ stack: template, agents, runtime });
  return { dir, memory, config, template, runtime, factory, captured, tools };
}

const noise = (id: string, i: number): Signal => ({
  id, kind: "dispatch", source: "harness:classifier", timestamp: Date.now() + i,
  content: { threadId: "t", agentId: "classifier", payload: `irrelevant dispatch ${i} ${"x".repeat(700)}`, ok: true },
});
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("actual classifier/router dispatch audit is retained but excluded from its own Harness executor input", async () => {
  const { factory, runtime, memory, captured } = await setup();
  const t = factory.create("work", { projectId: "P" });
  try {
    t.register(new Classifier({ id: "classifier", stack: t.stack, handler: async () => ({ value: { category: "bug" }, confidence: 1 }) }));
    t.register(new Router({ id: "router", stack: t.stack, handler: async () => ({ value: { destination: "worker" }, confidence: 1 }) }));
    const harness = new Harness(t);
    harness.setClassifier("classifier"); harness.setRouter("router");
    const result = await harness.send({ id: "logical-current", payload: "Zephyr rollback migration" });
    const audit = memory.all("dispatch").filter(e => ["classifier", "router"].includes(JSON.parse(e.content).agentId));
    expect(audit).toHaveLength(2);
    expect(audit.map(e => JSON.parse(e.content).messageId)).toEqual(["logical-current", "logical-current"]);
    const artifact = result.result.meta?.injection as InjectionArtifact;
    const selection = artifact.layers?.find(l => l.id === "memory")?.selection?.sources[0]?.report;
    for (const entry of audit) {
      expect(selection?.omitted).toContainEqual(expect.objectContaining({ id: entry.id, reason: "current-message-audit" }));
      expect(selection?.selected.map(s => s.id)).not.toContain(entry.id);
      expect(captured[0]?.system).not.toContain(entry.id);
      expect(memory.get(entry.id)?.content).toBe(entry.content);
    }
    expect(captured).toHaveLength(1);
  } finally { t.dispose(); runtime.disposeAll(); }
});

test("dispatch identity reaches frozen plans, refire and selection; unidentified direct/background work clears it", async () => {
  const { factory, runtime, memory, captured } = await setup();
  const t = factory.create("work", { projectId: "P" });
  try {
    const query = "Zephyr rollback migration";
    const identity = { threadId: "work", projectId: "P", messageId: "turn-current" };
    await memory.view(identity).write({ id: "own-current", kind: "dispatch", timestamp: 1,
      content: JSON.stringify({ messageId: identity.messageId, payload: query }) });
    await memory.view({ threadId: "published-other", projectId: "P" }).write({ id: "published-collision", kind: "dispatch", timestamp: 2,
      visibility: "project", content: JSON.stringify({ messageId: identity.messageId, payload: query }) });
    const seen: unknown[] = [];
    t.middleware.use("identity-witness", async (ctx, next) => {
      seen.push({ threadId: ctx.threadId, projectId: ctx.projectId, messageId: ctx.messageId }); return next();
    });
    const artifacts: InjectionArtifact[] = [];
    const identified = { messageId: identity.messageId, recordInjection: (a: InjectionArtifact) => { artifacts.push(a); } };
    const pending = t.dispatch("worker", query, undefined, identified);
    identified.messageId = "caller-reused-options";
    await pending;
    identified.messageId = identity.messageId;
    expect(seen[0]).toEqual(identity);
    expect(JSON.parse(memory.all("dispatch").find(e => JSON.parse(e.content).agentId === "worker")!.content).messageId).toBe(identity.messageId);
    expect(artifacts[0]?.decoration?.input.currentMessage).toEqual(identity);
    expect((artifacts[0]?.plan as any).input.currentMessage).toEqual(identity);
    const layer = artifacts[0]!.layers!.find(l => l.id === "memory")!;
    expect(layer.selection?.sources[0]?.report.omitted).toContainEqual(expect.objectContaining({ id: "own-current", excludedFor: identity }));
    expect(layer.selection?.sources[0]?.report.selected.map(s => s.id)).toContain("published-collision");
    const history = JSON.stringify(artifacts[0]);
    const flow = runtime.get(t.id)!.flowOrchestrator;
    const refired = await flow.refire();
    expect(refired?.input.currentMessage).toEqual(identity);
    await flow.hydrateDelta(refired!);
    expect(t.stack.getLayer("memory")!.selection?.currentMessage).toEqual(identity);
    // Same input without an ID must not inherit the last admission, in either entry point.
    for (const background of [false, true]) {
      await t.dispatch("worker", query, undefined, identified);
      const options = { recordInjection: (a: InjectionArtifact) => { artifacts.push(a); } };
      if (background) await t.dispatchBackground("worker", query, undefined, options).promise;
      else await t.dispatch("worker", query, undefined, options);
      expect(artifacts.at(-1)?.decoration?.input.currentMessage).toBeUndefined();
      const selected = artifacts.at(-1)?.layers?.find(l => l.id === "memory")?.selection;
      expect(selected?.currentMessage).toBeUndefined();
      expect(selected?.sources[0]?.report.selected.map(s => s.id)).toContain("own-current");
      expect((await flow.refire())?.input.currentMessage).toBeUndefined();
    }
    expect(JSON.stringify(artifacts[0])).toBe(history);
    expect(captured).toHaveLength(5); // Refire/hydration inspect and prepare; no executor replay.
  } finally { t.dispose(); runtime.disposeAll(); }
});

test.each(["second", undefined])("overlapping loads cannot send one logical message with another selection (later identity=%s)", async secondMessageId => {
  const { factory, runtime, memory, captured } = await setup();
  const t = factory.create("work", { projectId: "P" });
  try {
    const query = "Zephyr rollback migration";
    for (const messageId of ["first", "second"]) await memory.view({ threadId: "work", projectId: "P" }).write({
      id: messageId, kind: "dispatch", timestamp: 1, content: JSON.stringify({ messageId, payload: query }),
    });
    const layer = t.stack.getLayer("memory")!;
    const source = layer.sources[0]!;
    const load = source.load.bind(source);
    let release!: () => void;
    let loading!: () => void;
    let secondFocused!: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    const entered = new Promise<void>(r => { loading = r; });
    const focused = new Promise<void>(r => { secondFocused = r; });
    source.load = async hint => { if (hint?.currentMessage?.messageId === "first") { loading(); await barrier; } return load(hint); };
    const setFocus = layer.setFocus.bind(layer);
    layer.setFocus = (text, identity) => { setFocus(text, identity); if (identity?.messageId === secondMessageId) secondFocused(); };
    const artifacts: InjectionArtifact[] = [];
    const first = t.dispatch("worker", query, undefined, { messageId: "first", recordInjection: a => { artifacts.push(a); } })
      .then(() => undefined, e => e);
    await entered;
    const second = t.dispatch("worker", query, undefined, { messageId: secondMessageId });
    await focused;
    release();
    expect(String(await first)).toContain("Memory selection changed before provider execution");
    expect((await second).output).toBe("ok");
    expect(captured).toHaveLength(1);
    expect(artifacts[0]?.providerMessages).toBeUndefined();
    expect((artifacts[0]?.plan as any).input.currentMessage.messageId).toBe("first");
    expect(artifacts[0]?.layers?.find(l => l.id === "memory")?.selection?.currentMessage?.messageId).toBe(secondMessageId);
  } finally { t.dispose(); runtime.disposeAll(); }
});

async function send(thread: Awaited<ReturnType<typeof setup>>["factory"] extends { create: (...a: any[]) => infer T } ? T : never, message: string) {
  const result = await thread.dispatch("worker", message);
  return { result, artifact: result.meta?.injection as InjectionArtifact | undefined };
}

test("a learned convention still reaches the executor after hundreds of irrelevant signals, and memory input stays bounded", async () => {
  const { factory, runtime, memory, captured } = await setup();
  try {
    const t = factory.create("work", { projectId: "P" });
    await memory.view({ threadId: "work", projectId: "P" }).write({ id: "conv", kind: "convention", content: "CONVENTION: always run the typecheck gate before reporting done.", timestamp: 1 });
    for (let i = 0; i < 40; i++) await t.signals.emit(noise(`early-${i}`, i));
    await t.stack.getLayer("memory")!.warm();
    const first = await send(t, "Please summarise the plan.");
    const firstMemory = first.artifact?.layers?.find((l) => l.id === "memory");
    expect(captured.at(-1)?.system).toContain("CONVENTION: always run the typecheck gate");
    expect(captured.at(-1)?.system).not.toContain("irrelevant dispatch 3 ");

    for (let i = 40; i < 340; i++) await t.signals.emit(noise(`late-${i}`, i));
    await t.stack.refresh();
    // A message whose terms match none of the log, so only the pinned convention is selected.
    const second = await send(t, "Status check.");
    const secondMemory = second.artifact?.layers?.find((l) => l.id === "memory");
    expect(captured.at(-1)?.system).toContain("CONVENTION: always run the typecheck gate");
    expect(secondMemory!.content.length - firstMemory!.content.length).toBeLessThan(300);
    expect(secondMemory!.content.length).toBeLessThan(8000);
    // The selection report travels on the executor's injection artifact. The
    // runtime's own dispatch and delivery signals are captured too, so counts
    // are lower bounds; every one of them is audit-only.
    const report = secondMemory!.selection?.sources[0]?.report;
    expect(report?.retained.count).toBeGreaterThanOrEqual(341);
    expect(report?.selected.map((s) => s.id)).toEqual(["conv"]);
    expect(report?.omitted.filter((o) => o.reason === "audit-only").length).toBeGreaterThanOrEqual(340);
    expect(report?.omitted.every((o) => o.reason === "audit-only")).toBe(true);
    // The audit log is intact on disk and searchable through the thread-scoped tool.
    expect(memory.all().length).toBeGreaterThanOrEqual(341);
    expect(memory.all().filter((e) => e.id.startsWith("early-") || e.id.startsWith("late-"))).toHaveLength(340);
    const registry = new ToolRegistry();
    registry.register(MemoryToolAdapter.fromFileMemory(memory), "memory");
    const found = await registry.dispatch("memory-file_search", { query: "irrelevant dispatch 3 " }, { scope: { threadId: "work", projectId: "P" } });
    expect((found.data as Array<{ id: string }>).map((e) => e.id)).toEqual(["early-3"]);
  } finally { runtime.disposeAll(); }
});

test("an older relevant record is selected for a new message through the production flow, and the artifact records the focus", async () => {
  const { factory, runtime, captured } = await setup();
  try {
    const t = factory.create("work", { projectId: "P" });
    await t.signals.emit({ id: "old-fact", kind: "dispatch", source: "harness:artificer", timestamp: 1,
      content: { payload: "The release-notes sample keeps byte-identical default output when grouping is disabled." } });
    for (let i = 0; i < 60; i++) await t.signals.emit(noise(`n-${i}`, i));
    await t.stack.getLayer("memory")!.warm();

    await send(t, "Summarise today's status.");
    expect(captured.at(-1)?.system).not.toContain("byte-identical default output");

    const { artifact } = await send(t, "Why does the release-notes grouping change the default output?");
    expect(captured.at(-1)?.system).toContain("byte-identical default output");
    const memoryLayer = artifact?.layers?.find((l) => l.id === "memory");
    expect(memoryLayer?.selection?.focusHash).toBeString();
    expect(memoryLayer?.selection?.sources[0]?.report.selected.find((s) => s.id === "old-fact")?.reason).toBe("relevant");
  } finally { runtime.disposeAll(); }
});

test("a pinned instruction over the budget reaches the provider in full with its ending, with a visible conflict", async () => {
  const { factory, runtime, memory, captured } = await setup({ sourceExtras: { selection: { budgetChars: 1500, maxEntryChars: 300 } } });
  try {
    const t = factory.create("work", { projectId: "P" });
    await memory.view({ threadId: "work", projectId: "P" }).write({ id: "rule", kind: "instruction", content: "MUST-KEEP-RULE " + "detail ".repeat(300) + "RULE-OPERATIVE-ENDING", timestamp: 1 });
    await t.stack.getLayer("memory")!.warm();
    const { artifact } = await send(t, "Do the work.");
    expect(captured.at(-1)?.system).toContain("MUST-KEEP-RULE");
    expect(captured.at(-1)?.system).toContain("RULE-OPERATIVE-ENDING");
    expect(captured.at(-1)?.system).not.toMatch(/excerpt/);
    const report = artifact?.layers?.find((l) => l.id === "memory")?.selection?.sources[0]?.report;
    expect(report?.budget.exceeded).toBe(true);
    expect(report?.conflicts.map((c) => c.kind)).toContain("pinned-over-budget");
  } finally { runtime.disposeAll(); }
});

test("a pinned record beyond the hard cap reaches the provider in full by default and stays retained", async () => {
  const { factory, runtime, memory, captured } = await setup({ sourceExtras: { selection: { budgetChars: 1500, pinnedHardCapChars: 2000 } } });
  try {
    const t = factory.create("work", { projectId: "P" });
    const content = "Intro. " + "filler ".repeat(600) + "MANDATORY-ENDING";
    await memory.view({ threadId: "work", projectId: "P" }).write({ id: "rule", kind: "requirement", content, timestamp: 1 });
    await t.stack.getLayer("memory")!.warm();
    const { artifact } = await send(t, "Do the work.");
    expect(captured.at(-1)?.system).toContain("MANDATORY-ENDING");
    expect(captured.at(-1)?.system).not.toContain("memory tool");
    const report = artifact?.layers?.find((l) => l.id === "memory")?.selection?.sources[0]?.report;
    expect(report?.conflicts.map((c) => c.kind)).toContain("pinned-oversized");
    expect(memory.get("rule")?.content).toBe(content);
  } finally { runtime.disposeAll(); }
});

test("in block mode an oversized pinned record refuses execution before any provider call, with the record id in the error", async () => {
  const { factory, runtime, memory, captured } = await setup({ sourceExtras: { selection: { budgetChars: 1500, pinnedHardCapChars: 2000, oversizedPinned: "block" } } });
  try {
    const t = factory.create("work", { projectId: "P" });
    const content = "Intro. " + "filler ".repeat(600) + "MANDATORY-ENDING";
    await memory.view({ threadId: "work", projectId: "P" }).write({ id: "rule", kind: "requirement", content, timestamp: 1 });
    await t.stack.getLayer("memory")!.warm();
    const before = captured.length;
    await expect(send(t, "Do the work.")).rejects.toThrow(/Required memory context blocked.*rule/);
    expect(captured.length).toBe(before);
    expect(memory.get("rule")?.content).toBe(content);
  } finally { runtime.disposeAll(); }
});

test("an invalid persisted selection policy is rejected when the source is built, before any warm", async () => {
  await expect(setup({ sourceExtras: { selection: { budgetChars: "lots" } as never } })).rejects.toThrow(/selection policy budgetChars/);
});

test("same-named threads in different projects, project publications and hidden unowned records follow ownership", async () => {
  const { factory, runtime, memory, captured } = await setup();
  try {
    // The runtime allows one live thread object per id, so the same-named
    // thread in project Q is created after P's is disposed.
    const p = factory.create("same", { projectId: "P" });
    await memory.view({ threadId: "same", projectId: "P" }).write({ id: "priv", kind: "convention", content: "PRIVATE-P-CONVENTION", timestamp: 1 });
    await memory.view({ threadId: "other", projectId: "P" }).write({ id: "pub", kind: "convention", content: "PUBLISHED-P-CONVENTION", visibility: "project", timestamp: 2 });
    await memory.write({ id: "legacy", kind: "convention", content: "LEGACY-UNOWNED-CONVENTION", timestamp: 3 });
    await p.stack.getLayer("memory")!.warm();
    await send(p, "hello");
    expect(captured.at(-1)?.system).toContain("PRIVATE-P-CONVENTION");
    expect(captured.at(-1)?.system).toContain("PUBLISHED-P-CONVENTION");
    expect(captured.at(-1)?.system).not.toContain("LEGACY-UNOWNED-CONVENTION");
    runtime.dispose("same");

    const q = factory.create("same", { projectId: "Q" });
    await q.stack.getLayer("memory")!.warm();
    await send(q, "hello");
    expect(captured.at(-1)?.system).not.toContain("PRIVATE-P-CONVENTION");
    expect(captured.at(-1)?.system).not.toContain("PUBLISHED-P-CONVENTION");
    expect(captured.at(-1)?.system).not.toContain("LEGACY-UNOWNED-CONVENTION");
  } finally { runtime.disposeAll(); }
});

test("a failed refresh keeps the previously selected content and does not blank the layer", async () => {
  const { factory, runtime, memory } = await setup();
  try {
    const t = factory.create("work", { projectId: "P" });
    await memory.view({ threadId: "work", projectId: "P" }).write({ id: "conv", kind: "convention", content: "KEEP-ME", timestamp: 1 });
    const layer = t.stack.getLayer("memory")!;
    await layer.warm();
    expect(layer.content).toContain("KEEP-ME");
    const original = memory.view.bind(memory);
    (memory as unknown as { view: unknown }).view = () => { throw new Error("store unavailable"); };
    try {
      layer.invalidate();
      await expect(layer.warm()).rejects.toThrow("store unavailable");
    } finally { (memory as unknown as { view: unknown }).view = original; }
    expect(layer.content).toContain("KEEP-ME");
    expect(layer.state).toBe("stale");
  } finally { runtime.disposeAll(); }
});

test("selection survives restart: a fresh memory over the same directory yields the same bounded content and the same full log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-memory-selection-restart-")); dirs.push(dir);
  const first = await setup({ dir });
  let before: string; let count: number;
  try {
    const t = first.factory.create("work", { projectId: "P" });
    await first.memory.view({ threadId: "work", projectId: "P" }).write({ id: "conv", kind: "convention", content: "DURABLE-CONVENTION", timestamp: 1 });
    for (let i = 0; i < 25; i++) await t.signals.emit(noise(`s-${i}`, i));
    await t.stack.getLayer("memory")!.warm();
    before = t.stack.getLayer("memory")!.content;
    count = readdirSync(dir).length;
  } finally { first.runtime.disposeAll(); }

  const second = await setup({ dir });
  try {
    const t = second.factory.create("work", { projectId: "P" });
    await t.stack.getLayer("memory")!.warm();
    expect(sha(t.stack.getLayer("memory")!.content)).toBe(sha(before));
    expect(t.stack.getLayer("memory")!.content).toContain("DURABLE-CONVENTION");
    expect(readdirSync(dir).length).toBe(count);
    expect(second.memory.all()).toHaveLength(26);
  } finally { second.runtime.disposeAll(); }
});

test("a forked thread does not inherit the parent's private selection but does see project publications", async () => {
  const { factory, runtime, memory, captured } = await setup();
  try {
    const parent = factory.create("parent", { projectId: "P" });
    await memory.view({ threadId: "parent", projectId: "P" }).write({ id: "priv", kind: "convention", content: "PARENT-PRIVATE", timestamp: 1 });
    await memory.view({ threadId: "parent", projectId: "P" }).write({ id: "pub", kind: "decision", content: "PARENT-PUBLISHED", visibility: "project", timestamp: 2 });
    const fork = factory.create("parent-fork", { projectId: "P" });
    await fork.stack.getLayer("memory")!.warm();
    await send(fork, "continue");
    expect(captured.at(-1)?.system).toContain("PARENT-PUBLISHED");
    expect(captured.at(-1)?.system).not.toContain("PARENT-PRIVATE");
  } finally { runtime.disposeAll(); }
});
