import { afterEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ContextLayer, ContextStack, Thread, ToolRegistry, FileMemory, type MemoryEntry } from "@inixiative/foundry-core";
import { SessionManager } from "../src/agents/session";
import { MemoryToolAdapter, type MemoryBackend } from "../src/tools/memory-adapter";
import { createFoundryMcp } from "../src/mcp/server";
import { createLiveBridge, type LiveBridge } from "../src/mcp/transport";
import { readLaunchFile, runProxy } from "../src/mcp/proxy";

// T2 focused tests, written RED first. Actual loopback HTTP through the SDK
// streamable client, and a REAL owned Bun stdio proxy subprocess talking to that
// server. No model, no credentials beyond opaque generated capabilities kept in
// owned temp files; tokens and raw launch contents never reach test output.
const resolve = createRequire(new URL("../package.json", import.meta.url)).resolve;
const { Client } = await import(resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StreamableHTTPClientTransport } = await import(resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"));
const { StdioClientTransport } = await import(resolve("@modelcontextprotocol/sdk/client/stdio.js"));
const PROXY = fileURLToPath(new URL("../src/mcp/proxy.ts", import.meta.url));

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch {} } });

const text = (result: any) => (result.content as Array<{ type: string; text: string }>).filter(c => c.type === "text").map(c => c.text).join("\n");
const invocation = (result: any) => {
  const block = (result.content as Array<{ type: string; text: string }>).map(c => c.text).find(t => t.startsWith("{\"invocation\""));
  return block ? JSON.parse(block).invocation : undefined;
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function counting(backing: FileMemory) {
  const counts = { reads: 0 };
  const wrap = (b: MemoryBackend): MemoryBackend => ({
    write: e => b.write(e), get: id => { counts.reads++; return b.get(id); }, search: (q, l) => { counts.reads++; return b.search(q, l); },
    ...(b.view ? { view: (scope: any) => wrap(b.view!(scope)) } : {}),
  });
  return { backend: wrap(backing), counts };
}

async function fixture(opts: { projectId?: string; slowRead?: () => Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "foundry-t2-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const memory = new FileMemory(join(dir, "memory"));
  await memory.write({ id: "own-omitted", kind: "observation", content: "OWN_OMITTED_FACT: migration order C before B", timestamp: 1, owner: { threadId: "owner", projectId: "project-A" }, visibility: "thread" });
  await memory.write({ id: "sibling-published", kind: "convention", content: "SIBLING_PUBLISHED_FACT", timestamp: 2, owner: { threadId: "sibling", projectId: "project-A" }, visibility: "project" });
  await memory.write({ id: "sibling-private", kind: "observation", content: "SIBLING_PRIVATE_FACT", timestamp: 3, owner: { threadId: "sibling", projectId: "project-A" }, visibility: "thread" });
  await memory.write({ id: "foreign-marker", kind: "observation", content: "FOREIGN_PROJECT_MARKER", timestamp: 4, owner: { threadId: "foreign", projectId: "project-B" }, visibility: "project" });
  const { backend, counts } = counting(memory);
  const slow: MemoryBackend = opts.slowRead ? { write: e => backend.write(e), get: async id => { await opts.slowRead!(); return backend.get(id); },
    search: async (q, l) => { await opts.slowRead!(); return backend.search(q, l); }, view: (scope: any) => {
      const v = backend.view!(scope); return { write: e => v.write(e), get: async id => { await opts.slowRead!(); return v.get(id); }, search: async (q, l) => { await opts.slowRead!(); return v.search(q, l); } };
    } } : backend;
  const tools = new ToolRegistry();
  tools.register(MemoryToolAdapter.from("file", slow), "Project memory");
  const layer = new ContextLayer({ id: "memory-conventions" }); layer.set("CURRENT_OWNER_FACT: layer content without the omitted fact");
  const knowledge = new ContextLayer({ id: "thread-knowledge:conventions" }); knowledge.set("THREAD_KNOWLEDGE_V1");
  const owner = new Thread("owner", new ContextStack([layer, knowledge])); owner.meta.projectId = opts.projectId ?? "project-A";
  const sibling = new Thread("sibling", new ContextStack([new ContextLayer({ id: "x" })])); sibling.meta.projectId = "project-A"; sibling.meta.description = "SAME_PROJECT_SUMMARY";
  const foreign = new Thread("foreign", new ContextStack([new ContextLayer({ id: "x" })])); foreign.meta.projectId = "project-B"; foreign.meta.description = "PRIVATE_PROJECT_B_DESCRIPTION";
  const manager = new SessionManager(); for (const t of [owner, sibling, foreign]) manager.add(t);
  cleanups.push(() => { for (const t of [owner, sibling, foreign]) t.dispose(); });
  const bridge = await createLiveBridge({ createMcp: () => createFoundryMcp({ thread: owner, sessionManager: manager, tools }), launchRoot: dir });
  cleanups.push(() => bridge.close());
  const launch = readFileSync(bridge.launchFile, "utf8"); // read once, in-process only; never printed
  const capability = JSON.parse(launch).capability as string;
  return { bridge, owner, memory, counts, knowledge, dir, capability, manager, tools };
}

async function httpClient(bridge: LiveBridge, capability: string) {
  const client = new Client({ name: "fable-t2-http", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(bridge.endpoint), { requestInit: { headers: { Authorization: `Bearer ${capability}` } } });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

async function proxyClient(bridge: LiveBridge) {
  const transport = new StdioClientTransport({ command: "bun", args: [PROXY, bridge.launchFile], stderr: "pipe" });
  const client = new Client({ name: "fable-t2-proxy", version: "1.0.0" });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

const raw = (bridge: LiveBridge, init: RequestInit & { host?: string } = {}, path = "") => {
  const headers = new Headers(init.headers);
  if (init.host) headers.set("Host", init.host);
  return fetch(bridge.endpoint + path, { ...init, headers, redirect: "manual" });
};
const initializeBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });

test("launch artifacts: 0700 directory, 0600 file, loopback endpoint, capability only in the file, descriptors for both engines", async () => {
  const f = await fixture();
  expect(f.bridge.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  expect(statSync(f.bridge.launchDir).mode & 0o777).toBe(0o700);
  expect(statSync(f.bridge.launchFile).mode & 0o777).toBe(0o600);
  expect(f.capability.length).toBeGreaterThanOrEqual(32);
  const d = f.bridge.launch;
  expect(d.command).toBe("bun");
  expect(d.args).toEqual([PROXY, f.bridge.launchFile]);
  expect(JSON.stringify(d)).not.toContain(f.capability);
  expect(d.claude.mcpConfig.mcpServers.foundry).toEqual({ command: "bun", args: [PROXY, f.bridge.launchFile] });
  expect(d.codex.configOverrides.some(o => o.startsWith("mcp_servers.foundry.command="))).toBe(true);
  expect(JSON.stringify({ stats: f.bridge.stats(), inv: f.bridge.invocations() })).not.toContain(f.capability);
});

test("loopback HTTP SDK client retrieves scoped records, sees fresh knowledge, and keeps results immutable with correlated concurrency", async () => {
  const f = await fixture();
  const client = await httpClient(f.bridge, f.capability);
  expect((await client.listTools()).tools.map((t: any) => t.name).sort()).toEqual(["foundry_conventions", "foundry_device", "foundry_memory", "foundry_query", "foundry_signal", "foundry_threads"]);
  const search = await client.callTool({ name: "foundry_memory", arguments: { query: "FACT" } });
  expect(text(search)).toContain("OWN_OMITTED_FACT");
  expect(text(search)).toContain("SIBLING_PUBLISHED_FACT");
  expect(text(search)).not.toMatch(/SIBLING_PRIVATE_FACT|FOREIGN_PROJECT_MARKER/);
  for (const id of ["sibling-private", "foreign-marker", "forged"]) {
    const missing = await client.callTool({ name: "foundry_memory", arguments: { id } });
    expect(text(missing)).toContain("No record with that id is available to this thread");
  }
  const threads = await client.callTool({ name: "foundry_threads", arguments: {} });
  expect(text(threads)).toContain("SAME_PROJECT_SUMMARY");
  expect(JSON.stringify(threads)).not.toMatch(/PRIVATE_PROJECT_B|foreign/);
  const before = await client.callTool({ name: "foundry_conventions", arguments: { domain: "conventions" } });
  const frozen = JSON.stringify(before);
  expect(text(before)).toContain("THREAD_KNOWLEDGE_V1");
  f.knowledge.set("THREAD_KNOWLEDGE_V2_FRESH_COMMIT");
  const after = await client.callTool({ name: "foundry_conventions", arguments: { domain: "conventions" } });
  expect(text(after)).toContain("THREAD_KNOWLEDGE_V2_FRESH_COMMIT");
  expect(JSON.stringify(before)).toBe(frozen);
  expect(invocation(after).digest).toBe(sha((after.content as any[])[0].text));
  const topics = ["OWN_OMITTED", "SIBLING_PUBLISHED", "CURRENT_OWNER_FACT", "THREAD_KNOWLEDGE", "nothing-here"];
  const results = await Promise.all(topics.map(topic => client.callTool({ name: topic.startsWith("nothing") ? "foundry_query" : topic.includes("OMITTED") || topic.includes("PUBLISHED") ? "foundry_memory" : "foundry_query",
    arguments: topic.includes("OMITTED") || topic.includes("PUBLISHED") ? { query: topic } : { topic, detail: "full" } })));
  expect(text(results[0])).toContain("OWN_OMITTED_FACT");
  expect(text(results[1])).toContain("SIBLING_PUBLISHED_FACT");
  expect(text(results[2])).toContain("CURRENT_OWNER_FACT");
  expect(text(results[3])).toContain("THREAD_KNOWLEDGE_V2_FRESH_COMMIT");
  expect(invocation(results[4]).status).toBe("missing");
  const requestIds = results.map(r => invocation(r).sdkRequestId);
  expect(new Set(requestIds).size).toBe(5);
  expect(results.every(r => invocation(r).nativeCorrelation === "unknown")).toBe(true);
});

test("a real owned Bun stdio proxy subprocess serves the same scoped tools through the loopback bridge, including concurrent calls", async () => {
  const f = await fixture();
  const client = await proxyClient(f.bridge);
  expect((await client.listTools()).tools.map((t: any) => t.name)).toContain("foundry_memory");
  const get = await client.callTool({ name: "foundry_memory", arguments: { id: "own-omitted" } });
  expect(get.isError).not.toBe(true);
  expect(text(get)).toContain("OWN_OMITTED_FACT: migration order C before B");
  const [a, b, c] = await Promise.all([
    client.callTool({ name: "foundry_memory", arguments: { query: "SIBLING_PUBLISHED" } }),
    client.callTool({ name: "foundry_query", arguments: { topic: "CURRENT_OWNER_FACT", detail: "full" } }),
    client.callTool({ name: "foundry_memory", arguments: { id: "foreign-marker" } }),
  ]);
  expect(text(a)).toContain("SIBLING_PUBLISHED_FACT");
  expect(text(b)).toContain("CURRENT_OWNER_FACT");
  expect(text(c)).toContain("No record with that id is available to this thread");
  expect(JSON.stringify([a, b, c])).not.toMatch(/FOREIGN_PROJECT_MARKER|SIBLING_PRIVATE_FACT/);
  const refused = await client.callTool({ name: "foundry_signal", arguments: { kind: "info", content: "x", confidence: 0.5 } });
  expect(refused.isError).toBe(true); // isError preserved through the proxy
  expect(f.bridge.stats().sessions).toBeGreaterThanOrEqual(1);
});

test("wrong or absent capability, browser origins, bad Host and unsupported methods are rejected before any backend work", async () => {
  const f = await fixture();
  const post = (headers: Record<string, string>, host?: string) => raw(f.bridge, { method: "POST", body: initializeBody, host, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } });
  expect((await post({})).status).toBe(401);
  expect((await post({ Authorization: "Bearer wrong-capability-value-that-is-long-enough-000" })).status).toBe(401);
  expect((await post({ Authorization: `Bearer ${f.capability}`, Origin: "http://127.0.0.1:1" })).status).toBe(403);
  expect((await post({ Authorization: `Bearer ${f.capability}`, Origin: "null" })).status).toBe(403);
  expect((await post({ Authorization: `Bearer ${f.capability}` }, "evil.example:80")).status).toBe(400);
  for (const method of ["PUT", "PATCH", "OPTIONS", "HEAD"]) {
    expect((await raw(f.bridge, { method, headers: { Authorization: `Bearer ${f.capability}` } })).status).toBe(405);
  }
  expect((await raw(f.bridge, { method: "GET", headers: { accept: "text/event-stream" } })).status).toBe(401);
  expect((await raw(f.bridge, { method: "DELETE", headers: { "mcp-session-id": "forged" } })).status).toBe(401);
  // Authenticated but forged session ids: the SDK transport refuses without reaching a tool.
  expect((await raw(f.bridge, { method: "DELETE", headers: { Authorization: `Bearer ${f.capability}`, "mcp-session-id": "forged-session" } })).status).toBe(404);
  expect((await raw(f.bridge, { method: "GET", headers: { Authorization: `Bearer ${f.capability}`, accept: "text/event-stream", "mcp-session-id": "forged-session" } })).status).toBe(404);
  const bodies = await Promise.all([post({}), post({ Authorization: "Bearer nope" })].map(async p => (await p).text()));
  expect(bodies.join("\n")).not.toContain(f.capability);
  expect(f.counts.reads).toBe(0);
  expect(f.bridge.invocations()).toHaveLength(0);
  const stats = f.bridge.stats();
  expect(stats.rejected.unauthorized).toBeGreaterThanOrEqual(4);
  expect(stats.rejected.origin).toBe(2);
  expect(stats.rejected.host).toBe(1);
  expect(stats.rejected.method).toBe(4);
  // Oversized bodies are refused before parsing.
  const big = await raw(f.bridge, { method: "POST", body: "x".repeat(2_000_000), headers: { Authorization: `Bearer ${f.capability}`, "content-type": "application/json" } });
  expect(big.status).toBe(413);
});

test("revocation during a held backend read refuses delivery; disposal revokes at the HTTP boundary; close invalidates the capability and cleans only its artifacts", async () => {
  let release!: () => void; const held = new Promise<void>(r => { release = r; });
  const f = await fixture({ slowRead: () => held });
  const client = await httpClient(f.bridge, f.capability);
  const pending = client.callTool({ name: "foundry_memory", arguments: { id: "own-omitted" } });
  await Bun.sleep(20);
  f.owner.dispose();
  release();
  const result = await pending.catch(() => ({ isError: true, content: [] }));
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain("OWN_OMITTED_FACT");
  // After revocation the HTTP boundary itself refuses further work; the launch file is untouched until close.
  const after = await raw(f.bridge, { method: "POST", body: initializeBody, headers: { Authorization: `Bearer ${f.capability}`, "content-type": "application/json", accept: "application/json, text/event-stream" } });
  expect(after.status).toBe(410);
  expect(existsSync(f.bridge.launchFile)).toBe(true);
  const unrelated = join(f.dir, "unrelated.txt"); writeFileSync(unrelated, "keep");
  await f.bridge.close();
  expect(existsSync(f.bridge.launchDir)).toBe(false);
  expect(existsSync(unrelated)).toBe(true);
  expect(f.bridge.closed).toBe(true);
  await expect(raw(f.bridge, { method: "POST", body: initializeBody, headers: { Authorization: `Bearer ${f.capability}` } })).rejects.toThrow();
});

test("client disconnect is not revocation, not native cancel and not idle proof", async () => {
  const f = await fixture();
  const client = await httpClient(f.bridge, f.capability);
  await client.callTool({ name: "foundry_query", arguments: { topic: "CURRENT_OWNER_FACT" } });
  await client.close();
  expect(f.owner.disposed).toBe(false);
  const again = await httpClient(f.bridge, f.capability);
  expect(text(await again.callTool({ name: "foundry_query", arguments: { topic: "CURRENT_OWNER_FACT", detail: "full" } }))).toContain("CURRENT_OWNER_FACT");
});

test("launch file validation: symlink, loose mode, malformed shape, remote endpoint and redirects are refused; partial setup leaves nothing behind", async () => {
  const f = await fixture();
  const good = readLaunchFile(f.bridge.launchFile);
  expect(good.endpoint).toBe(f.bridge.endpoint);
  const link = join(f.dir, "link.json"); symlinkSync(f.bridge.launchFile, link);
  expect(() => readLaunchFile(link)).toThrow(/symlink|ELOOP|not a regular file/i);
  const loose = join(f.dir, "loose.json"); writeFileSync(loose, readFileSync(f.bridge.launchFile)); chmodSync(loose, 0o644);
  expect(() => readLaunchFile(loose)).toThrow(/mode/i);
  const malformed = join(f.dir, "malformed.json"); writeFileSync(malformed, "{not json", { mode: 0o600 });
  expect(() => readLaunchFile(malformed)).toThrow();
  const remote = join(f.dir, "remote.json"); writeFileSync(remote, JSON.stringify({ ...good, endpoint: "http://example.com:8080/mcp" }), { mode: 0o600 });
  expect(() => readLaunchFile(remote)).toThrow(/loopback|127\.0\.0\.1/);
  const https = join(f.dir, "https.json"); writeFileSync(https, JSON.stringify({ ...good, endpoint: "https://127.0.0.1:1/mcp" }), { mode: 0o600 });
  expect(() => readLaunchFile(https)).toThrow();
  // Redirect refusal: a loopback redirector pointing at a sink must never see the capability forwarded.
  let sinkHits = 0; let redirectorAuth: string | null = null;
  const sink = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { sinkHits++; return new Response("sink"); } });
  const redirector = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { redirectorAuth = req.headers.get("authorization"); return Response.redirect(`http://127.0.0.1:${sink.port}/mcp`, 307); } });
  cleanups.push(() => { sink.stop(true); redirector.stop(true); });
  const redirected = join(f.dir, "redirect.json");
  writeFileSync(redirected, JSON.stringify({ ...good, endpoint: `http://127.0.0.1:${redirector.port}/mcp` }), { mode: 0o600 });
  await expect(runProxy(redirected, { connectOnly: true })).rejects.toThrow(/redirect/i);
  expect(sinkHits).toBe(0);
  expect(redirectorAuth).not.toBeNull();
  // Partial setup: an unwritable launch root fails creation and leaves no listener or directory.
  const blocked = join(f.dir, "blocked"); writeFileSync(blocked, "file-not-dir");
  await expect(createLiveBridge({ createMcp: () => createFoundryMcp({ thread: f.owner, sessionManager: f.manager }), launchRoot: blocked })).rejects.toThrow();
});

