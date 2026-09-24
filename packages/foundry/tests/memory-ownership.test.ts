import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextStack,
  Executor,
  FileMemory,
  ToolRegistry,
  type BaseAgent,
  type CompletionResult,
  type LLMMessage,
  type LLMProvider,
  type Signal,
} from "@inixiative/foundry-core";
import { Hono } from "hono";
import { EventStream, Harness, InterventionLog } from "@inixiative/foundry-core";
import { ThreadFactory, buildAgents, buildLayers, createSourceResolver } from "../src/agents/thread-factory";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { ProjectRegistry } from "../src/agents/project";
import { MemoryToolAdapter } from "../src/tools/memory-adapter";
import { registerRuntimeRoutes } from "../src/viewer/routes/runtime";
import { ConfigStore, type FoundryConfig } from "../src/viewer/config";

// Private memory source ownership (CORE-003, before G3).
//
// Every thread used to reload the same project-wide signal log through the
// shared FileMemory source, so one thread's captured signals reappeared in
// every other thread on refresh. These tests use the production factory and
// runtime with the real FileMemory adapter in a temporary directory.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const agentSettings = { provider: "mock", model: "mock", temperature: 0, maxTokens: 256, visibleLayers: [], peers: [], maxDepth: 1, enabled: true };

function makeConfig(dir: string, opts?: { includeUnowned?: boolean }): FoundryConfig {
  return {
    defaults: { provider: "mock", model: "mock" },
    providers: {},
    agents: { worker: { ...agentSettings, id: "worker", kind: "executor", prompt: "Execute" } },
    layers: {
      memory: { id: "memory", prompt: "Working memory", sourceIds: ["memory-src"], staleness: 0, enabled: true },
      shared: { id: "shared", prompt: "Published knowledge", sourceIds: ["shared-src"], staleness: 0, enabled: true },
    },
    sources: {
      "memory-src": { id: "memory-src", type: "file", label: "Working memory", uri: dir, enabled: true, includeUnowned: opts?.includeUnowned },
      "shared-src": { id: "shared-src", type: "file", label: "Published knowledge", uri: dir, enabled: true, scope: "global" },
    },
    projects: {},
  };
}

async function setup(opts?: { includeUnowned?: boolean; provider?: LLMProvider; tools?: ToolRegistry }) {
  const dir = mkdtempSync(join(tmpdir(), "foundry-memory-ownership-"));
  dirs.push(dir);
  const memory = new FileMemory(dir);
  await memory.load();
  const config = makeConfig(dir, opts);
  const template = new ContextStack(buildLayers(config, { sourceResolver: createSourceResolver({ memory }) }));
  await template.warmAll();

  let agents: Map<string, BaseAgent>;
  if (opts?.provider) {
    // Production executors take the tool loop only when tools exist at build time.
    opts.tools?.register(MemoryToolAdapter.fromFileMemory(memory), "memory");
    agents = buildAgents(config, template, { provider: opts.provider, tools: opts.tools });
  } else {
    agents = new Map<string, BaseAgent>([["worker", new Executor({ id: "worker", stack: template, handler: async (context) => context })]]);
  }

  const runtime = new ThreadRuntimeManager({
    config,
    domains: [],
    log: () => {},
    warn: () => {},
    llm: { id: "mock", complete: async () => ({ model: "mock", content: "{}" }) },
    signalSinks: [memory.signalWriter()],
  });
  const factory = new ThreadFactory({ stack: template, agents, runtime });
  return { dir, memory, config, template, runtime, factory };
}

const signal = (id: string, content: string): Signal => ({ id, kind: "correction", source: "user", content, timestamp: Date.now() });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("captured signals are owned by their thread and stay usable there after refresh", async () => {
  const { factory, runtime, memory } = await setup();
  try {
    const a = factory.create("a", { projectId: "P" });
    const b = factory.create("b", { projectId: "P" });
    await a.signals.emit(signal("sentinel-a", "SENTINEL-A"));

    const stored = memory.get("sentinel-a");
    expect(stored?.owner).toEqual({ threadId: "a", projectId: "P" });
    expect(stored?.visibility).toBe("thread");

    await a.stack.getLayer("memory")!.warm();
    expect((await a.dispatch("worker", "inspect")).output).toContain("SENTINEL-A");

    await b.stack.getLayer("memory")!.warm();
    await b.stack.refresh();
    expect(b.stack.getLayer("memory")!.content).not.toContain("SENTINEL-A");
    expect((await b.dispatch("worker", "inspect")).output).not.toContain("SENTINEL-A");
  } finally { runtime.disposeAll(); }
});

