import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { ContextStack, Thread, type NativeEvidence } from "@inixiative/foundry-core";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { starterConfig } from "../src/viewer/config";
import { fixtureBridgeSource, type FixtureRequest, type FixtureResult } from "../src/mcp/fixture-bridge";

const req = createRequire(new URL("../package.json", import.meta.url));
const { Client } = await import(req.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StdioClientTransport } = await import(req.resolve("@modelcontextprotocol/sdk/client/stdio.js"));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const parse = (response: any) => JSON.parse(response.content[0].text);

async function fixture(options: { result?: (request: Readonly<FixtureRequest>) => Promise<FixtureResult>; deadlineMs?: number; persistenceFailure?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fixture-bridge-"));
  const thread = new Thread("fixture-owner", new ContextStack([]), { projectId: "P" });
  const runtime = new ThreadRuntimeManager({ config: starterConfig("fake", "fake"), domains: [],
    llm: { id: "fake", async complete() { throw Error("No model calls"); } }, log() {}, warn() {} });
  runtime.attach(thread);
  let executions = 0;
  const requests: Readonly<FixtureRequest>[] = [];
  const bridge = fixtureBridgeSource({ thread, runtime, launchRoot: root,
    descriptor: { armId: crypto.randomUUID(), inventoryHash: "a".repeat(64), image: `sha256:${"b".repeat(64)}`, maxCalls: 5, timeoutMs: 1000, deadlineAt: Date.now() + (options.deadlineMs ?? 30000) },
    journal: record => ({ record, persistence: options.persistenceFailure ? "failed" : "committed", publication: "published" }),
    async invoke(request) {
      requests.push(request);
      if (await bridge.authorize(request) !== "allow") return { id: request.id, status: "denied" };
      executions++;
      return options.result ? options.result(request) : { id: request.id, status: "completed", output: "ARM-PRIVATE-RESULT", exitCode: 0 };
    },
  });
  const lease = await bridge.source.acquire();
  const launch = JSON.parse(lease.launch.claudeJson).mcpServers[lease.name];
  const client = new Client({ name: "controlled-fixture", version: "1" });
  await client.connect(new StdioClientTransport({ command: launch.command, args: launch.args, stderr: "pipe" }));
  cleanups.push(async () => { await client.close(); await lease.close(); runtime.disposeAll(); rmSync(root, { recursive: true, force: true }); });
  const admit = (id = "admission-1"): NativeEvidence => {
    const evidence: NativeEvidence = { schema: 1, admissionId: id, nativeOutcome: "unknown", localOutcome: "pending", dispatch: "not-dispatched",
      owner: { threadId: thread.id, projectId: "P", generation: runtime.get(thread.id)!.generation, dispatchId: `dispatch-${id}`, providerSessionKey: thread.id } };
    lease.register(evidence); return evidence;
  };
  return { bridge, lease, client, thread, runtime, admit, requests, executions: () => executions };
}

test("actual MCP surface exposes only fixed fixture operations; admission and strict inputs precede execution", async () => {
  const f = await fixture();
  expect((await f.client.listTools()).tools.map((tool: any) => tool.name).sort()).toEqual(["fixture_command", "fixture_read", "fixture_write"]);
  expect(readdirSync(f.lease.fixtureCwd!)).toEqual([]);
  const unowned = parse(await f.client.callTool({ name: "fixture_read", arguments: { path: "input.ts" } }));
  expect(unowned).toMatchObject({ status: "refused", dispatched: false });
  expect(unowned.id).toMatch(/^[a-f0-9-]{36}$/); expect(unowned.sdkRequestId).toBeDefined();
  const admitted = f.admit();
  for (const call of [
    { name: "foundry_device", arguments: {} },
    { name: "fixture_read", arguments: { path: "input.ts", host: "/private/profile" } },
    { name: "fixture_read", arguments: { path: "../outside" } },
    { name: "fixture_command", arguments: { command: "echo fixture", image: "untrusted" } },
  ]) expect(parse(await f.client.callTool(call))).toMatchObject({ status: "refused", dispatched: false });
  expect(f.executions()).toBe(0);
  const response = parse(await f.client.callTool({ name: "fixture_read", arguments: { path: "input.ts" } }));
  expect(response.status).toBe("ok"); expect(response.result).toContain("ARM-PRIVATE-RESULT");
  expect(f.executions()).toBe(1);
  const evidence = f.lease.evidence(admitted.admissionId).at(-1)!;
  expect(evidence.record.id).toBe(response.id);
  expect(evidence.record.association.owner).toEqual(admitted.owner);
  expect(evidence.record.nativeCorrelation).toBe("unknown");
  expect(await f.bridge.authorize(f.requests[0])).toBe("deny");
  await expect(f.bridge.source.acquire()).rejects.toThrow("fresh arm");
});

test("foreign generation and settlement cannot replace fixture authority", async () => {
  const f = await fixture(), original = f.admit();
  expect(() => f.bridge.source.check({ ...original.owner!, generation: "foreign" })).toThrow("mismatch");
  f.lease.observe({ ...original, owner: { ...original.owner!, dispatchId: "foreign" }, nativeOutcome: "completed" });
  expect(() => f.admit("second")).toThrow("refused");
  f.lease.observe({ ...original, nativeOutcome: "completed" });
  expect(() => f.lease.register(original)).toThrow("refused");
  f.admit("second");
  expect(parse(await f.client.callTool({ name: "fixture_write", arguments: { path: "new.ts", content: "fixture" } })).status).toBe("ok");
  expect(f.executions()).toBe(1);
});

test("late broker output keeps original ownership and cannot expose data after settlement", async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture({ result: async request => { entered(); await held; return { id: request.id, status: "completed", output: "MUST-NOT-DELIVER" }; } });
  const original = f.admit();
  const pending = f.client.callTool({ name: "fixture_command", arguments: { command: "echo fixture" } });
  await started;
  f.lease.observe({ ...original, nativeOutcome: "completed" });
  expect(() => f.admit("successor")).toThrow("refused");
  release();
  const response = parse(await pending);
  expect(response).toMatchObject({ status: "error", dispatched: true });
  expect(JSON.stringify(response)).not.toContain("MUST-NOT-DELIVER");
  expect(f.lease.evidence()[0].record.association.owner).toEqual(original.owner);
  expect(f.lease.status!().closed).toBe(true);
});

