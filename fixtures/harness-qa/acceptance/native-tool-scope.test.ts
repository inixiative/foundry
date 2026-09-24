import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { ContextLayer, ContextStack, Thread } from "../../../packages/core/src/index";
import { SessionManager } from "../../../packages/foundry/src/agents/session";
import { createFoundryMcpServer } from "../../../packages/foundry/src/mcp/server";

// Resolve the SDK owned by Foundry, without adding a second root dependency.
const resolve = createRequire(new URL("../../../packages/foundry/package.json", import.meta.url)).resolve;
const { Client } = await import(resolve("@modelcontextprotocol/sdk/client/index.js"));
const { InMemoryTransport } = await import(resolve("@modelcontextprotocol/sdk/inMemory.js"));

function thread(id: string, projectId?: string) {
  const layer = new ContextLayer({ id: "memory-conventions" });
  layer.set("CURRENT_OWNER_FACT: rollback C before B");
  const t = new Thread(id, new ContextStack([layer]));
  t.meta.projectId = projectId;
  return t;
}

async function fixture(options: { projectId?: string } = { projectId: "project-A" }) {
  const owner = thread("controlled-owner", options.projectId);
  const sibling = thread("controlled-sibling", "project-A");
  sibling.meta.description = "SAME_PROJECT_SUMMARY";
  const foreign = thread("controlled-foreign", "project-B");
  foreign.meta.description = "PRIVATE_PROJECT_B_DESCRIPTION";
  foreign.meta.tags = ["PRIVATE_PROJECT_B_TAG"];
  const manager = new SessionManager();
  for (const t of [owner, sibling, foreign]) manager.add(t);
  const server = createFoundryMcpServer({ thread: owner, sessionManager: manager });
  const client = new Client({ name: "independent-controlled-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try { await server.connect(serverTransport); await client.connect(clientTransport); }
  catch (error) { await client.close(); await server.close(); throw error; }
  return { client, owner, manager, async close() {
    try { await client.close(); } finally {
      try { await server.close(); } finally {
        for (const t of new Set([owner, ...manager.threads.values()])) t.dispose();
      }
    }
  } };
}

test("actual MCP thread enumeration cannot disclose another project's private summary or tags", async () => {
  const f = await fixture();
  try {
    const result = await f.client.callTool({ name: "foundry_threads", arguments: {} });
    const text = JSON.stringify(result);
    expect(text).not.toContain("PRIVATE_PROJECT_B_DESCRIPTION");
    expect(text).not.toContain("PRIVATE_PROJECT_B_TAG");
    expect(text).not.toContain("controlled-foreign");
    expect(result.isError).not.toBe(true);
  } finally { await f.close(); }
});

test("an in-process MCP tool reads the bound thread's current layer after a knowledge update", async () => {
  const f = await fixture();
  try {
    const first = await f.client.callTool({ name: "foundry_query", arguments: { topic: "CURRENT_OWNER_FACT", detail: "full" } });
    expect(JSON.stringify(first)).toContain("rollback C before B");
    f.owner.stack.getLayer("memory-conventions")!.set("CURRENT_OWNER_FACT: new committed migration checkpoint");
    const second = await f.client.callTool({ name: "foundry_query", arguments: { topic: "CURRENT_OWNER_FACT", detail: "full" } });
    expect(JSON.stringify(second)).toContain("new committed migration checkpoint");
    expect(JSON.stringify(second)).not.toContain("rollback C before B");
    expect(JSON.stringify(first)).toContain("rollback C before B");
  } finally { await f.close(); }
});

test("an authorized project can still enumerate its active sibling summaries", async () => {
  const f = await fixture();
  try {
    const result = await f.client.callTool({ name: "foundry_threads", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("SAME_PROJECT_SUMMARY");
  } finally { await f.close(); }
});

test("an absent project does not authorize enumeration of unrelated unprojected threads", async () => {
  const f = await fixture({});
  try {
    const other = thread("unrelated-unprojected");
    other.meta.description = "UNSCOPED_PRIVATE_DESCRIPTION";
    f.manager.add(other);
    const result = await f.client.callTool({ name: "foundry_threads", arguments: {} });
    expect(JSON.stringify(result)).not.toContain("UNSCOPED_PRIVATE_DESCRIPTION");
    expect(JSON.stringify(result)).not.toContain("unrelated-unprojected");
  } finally { await f.close(); }
});

test("a disposed thread cannot keep supplying its cached private facts over MCP", async () => {
  const f = await fixture();
  try {
    f.owner.dispose();
    const result = await f.client.callTool({ name: "foundry_query", arguments: { topic: "CURRENT_OWNER_FACT", detail: "full" } })
      .catch(() => ({ isError: true }));
    expect(JSON.stringify(result)).not.toContain("rollback C before B");
    expect(result.isError).toBe(true);
  } finally { await f.close(); }
});

test("an existing MCP authority cannot silently follow its thread into a different project", async () => {
  const f = await fixture();
  try {
    f.owner.meta.projectId = "project-B";
    const result = await f.client.callTool({ name: "foundry_threads", arguments: {} })
      .catch(() => ({ isError: true }));
    expect(JSON.stringify(result)).not.toContain("PRIVATE_PROJECT_B_DESCRIPTION");
    expect(result.isError).toBe(true);
  } finally { await f.close(); }
});

test("replacing a registered thread with the same id revokes its old MCP authority", async () => {
  const f = await fixture();
  try {
    const replacement = thread(f.owner.id, "project-A");
    replacement.stack.getLayer("memory-conventions")!.set("REPLACEMENT_RUNTIME_PRIVATE_FACT");
    f.manager.add(replacement);
    expect(f.owner.disposed).toBe(false);
    const result = await f.client.callTool({ name: "foundry_query", arguments: { topic: "CURRENT_OWNER_FACT", detail: "full" } })
      .catch(() => ({ isError: true }));
    expect(JSON.stringify(result)).not.toContain("rollback C before B");
    expect(JSON.stringify(result)).not.toContain("REPLACEMENT_RUNTIME_PRIVATE_FACT");
    expect(result.isError).toBe(true);
  } finally { await f.close(); }
});
