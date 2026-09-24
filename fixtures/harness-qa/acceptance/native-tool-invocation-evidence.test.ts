import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { ContextLayer, ContextStack, Thread } from "../../../packages/core/src/index";
import { createFoundryMcp, type ToolInvocationRecord } from "../../../packages/foundry/src/mcp/server";

const resolve = createRequire(new URL("../../../packages/foundry/package.json", import.meta.url)).resolve;
const { Client } = await import(resolve("@modelcontextprotocol/sdk/client/index.js"));
const { InMemoryTransport } = await import(resolve("@modelcontextprotocol/sdk/inMemory.js"));

type TextResult = { isError?: boolean; content?: Array<{ type: string; text?: string }> };
function evidence(result: TextResult): ToolInvocationRecord | undefined {
  for (const block of result.content ?? []) {
    if (block.type !== "text" || !block.text?.startsWith('{"invocation":')) continue;
    return JSON.parse(block.text).invocation;
  }
}

async function fixture(onInvocation?: (record: ToolInvocationRecord) => void) {
  const layer = new ContextLayer({ id: "conventions" });
  layer.set("CONTROLLED_RETRIEVAL_FACT: preserve migration order");
  const owner = new Thread("invocation-owner", new ContextStack([layer]));
  owner.meta.projectId = "invocation-project";
  const bridge = createFoundryMcp({ thread: owner, onInvocation });
  const client = new Client({ name: "independent-invocation-evidence", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const close = async () => {
    try { await client.close(); } finally {
      try { await bridge.server.close(); } finally { owner.dispose(); }
    }
  };
  try { await bridge.server.connect(st); await client.connect(ct); }
  catch (error) { await close(); throw error; }
  return { bridge, close, async read(): Promise<TextResult> {
    return client.callTool({ name: "foundry_query", arguments: { topic: "CONTROLLED_RETRIEVAL_FACT", detail: "full" } });
  } };
}

test("an invocation observer exception cannot replace a successful SDK retrieval", async () => {
  const f = await fixture(() => { throw new Error("CONTROLLED_OBSERVER_FAILURE"); });
  try {
    const result = await f.read();
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("CONTROLLED_RETRIEVAL_FACT");
    expect(JSON.stringify(result)).not.toContain("CONTROLLED_OBSERVER_FAILURE");
    expect(evidence(result)?.status).toBe("ok");
    expect(f.bridge.invocations()).toHaveLength(1);
  } finally { await f.close(); }
});

test("observer mutation cannot forge the owner delivered in the SDK invocation contract", async () => {
  const f = await fixture(record => {
    try { (record.owner as { projectId?: string }).projectId = "FORGED_PROJECT"; } catch {}
  });
  try {
    const result = await f.read();
    expect(result.isError).not.toBe(true);
    expect(evidence(result)?.owner).toEqual({ threadId: "invocation-owner", projectId: "invocation-project" });
    expect(JSON.stringify(f.bridge.invocations())).not.toContain("FORGED_PROJECT");
  } finally { await f.close(); }
});

test("mutating a returned history snapshot cannot rewrite retained invocation ownership", async () => {
  const f = await fixture();
  try {
    const first = await f.read();
    const frozenWire = JSON.stringify(first);
    const history = f.bridge.invocations();
    try { (history[0]!.owner as { threadId?: string }).threadId = "FORGED_THREAD"; } catch {}
    expect(f.bridge.invocations()[0]!.owner.threadId).toBe("invocation-owner");
    expect(JSON.stringify(first)).toBe(frozenWire);
    const second = await f.read();
    expect(evidence(second)?.owner.threadId).toBe("invocation-owner");
  } finally { await f.close(); }
});

test("successful observer sees the same truthful owner and content digest as the SDK caller", async () => {
  const observed: ToolInvocationRecord[] = [];
  const f = await fixture(record => { observed.push(record); });
  try {
    const result = await f.read();
    const record = evidence(result)!;
    const delivered = result.content?.[0]?.text ?? "";
    expect(result.isError).not.toBe(true);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual(record);
    expect(record.digest).toBe(createHash("sha256").update(delivered).digest("hex"));
    expect(record.owner).toEqual({ threadId: "invocation-owner", projectId: "invocation-project" });
    expect(record.nativeCorrelation).toBe("unknown");
  } finally { await f.close(); }
});

test("observer diagnostics do not retain caller-controlled Error.name payloads", async () => {
  const error = new Error("controlled observer error");
  error.name = "CONTROLLED_PRIVATE_NAME_PAYLOAD";
  const f = await fixture(() => { throw error; });
  try {
    const result = await f.read();
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(f.bridge.diagnostics())).not.toContain("CONTROLLED_PRIVATE_NAME_PAYLOAD");
    expect(f.bridge.diagnostics().observerFailures.synchronous).toBe(1);
  } finally { await f.close(); }
});

test("observer diagnostics cannot invoke a throwing Error.name accessor and mask retrieval", async () => {
  const error = new Error("controlled observer error");
  Object.defineProperty(error, "name", { get() { throw new Error("CONTROLLED_NAME_ACCESSOR_FAILURE"); } });
  const f = await fixture(() => { throw error; });
  try {
    const result = await f.read();
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("CONTROLLED_RETRIEVAL_FACT");
    expect(f.bridge.diagnostics().observerFailures.synchronous).toBe(1);
  } finally { await f.close(); }
});