test("expired tool admission returns identity and executes nothing", async () => {
  const f = await fixture({ deadlineMs: 1000 }); f.admit();
  await Bun.sleep(1000);
  const response = parse(await f.client.callTool({ name: "fixture_read", arguments: { path: "input.ts" } }));
  expect(response).toMatchObject({ status: "refused", dispatched: false });
  expect(response.sdkRequestId).toBeDefined(); expect(f.executions()).toBe(0);
});


test("nonthrowing journal failure closes admission and withholds an unjournaled response", async () => {
  const f = await fixture({ persistenceFailure: true }); f.admit();
  const result = parse(await f.client.callTool({ name: "fixture_read", arguments: { path: "input.ts" } }));
  expect(result).toMatchObject({ status: "error", dispatched: true, reason: "journal-unavailable" });
  expect(JSON.stringify(result)).not.toContain("ARM-PRIVATE-RESULT");
  expect(f.lease.status!().closed).toBe(true);
  await f.client.callTool({ name: "fixture_command", arguments: { command: "echo later" } });
  expect(f.executions()).toBe(1);
  expect(f.lease.evidence()[0].persistence).toBe("failed");
});

test("disposal during acquisition closes transport and private directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "fixture-acquire-race-"));
  const thread = new Thread("race", new ContextStack([]));
  const runtime = new ThreadRuntimeManager({ config: starterConfig("fake", "fake"), domains: [], llm: { id: "fake", async complete() { throw Error("No model"); } }, log() {}, warn() {} });
  runtime.attach(thread);
  const f = fixtureBridgeSource({ thread, runtime, launchRoot: root,
    descriptor: { armId: crypto.randomUUID(), inventoryHash: "a".repeat(64), image: `sha256:${"b".repeat(64)}`, maxCalls: 1, timeoutMs: 1000, deadlineAt: Date.now() + 10000 },
    invoke: async request => ({ id: request.id, status: "denied" }), journal: record => ({ record, persistence: "committed", publication: "published" }) });
  try {
    const pending = f.source.acquire(); thread.dispose();
    await expect(pending).rejects.toThrow("revoked");
    expect(readdirSync(root)).toEqual([]);
  } finally { runtime.disposeAll(); rmSync(root, { recursive: true, force: true }); }
});
