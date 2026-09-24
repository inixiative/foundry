import { expect, test } from "bun:test";
import { ContextStack, Executor, Harness, Thread, type InjectionArtifact } from "../src";

test("prepared and boundary snapshots are observable before a held handler finishes", async () => {
  const snapshots: InjectionArtifact[] = [];
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const executor = new Executor({ id: "worker", stack: new ContextStack(), handler: async (_context, _payload, meta) => {
    meta?.recordProviderInput?.([{ role: "user", content: "prepared boundary" }]);
    entered(); await hold;
    throw Object.freeze(new Error("original provider failure"));
  } });
  const outcome = executor.run("original", undefined, { recordInjection: artifact => snapshots.push(artifact) })
    .catch(error => error);
  await ready;
  try {
    expect(snapshots[0]?.userMessage).toBe("original");
    expect(snapshots[0]?.providerMessages).toBeUndefined();
    expect(snapshots.at(-1)?.providerMessages).toEqual([{ role: "user", content: "prepared boundary" }]);
  } finally { release(); await outcome; }
});

for (const original of [Object.freeze(new Error("original failure")), "primitive failure", undefined]) {
  test(`evidence observers cannot replace the original failure: ${String(original)}`, async () => {
    const executor = new Executor({ id: "worker", stack: new ContextStack(), handler: async (_context, _payload, meta) => {
      meta?.recordProviderInput?.([{ role: "user", content: "input" }]);
      throw original;
    } });
    let rejected = false;
    await executor.run("input", undefined, {
      recordProviderInput: () => { throw new Error("boundary observer failed"); },
      recordInjection: () => { throw new Error("snapshot observer failed"); },
    }).then(() => {}, error => { rejected = true; expect(error).toBe(original); });
    expect(rejected).toBe(true);
  });
}

test("a falsy thrown value still terminates a stream as failure and closes its trace", async () => {
  const thread = new Thread("falsy", new ContextStack());
  thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async (_context, _payload, meta) => {
    meta?.onDelta?.("partial"); throw undefined;
  } }));
  const harness = new Harness(thread); harness.setDefaultExecutor("worker");
  const events: unknown[] = [];
  let rejected = false;
  try {
    try { for await (const event of harness.sendStream({ id: "falsy-turn", payload: "input" })) events.push(event); }
    catch (error) { rejected = true; expect(error).toBeUndefined(); }
    expect(rejected).toBe(true);
    expect(events).toEqual([{ kind: "delta", text: "partial" }]);
    expect(harness.getTraceForMessage("falsy-turn")?.root.status).toBe("error");
  } finally { thread.dispose(); }
});
