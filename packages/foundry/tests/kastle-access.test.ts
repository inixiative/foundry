import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { ContextStack, Thread, ToolRegistry } from "@inixiative/foundry-core";
import { registerKastleAccess } from "../src/tools/kastle-access";
import { type KastleAccessSource } from "../src/providers/kastle-access-client";
import { defaultConfig, ConfigStore, validateConfig } from "../src/viewer/config";
import { inspectReadiness } from "../src/readiness";
import { createFoundryMcp } from "../src/mcp/server";
import { nativeBridgeSource } from "../src/mcp/native-bridge";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { LocalSessionStore } from "../src/persistence/local-session-store";

const require = createRequire(new URL("../package.json", import.meta.url));
const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { InMemoryTransport } = await import(require.resolve("@modelcontextprotocol/sdk/inMemory.js"));
const { StdioClientTransport } = await import(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"));
const projectId = crypto.randomUUID(), otherProjectId = crypto.randomUUID();
const scope = { projectId, threadId: crypto.randomUUID() };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "foundry-access-"));
  const secret = `kastle_${"x".repeat(43)}`, credentialFile = join(directory, "access.json");
  await writeFile(credentialFile, JSON.stringify({ secret }), { mode: 0o600 });
  const connectionId = crypto.randomUUID(), signetId = crypto.randomUUID(), resourceId = crypto.randomUUID();
  const requests: Array<{ action: string; body: any; authorized: boolean }> = [];
  let revoked = false, wrongGrant = false, oversize = false, redirect = false, failExecution = false;
  let onExecute: (() => Promise<void>) | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const action = new URL(request.url).pathname.split("/").at(-1)!;
    requests.push({ action, body: await request.json(), authorized: request.headers.get("authorization") === `Bearer ${secret}` });
    if (redirect) return Response.redirect("http://127.0.0.1:1/credential-trap");
    if (revoked) return new Response("PRIVATE_PROVIDER_ERROR", { status: 401 });
    if (oversize) return new Response("x".repeat(1_048_577));
    if (action === "describe") return Response.json({ data: {
      signetId, connectionId: wrongGrant ? crypto.randomUUID() : connectionId, integrationId: crypto.randomUUID(), name: "Team integration",
      expiresAt: new Date(Date.now() + 60000).toISOString(), remainingRequests: 4,
      operations: [{ key: "issues.read", name: "Read issue", resources: [{ id: resourceId, name: "Fixture issue", kind: "issue" }] },
        { key: "issues.write", name: "Write issue", resources: [{ id: resourceId, name: "Fixture issue", kind: "issue" }] }],
    } });
    if (action === "execute") {
      await onExecute?.();
      if (failExecution) return new Response("PRIVATE_UNCERTAIN_BODY", { status: 503 });
      return Response.json({ data: { executionId: crypto.randomUUID(), result: { title: "CONTROLLED_ISSUE" } } });
    }
    return new Response(null, { status: 404 });
  } });
  const source: KastleAccessSource = { id: crypto.randomUUID(), name: "Team issues", connectionId, signetId, credentialFile, url: server.url.origin, projectIds: [projectId] };
  const tools = new ToolRegistry(); registerKastleAccess(tools, [source]);
  const call = (url: string, body: unknown = {}, owner = scope) => tools.dispatch("kastle_request", { url, method: "POST", body }, { scope: owner });
  const read = () => call("read", { accessId: source.id, operation: "issues.read", resourceId });
  return { directory, source, tools, resourceId, requests, call, read,
    state(options: { revoked?: boolean; wrongGrant?: boolean; oversize?: boolean; redirect?: boolean; failExecution?: boolean; onExecute?: () => Promise<void> }) {
      revoked = options.revoked ?? false; wrongGrant = options.wrongGrant ?? false; oversize = options.oversize ?? false;
      redirect = options.redirect ?? false; failExecution = options.failExecution ?? false; onExecute = options.onExecute;
    },
    async close() { server.stop(true); await rm(directory, { recursive: true, force: true }); },
  };
}

