import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, Thread, ToolRegistry, FileMemory, type NativeEvidence, type NativeToolRecord } from "../../../packages/core/src/index";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { starterConfig } from "../../../packages/foundry/src/viewer/config";
import { nativeBridgeSource } from "../../../packages/foundry/src/mcp/native-bridge";
import { readLaunchFile } from "../../../packages/foundry/src/mcp/proxy";
import { MemoryToolAdapter, type MemoryBackend } from "../../../packages/foundry/src/tools/memory-adapter";

const resolve = createRequire(new URL("../../../packages/foundry/package.json", import.meta.url)).resolve;
const { Client } = await import(resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StreamableHTTPClientTransport } = await import(resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"));

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(r => { release = r; });
  return { promise, release };
}

async function fixture(journalFails = false) {
  const dir = await mkdtemp(join(tmpdir(), "foundry-admission-window-"));
  const entered = latch(), held = latch();
  const thread = new Thread("window-owner", new ContextStack([]));
  thread.meta.projectId = "window-project";
  const config = starterConfig("controlled", "controlled");
  const runtime = new ThreadRuntimeManager({ config, domains: [], log() {}, warn() {},
    llm: { id: "controlled", async complete() { throw Error("No model calls allowed in this acceptance fixture"); } } });
  const owned = runtime.attach(thread);
  const memory = new FileMemory(join(dir, "memory"));
  await memory.write({ id: "held", kind: "observation", content: "OWNED_WINDOW_FACT", timestamp: 1,
    owner: { threadId: thread.id, projectId: thread.meta.projectId }, visibility: "thread" });
  const gate = (backend: MemoryBackend): MemoryBackend => ({
    write: entry => backend.write(entry), search: (query, limit) => backend.search(query, limit),
    get: async id => { entered.release(); await held.promise; return backend.get(id); },
    ...(backend.view ? { view: scope => gate(backend.view!(scope)) } : {}),
  });
  const tools = new ToolRegistry();
  tools.register(MemoryToolAdapter.from("file", gate(memory)), "Memory");
  const journal: NativeToolRecord[] = [];
  const source = nativeBridgeSource(thread, runtime, tools, record => {
    if (journalFails) throw Error("CONTROLLED_PRIVATE_JOURNAL_ERROR");
    journal.push(record);
    return { record, persistence: "committed", publication: "published" };
  });
  const bridge = await source.acquire();
  const launch = JSON.parse(bridge.launch.claudeJson).mcpServers[bridge.name];
  const file = readLaunchFile(launch.args.at(-1));
  const client = new Client({ name: "independent-admission-window", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(file.endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${file.capability}` } },
  });
  let call: Promise<Awaited<ReturnType<typeof client.callTool>>> | undefined;
  const evidence = (id: string): NativeEvidence => ({ schema: 1, admissionId: id,
    owner: { threadId: thread.id, projectId: thread.meta.projectId, generation: owned.generation,
      messageId: `message-${id}`, dispatchId: `dispatch-${id}` },
    nativeOutcome: "unknown", localOutcome: "pending", dispatch: "attempted" });
  const close = async () => {
    held.release();
    try { await call?.catch(() => undefined); }
    finally {
      try { await client.close(); }
      finally { await bridge.close(); runtime.disposeAll(); await rm(dir, { recursive: true, force: true }); }
    }
  };
  try { await client.connect(transport); }
  catch (error) { await close(); throw error; }
  return { bridge, journal, evidence, held, close,
    async startHeldRead() {
      call = client.callTool({ name: "foundry_memory", arguments: { id: "held" } });
      await Promise.race([entered.promise, Bun.sleep(1500).then(() => { throw Error("Backend was not entered"); })]);
    },
    async result() { held.release(); return await call!; },
  };
}

test("a late bridge result retains its operation-start admission across the next admission", async () => {
  const f = await fixture();
  try {
    const first = f.evidence("first"), second = f.evidence("second");
    f.bridge.register(first);
    await f.startHeldRead();
    f.bridge.observe({ ...first, nativeOutcome: "completed", localOutcome: "resolved" });
    f.bridge.register(second);
    const result = await f.result();
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("OWNED_WINDOW_FACT");
    expect(f.journal).toHaveLength(1);
    expect(f.journal[0].association).toEqual({ kind: "registered-admission-window", admissionId: "first", owner: first.owner });
    expect(f.bridge.evidence("second")).toHaveLength(0);
    const retained = f.bridge.evidence("first")[0];
    expect(retained.persistence).toBe("committed");
    expect(retained.record.nativeCorrelation).toBe("unknown");
    expect(retained.record.sdkRequestId).toBeDefined();
    // The SDK validates and applies schema defaults before invoking the handler.
    expect(retained.record.arguments).toEqual({ id: "held", limit: 10 });
    expect(retained.record.digest).toBe(createHash("sha256").update(retained.record.result).digest("hex"));
    expect(Object.isFrozen(retained.record.association.owner)).toBe(true);
  } finally { await f.close(); }
});

test("a pre-admission bridge operation cannot acquire a later admission retroactively", async () => {
  const f = await fixture();
  try {
    await f.startHeldRead();
    f.bridge.register(f.evidence("later"));
    const result = await f.result();
    expect(result.isError).not.toBe(true);
    expect(f.journal).toHaveLength(1);
    expect(f.journal[0].association).toEqual({ kind: "unassociated" });
    expect(f.bridge.evidence("later")).toHaveLength(0);
    expect(f.bridge.evidence()).toHaveLength(1);
  } finally { await f.close(); }
});

test("a successful bridge result remains distinct from failed journal persistence", async () => {
  const f = await fixture(true);
  try {
    f.bridge.register(f.evidence("journal-failure"));
    await f.startHeldRead();
    const result = await f.result();
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("OWNED_WINDOW_FACT");
    expect(f.journal).toHaveLength(0);
    const retained = f.bridge.evidence("journal-failure");
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ persistence: "failed", publication: "reconciliation-needed",
      error: "tool-journal-failed", record: { status: "ok" } });
    expect(JSON.stringify(retained)).not.toContain("CONTROLLED_PRIVATE_JOURNAL_ERROR");
  } finally { await f.close(); }
});

test("bridge admission refuses overlap and foreign generation without replacing ownership", async () => {
  const f = await fixture();
  try {
    const first = f.evidence("first");
    f.bridge.register(first);
    expect(() => f.bridge.register(f.evidence("second"))).toThrow("unresolved");
    expect(() => f.bridge.register({ ...first, owner: { ...first.owner!, generation: "foreign" } })).toThrow("ownership mismatch");
    await f.startHeldRead();
    await f.result();
    expect(f.journal[0].association.admissionId).toBe("first");
    expect(f.journal[0].association.owner).toEqual(first.owner);
  } finally { await f.close(); }
});
