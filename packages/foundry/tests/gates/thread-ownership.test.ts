import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, Executor } from "@inixiative/foundry-core";
import { ThreadFactory } from "../../src/agents/thread-factory";

function makeFactory(handler?: (context: string, payload: string) => Promise<string>) {
  const layer = new ContextLayer({ id: "domain", prompt: "Keep domain evidence", sources: [
    { id: "source", load: async () => "Project baseline" },
  ] });
  layer.set("Project baseline");
  const stack = new ContextStack([layer]);
  const agent = new Executor({ id: "worker", stack, prompt: "Use the thread context",
    handler: handler ?? (async context => context) });
  return new ThreadFactory({ stack, agents: new Map([[agent.id, agent]]) });
}

test("G1: production factory owns independent layers and agents", async () => {
  const factory = makeFactory();
  const a = factory.create("a");
  const b = factory.create("b");
  expect(a.stack).not.toBe(b.stack);
  expect(a.stack.getLayer("domain")).not.toBe(b.stack.getLayer("domain"));
  expect(a.getAgent("worker")).not.toBe(b.getAgent("worker"));
  a.stack.getLayer("domain")!.set("PRIVATE-A");
  b.stack.getLayer("domain")!.set("PRIVATE-B");
  a.getAgent("worker")!.setLayerFilter(() => false);
  expect((await a.dispatch("worker", "inspect")).output).not.toContain("PRIVATE-A");
  expect((await b.dispatch("worker", "inspect")).output).toContain("PRIVATE-B");
  expect((await b.dispatch("worker", "inspect")).output).not.toContain("PRIVATE-A");
});

test("G1: later thread creation does not inherit another thread's writeback", async () => {
  const factory = makeFactory();
  const a = factory.create("a");
  a.stack.getLayer("domain")!.set("PRIVATE-A");
  const privateState = new ContextLayer({ id: "thread-state" });
  privateState.set("A's private decision");
  a.stack.addLayer(privateState);
  const b = factory.create("b");
  await b.stack.warmAll();
  expect((await b.dispatch("worker", "inspect")).output).not.toContain("PRIVATE-A");
  expect(b.stack.getLayer("thread-state")?.content ?? "").not.toContain("A's private decision");
  expect(b.stack.getLayer("domain")!.prompt).toBe("Keep domain evidence");
  expect(b.stack.getLayer("domain")!.sources.map(source => source.id)).toEqual(["source"]);
});

test("G1: concurrent factory dispatches do not cross-read context", async () => {
  let entered = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const factory = makeFactory(async context => {
    if (++entered === 2) release();
    await barrier;
    return context;
  });
  const a = factory.create("a");
  const b = factory.create("b");
  a.stack.getLayer("domain")!.set("ONLY-A");
  b.stack.getLayer("domain")!.set("ONLY-B");
  const [left, right] = await Promise.all([a.dispatch("worker", "left"), b.dispatch("worker", "right")]);
  expect(left.output).toContain("ONLY-A");
  expect(left.output).not.toContain("ONLY-B");
  expect(right.output).toContain("ONLY-B");
  expect(right.output).not.toContain("ONLY-A");
});
