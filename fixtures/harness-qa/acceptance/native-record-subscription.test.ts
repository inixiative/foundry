import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { ContextLayer, ContextStack, Thread } from "../../../packages/core/src/index";
import { createFoundryMcp, type ToolInvocationRecord } from "../../../packages/foundry/src/mcp/server";

const resolve = createRequire(new URL("../../../packages/foundry/package.json", import.meta.url)).resolve;
const { Client } = await import(resolve("@modelcontextprotocol/sdk/client/index.js"));
const { InMemoryTransport } = await import(resolve("@modelcontextprotocol/sdk/inMemory.js"));

async function fixture() {
  const layer = new ContextLayer({ id: "domain" }); layer.set("CONTROLLED_SUBSCRIPTION_FACT");
  const owner = new Thread("subscription-owner", new ContextStack([layer]));
  const mcp = createFoundryMcp({ thread: owner });
  const client = new Client({ name: "independent-subscription", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(st); await client.connect(ct);
  return { mcp, read: () => client.callTool({ name: "foundry_query", arguments: { topic: "CONTROLLED_SUBSCRIPTION_FACT", detail: "full" } }),
    async close() { try { await client.close(); } finally { try { await mcp.server.close(); } finally { owner.dispose(); } } } };
}

test("record subscriptions isolate and count asynchronous observer failure", async () => {
  const f = await fixture();
  try {
    const rejected = Promise.reject(new Error("CONTROLLED_ASYNC_RECORD_FAILURE"));
    // Handle locally so the test can assert the missing diagnostic without an
    // unrelated test-runner unhandled-rejection crash masking that assertion.
    void rejected.catch(() => {});
    f.mcp.onRecord(() => rejected);
    const result = await f.read();
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("CONTROLLED_SUBSCRIPTION_FACT");
    expect(f.mcp.diagnostics().observerFailures.asynchronous).toBe(1);
    expect(JSON.stringify(f.mcp.diagnostics())).not.toContain("CONTROLLED_ASYNC_RECORD_FAILURE");
  } finally { await f.close(); }
});

test("record subscriptions safely handle a throwing then accessor", async () => {
  const f = await fixture();
  try {
    f.mcp.onRecord(() => Object.defineProperty({}, "then", { get() { throw Error("CONTROLLED_THEN_ACCESSOR"); } }));
    const result = await f.read();
    expect(result.isError).not.toBe(true);
    expect(f.mcp.diagnostics().observerFailures.synchronous).toBe(1);
    expect(JSON.stringify(f.mcp.diagnostics())).not.toContain("CONTROLLED_THEN_ACCESSOR");
  } finally { await f.close(); }
});

test("unsubscribing stops future notifications without erasing sealed history", async () => {
  const f = await fixture();
  try {
    const records: ToolInvocationRecord[] = [];
    const unsubscribe = f.mcp.onRecord(record => { records.push(record); });
    await f.read(); unsubscribe(); unsubscribe(); await f.read();
    expect(records).toHaveLength(1);
    expect(f.mcp.invocations()).toHaveLength(2);
    expect(Object.isFrozen(records[0])).toBe(true);
  } finally { await f.close(); }
});