const initializeMessage = (id: number) => ({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "lifecycle", version: "1" } } });

async function lifecycleFixture(hooks: { holdFirstConnect?: boolean; rejectFirstConnect?: boolean; maxSessions?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "foundry-t2-life-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const layer = new ContextLayer({ id: "controlled" }); layer.set("LIFECYCLE_FACT");
  const owner = new Thread("life-owner", new ContextStack([layer])); owner.meta.projectId = "project-L";
  cleanups.push(() => owner.dispose());
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const firstEntered = new Promise<void>(r => { entered = r; });
  const counts = { created: 0, closedServers: 0 };
  const bridge = await createLiveBridge({ maxSessions: hooks.maxSessions ?? 1, launchRoot: dir, createMcp: () => {
    const mcp = createFoundryMcp({ thread: owner });
    counts.created++;
    mcp.server.server.onclose = () => { counts.closedServers++; };
    if (counts.created === 1 && (hooks.holdFirstConnect || hooks.rejectFirstConnect)) {
      const connect = mcp.server.connect.bind(mcp.server);
      mcp.server.connect = async transport => { entered(); await held; if (hooks.rejectFirstConnect) throw new Error("CONTROLLED_CONNECT_REJECTION"); await connect(transport); };
    }
    return mcp;
  } });
  cleanups.push(() => { release(); return bridge.close(); });
  const capability = readLaunchFile(bridge.launchFile).capability;
  const post = (body: unknown, extra: Record<string, string> = {}) => fetch(bridge.endpoint, { method: "POST", signal: AbortSignal.timeout(4000),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${capability}`, ...extra }, body: JSON.stringify(body) });
  const terminate = (sessionId: string) => fetch(bridge.endpoint, { method: "DELETE", headers: { authorization: `Bearer ${capability}`, "mcp-session-id": sessionId } });
  return { bridge, owner, post, terminate, release, firstEntered, counts, capability };
}

test("reservation: a held initialize blocks a second at maxSessions=1, releases exactly once, and a terminated session frees capacity while its records are retained", async () => {
  const f = await lifecycleFixture({ holdFirstConnect: true });
  const first = f.post(initializeMessage(1));
  await f.firstEntered;
  expect(f.bridge.stats().pendingInitializations).toBe(1);
  expect((await f.post(initializeMessage(2))).status).toBe(429);
  expect(f.counts.created).toBe(1);
  f.release();
  const ok = await first;
  expect(ok.status).toBe(200);
  const sessionId = ok.headers.get("mcp-session-id")!;
  expect(sessionId).toBeTruthy();
  expect(f.bridge.stats()).toMatchObject({ sessions: 1, pendingInitializations: 0, liveServers: 1 });
  expect((await f.post(initializeMessage(3))).status).toBe(429); // still full: reservation converted, not double-counted or leaked
  const call = await f.post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "foundry_query", arguments: { topic: "LIFECYCLE_FACT", detail: "full" } } }, { "mcp-session-id": sessionId });
  expect(call.status).toBe(200);
  await Bun.sleep(20);
  const before = f.bridge.invocations();
  expect(before).toHaveLength(1);
  expect((await f.terminate(sessionId)).status).toBeLessThan(300);
  await Bun.sleep(20);
  expect(f.bridge.stats()).toMatchObject({ sessions: 0, liveServers: 0 });
  expect(f.counts.closedServers).toBe(1);
  expect(f.bridge.invocations()).toEqual(before); // evidence retained after the live server is gone
  expect((await f.post(initializeMessage(5))).status).toBe(200); // capacity freed exactly once
  expect(f.counts.created).toBe(2);
});

test("a rejected connection during initialize releases its reservation, closes its server and does not block the next admission", async () => {
  const f = await lifecycleFixture({ rejectFirstConnect: true });
  const first = f.post(initializeMessage(1));
  await f.firstEntered;
  expect((await f.post(initializeMessage(2))).status).toBe(429);
  f.release();
  const failed = await first;
  expect(failed.status).toBeGreaterThanOrEqual(500);
  expect(await failed.text()).not.toContain("CONTROLLED_CONNECT_REJECTION"); // internal detail not reflected
  // A server whose connection was rejected never connected a transport, so the SDK's
  // protocol-level onclose does not fire; the bridge's own release accounting must.
  expect(f.bridge.stats()).toMatchObject({ sessions: 0, pendingInitializations: 0, liveServers: 0, serversClosed: 1 });
  expect((await f.post(initializeMessage(3))).status).toBe(200);
});

test("bridge close during an outstanding initialize: the late initialization cannot escape the completed close", async () => {
  const f = await lifecycleFixture({ holdFirstConnect: true });
  const first = f.post(initializeMessage(1)).catch(() => undefined);
  await f.firstEntered;
  const closing = f.bridge.close();
  await Bun.sleep(10);
  f.release();
  await closing;
  const late = await first;
  if (late) expect(late.status).toBeGreaterThanOrEqual(400);
  expect(f.bridge.closed).toBe(true);
  expect(f.bridge.stats()).toMatchObject({ sessions: 0, liveServers: 0, pendingInitializations: 0 });
  expect(f.counts.closedServers).toBe(f.counts.created);
  expect(existsSync(f.bridge.launchDir)).toBe(false);
});

test("owner revocation during an outstanding initialize refuses the session and closes its server", async () => {
  const f = await lifecycleFixture({ holdFirstConnect: true });
  const first = f.post(initializeMessage(1));
  await f.firstEntered;
  f.owner.meta.projectId = "project-M";
  f.release();
  const response = await first;
  expect(response.status).toBe(410);
  expect(f.bridge.stats()).toMatchObject({ sessions: 0, liveServers: 0, pendingInitializations: 0 });
  expect(f.counts.closedServers).toBe(f.counts.created);
});

test("repeated failed initializations and explicit terminations never accumulate live servers", async () => {
  const f = await lifecycleFixture({ maxSessions: 2 });
  for (let i = 0; i < 4; i++) {
    const bad = await f.post({ jsonrpc: "2.0", id: i, method: "initialize", params: null });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  }
  expect(f.bridge.stats()).toMatchObject({ sessions: 0, liveServers: 0 });
  expect(f.counts.closedServers).toBe(f.counts.created);
  for (let i = 0; i < 3; i++) {
    const ok = await f.post(initializeMessage(10 + i));
    expect(ok.status).toBe(200);
    expect((await f.terminate(ok.headers.get("mcp-session-id")!)).status).toBeLessThan(300);
    await Bun.sleep(10);
  }
  expect(f.bridge.stats()).toMatchObject({ sessions: 0, liveServers: 0 });
  expect(f.counts.closedServers).toBe(f.counts.created);
});

test("proxy sessions are terminated on connect-only verification, on normal close, and when a real stdio proxy subprocess shuts down", async () => {
  const f = await fixture();
  // Session bookkeeping lands in the transport's initialization callback, which can
  // settle a tick after a connect resolves; observe counts with a bounded poll.
  const sessionsSettleTo = async (expected: number) => {
    for (let i = 0; i < 100 && f.bridge.stats().sessions !== expected; i++) await Bun.sleep(10);
    expect(f.bridge.stats().sessions).toBe(expected);
  };
  await runProxy(f.bridge.launchFile, { connectOnly: true });
  await sessionsSettleTo(0);
  const running = await runProxy(f.bridge.launchFile, { stdin: new (await import("node:stream")).PassThrough(), stdout: new (await import("node:stream")).PassThrough() });
  await sessionsSettleTo(1);
  await running.close();
  await running.close(); // idempotent
  await sessionsSettleTo(0);
  const transport = new StdioClientTransport({ command: "bun", args: [PROXY, f.bridge.launchFile], stderr: "pipe" });
  const client = new Client({ name: "shutdown", version: "1.0.0" });
  await client.connect(transport);
  expect(text(await client.callTool({ name: "foundry_query", arguments: { topic: "CURRENT_OWNER_FACT", detail: "full" } }))).toContain("CURRENT_OWNER_FACT");
  await sessionsSettleTo(1);
  await client.close(); // closes the subprocess stdin; the proxy must terminate its bridge session and exit
  await sessionsSettleTo(0);
  expect(f.owner.disposed).toBe(false); // disconnect is not revocation, cancel or idle proof
}, 20_000);

async function lateFixture(observer?: (record: unknown) => void) {
  let release!: () => void; let entered = 0; let signalEntered!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const enteredOnce = new Promise<void>(r => { signalEntered = r; });
  const f = await fixture({ slowRead: async () => { entered++; signalEntered(); await held; } });
  const bridge = observer
    ? await createLiveBridge({ launchRoot: f.dir, createMcp: () => createFoundryMcp({ thread: f.owner, sessionManager: f.manager, tools: f.tools, onInvocation: observer }) })
    : f.bridge;
  const capability = bridge === f.bridge ? f.capability : (JSON.parse(readFileSync(bridge.launchFile, "utf8")).capability as string);
  return { ...f, bridge, capability, release, enteredOnce, entered: () => entered };
}

test("late owned evidence after SDK termination is retained as ok with its original owner and session; returned snapshots stay immutable", async () => {
  const f = await lateFixture();
  const transport = new StreamableHTTPClientTransport(new URL(f.bridge.endpoint), { requestInit: { headers: { Authorization: `Bearer ${f.capability}` } } });
  const client = new Client({ name: "late", version: "1" }); await client.connect(transport);
  cleanups.push(() => client.close());
  const call = client.callTool({ name: "foundry_memory", arguments: { id: "own-omitted" } }).catch(() => undefined);
  await f.enteredOnce;
  const before = f.bridge.invocations();
  const beforeJson = JSON.stringify(before);
  await transport.terminateSession();
  expect(f.bridge.stats()).toMatchObject({ sessions: 0, liveServers: 0 });
  f.release();
  // The SDK client only settles the orphaned call when it closes (cleanup); the
  // server-side record is the evidence, so poll for it rather than awaiting the call.
  void call;
  for (let i = 0; i < 100 && f.bridge.invocations().length === 0; i++) await Bun.sleep(10);
  const after = f.bridge.invocations();
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ operation: "foundry_memory", status: "ok", owner: { threadId: "owner", projectId: "project-A" }, nativeCorrelation: "unknown" });
  expect(after[0].sdkSessionId).toBeTruthy();
  expect(Object.isFrozen(after[0]) && Object.isFrozen(after[0].owner)).toBe(true);
  expect(JSON.stringify(before)).toBe(beforeJson);
  expect(before).toHaveLength(0);
  expect(f.bridge.invocations()).toHaveLength(1); // exact once
});

test("late evidence after bridge close is a refusal, retained exactly once, while concurrent held calls each settle and close blocks on none of them", async () => {
  const f = await lateFixture();
  const transport = new StreamableHTTPClientTransport(new URL(f.bridge.endpoint), { requestInit: { headers: { Authorization: `Bearer ${f.capability}` } } });
  const client = new Client({ name: "late-close", version: "1" }); await client.connect(transport);
  cleanups.push(() => client.close());
  const calls = [1, 2, 3].map(() => client.callTool({ name: "foundry_memory", arguments: { id: "own-omitted" } }).catch(() => undefined));
  for (let i = 0; i < 50 && f.entered() < 3; i++) await Bun.sleep(10);
  expect(f.entered()).toBe(3);
  const closeStarted = Date.now();
  await f.bridge.close(); // must not wait for the held backend
  expect(Date.now() - closeStarted).toBeLessThan(1000);
  expect(f.bridge.closed).toBe(true);
  expect(f.bridge.invocations()).toHaveLength(0);
  f.release();
  void calls; // settled by client close in cleanup; the records are the evidence
  for (let i = 0; i < 100 && f.bridge.invocations().length < 3; i++) await Bun.sleep(10);
  const records = f.bridge.invocations();
  expect(records).toHaveLength(3);
  for (const r of records) {
    expect(r.status).toBe("refused");
    expect(r.refusal).toBe("revoked");
    expect(r.owner).toEqual({ threadId: "owner", projectId: "project-A" });
    expect(r.nativeCorrelation).toBe("unknown");
  }
  expect(new Set(records.map(r => r.sdkRequestId)).size).toBe(3);
  expect(f.bridge.stats()).toMatchObject({ sessions: 0, liveServers: 0 });
});

test("an observer that throws on a late record does not lose the record, and retention is bounded without live server accumulation", async () => {
  const f = await lateFixture(() => { throw new Error("CONTROLLED_LATE_OBSERVER"); });
  cleanups.push(() => f.bridge.close());
  const transport = new StreamableHTTPClientTransport(new URL(f.bridge.endpoint), { requestInit: { headers: { Authorization: `Bearer ${f.capability}` } } });
  const client = new Client({ name: "late-observer", version: "1" }); await client.connect(transport);
  cleanups.push(() => client.close());
  const call = client.callTool({ name: "foundry_memory", arguments: { id: "own-omitted" } }).catch(() => undefined);
  await f.enteredOnce;
  await transport.terminateSession();
  f.release();
  void call;
  for (let i = 0; i < 100 && f.bridge.invocations().length === 0; i++) await Bun.sleep(10);
  expect(f.bridge.invocations()).toHaveLength(1);
  expect(f.bridge.invocations()[0].status).toBe("ok");
  expect(JSON.stringify(f.bridge.invocations())).not.toContain("CONTROLLED_LATE_OBSERVER");
  expect(f.bridge.stats()).toMatchObject({ liveServers: 0, retainedRecords: 1, droppedRecords: 0 });
}, 20_000);

async function heldClient(f: Awaited<ReturnType<typeof lateFixture>>, name: string) {
  const transport = new StreamableHTTPClientTransport(new URL(f.bridge.endpoint), { requestInit: { headers: { Authorization: `Bearer ${f.capability}` } } });
  const client = new Client({ name, version: "1" }); await client.connect(transport);
  cleanups.push(() => client.close());
  return { client, transport };
}
const settledRecords = async (bridge: LiveBridge, count: number) => {
  for (let i = 0; i < 100 && bridge.invocations().length < count; i++) await Bun.sleep(10);
  return bridge.invocations();
};

test("bridge close revokes every session authority: a second SDK session's held read settles as refused, never ok", async () => {
  const f = await lateFixture();
  const a = await heldClient(f, "session-a");
  await a.client.callTool({ name: "foundry_query", arguments: { topic: "CURRENT_OWNER_FACT" } }); // primary session used
  const b = await heldClient(f, "session-b");
  expect(f.bridge.stats().sessions).toBe(2);
  const held = b.client.callTool({ name: "foundry_memory", arguments: { id: "own-omitted" } }).catch(() => undefined);
  await f.enteredOnce;
  await f.bridge.close();
  f.release();
  void held;
  const records = await settledRecords(f.bridge, 2);
  const late = records.find(r => r.operation === "foundry_memory");
  expect(late).toBeDefined();
  expect(late!.status).toBe("refused");
  expect(late!.refusal).toBe("revoked");
  expect(late!.owner).toEqual({ threadId: "owner", projectId: "project-A" });
  expect(late!.sdkSessionId).toBeTruthy();
  expect(late!.nativeCorrelation).toBe("unknown");
  expect(JSON.stringify(late)).not.toContain("OWN_OMITTED_FACT");
});

test("SDK DELETE followed by bridge close with the read still held: the late record is refused as revoked, not ok", async () => {
  const f = await lateFixture();
  const b = await heldClient(f, "session-delete-then-close");
  const held = b.client.callTool({ name: "foundry_memory", arguments: { id: "own-omitted" } }).catch(() => undefined);
  await f.enteredOnce;
  await b.transport.terminateSession(); // transport gone, backend still pending, bridge still open
  expect(f.bridge.stats()).toMatchObject({ sessions: 0, liveServers: 0 });
  await f.bridge.close();
  f.release();
  void held;
  const [late] = await settledRecords(f.bridge, 1);
  expect(late).toMatchObject({ operation: "foundry_memory", status: "refused", refusal: "revoked", owner: { threadId: "owner", projectId: "project-A" } });
});

test("a primary held read while another initialization delays close is still refused after close completes", async () => {
  let releaseConnect!: () => void; let connectEntered!: () => void;
  const connectHeld = new Promise<void>(r => { releaseConnect = r; });
  const connectStarted = new Promise<void>(r => { connectEntered = r; });
  let release!: () => void; let signalEntered!: () => void;
  const readHeld = new Promise<void>(r => { release = r; });
  const readEntered = new Promise<void>(r => { signalEntered = r; });
  const base = await fixture({ slowRead: async () => { signalEntered(); await readHeld; } });
  let created = 0;
  const bridge = await createLiveBridge({ launchRoot: base.dir, createMcp: () => {
    const mcp = createFoundryMcp({ thread: base.owner, sessionManager: base.manager, tools: base.tools });
    created++;
    if (created === 2) { const connect = mcp.server.connect.bind(mcp.server); mcp.server.connect = async t => { connectEntered(); await connectHeld; await connect(t); }; }
    return mcp;
  } });
  cleanups.push(() => { releaseConnect(); release(); return bridge.close(); });
  const capability = JSON.parse(readFileSync(bridge.launchFile, "utf8")).capability as string;
  const transport = new StreamableHTTPClientTransport(new URL(bridge.endpoint), { requestInit: { headers: { Authorization: `Bearer ${capability}` } } });
  const primary = new Client({ name: "primary", version: "1" }); await primary.connect(transport);
  cleanups.push(() => primary.close());
  const held = primary.callTool({ name: "foundry_memory", arguments: { id: "own-omitted" } }).catch(() => undefined);
  await readEntered;
  const second = fetch(bridge.endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${capability}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "second", version: "1" } } }) }).catch(() => undefined);
  await connectStarted;
  const closing = bridge.close();
  await Bun.sleep(30);
  expect(bridge.closed).toBe(true); // latched at entry, before the delayed initialization settles
  releaseConnect();
  await closing;
  const late = await second;
  if (late) expect(late.status).toBeGreaterThanOrEqual(400);
  release();
  void held;
  const [record] = await settledRecords(bridge, 1);
  expect(record).toMatchObject({ operation: "foundry_memory", status: "refused", refusal: "revoked" });
  expect(bridge.stats()).toMatchObject({ sessions: 0, liveServers: 0, pendingInitializations: 0 });
});

test("a factory that returns a foreign thread's server is refused, closed and accounted, and never adopted", async () => {
  const f = await fixture();
  const foreign = new Thread("foreign-owner", new ContextStack([new ContextLayer({ id: "x" })])); foreign.meta.projectId = "project-B";
  cleanups.push(() => foreign.dispose());
  let created = 0; let closedForeign = 0;
  const bridge = await createLiveBridge({ launchRoot: f.dir, maxSessions: 2, createMcp: () => {
    created++;
    if (created === 2) { const bad = createFoundryMcp({ thread: foreign }); bad.server.server.onclose = () => { closedForeign++; }; return bad; }
    return createFoundryMcp({ thread: f.owner, sessionManager: f.manager, tools: f.tools });
  } });
  cleanups.push(() => bridge.close());
  const capability = JSON.parse(readFileSync(bridge.launchFile, "utf8")).capability as string;
  const init = (id: number) => fetch(bridge.endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${capability}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } } }) });
  expect((await init(1)).status).toBe(200);
  const refused = await init(2);
  expect(refused.status).toBe(500);
  expect(await refused.text()).not.toMatch(/foreign-owner|project-B/);
  const stats = bridge.stats();
  // Two servers created so far: the primary and the refused foreign allocation.
  expect(stats).toMatchObject({ sessions: 1, liveServers: 1, pendingInitializations: 0, serversCreated: 2, serversClosed: 1 });
  expect(stats.rejected.connect).toBe(1);
  expect((await init(3)).status).toBe(200); // a later valid allocation is admitted; the foreign one was not adopted
  expect(bridge.stats().serversCreated).toBe(3);
  expect(JSON.stringify(bridge.invocations())).not.toContain("foreign-owner");
});

test("the launch descriptor is an owned deep-frozen snapshot whose serialized configuration cannot be altered", async () => {
  const f = await fixture();
  const d = f.bridge.launch;
  expect(Object.isFrozen(d.claude.mcpConfig)).toBe(true);
  expect(Object.isFrozen(d.claude.mcpConfig.mcpServers)).toBe(true);
  expect(Object.isFrozen(d.claude.mcpConfig.mcpServers.foundry)).toBe(true);
  expect(Object.isFrozen(d.claude.mcpConfig.mcpServers.foundry.args)).toBe(true);
  const before = d.claude.mcpConfigJson;
  try { (d.claude.mcpConfig.mcpServers as any).evil = { command: "sh" }; } catch {}
  try { (d.claude.mcpConfig.mcpServers.foundry.args as any).push("--evil"); } catch {}
  expect(JSON.stringify(d.claude.mcpConfig)).toBe(before);
  expect(d.claude.mcpConfigJson).toBe(before);
  expect(before).not.toContain(f.capability);
});

function observedThread(id: string, projectId: string, fact: string) {
  const layer = new ContextLayer({ id: "memory-conventions" }); layer.set(fact);
  const thread = new Thread(id, new ContextStack([layer])); thread.meta.projectId = projectId;
  cleanups.push(() => thread.dispose());
  let hooks = 0;
  const original = thread.onDispose.bind(thread);
  thread.onDispose = callback => {
    hooks++; let active = true;
    const finish = () => { if (active) { active = false; hooks--; } };
    const off = original(() => { finish(); callback(); });
    return () => { finish(); off(); };
  };
  return { thread, hooks: () => hooks };
}

test("SDK session churn leaves no disposal hooks, while detached authorities still refuse disposal, replacement and project changes on late reads", async () => {
  const owner = observedThread("churn-owner", "project-A", "CHURN_FACT");
  const manager = new SessionManager(); manager.add(owner.thread);
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const readEntered = new Promise<void>(r => { entered = r; });
  const backing = new FileMemory(mkdtempSync(join(tmpdir(), "foundry-t2-churn-")));
  await backing.write({ id: "own", kind: "observation", content: "CHURN_OWN_RECORD", timestamp: 1, owner: { threadId: "churn-owner", projectId: "project-A" }, visibility: "thread" });
  const tools = new ToolRegistry();
  tools.register(MemoryToolAdapter.from("slow", { write: e => backing.write(e), get: id => backing.get(id), search: q => backing.search(q), view: (scope: any) => {
    const v = backing.view(scope); return { write: e => v.write(e), get: async id => { entered(); await held; return v.get(id); }, search: (q, l) => v.search(q, l) };
  } }), "Slow memory");
  const bridge = await createLiveBridge({ launchRoot: mkdtempSync(join(tmpdir(), "foundry-t2-churn-launch-")), createMcp: () => createFoundryMcp({ thread: owner.thread, sessionManager: manager, tools }) });
  cleanups.push(() => { release(); return bridge.close(); });
  expect(owner.hooks()).toBe(1); // the primary authority's single hook
  for (let i = 0; i < 3; i++) { await runProxy(bridge.launchFile, { connectOnly: true }); }
  for (let i = 0; i < 100 && bridge.stats().sessions > 0; i++) await Bun.sleep(10);
  expect(bridge.stats()).toMatchObject({ sessions: 0, liveServers: 0 });
  expect(owner.hooks()).toBe(0); // primary consumed and released by the first session; churned sessions detached theirs
  // A detached authority keeps its live checks: hold a read, terminate the session, change the project, release.
  const capability = JSON.parse(readFileSync(bridge.launchFile, "utf8")).capability as string;
  const transport = new StreamableHTTPClientTransport(new URL(bridge.endpoint), { requestInit: { headers: { Authorization: `Bearer ${capability}` } } });
  const client = new Client({ name: "late-after-detach", version: "1" }); await client.connect(transport);
  cleanups.push(() => client.close());
  const call = client.callTool({ name: "foundry_memory", arguments: { id: "own" } }).catch(() => undefined);
  await readEntered;
  await transport.terminateSession();
  expect(owner.hooks()).toBe(0);
  owner.thread.meta.projectId = "project-Z"; // actual project change after the hook was detached
  release();
  void call;
  for (let i = 0; i < 100 && bridge.invocations().length === 0; i++) await Bun.sleep(10);
  const [record] = bridge.invocations();
  expect(record).toMatchObject({ operation: "foundry_memory", status: "refused", refusal: "project-changed" });
  expect(JSON.stringify(record)).not.toContain("CHURN_OWN_RECORD");
  await bridge.close();
  expect(owner.hooks()).toBe(0);
  expect(owner.thread.disposed).toBe(false);
});

test("cleanup accounting: a held or rejected server close is never reported completed early, is retained until it settles, and never blocks a bounded bridge close", async () => {
  const f = await fixture();
  const foreign = new Thread("foreign-alloc", new ContextStack([new ContextLayer({ id: "x" })])); foreign.meta.projectId = "project-B";
  cleanups.push(() => foreign.dispose());
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const closing = new Promise<void>(r => { entered = r; });
  let created = 0; let completed = 0;
  const bridge = await createLiveBridge({ launchRoot: f.dir, maxSessions: 4, createMcp: () => {
    const current = ++created;
    const mcp = createFoundryMcp({ thread: current === 2 || current === 3 ? foreign : f.owner, sessionManager: manager(f), tools: f.tools });
    const original = mcp.server.close.bind(mcp.server);
    if (current === 2) mcp.server.close = async () => { entered(); await held; await original(); completed++; };
    if (current === 3) mcp.server.close = async () => { throw new Error("CONTROLLED_CLOSE_REJECTION"); };
    return mcp;
  } });
  cleanups.push(() => { release(); return bridge.close(); });
  const capability = JSON.parse(readFileSync(bridge.launchFile, "utf8")).capability as string;
  const init = (id: number) => fetch(bridge.endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${capability}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } } }) });
  expect((await init(1)).status).toBe(200);
  const refusedHeld = init(2);
  await closing;
  // Held close: requested, not completed.
  expect(bridge.stats()).toMatchObject({ serversCreated: 2, serversClosed: 0, pendingCleanups: 1, cleanupFailures: 0 });
  expect((await refusedHeld).status).toBe(500);
  expect(bridge.stats().serversClosed).toBe(completed);
  // Rejected close: counted as a cleanup failure, never as a completed close.
  expect((await init(3)).status).toBe(500);
  for (let i = 0; i < 50 && bridge.stats().cleanupFailures === 0; i++) await Bun.sleep(10);
  expect(bridge.stats()).toMatchObject({ serversCreated: 3, serversClosed: 0, cleanupFailures: 1, pendingCleanups: 1 });
  release();
  for (let i = 0; i < 100 && bridge.stats().pendingCleanups > 0; i++) await Bun.sleep(10);
  expect(completed).toBe(1);
  expect(bridge.stats()).toMatchObject({ serversClosed: 1, pendingCleanups: 0, cleanupFailures: 1 });
  const started = Date.now();
  await bridge.close(); // live primary released; nothing left pending
  expect(Date.now() - started).toBeLessThan(2000);
  expect(bridge.stats()).toMatchObject({ liveServers: 0, pendingCleanups: 0, serversClosed: 2 });
});
const manager = (f: Awaited<ReturnType<typeof fixture>>) => f.manager;

test("a proxy given a wrong capability or an unusable launch file exits without serving tools and without printing the launch contents", async () => {
  const f = await fixture();
  const wrong = join(f.dir, "wrong.json");
  writeFileSync(wrong, JSON.stringify({ ...readLaunchFile(f.bridge.launchFile), capability: "b".repeat(43) }), { mode: 0o600 });
  const proc = Bun.spawn(["bun", PROXY, wrong], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(code).not.toBe(0);
  expect(err).not.toContain("b".repeat(43));
  expect(err).not.toContain(f.capability);
  expect(f.counts.reads).toBe(0);
  const missing = Bun.spawn(["bun", PROXY, join(f.dir, "does-not-exist.json")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  expect(await missing.exited).not.toBe(0);
});
