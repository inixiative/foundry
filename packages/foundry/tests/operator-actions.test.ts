import { expect, test } from "bun:test";
import { Hono } from "hono";
import { ContextLayer, ContextStack, EventStream, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";
import { ActionHandler, type ActionKind } from "../src/viewer/actions";
import { registerControlRoutes } from "../src/viewer/routes/control";
import { ConfigStore } from "../src/viewer/config";

function setup() {
  const main = new Thread("main", new ContextStack());
  const selected = new Thread("selected", new ContextStack());
  const threads = new Map([[main.id, main], [selected.id, selected]]);
  const actions = new ActionHandler({ harness: new Harness(main), eventStream: new EventStream(),
    interventions: new InterventionLog(main.signals), resolveThread: id => threads.get(id) });
  const run = (kind: ActionKind, target?: string, threadId?: string) => actions.execute({ kind, target, threadId, timestamp: Date.now() });
  return { main, selected, threads, actions, run };
}

test("archive targets the selected thread, not the main thread", async () => {
  const { main, selected, run } = setup();
  expect((await run("thread:archive", selected.id)).ok).toBe(true);
  expect(selected.disposed).toBe(true);
  expect(main.disposed).toBe(false);
});

test("unknown and conflicting thread targets cannot mutate either thread", async () => {
  const { main, selected, run } = setup();
  expect((await run("thread:archive", "missing")).ok).toBe(false);
  expect((await run("thread:archive", selected.id, main.id)).ok).toBe(false);
  expect(main.disposed).toBe(false);
  expect(selected.disposed).toBe(false);
});

test("inspect and snapshot read the selected thread", async () => {
  const { selected, run } = setup();
  expect((await run("thread:inspect", selected.id)).data).toMatchObject({ id: selected.id });
  expect((await run("system:snapshot", undefined, selected.id)).data).toMatchObject({ thread: { id: selected.id } });
});

test("pause and resume operate on the selected thread", async () => {
  const { main, selected, run } = setup();
  expect((await run("thread:pause", undefined, selected.id)).ok).toBe(true);
  expect(selected.meta.status).toBe("waiting");
  expect(main.meta.status).toBe("idle");
  expect((await run("thread:resume", undefined, selected.id)).ok).toBe(true);
  expect(selected.meta.status).toBe("idle");
  selected.dispose();
});

test("an archived thread cannot be resumed or have its status changed", async () => {
  const { main, run } = setup();
  main.archive();
  expect((await run("thread:resume", main.id)).ok).toBe(false);
  expect((await run("thread:pause", main.id)).ok).toBe(false);
  expect(main.meta.status).toBe("archived");
});

test("warming loads only the selected thread's layer before returning success", async () => {
  const { main, selected, run } = setup();
  const a = new ContextLayer({ id: "domain", sources: [{ id: "a", load: async () => "main knowledge" }] });
  const b = new ContextLayer({ id: "domain", sources: [{ id: "b", load: async () => "selected knowledge" }] });
  main.stack.addLayer(a); selected.stack.addLayer(b);
  expect((await run("layer:warm", "domain", selected.id)).ok).toBe(true);
  expect(b.content).toBe("selected knowledge");
  expect(a.state).toBe("cold");
  expect((await run("layer:invalidate", "domain", selected.id)).ok).toBe(true);
  expect(b.state).toBe("stale");
  expect(b.content).toBe("selected knowledge");
});

test("failed warming is reported as failure", async () => {
  const { selected, run } = setup();
  selected.stack.addLayer(new ContextLayer({ id: "broken", sources: [{ id: "broken", load: async () => { throw new Error("unavailable source"); } }] }));
  const result = await run("layer:warm", "broken", selected.id);
  expect(result.ok).toBe(false);
  expect(result.message).toContain("unavailable source");
});

test("thread resolution is live rather than retaining a removed instance", async () => {
  const { selected, threads, run } = setup();
  threads.delete(selected.id);
  expect((await run("thread:archive", selected.id)).ok).toBe(false);
  expect(selected.disposed).toBe(false);
});

test("production action route preserves thread scope for layer commands", async () => {
  const { main, selected, actions } = setup();
  const layer = new ContextLayer({ id: "domain", sources: [{ id: "source", load: async () => "selected only" }] });
  selected.stack.addLayer(layer);
  const app = new Hono();
  registerControlRoutes(app, { harness: new Harness(main), actions,
    configStore: new ConfigStore("/tmp/unused-operator-config"), aiAssist: null, analyticsStore: null,
    actionQueue: null, tunnelHolder: { tunnel: null }, port: 0 });
  const response = await app.request("/api/actions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "layer:warm", target: "domain", threadId: selected.id }) });
  expect(response.status).toBe(200);
  expect((await response.json()).ok).toBe(true);
  expect(layer.content).toBe("selected only");
  expect(actions.history.at(-1)?.threadId).toBe(selected.id);
  for (const scope of [{ threadId: 123 }, { threadId: "" }, { target: 123 }, { target: "" }]) {
    const invalid = await app.request("/api/actions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "thread:archive", ...scope }) });
    expect(invalid.status).toBe(400);
    expect(main.disposed).toBe(false);
    expect(selected.disposed).toBe(false);
  }
});
