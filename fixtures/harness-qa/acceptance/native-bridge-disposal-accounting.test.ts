import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, Thread } from "../../../packages/core/src/index";
import { createFoundryMcp } from "../../../packages/foundry/src/mcp/server";
import { createLiveBridge } from "../../../packages/foundry/src/mcp/transport";
import { runProxy } from "../../../packages/foundry/src/mcp/proxy";

function observedOwner(id: string) {
  const thread = new Thread(id, new ContextStack([new ContextLayer({ id: "controlled" })]));
  thread.meta.projectId = "controlled-disposal-project";
  let subscriptions = 0;
  const original = thread.onDispose.bind(thread);
  thread.onDispose = callback => {
    subscriptions++;
    let active = true;
    const finish = () => { if (active) { active = false; subscriptions--; } };
    const off = original(() => { finish(); callback(); });
    return () => { finish(); off(); };
  };
  return { thread, subscriptions: () => subscriptions };
}

test("closing an unused bridge releases its owned disposal subscription", async () => {
  const owner = observedOwner("unused-bridge-owner");
  const bridge = await createLiveBridge({ createMcp: () => createFoundryMcp({ thread: owner.thread }) });
  try {
    expect(owner.subscriptions()).toBe(1);
    await bridge.close();
    expect(owner.subscriptions()).toBe(0);
    expect(owner.thread.disposed).toBe(false);
  } finally { await bridge.close(); owner.thread.dispose(); }
});

test("closed SDK sessions leave no authority disposal hooks after bridge shutdown", async () => {
  const owner = observedOwner("session-churn-owner");
  const bridge = await createLiveBridge({ createMcp: () => createFoundryMcp({ thread: owner.thread }) });
  try {
    for (let i = 0; i < 3; i++) {
      await runProxy(bridge.launchFile, { connectOnly: true });
      expect(bridge.stats().sessions).toBe(0);
    }
    await bridge.close();
    expect(bridge.stats().serversClosed).toBe(bridge.stats().serversCreated);
    // The owner remains usable. Closed SDK sessions must not accumulate hooks
    // on a long-lived thread merely because it has not itself been disposed.
    expect(owner.thread.disposed).toBe(false);
    expect(owner.subscriptions()).toBe(0);
  } finally { await bridge.close(); owner.thread.dispose(); }
});

test("a rejected factory server is not counted closed before its close settles", async () => {
  const owner = observedOwner("valid-allocation-owner");
  const foreign = observedOwner("foreign-allocation-owner");
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const closing = new Promise<void>(resolve => { entered = resolve; });
  let created = 0;
  let completed = 0;
  const closes: Promise<void>[] = [];
  const bridge = await createLiveBridge({ createMcp: () => {
    const current = ++created;
    const mcp = createFoundryMcp({ thread: current === 2 ? foreign.thread : owner.thread });
    const original = mcp.server.close.bind(mcp.server);
    mcp.server.close = () => {
      const pending = (async () => {
        if (current === 2) { entered(); await held; }
        await original();
        completed++;
      })();
      closes.push(pending);
      return pending;
    };
    return mcp;
  } });
  let refused: Promise<boolean> | undefined;
  try {
    await runProxy(bridge.launchFile, { connectOnly: true });
    refused = runProxy(bridge.launchFile, { connectOnly: true }).then(() => false, () => true);
    await closing;
    expect(foreign.subscriptions()).toBe(0);
    expect(bridge.stats().serversClosed).toBe(completed);
    release();
    expect(await refused).toBe(true);
    await Promise.all(closes);
    expect(bridge.stats().serversClosed).toBe(completed);
  } finally {
    release();
    await refused;
    await Promise.all(closes);
    await bridge.close();
    owner.thread.dispose();
    foreign.thread.dispose();
  }
});