test("project discovery exposes only local references; scoped reads retain server execution and UUID attribution", async () => {
  const f = await fixture();
  try {
    const listed = await f.call("connections");
    expect((listed.data as any).body).toEqual([{ id: f.source.id, name: "Team issues", connectionId: f.source.connectionId }]);
    expect(JSON.stringify(listed)).not.toContain(f.source.credentialFile); expect(f.requests).toHaveLength(0);
    const described = await f.call("describe", { accessId: f.source.id });
    expect((described.data as any).body.operations.map((op: any) => op.key)).toEqual(["issues.read"]);
    const read = await f.read(), again = await f.read();
    expect(read.ok).toBe(true); expect((read.data as any).body.result.title).toBe("CONTROLLED_ISSUE");
    const calls = f.requests.filter(request => request.action === "execute");
    expect(calls).toHaveLength(2); expect(calls[0]!.body.runId).toBe(calls[1]!.body.runId);
    expect(calls[0]!.body.requestId).not.toBe(calls[1]!.body.requestId);
    expect((read.data as any).body.requestId).toBe(calls[0]!.body.requestId);
    expect((again.data as any).body.executionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(calls[0]!.body).toMatchObject({ connectionId: f.source.connectionId, signetId: f.source.signetId, input: { resourceId: f.resourceId, limit: 20 } });
    expect(f.requests.every(request => request.authorized)).toBe(true);
  } finally { await f.close(); }
});

test("foreign, missing and model-forged scopes cannot discover or use a grant; callers cannot override transport", async () => {
  const f = await fixture();
  try {
    expect((await f.tools.dispatch("kastle_request", { url: "connections" })).ok).toBe(false);
    const foreign = { ...scope, projectId: otherProjectId };
    expect((await f.call("connections", {}, foreign)).data).toMatchObject({ body: [] });
    expect((await f.call("describe", { accessId: f.source.id }, foreign)).ok).toBe(false);
    for (const input of [
      { url: f.source.url },
      { url: "connections", headers: { authorization: "override" } },
      { url: "read", body: { accessId: f.source.id, operation: "issues.write", resourceId: f.resourceId } },
      { url: "describe", body: { accessId: f.source.id, projectId } },
      { url: "read", body: { accessId: f.source.id, operation: "issues.read", resourceId: f.resourceId, limit: 51 } },
    ]) expect((await f.tools.dispatch("kastle_request", { method: "POST", ...input }, { scope })).ok).toBe(false);
    expect(f.requests).toHaveLength(0);
    registerKastleAccess(f.tools, [{ ...f.source, threadIds: [crypto.randomUUID()] }]);
    expect((await f.call("connections")).data).toMatchObject({ body: [] });
  } finally { await f.close(); }
});

test("authorization is fresh for every read; wrong grants and unknown resources never execute", async () => {
  const f = await fixture();
  try {
    expect((await f.read()).ok).toBe(true);
    f.state({ revoked: true }); expect((await f.read()).ok).toBe(false);
    f.state({ wrongGrant: true }); expect((await f.read()).ok).toBe(false);
    f.state({});
    expect((await f.call("read", { accessId: f.source.id, operation: "issues.read", resourceId: crypto.randomUUID() })).ok).toBe(false);
    expect(f.requests.filter(request => request.action === "execute")).toHaveLength(1);
  } finally { await f.close(); }
});

test("private credentials, response bounds, redirect refusal and uncertain failures never leak or retry", async () => {
  const f = await fixture();
  try {
    await chmod(f.source.credentialFile, 0o644); expect((await f.read()).ok).toBe(false); expect(f.requests).toHaveLength(0);
    await chmod(f.source.credentialFile, 0o600);
    await writeFile(f.source.credentialFile, JSON.stringify({ secret: `kastle_runtime_${"x".repeat(43)}` }));
    expect((await f.read()).ok).toBe(false); expect(f.requests).toHaveLength(0);
    await writeFile(f.source.credentialFile, JSON.stringify({ secret: `kastle_${"x".repeat(43)}` }));
    for (const state of [{ redirect: true }, { oversize: true }, { failExecution: true }]) {
      f.state(state); const failure = await f.read(); expect(failure.ok).toBe(false);
      expect(JSON.stringify(failure)).not.toMatch(/PRIVATE|kastle_x|access\.json|credential-trap/);
    }
    expect(f.requests.filter(request => request.action === "execute")).toHaveLength(1);
  } finally { await f.close(); }
});

test("concurrent thread calls keep distinct owners and stable per-thread UUID run attribution", async () => {
  const f = await fixture();
  try {
    const owners = [scope, { ...scope, threadId: crypto.randomUUID() }];
    const read = (owner: typeof scope) => f.call("read", { accessId: f.source.id, operation: "issues.read", resourceId: f.resourceId }, owner);
    const first = await Promise.all(owners.map(read)), second = await Promise.all(owners.map(read));
    expect(first.every(result => result.ok)).toBe(true); expect(second.every(result => result.ok)).toBe(true);
    const runs = first.map(result => (result.data as any).body.runId);
    expect(new Set(runs).size).toBe(2);
    expect(second.map(result => (result.data as any).body.runId)).toEqual(runs);
  } finally { await f.close(); }
});

test("configuration and doctor validate access independently from inference without making requests", async () => {
  const f = await fixture();
  try {
    const config = defaultConfig(); config.projects[projectId] = { id: projectId, path: "/controlled/project" }; config.kastleAccess = [f.source];
    const store = new ConfigStore(join(f.directory, "state")); await store.save(config);
    expect((await store.load()).kastleAccess).toEqual([f.source]);
    const report = await inspectReadiness(config, { environment: {}, which: () => "/controlled/cli" });
    expect(report.issues.some(issue => issue.code === "integration-access-unverified")).toBe(true); expect(f.requests).toHaveLength(0);
    expect(() => validateConfig({ ...config, kastleAccess: [{ ...f.source, projectIds: [otherProjectId] }] })).toThrow("unavailable project");
    expect(() => validateConfig({ ...config, kastleAccess: [f.source, f.source] })).toThrow("Duplicate");
    expect(() => validateConfig({ ...config, kastleAccess: [{ ...f.source, secret: "inline" } as any] })).toThrow();
  } finally { await f.close(); }
});

test("native SDK tools require admission for reads, journal attribution, and refuse delivery after project reassignment", async () => {
  const f = await fixture();
  const thread = new Thread(scope.threadId, new ContextStack(), { projectId });
  let admitted = false;
  const bridge = createFoundryMcp({ thread, tools: f.tools, captureOperation: () => ({ id: crypto.randomUUID(), bridgeId: crypto.randomUUID(),
    association: admitted ? { kind: "registered-admission-window", admissionId: "controlled-admission", owner: { threadId: thread.id, projectId, generation: "g", messageId: "m", dispatchId: "d" } } : { kind: "unassociated" } }) });
  const client = new Client({ name: "controlled-access", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(serverTransport); await client.connect(clientTransport);
  try {
    expect((await client.listTools()).tools.some((tool: any) => tool.name === "foundry_access")).toBe(true);
    const args = { action: "read", accessId: f.source.id, operation: "issues.read", resourceId: f.resourceId };
    expect((await client.callTool({ name: "foundry_access", arguments: args })).isError).toBe(true); expect(f.requests).toHaveLength(0);
    admitted = true;
    expect(JSON.stringify(await client.callTool({ name: "foundry_access", arguments: args }))).toContain("CONTROLLED_ISSUE");
    const prior = bridge.invocations().at(-1)!;
    expect(prior.capture?.association.admissionId).toBe("controlled-admission");
    expect(prior.result).toContain("executionId"); expect(prior.owner).toEqual(scope);
    f.state({ onExecute: async () => { thread.meta.projectId = otherProjectId; } });
    const refused = await client.callTool({ name: "foundry_access", arguments: args });
    expect(refused.isError).toBe(true); expect(JSON.stringify(refused)).not.toContain("CONTROLLED_ISSUE");
    expect(bridge.invocations().at(-1)?.refusal).toBe("project-changed");
    const count = f.requests.length;
    await client.callTool({ name: "foundry_access", arguments: args }); expect(f.requests).toHaveLength(count);
  } finally { await client.close(); await bridge.server.close(); await f.close(); }
});

test("the native launch bridge transports integration reads and persists their original admission evidence", async () => {
  const f = await fixture();
  const thread = new Thread(scope.threadId, new ContextStack(), { projectId });
  const runtime = new ThreadRuntimeManager({ config: defaultConfig(), domains: [], llm: { id: "controlled", async complete() { throw Error("No model calls"); } }, log() {}, warn() {} });
  runtime.attach(thread);
  const store = new LocalSessionStore(join(f.directory, "sessions.sqlite")); store.saveThread(thread);
  const source = nativeBridgeSource(thread, runtime, f.tools, record => store.persistNativeTool(thread, record, () => true));
  const lease = await source.acquire();
  const launch = JSON.parse(lease.launch.claudeJson).mcpServers[lease.name];
  const client = new Client({ name: "controlled-native-access", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: launch.command, args: launch.args, stderr: "pipe" }));
    const messageId = crypto.randomUUID(); store.beginTurn(thread, messageId, "Read controlled integration");
    const admission = { schema: 1 as const, admissionId: crypto.randomUUID(), nativeOutcome: "unknown" as const, dispatch: "not-dispatched" as const,
      owner: { threadId: thread.id, projectId, generation: runtime.get(thread.id)!.generation, messageId, dispatchId: crypto.randomUUID() } };
    store.registerNative(thread, admission); lease.register(admission);
    const result = await client.callTool({ name: "foundry_access", arguments: { action: "read", accessId: f.source.id, operation: "issues.read", resourceId: f.resourceId } });
    expect(JSON.stringify(result)).toContain("CONTROLLED_ISSUE");
    const records = store.nativeTools(thread.id, messageId);
    expect(records).toHaveLength(1); expect(records[0]!.persistence).toBe("committed");
    expect(records[0]!.record.association.owner).toEqual(admission.owner);
    const delivered = JSON.parse(records[0]!.record.result);
    expect(delivered.requestId).toBe(f.requests.find(request => request.action === "execute")!.body.requestId);
    expect(delivered.executionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(records)).not.toMatch(/kastle_x|access\.json/);
    lease.observe({ ...admission, nativeOutcome: "completed" });
  } finally { await client.close(); await lease.close(); runtime.disposeAll(); store.close(); await f.close(); }
});