test("a thread created after another thread's writeback does not inherit it", async () => {
  const { factory, runtime, template } = await setup();
  try {
    const a = factory.create("a", { projectId: "P" });
    await a.signals.emit(signal("sentinel-a", "SENTINEL-A"));
    await sleep(2);

    await template.getLayer("memory")!.warm();
    expect(template.getLayer("memory")!.content).not.toContain("SENTINEL-A");

    const later = factory.create("later", { projectId: "P" });
    expect(later.stack.getLayer("memory")!.content).not.toContain("SENTINEL-A");
    await later.stack.getLayer("memory")!.warm();
    expect(later.stack.getLayer("memory")!.content).not.toContain("SENTINEL-A");
    expect((await later.dispatch("worker", "inspect")).output).not.toContain("SENTINEL-A");
  } finally { runtime.disposeAll(); }
});

test("project-published knowledge reaches only that project; private entries never cross projects", async () => {
  const { factory, runtime, memory } = await setup();
  try {
    const p1 = factory.create("p1", { projectId: "P" });
    await p1.signals.emit(signal("private-p1", "PRIVATE-P1"));
    await memory.view({ threadId: "p1", projectId: "P" }).write({
      id: "published-p", kind: "convention", content: "PUBLISHED-P", visibility: "project", timestamp: Date.now(),
    });
    expect(memory.get("published-p")?.owner).toEqual({ threadId: "p1", projectId: "P" });

    const p2 = factory.create("p2", { projectId: "P" });
    const q1 = factory.create("q1", { projectId: "Q" });
    await p2.stack.getLayer("memory")!.warm();
    await q1.stack.getLayer("memory")!.warm();

    expect(p2.stack.getLayer("memory")!.content).toContain("PUBLISHED-P");
    expect(p2.stack.getLayer("memory")!.content).not.toContain("PRIVATE-P1");
    expect(q1.stack.getLayer("memory")!.content).not.toContain("PUBLISHED-P");
    expect(q1.stack.getLayer("memory")!.content).not.toContain("PRIVATE-P1");
  } finally { runtime.disposeAll(); }
});

test("a global-scoped source exposes only globally published knowledge", async () => {
  const { factory, runtime, memory } = await setup();
  try {
    await memory.view({ threadId: "p1", projectId: "P" }).write({
      id: "published-p", kind: "convention", content: "PUBLISHED-P", visibility: "project", timestamp: Date.now(),
    });
    await memory.publish("published-p", "global");
    const p1 = factory.create("p1", { projectId: "P" });
    await p1.signals.emit(signal("private-p1", "PRIVATE-P1"));

    const q1 = factory.create("q1", { projectId: "Q" });
    await q1.stack.getLayer("shared")!.warm();
    await q1.stack.getLayer("memory")!.warm();
    expect(q1.stack.getLayer("shared")!.content).toContain("PUBLISHED-P");
    expect(q1.stack.getLayer("shared")!.content).not.toContain("PRIVATE-P1");
    expect(q1.stack.getLayer("memory")!.content).toContain("PUBLISHED-P");

    await p1.stack.getLayer("shared")!.warm();
    expect(p1.stack.getLayer("shared")!.content).not.toContain("PRIVATE-P1");
  } finally { runtime.disposeAll(); }
});

test("legacy unowned entries are preserved but hidden unless a source opts in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-memory-legacy-"));
  dirs.push(dir);
  writeFileSync(join(dir, "legacy.json"), JSON.stringify({ id: "legacy", kind: "convention", content: "LEGACY-NOTE", timestamp: 1 }));

  const memory = new FileMemory(dir);
  await memory.load();
  expect(memory.get("legacy")?.content).toBe("LEGACY-NOTE");
  expect(memory.view({ threadId: "a", projectId: "P" }).all()).toHaveLength(0);
  expect(memory.view({}).all()).toHaveLength(0);

  const hidden = createSourceResolver({ memory })("memory-src", makeConfig(dir));
  expect(await hidden!.bind!({ threadId: "a", projectId: "P" }).load()).not.toContain("LEGACY-NOTE");
  const optedIn = createSourceResolver({ memory })("memory-src", makeConfig(dir, { includeUnowned: true }));
  expect(await optedIn!.bind!({ threadId: "a", projectId: "P" }).load()).toContain("LEGACY-NOTE");
  expect(memory.get("legacy")?.owner).toBeUndefined();
});

