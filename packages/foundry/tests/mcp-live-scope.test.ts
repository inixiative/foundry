import { afterEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextLayer, ContextStack, Thread, ToolRegistry, FileMemory, type MemoryEntry } from "@inixiative/foundry-core";
import { SessionManager } from "../src/agents/session";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { ThreadFactory, buildAgents } from "../src/agents/thread-factory";
import { starterConfig } from "../src/viewer/config";
import { MemoryToolAdapter } from "../src/tools/memory-adapter";
import { createFoundryMcp, createFoundryMcpServer } from "../src/mcp/server";

// T1 focused SDK tests. Written RED first. Every case drives the actual SDK
// initialize/listTools/callTool path over the in-memory transport; no model,
// credentials or native process. Authority comes from the registered thread
// object, project and generation, never from tool arguments.
const resolve = createRequire(new URL("../package.json", import.meta.url)).resolve;
const { Client } = await import(resolve("@modelcontextprotocol/sdk/client/index.js"));
const { InMemoryTransport } = await import(resolve("@modelcontextprotocol/sdk/inMemory.js"));

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch {} } });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const text = (result: any) => (result.content as Array<{ type: string; text: string }>).filter(c => c.type === "text").map(c => c.text).join("\n");
const invocation = (result: any) => {
  const block = (result.content as Array<{ type: string; text: string }>).map(c => c.text).find(t => t.startsWith("{\"invocation\""));
  return block ? JSON.parse(block).invocation : undefined;
};

