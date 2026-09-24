import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, Thread } from "../../../packages/core/src/index";
import { createFoundryMcp } from "../../../packages/foundry/src/mcp/server";
import { createLiveBridge } from "../../../packages/foundry/src/mcp/transport";
import { readLaunchFile, runProxy } from "../../../packages/foundry/src/mcp/proxy";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "independent-lifecycle", version: "1" } } };

async function fixture(holdFirstConnection = false) {
  const layer = new ContextLayer({ id: "controlled" }); layer.set("OWNED_CONTROLLED_FACT");
  const owner = new Thread("bridge-lifecycle-owner", new ContextStack([layer]));
  owner.meta.projectId = "controlled-project";
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  let created = 0, closedServers = 0, invocations = 0;
  const bridge = await createLiveBridge({ maxSessions: 1, createMcp: () => {
    const mcp = createFoundryMcp({ thread: owner, onInvocation: () => { invocations++; } });
    created++;
    mcp.server.server.onclose = () => { closedServers++; };
    if (created === 1 && holdFirstConnection) {
      const connect = mcp.server.connect.bind(mcp.server);
      mcp.server.connect = async transport => { entered(); await held; await connect(transport); };
    }
    return mcp;
  } });
  const capability = readLaunchFile(bridge.launchFile).capability;
  const post = (body: unknown, authenticated = true) => fetch(bridge.endpoint, {
    method: "POST", signal: AbortSignal.timeout(3000),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authenticated ? { authorization: `Bearer ${capability}` } : {}) },
    body: JSON.stringify(body),
  });
  return { bridge, post, release, firstEntered, counts: () => ({ created, closedServers, invocations }), async close() {
    release();
    try { await bridge.close(); } finally { owner.dispose(); }
  } };
}

test("missing bridge capability refuses work without a tool invocation", async () => {
  const f = await fixture();
  try {
    const response = await f.post(initialize, false);
    expect(response.status).toBe(401);
    expect(f.bridge.stats().sessions).toBe(0);
    expect(f.counts().invocations).toBe(0);
  } finally { await f.close(); }
});

test("a pending initialize reserves session capacity before its asynchronous connection", async () => {
  const f = await fixture(true);
  let first: Promise<Response> | undefined;
  try {
    first = f.post(initialize);
    await f.firstEntered;
    const second = await f.post({ ...initialize, id: 2 });
    expect(second.status).toBe(429);
    expect(f.counts().created).toBe(1);
    f.release();
    expect((await first).status).toBe(200);
  } finally { f.release(); await first?.catch(() => {}); await f.close(); }
});

test("connect-only proxy verification terminates its owned SDK session", async () => {
  const f = await fixture();
  try {
    await runProxy(f.bridge.launchFile, { connectOnly: true });
    expect(f.bridge.stats().sessions).toBe(0);
    await runProxy(f.bridge.launchFile, { connectOnly: true });
    expect(f.bridge.stats().sessions).toBe(0);
  } finally { await f.close(); }
});

test("failed initialize closes its allocated transport/server instead of retaining it", async () => {
  const f = await fixture();
  try {
    const response = await f.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: null });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(f.bridge.stats().sessions).toBe(0);
    expect(f.counts().closedServers).toBe(f.counts().created);
  } finally { await f.close(); }
});
