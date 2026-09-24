import { expect, test } from "bun:test";
import { ContextStack, Thread } from "@inixiative/foundry-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createFoundryMcp } from "../src/mcp/server";
import { createLiveBridge } from "../src/mcp/transport";
import { readLaunchFile } from "../src/mcp/proxy";

const latch = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
for (const rejects of [false, true]) test(`bridge owns DELETE's complete transport/server cleanup chain (${rejects ? "failed" : "completed"} server)`, async () => {
  const thread = new Thread("cleanup-chain", new ContextStack());
  const transportEntered = latch(), transportGate = latch(), serverEntered = latch(), serverGate = latch();
  const mcp = createFoundryMcp({ thread });
  const connect = mcp.server.connect.bind(mcp.server), closeServer = mcp.server.close.bind(mcp.server);
  mcp.server.connect = async transport => {
    const close = transport.close.bind(transport); let closing: Promise<void> | undefined;
    transport.close = () => closing ??= (async () => { transportEntered.resolve(); await transportGate.promise; await close(); })();
    await connect(transport);
  };
  mcp.server.close = async () => { serverEntered.resolve(); await serverGate.promise; await closeServer(); if (rejects) throw Error("controlled close failure"); };
  const bridge = await createLiveBridge({ createMcp: () => mcp });
  const launch = readLaunchFile(bridge.launchFile);
  const transport = new StreamableHTTPClientTransport(new URL(bridge.endpoint), { requestInit: { headers: { Authorization: `Bearer ${launch.capability}` } } });
  const client = new Client({ name: "cleanup-chain", version: "1" });
  let deletion: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  try {
    await client.connect(transport);
    deletion = transport.terminateSession().catch(() => undefined);
    await transportEntered.promise;
    expect(bridge.stats().liveServers).toBe(0); // DELETE removed it before close takes its snapshot.
    let finished = false;
    closing = bridge.close().then(() => { finished = true; });
    expect(bridge.closed).toBe(true);
    transportGate.resolve(); await serverEntered.promise;
    await new Promise(resolve => setTimeout(resolve, 0)); // allow every ready promise continuation, not the held server.
    expect(bridge.stats().pendingCleanups).toBeGreaterThan(0);
    expect(bridge.stats().serversClosed).toBe(0);
    expect(finished).toBe(false);
    serverGate.resolve(); await closing;
    expect(bridge.stats()).toMatchObject({ pendingCleanups: 0, serversClosed: rejects ? 0 : 1, cleanupFailures: rejects ? 1 : 0 });
  } finally {
    transportGate.resolve(); serverGate.resolve(); await client.close(); await deletion; await closing; await bridge.close(); thread.dispose();
  }
});
