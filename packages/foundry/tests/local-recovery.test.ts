import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, EventStream, Executor, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";
import { LocalSessionStore } from "../src/persistence/local-session-store";
import { registerRuntimeRoutes } from "../src/viewer/routes/runtime";
import { ConfigStore } from "../src/viewer/config";
import { createViewer } from "../src/viewer/server";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "foundry-route-recovery-"));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const path = join(dir, "sessions.sqlite");
  const make = () => {
    const thread = new Thread("main", new ContextStack(), { description: "Preserved title" });
    let calls = 0;
    thread.register(new Executor({ id: "worker", stack: thread.stack, handler: async (_context, payload, meta) => {
      calls++;
      meta?.recordProviderInput?.([{ role: "user", content: String(payload) }]);
      if (payload === "FAIL") throw new Error("Provider failed");
      return `Actual output: ${payload}`;
    } }));
    const harness = new Harness(thread); harness.setDefaultExecutor("worker");
    const localStore = new LocalSessionStore(path);
    const app = new Hono();
    registerRuntimeRoutes(app, { harness, eventStream: new EventStream(), interventions: new InterventionLog(thread.signals),
      db: null, configStore: new ConfigStore(dir), localStore });
    return { app, localStore, thread, calls: () => calls };
  };
  return { make };
}

test("G4: completed HTTP turn and exact artifact survive route/store reconstruction without Postgres", async () => {
  const { make } = setup();
  const first = make();
  const response = await first.app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "turn-persist", threadId: "main", message: "Original input" }) });
  expect(response.status).toBe(200);
  const result = await response.json();
  first.localStore.close(); first.thread.dispose();
  const second = make(); cleanup.push(() => { second.localStore.close(); second.thread.dispose(); });
  const history = await (await second.app.request("/api/messages?threadId=main")).json();
  expect(history.messages.map((m: { content: string }) => m.content)).toEqual(["Original input", "Actual output: Original input"]);
  expect(history.messages[1].meta.injection).toEqual(result.meta.injection);
  expect(history.messages[1].trace).toEqual(result.trace);
  const trace = await second.app.request(`/api/traces/${result.traceId}`);
  expect(trace.status).toBe(200);
  expect((await trace.json()).messageId).toBe("turn-persist");
});

test("G4: retrying an accepted turn ID cannot repeat native execution", async () => {
  const { make } = setup(); const runtime = make();
  cleanup.push(() => { runtime.localStore.close(); runtime.thread.dispose(); });
  const send = () => runtime.app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "same-turn", threadId: "main", message: "Do work" }) });
  expect((await send()).status).toBe(200);
  expect((await send()).status).toBe(409);
  expect(runtime.calls()).toBe(1);
});

test("G4: SSE completion and failures remain visible in durable history", async () => {
  const { make } = setup(); const runtime = make();
  cleanup.push(() => { runtime.localStore.close(); runtime.thread.dispose(); });
  const response = await runtime.app.request("/api/messages/stream", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "stream-turn", threadId: "main", message: "Stream input" }) });
  expect(await response.text()).toContain('"type":"done"');
  const failed = await runtime.app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "failed-turn", threadId: "main", message: "FAIL" }) });
  expect(failed.status).toBe(500);
  const history = await (await runtime.app.request("/api/messages?threadId=main")).json();
  expect(history.messages).toHaveLength(4);
  expect(history.messages[1].meta.injection.userMessage).toBe("Stream input");
  expect(history.messages[3]).toMatchObject({ kind: "error", meta: { turnStatus: "failed" } });
});

for (const streaming of [false, true]) {
  test(`G4: ${streaming ? "SSE" : "HTTP"} failure preserves exact input and trace after restart`, async () => {
    const { make } = setup(); const first = make();
    const response = await first.app.request(`/api/messages${streaming ? "/stream" : ""}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "failure-evidence", threadId: "main", message: "FAIL" }),
    });
    const body = streaming
      ? (await response.text()).split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(event => event.type === "error")
      : await response.json();
    expect(body.traceId).toBeString();
    expect(body.meta.injection.providerMessages).toEqual([{ role: "user", content: "FAIL" }]);
    expect(body.meta.turnStatus).toBe("failed");
    first.localStore.close(); first.thread.dispose();
    const second = make(); cleanup.push(() => { second.localStore.close(); second.thread.dispose(); });
    const history = await (await second.app.request("/api/messages?threadId=main")).json();
    const failed = history.messages.at(-1);
    expect(failed).toMatchObject({ kind: "error", traceId: body.traceId, meta: body.meta });
    const storedTrace = await (await second.app.request(`/api/traces/${body.traceId}`)).json();
    expect(storedTrace.messageId).toBe("failure-evidence");
    expect(storedTrace.root.status).toBe("error");
    expect(storedTrace.spans.find((span: { kind: string }) => span.kind === "execute"))
      .toMatchObject({ status: "error", error: { message: "Provider failed" }, annotations: { injection: body.meta.injection } });
    expect(second.localStore.turn("failure-evidence")?.status).toBe("failed");
    expect(second.calls()).toBe(0);
  });
}

test("G4: viewer startup restores a projectless thread, rename and terminal archive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-viewer-recovery-"));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const make = () => {
    const main = new Thread("main", new ContextStack());
    const viewer = createViewer({ harness: new Harness(main), eventStream: new EventStream(),
      interventions: new InterventionLog(main.signals), configDir: dir });
    return { ...viewer, main };
  };
  const first = make();
  const request = (url: string, body: unknown, method = "POST") => first.app.request(url,
    { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await request("/api/threads", { id: "restored-orphan", description: "Original", tags: ["qa"] })).status).toBe(201);
  expect((await request("/api/threads/restored-orphan", { description: "Human renamed" }, "PATCH")).status).toBe(200);
  expect((await request("/api/actions", { kind: "thread:archive", target: "restored-orphan" })).status).toBe(200);
  first.localStore!.close(); first.main.dispose();
  const second = make();
  cleanup.push(() => { for (const thread of second.directory.all()) thread.dispose(); second.localStore!.close(); });
  const history = await (await second.app.request("/api/threads")).json();
  expect(history.threads.find((t: { threadId: string }) => t.threadId === "restored-orphan").meta)
    .toMatchObject({ description: "Human renamed", tags: ["qa"], status: "archived" });
  expect(second.directory.get("restored-orphan")?.disposed).toBe(true);
  const rejected = await second.app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "restored-orphan", message: "Cannot restart disposed work" }) });
  expect(rejected.status).toBe(409);
});

test("G4: fork and rewind cannot acknowledge a view-only native history change", async () => {
  const { make } = setup(); const runtime = make();
  cleanup.push(() => { runtime.localStore.close(); runtime.thread.dispose(); });
  const post = (url: string, body: unknown) => runtime.app.request(url,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await post("/api/messages", { id: "original", message: "Keep this evidence", threadId: "main" });
  expect((await post("/api/threads/main/revert", { keepCount: 0 })).status).toBe(501);
  expect((await post("/api/threads/main/fork", { copyCount: 1 })).status).toBe(501);
  expect(runtime.localStore.messages("main")).toHaveLength(2);
  expect(runtime.localStore.threads()).toHaveLength(1);
});