test("memory tool reads and searches are scoped to the dispatching thread", async () => {
  const { factory, runtime, memory } = await setup();
  try {
    const a = factory.create("a", { projectId: "P" });
    factory.create("b", { projectId: "P" });
    await a.signals.emit(signal("sentinel-a", "SENTINEL-A"));

    const tools = new ToolRegistry();
    tools.register(MemoryToolAdapter.fromFileMemory(memory), "memory");
    const scopeA = { threadId: "a", projectId: "P" };
    const scopeB = { threadId: "b", projectId: "P" };

    const foundByA = await tools.dispatch("memory-file_search", { query: "SENTINEL" }, { scope: scopeA });
    expect((foundByA.data as Array<{ id: string }>).map((e) => e.id)).toEqual(["sentinel-a"]);
    const foundByB = await tools.dispatch("memory-file_search", { query: "SENTINEL" }, { scope: scopeB });
    expect(foundByB.data).toEqual([]);
    expect((await tools.dispatch("memory-file_get", { id: "sentinel-a" }, { scope: scopeB })).data).toBeNull();
    expect((await tools.dispatch("memory-file_search", { query: "SENTINEL" })).data).toEqual([]);

    const tool = MemoryToolAdapter.fromFileMemory(memory).scoped(scopeB);
    expect((await tool.recent(10)).data).toEqual([]);
    expect((await tool.delete("sentinel-a")).data).toEqual({ deleted: false });
    expect(memory.get("sentinel-a")).toBeDefined();

    await tools.dispatch("memory-file_write", { id: "published-b", kind: "convention", content: "PUBLISHED-B", visibility: "project" }, { scope: scopeB });
    expect(memory.get("published-b")).toMatchObject({ owner: scopeB, visibility: "project" });
    const seenByA = await tools.dispatch("memory-file_search", { query: "PUBLISHED" }, { scope: scopeA });
    expect((seenByA.data as Array<{ id: string }>).map((e) => e.id)).toEqual(["published-b"]);
    const seenByQ = await tools.dispatch("memory-file_search", { query: "PUBLISHED" }, { scope: { threadId: "q", projectId: "Q" } });
    expect(seenByQ.data).toEqual([]);
  } finally { runtime.disposeAll(); }
});

test("the no-factory route fallback binds the new thread's memory to its own scope, not main's", async () => {
  const { factory, runtime, memory } = await setup();
  try {
    const registry = new ProjectRegistry();
    const project = registry.register({ id: "P", path: "/qa/p", label: "P", tags: [], runtime: "claude-code" });
    const main = factory.create("main");
    project.addThread(main);
    await main.signals.emit(signal("private-main", "PRIVATE-MAIN"));
    await main.stack.getLayer("memory")!.warm();
    expect(main.stack.getLayer("memory")!.content).toContain("PRIVATE-MAIN");

    const app = new Hono();
    registerRuntimeRoutes(app, {
      harness: new Harness(main), eventStream: new EventStream(), interventions: new InterventionLog(main.signals),
      projectRegistry: registry, db: null, configStore: new ConfigStore("/tmp/foundry-ownership-unused-config"),
    });
    const response = await app.request("/api/threads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "fallback", projectId: "P" }),
    });
    expect(response.status).toBe(201);

    const fallback = project.threads.get("fallback")!;
    expect(fallback.meta.projectId).toBe("P");
    await fallback.stack.getLayer("memory")!.warm();
    expect(fallback.stack.getLayer("memory")!.content).not.toContain("PRIVATE-MAIN");

    await memory.view({ threadId: "main", projectId: "P" }).write({
      id: "published-main", kind: "convention", content: "PUBLISHED-MAIN", visibility: "project", timestamp: Date.now(),
    });
    fallback.stack.getLayer("memory")!.invalidate();
    await fallback.stack.refresh();
    expect(fallback.stack.getLayer("memory")!.content).toContain("PUBLISHED-MAIN");
    expect(fallback.stack.getLayer("memory")!.content).not.toContain("PRIVATE-MAIN");
  } finally { runtime.disposeAll(); }
});

test("production executor tool calls carry the thread scope into the memory tool", async () => {
  const tools = new ToolRegistry();
  const provider: LLMProvider = {
    id: "mock",
    async complete(messages: LLMMessage[]): Promise<CompletionResult> {
      const last = messages[messages.length - 1];
      if (typeof last.content === "string" && last.content.startsWith("[Tool Result")) {
        return { model: "mock", content: last.content };
      }
      return { model: "mock", content: "", toolCalls: [{ id: "call-1", name: "memory-file_search", input: { query: "SENTINEL" } }] };
    },
  };
  const { factory, runtime } = await setup({ provider, tools });
  try {
    const a = factory.create("a", { projectId: "P" });
    const b = factory.create("b", { projectId: "P" });
    await a.signals.emit(signal("sentinel-a", "SENTINEL-A"));
    expect((await a.dispatch("worker", "search memory")).output).toContain("SENTINEL-A");
    expect((await b.dispatch("worker", "search memory")).output).not.toContain("SENTINEL-A");
  } finally { runtime.disposeAll(); }
});