async function connect(server: { connect(t: unknown): Promise<void>; close(): Promise<void> }) {
  const client = new Client({ name: "fable-t1-client", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return client;
}

function layerThread(id: string, projectId: string | undefined, fact: string) {
  const layer = new ContextLayer({ id: "memory-conventions" }); layer.set(fact);
  const knowledge = new ContextLayer({ id: "thread-knowledge:conventions" }); knowledge.set(`THREAD_KNOWLEDGE_${id}`);
  const t = new Thread(id, new ContextStack([layer, knowledge]));
  t.meta.projectId = projectId;
  cleanups.push(() => t.dispose());
  return t;
}

async function memoryFixture() {
  const dir = mkdtempSync(join(tmpdir(), "foundry-t1-memory-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const memory = new FileMemory(dir);
  const write = (entry: MemoryEntry) => memory.write(entry);
  await write({ id: "own-omitted", kind: "observation", content: "OWN_OMITTED_FACT: the migration order is C before B", timestamp: 1,
    owner: { threadId: "owner", projectId: "project-A" }, visibility: "thread" });
  await write({ id: "sibling-published", kind: "convention", content: "SIBLING_PUBLISHED_FACT for project A", timestamp: 2,
    owner: { threadId: "sibling", projectId: "project-A" }, visibility: "project" });
  await write({ id: "sibling-private", kind: "observation", content: "SIBLING_PRIVATE_FACT must not leak", timestamp: 3,
    owner: { threadId: "sibling", projectId: "project-A" }, visibility: "thread" });
  await write({ id: "foreign-marker", kind: "observation", content: "FOREIGN_PROJECT_MARKER must not leak", timestamp: 4,
    owner: { threadId: "foreign", projectId: "project-B" }, visibility: "project" });
  const tools = new ToolRegistry();
  tools.register(MemoryToolAdapter.fromFileMemory(memory), "Project memory");
  return { memory, tools };
}

test("SDK listTools exposes the read-only bridge, and each result carries a bounded invocation contract", async () => {
  const owner = layerThread("owner", "project-A", "CURRENT_OWNER_FACT");
  const manager = new SessionManager(); manager.add(owner);
  const { server, invocations } = createFoundryMcp({ thread: owner, sessionManager: manager });
  const client = await connect(server);
  const listed = await client.listTools();
  expect(listed.tools.map((t: any) => t.name).sort()).toEqual(["foundry_conventions", "foundry_device", "foundry_memory", "foundry_query", "foundry_signal", "foundry_threads"]);
  const result = await client.callTool({ name: "foundry_query", arguments: { topic: "CURRENT_OWNER_FACT", detail: "full" } });
  const record = invocation(result);
  expect(record).toMatchObject({ operation: "foundry_query", owner: { threadId: "owner", projectId: "project-A" }, status: "ok", nativeCorrelation: "unknown" });
  expect(record.generation).toBeUndefined(); // no live runtime generation in the session-manager path
  expect(typeof record.sdkRequestId === "number" || typeof record.sdkRequestId === "string").toBe(true);
  expect(record.finishedAt).toBeGreaterThanOrEqual(record.startedAt);
  const delivered = (result.content as any[])[0].text;
  expect(record.digest).toBe(sha(delivered));
  expect(invocations().at(-1)).toMatchObject({ operation: "foundry_query", status: "ok", digest: record.digest });
});

test("scoped memory search and get reach an own omitted record and same-project publications only", async () => {
  const owner = layerThread("owner", "project-A", "layer content without the omitted fact");
  const manager = new SessionManager(); manager.add(owner);
  const { tools } = await memoryFixture();
  const client = await connect(createFoundryMcpServer({ thread: owner, sessionManager: manager, tools }));
  const search = await client.callTool({ name: "foundry_memory", arguments: { query: "FACT" } });
  const body = text(search);
  expect(search.isError).not.toBe(true);
  expect(body).toContain("OWN_OMITTED_FACT");
  expect(body).toContain("SIBLING_PUBLISHED_FACT");
  expect(body).not.toContain("SIBLING_PRIVATE_FACT");
  expect(body).not.toContain("FOREIGN_PROJECT_MARKER");
  expect(body).toMatch(/owner: thread owner; project project-A/);
  expect(body).toMatch(/visibility: thread/);
  expect(body).toMatch(/hash: [0-9a-f]{64}/);
  expect(body).toMatch(/range: chars 0-\d+ of \d+/);
  // Tool arguments never supply authorization: foreign thread/project ids in the call change nothing.
  const forgedScope = await client.callTool({ name: "foundry_memory", arguments: { query: "FACT", threadId: "sibling", projectId: "project-B" } as any });
  expect(text(forgedScope)).toContain("OWN_OMITTED_FACT");
  expect(text(forgedScope)).not.toMatch(/SIBLING_PRIVATE_FACT|FOREIGN_PROJECT_MARKER/);
  const get = await client.callTool({ name: "foundry_memory", arguments: { id: "own-omitted" } });
  expect(text(get)).toContain("OWN_OMITTED_FACT: the migration order is C before B");
  expect(invocation(get).status).toBe("ok");
  for (const forged of ["sibling-private", "foreign-marker", "no-such-record"]) {
    const missing = await client.callTool({ name: "foundry_memory", arguments: { id: forged } });
    expect(missing.isError).not.toBe(true);
    expect(text(missing)).toContain("No record with that id is available to this thread");
    expect(text(missing)).not.toMatch(/SIBLING_PRIVATE|FOREIGN_PROJECT|sibling|foreign/);
    expect(invocation(missing).status).toBe("missing");
  }
});

test("a backend that cannot honor scope and a session without a memory tool are explicitly unavailable", async () => {
  const owner = layerThread("owner", "project-A", "fact");
  const manager = new SessionManager(); manager.add(owner);
  const incapable = new ToolRegistry();
  const store = new Map<string, MemoryEntry>([["leak", { id: "leak", kind: "x", content: "UNSCOPED_BACKEND_LEAK", timestamp: 1 }]]);
  incapable.register(MemoryToolAdapter.from("plain", { write: async e => { store.set(e.id, e); }, get: id => store.get(id), search: () => [...store.values()] }), "Plain memory");
  const withIncapable = await connect(createFoundryMcpServer({ thread: owner, sessionManager: manager, tools: incapable }));
  const result = await withIncapable.callTool({ name: "foundry_memory", arguments: { query: "LEAK" } });
  expect(text(result)).not.toContain("UNSCOPED_BACKEND_LEAK");
  expect(text(result)).toMatch(/unavailable/i);
  expect(invocation(result).status).toBe("unavailable");
  const owner2 = layerThread("owner2", "project-A", "fact"); manager.add(owner2);
  const none = await connect(createFoundryMcpServer({ thread: owner2, sessionManager: manager }));
  const absent = await none.callTool({ name: "foundry_memory", arguments: { query: "anything" } });
  expect(text(absent)).toMatch(/not available/i);
  expect(invocation(absent).status).toBe("unavailable");
});

test("authority is re-validated after an awaited read: disposal during a slow backend read refuses delivery", async () => {
  const owner = layerThread("owner", "project-A", "fact");
  const manager = new SessionManager(); manager.add(owner);
  let release!: () => void; const held = new Promise<void>(r => { release = r; });
  const slow = new ToolRegistry();
  const backing = (await memoryFixture()).memory;
  slow.register(MemoryToolAdapter.from("slow", { write: e => backing.write(e), get: async id => { await held; return backing.get(id); },
    search: async q => { await held; return backing.search(q); }, view: scope => {
      const view = backing.view(scope);
      return { write: e => view.write(e), get: async id => { await held; return view.get(id); }, search: async (q, l) => { await held; return view.search(q, l); } };
    } }), "Slow scoped memory");
  const client = await connect(createFoundryMcpServer({ thread: owner, sessionManager: manager, tools: slow }));
  const pending = client.callTool({ name: "foundry_memory", arguments: { id: "own-omitted" } });
  await Bun.sleep(5);
  owner.dispose();
  release();
  const result = await pending.catch(() => ({ isError: true, content: [] }));
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain("OWN_OMITTED_FACT");
});

test("a later publication becomes visible to the same-project reader while earlier results stay immutable", async () => {
  const owner = layerThread("owner", "project-A", "fact");
  const manager = new SessionManager(); manager.add(owner);
  const { memory, tools } = await memoryFixture();
  const client = await connect(createFoundryMcpServer({ thread: owner, sessionManager: manager, tools }));
  const before = await client.callTool({ name: "foundry_memory", arguments: { query: "SIBLING" } });
  const frozen = JSON.stringify(before);
  expect(text(before)).not.toContain("SIBLING_PRIVATE_FACT");
  await memory.publish("sibling-private", "project");
  const after = await client.callTool({ name: "foundry_memory", arguments: { query: "SIBLING" } });
  expect(text(after)).toContain("SIBLING_PRIVATE_FACT");
  expect(JSON.stringify(before)).toBe(frozen);
});

test("foundry_threads discloses only authorized same-project live summaries; an unprojected owner keeps its own context only", async () => {
  const owner = layerThread("owner", undefined, "UNPROJECTED_OWN_FACT");
  const other = layerThread("other-unprojected", undefined, "OTHER_FACT"); other.meta.description = "OTHER_UNPROJECTED_DESCRIPTION";
  const projected = layerThread("projected", "project-A", "PROJECTED_FACT"); projected.meta.description = "PROJECTED_DESCRIPTION";
  const manager = new SessionManager(); for (const t of [owner, other, projected]) manager.add(t);
  const client = await connect(createFoundryMcpServer({ thread: owner, sessionManager: manager }));
  const threads = await client.callTool({ name: "foundry_threads", arguments: {} });
  expect(threads.isError).not.toBe(true);
  expect(JSON.stringify(threads)).not.toMatch(/OTHER_UNPROJECTED_DESCRIPTION|other-unprojected|PROJECTED_DESCRIPTION|projected/);
  expect(text(threads)).toMatch(/no project/i);
  const own = await client.callTool({ name: "foundry_query", arguments: { topic: "UNPROJECTED_OWN_FACT", detail: "full" } });
  expect(text(own)).toContain("UNPROJECTED_OWN_FACT");
});

test("foundry_signal is refused on the read-only native grant and emits only with an explicit standalone grant", async () => {
  const owner = layerThread("owner", "project-A", "fact");
  const received: unknown[] = [];
  owner.signals.on("info", s => { received.push(s); });
  const readOnly = await connect(createFoundryMcpServer({ thread: owner }));
  const refused = await readOnly.callTool({ name: "foundry_signal", arguments: { kind: "info", content: "not journaled", confidence: 0.5 } });
  expect(refused.isError).toBe(true);
  expect(text(refused)).toMatch(/read-only/i);
  expect(received).toHaveLength(0);
  const standalone = await connect(createFoundryMcpServer({ thread: owner, grant: { signal: true } }));
  const emitted = await standalone.callTool({ name: "foundry_signal", arguments: { kind: "info", content: "operator standalone", confidence: 0.5 } });
  expect(emitted.isError).not.toBe(true);
  expect(received).toHaveLength(1);
  expect(text(emitted)).toMatch(/not.*journaled|no journal/i);
});

test("observer failures are isolated on ok, refusal and error paths, counted without retaining error text, and never awaited on retrieval", async () => {
  const owner = layerThread("owner", "project-A", "OBSERVER_FACT");
  const manager = new SessionManager(); manager.add(owner);
  let calls = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  cleanups.push(() => process.off("unhandledRejection", onUnhandled));
  // A plain function: synchronous throws stay synchronous; only the second call returns a rejecting promise.
  const { server, diagnostics, invocations } = createFoundryMcp({ thread: owner, sessionManager: manager, onInvocation: (): void | Promise<void> => {
    calls++;
    if (calls === 1) throw new TypeError("PRIVATE_SYNC_OBSERVER_TEXT");
    if (calls === 2) return Bun.sleep(30).then(() => { throw new RangeError("PRIVATE_ASYNC_OBSERVER_TEXT"); });
    if (calls === 3) throw new Error("PRIVATE_REFUSAL_OBSERVER_TEXT");
  } });
  const client = await connect(server);
  const ok = await client.callTool({ name: "foundry_query", arguments: { topic: "OBSERVER_FACT", detail: "full" } });
  expect(ok.isError).not.toBe(true);
  expect(text(ok)).toContain("OBSERVER_FACT");
  expect(invocation(ok).status).toBe("ok");
  const started = Date.now();
  const second = await client.callTool({ name: "foundry_query", arguments: { topic: "OBSERVER_FACT", detail: "full" } });
  expect(Date.now() - started).toBeLessThan(25); // the rejecting async observer was not awaited
  expect(second.isError).not.toBe(true);
  await Bun.sleep(50);
  expect(unhandled).toEqual([]);
  owner.meta.projectId = "project-B";
  const refused = await client.callTool({ name: "foundry_query", arguments: { topic: "OBSERVER_FACT", detail: "full" } });
  expect(refused.isError).toBe(true);
  expect(text(refused)).toMatch(/no longer valid/);
  expect(invocation(refused).status).toBe("refused");
  const d = diagnostics();
  expect(d.observerFailures).toEqual({ synchronous: 2, asynchronous: 1 });
  expect(d.lastObserverFailure).toEqual({ category: "synchronous-throw", operation: "foundry_query" });
  expect(JSON.stringify([d, invocations(), ok, second, refused])).not.toMatch(/PRIVATE_(SYNC|ASYNC|REFUSAL)_OBSERVER_TEXT|TypeError|RangeError/);
  expect(invocations()).toHaveLength(3);
  expect(Object.isFrozen(invocations()[0].owner)).toBe(true);
});

test("hostile thrown and rejected values are never inspected: throwing accessors, proxies and non-Error rejections cannot escape or leak", async () => {
  const owner = layerThread("owner", "project-A", "HOSTILE_FACT");
  const manager = new SessionManager(); manager.add(owner);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  cleanups.push(() => process.off("unhandledRejection", onUnhandled));
  // Every property access on this value throws; a diagnostic that reads name/message/constructor would escape.
  const hostile = new Proxy({}, { get() { throw new Error("CONTROLLED_PROXY_TRAP"); }, getPrototypeOf() { throw new Error("CONTROLLED_PROTO_TRAP"); } });
  const namedAccessor = new Error("controlled"); Object.defineProperty(namedAccessor, "name", { get() { throw new Error("CONTROLLED_NAME_ACCESSOR"); } });
  const thenTrap = { get then() { throw new Error("CONTROLLED_THEN_ACCESSOR"); } };
  let calls = 0;
  const { server, diagnostics } = createFoundryMcp({ thread: owner, sessionManager: manager, onInvocation: (): unknown => {
    calls++;
    if (calls === 1) throw hostile;
    if (calls === 2) throw namedAccessor;
    if (calls === 3) return thenTrap; // hostile thenable: `then` accessor throws
    if (calls === 4) return Promise.reject(hostile); // non-Error rejected value
    if (calls === 5) return Promise.reject("CONTROLLED_STRING_REJECTION");
    return undefined;
  } });
  const client = await connect(server);
  for (let i = 0; i < 5; i++) {
    const result = await client.callTool({ name: "foundry_query", arguments: { topic: "HOSTILE_FACT", detail: "full" } });
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("HOSTILE_FACT");
    expect(invocation(result).status).toBe("ok");
  }
  await Bun.sleep(20);
  expect(unhandled).toEqual([]);
  const d = diagnostics();
  expect(d.observerFailures).toEqual({ synchronous: 3, asynchronous: 2 });
  expect(d.lastObserverFailure).toEqual({ category: "asynchronous-rejection", operation: "foundry_query" });
  expect(JSON.stringify(d)).not.toMatch(/CONTROLLED_/);
});

test("revocation discovered after a throwing backend read is a refusal that admits the read, never a bare tool error", async () => {
  const owner = layerThread("owner", "project-A", "fact");
  const manager = new SessionManager(); manager.add(owner);
  const tools = new ToolRegistry();
  tools.register(MemoryToolAdapter.from("exploding", { write: async () => {}, get: async () => { owner.dispose(); throw new Error("BACKEND_PRIVATE_DETAIL"); },
    search: async () => { owner.dispose(); throw new Error("BACKEND_PRIVATE_DETAIL"); }, view: () => ({ write: async () => {},
      get: async () => { owner.dispose(); throw new Error("BACKEND_PRIVATE_DETAIL"); }, search: async () => { owner.dispose(); throw new Error("BACKEND_PRIVATE_DETAIL"); } }) }), "Exploding memory");
  const client = await connect(createFoundryMcpServer({ thread: owner, sessionManager: manager, tools }));
  const result = await client.callTool({ name: "foundry_memory", arguments: { id: "anything" } }).catch(() => ({ isError: true, content: [] }));
  expect(result.isError).toBe(true);
  const body = JSON.stringify(result);
  expect(body).not.toContain("BACKEND_PRIVATE_DETAIL");
  expect(body).toMatch(/no longer valid/);
  expect(body).toMatch(/read may have occurred|before revocation was observed/i);
  expect(body).not.toMatch(/No data was read or delivered/);
  expect(invocation(result)?.status).toBe("refused");
  expect(invocation(result)?.refusal).toBe("disposed");
});

test("record listeners share the observer contract: async rejections counted, hostile thenables isolated, retrieval unaffected, exact-once notification", async () => {
  const owner = layerThread("owner", "project-A", "LISTENER_FACT");
  const manager = new SessionManager(); manager.add(owner);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  cleanups.push(() => process.off("unhandledRejection", onUnhandled));
  const { server, diagnostics, onRecord, invocations } = createFoundryMcp({ thread: owner, sessionManager: manager });
  const seen: string[] = [];
  onRecord(record => { seen.push(record.operation); });
  onRecord(() => Promise.reject(new Error("CONTROLLED_LISTENER_REJECTION")));
  onRecord(() => ({ get then() { throw new Error("CONTROLLED_LISTENER_THEN"); } }));
  onRecord(() => { throw new Proxy({}, { get() { throw new Error("CONTROLLED_LISTENER_PROXY"); } }); });
  const client = await connect(server);
  const result = await client.callTool({ name: "foundry_query", arguments: { topic: "LISTENER_FACT", detail: "full" } });
  expect(result.isError).not.toBe(true);
  expect(text(result)).toContain("LISTENER_FACT");
  await Bun.sleep(20);
  expect(unhandled).toEqual([]);
  expect(seen).toEqual(["foundry_query"]);
  expect(invocations()).toHaveLength(1);
  const d = diagnostics();
  expect(d.observerFailures).toEqual({ synchronous: 2, asynchronous: 1 });
  expect(JSON.stringify(d)).not.toMatch(/CONTROLLED_LISTENER/);
});

function runtimeFixture() {
  const config = starterConfig("controlled", "controlled");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "controlled", model: "controlled", prompt: "Work", temperature: 0,
    visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const layer = new ContextLayer({ id: "conventions", prompt: "Configured domain instructions" }); layer.set("CONFIGURED_DOMAIN_KNOWLEDGE");
  const stack = new ContextStack([layer]);
  const manager = new ThreadRuntimeManager({ config, log() {}, warn() {}, domains: [{ domain: "conventions", layerId: "conventions", guardTriggers: [], reviewPrompt: "REVIEW_INSTRUCTIONS_TEXT" }],
    llm: { id: "controlled", async complete() { return { model: "controlled", content: "{}" }; } } });
  const factory = new ThreadFactory({ stack, runtime: manager, agents: buildAgents(config, stack, { provider: { id: "controlled", async complete() { return { model: "controlled", content: "done" }; } } }) });
  cleanups.push(() => manager.disposeAll());
  return { manager, factory };
}

test("a live runtime authority distinguishes instructions, configured domain knowledge and thread knowledge, and sees fresh commits without a new server", async () => {
  const { manager, factory } = runtimeFixture();
  const thread = factory.create("live", { projectId: "project-A" });
  const runtime = manager.get("live")!;
  const { server, authority } = createFoundryMcp({ thread, runtime: manager });
  expect(authority.generation).toBe(runtime.generation);
  const client = await connect(server);
  const before = text(await client.callTool({ name: "foundry_conventions", arguments: { domain: "conventions" } }));
  expect(before).toContain("REVIEW_INSTRUCTIONS_TEXT");
  expect(before).toContain("CONFIGURED_DOMAIN_KNOWLEDGE");
  expect(before).toMatch(/thread knowledge[^\n]*revision 0/i);
  runtime.domainLibrarians.get("conventions")!.threadKnowledge.learn("FRESH_COMMITTED_THREAD_FACT", { kind: "dispatch", id: "e1", timestamp: 1 }, "controlled-reviewer");
  const after = await client.callTool({ name: "foundry_conventions", arguments: { domain: "conventions" } });
  expect(text(after)).toContain("FRESH_COMMITTED_THREAD_FACT");
  expect(text(after)).toMatch(/revision 1/);
  expect(invocation(after)).toMatchObject({ generation: runtime.generation, owner: { threadId: "live", projectId: "project-A" } });
});

test("replacing the live runtime for the same thread id revokes the old authority and the new one is not silently adopted", async () => {
  const { manager, factory } = runtimeFixture();
  const thread = factory.create("live", { projectId: "project-A" });
  const client = await connect(createFoundryMcpServer({ thread, runtime: manager }));
  expect((await client.callTool({ name: "foundry_conventions", arguments: { domain: "conventions" } })).isError).not.toBe(true);
  manager.get("live")!.dispose();
  const replacement = factory.create("live", { projectId: "project-A" });
  manager.get("live")!.domainLibrarians.get("conventions")!.threadKnowledge.learn("REPLACEMENT_PRIVATE_FACT", { kind: "dispatch", id: "e2", timestamp: 2 }, "controlled-reviewer");
  const result = await client.callTool({ name: "foundry_conventions", arguments: { domain: "conventions" } }).catch(() => ({ isError: true }));
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain("REPLACEMENT_PRIVATE_FACT");
  expect(invocation(result)?.status ?? "refused").toBe("refused");
  expect(replacement.disposed).toBe(false);
});
