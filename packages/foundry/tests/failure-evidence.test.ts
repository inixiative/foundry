import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, EventStream, Executor, Harness, InterventionLog, type LLMProvider } from "@inixiative/foundry-core";
import { buildAgents, ThreadFactory } from "../src/agents/thread-factory";
import { ConfigStore, starterConfig } from "../src/viewer/config";
import { createViewer } from "../src/viewer/server";
import { mergeMessageHistory } from "../src/viewer/ui/conversation-state.js";
import { traceInjection } from "../src/viewer/ui/inspector-data.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture(provider: LLMProvider, maxTraces = 1000) {
  const dir = mkdtempSync(join(tmpdir(), "foundry-failure-evidence-"));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  async function make() {
    const config = starterConfig("mock", "mock");
    config.agents = { worker: { id: "worker", kind: "executor", provider: "mock", model: "mock", prompt: "Execute",
      temperature: 0, maxTokens: 256, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
    const stack = new ContextStack();
    const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider }) });
    const thread = factory.create("main");
    const harness = new Harness(thread, { maxTraces }); harness.setDefaultExecutor("worker");
    const events = new EventStream();
    const configStore = new ConfigStore(dir); await configStore.save(config);
    const viewer = createViewer({ harness, eventStream: events, interventions: new InterventionLog(thread.signals),
      configDir: dir, configStore, threadFactory: factory });
    let closed = false;
    const close = () => { if (closed) return; closed = true; viewer.localStore!.close(); for (const t of viewer.directory.all()) t.dispose(); };
    cleanup.push(close);
    return { ...viewer, harness, thread, events, close };
  }
  return { make };
}

type Runtime = Awaited<ReturnType<ReturnType<typeof fixture>["make"]>>;
async function send(runtime: Runtime, id: string, streaming = true, threadId = "main") {
  const response = await runtime.app.request(`/api/messages${streaming ? "/stream" : ""}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, threadId, message: id }),
  });
  if (!streaming) return { status: response.status, body: await response.json(), events: [] };
  const events = (await response.text()).split("\n\n").filter(frame => frame.startsWith("data: "))
    .map(frame => JSON.parse(frame.slice(6)));
  return { status: response.status, body: events.find(event => event.type === "error"), events };
}

const failingProvider: LLMProvider = {
  id: "mock", complete: async () => { throw new Error("provider refused"); },
  stream: async function* (messages) {
    const input = messages.at(-1)!.content;
    yield { type: "text", text: `partial:${input}` };
    yield { type: "error", error: `provider refused:${input}` };
  },
};

for (const streaming of [false, true]) {
  test(`pre-provider ${streaming ? "SSE" : "HTTP"} failure records explicit unavailable input without calling provider`, async () => {
    let calls = 0;
    const runtime = await fixture({ id: "mock", complete: async () => { calls++; throw new Error("must not call"); } }).make();
    runtime.thread.middleware.use("fail-before-provider", async () => { throw new Error("preparation failed"); });
    const { body } = await send(runtime, "pre-provider", streaming);
    expect(calls).toBe(0);
    expect(body.meta).toMatchObject({ inputEvidence: "unavailable", deliveryAcknowledgment: "unavailable", nativeOutcome: "unknown", persistence: "committed" });
    expect(body.meta.injection).toBeUndefined();
    const trace = await (await runtime.app.request(`/api/traces/${body.traceId}`)).json();
    expect(trace.root).toMatchObject({ input: "pre-provider", status: "error", annotations: { failure: { inputEvidence: "unavailable" } } });
    expect(trace.spans.every((span: any) => span.status !== "running")).toBe(true);
  });
}

test("factory provider failure retains boundary input, partial output and historical inspector data after viewer reconstruction", async () => {
  const { make } = fixture(failingProvider);
  const first = await make();
  const { body, events } = await send(first, "partial-turn");
  expect(events.filter(event => event.type === "delta").map(event => event.text)).toEqual(["partial:partial-turn"]);
  expect(body.meta).toMatchObject({ partialOutput: "partial:partial-turn", inputEvidence: "provider-boundary-recorded",
    deliveryAcknowledgment: "unavailable", nativeOutcome: "unknown", persistence: "committed" });
  expect(body.meta.injection.providerMessages.at(-1)).toEqual({ role: "user", content: "partial-turn" });
  const originalTrace = await (await first.app.request(`/api/traces/${body.traceId}`)).json();
  first.close();
  const second = await make();
  const history = await (await second.app.request("/api/messages?threadId=main")).json();
  const messages = mergeMessageHistory([], history.messages);
  expect(messages[1]).toMatchObject({ traceId: body.traceId, meta: body.meta, streaming: false, storage: "server" });
  const trace = await (await second.app.request(`/api/traces/${body.traceId}`)).json();
  expect(trace).toEqual(originalTrace);
  expect(traceInjection(trace)).toEqual(body.meta.injection);
  expect(trace.root.annotations.failure.partialOutput).toBe("partial:partial-turn");
  expect(second.localStore!.turn("partial-turn")?.status).toBe("failed");
  expect((await send(second, "partial-turn", false)).status).toBe(409);
});

test("overlapping failures do not depend on retained Harness trace history", async () => {
  const runtime = await fixture(failingProvider, 0).make();
  const [a, b] = await Promise.all([send(runtime, "PRIVATE_A"), send(runtime, "PRIVATE_B")]);
  for (const [result, own, other] of [[a, "PRIVATE_A", "PRIVATE_B"], [b, "PRIVATE_B", "PRIVATE_A"]] as const) {
    expect(result.body.traceId).toBeString();
    const trace = runtime.localStore!.trace(result.body.traceId);
    expect(trace?.messageId).toBe(own);
    expect(JSON.stringify(trace)).not.toContain(other);
    expect(result.body.meta.partialOutput).toBe(`partial:${own}`);
    expect(result.body.meta.injection.userMessage).toBe(own);
  }
  expect(a.body.traceId).not.toBe(b.body.traceId);
});

test("overlapping failures in separate factory-created threads retain their own inputs and outputs", async () => {
  const runtime = await fixture(failingProvider).make();
  const create = await runtime.app.request("/api/threads", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "other-thread" }) });
  expect(create.status).toBe(201);
  const [a, b] = await Promise.all([send(runtime, "PRIVATE_MAIN"), send(runtime, "PRIVATE_OTHER", true, "other-thread")]);
  for (const [result, owner, other] of [[a, "main", "PRIVATE_OTHER"], [b, "other-thread", "PRIVATE_MAIN"]] as const) {
    expect(result.body.meta.injection.threadId).toBe(owner);
    const history = runtime.localStore!.messages(owner);
    expect(JSON.stringify(history)).not.toContain(other);
    expect(runtime.localStore!.trace(result.body.traceId)?.root).toMatchObject({ threadId: owner });
  }
});

test("a handler failing before the provider boundary is prepared-only and never acknowledged", async () => {
  const runtime = await fixture(failingProvider).make();
  runtime.thread.register(new Executor({ id: "before-boundary", stack: runtime.thread.stack, handler: async () => {
    throw new Error("handler preparation failed");
  } }));
  runtime.harness.setDefaultExecutor("before-boundary");
  const { body } = await send(runtime, "prepared-only");
  expect(body.meta).toMatchObject({ inputEvidence: "prepared-only", deliveryAcknowledgment: "unavailable", nativeOutcome: "unknown" });
  expect(body.meta.injection.userMessage).toBe("prepared-only");
  expect(body.meta.injection.providerMessages).toBeUndefined();
});

test("a failed later execute stage cannot inherit the earlier stage's prepared input", async () => {
  const runtime = await fixture({ id: "mock", complete: async () => ({ content: "first complete", model: "mock" }) }).make();
  runtime.thread.register(new Executor({ id: "later", stack: runtime.thread.stack, handler: async () => "must not run" }));
  runtime.thread.middleware.use("fail-later", async (context, next) => {
    if (context.agentId === "later") throw new Error("later preparation failed");
    return next();
  });
  runtime.harness.setFlow({ stages: [
    { agentId: "worker", role: "execute", invocation: "always" },
    { agentId: "later", role: "execute", invocation: "always" },
  ] });
  const { body } = await send(runtime, "later-pre-provider", false);
  expect(body.meta.inputEvidence).toBe("unavailable");
  expect(body.meta.injection).toBeUndefined();
  const trace = runtime.localStore!.trace(body.traceId);
  expect(trace!.spans.some((span: any) => span.agentId === "worker" && span.annotations.injection)).toBe(true);
  expect(traceInjection(trace)).toBeUndefined();
});

test("disconnecting the SSE reader does not lose partial failure evidence or replay execution", async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const runtime = await fixture({ ...failingProvider, stream: async function* () {
    calls++; yield { type: "text", text: "before disconnect" }; await hold;
    yield { type: "error", error: "failure after disconnect" };
  } }).make();
  let terminal!: () => void;
  const finished = new Promise<void>(resolve => { terminal = resolve; });
  const unsubscribe = runtime.events.subscribe(event => { if (event.kind === "error") terminal(); });
  cleanup.push(unsubscribe);
  const response = await runtime.app.request("/api/messages/stream", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "disconnect", message: "disconnect", threadId: "main" }),
  });
  const reader = response.body!.getReader();
  let received = "";
  try {
    while (!received.includes('"type":"delta"')) {
      const { done, value } = await reader.read();
      if (done) throw new Error("stream ended before partial output");
      received += new TextDecoder().decode(value);
    }
    await reader.cancel();
  } finally { release(); reader.releaseLock(); }
  await finished;
  const history = await (await runtime.app.request("/api/messages?threadId=main")).json();
  expect(history.messages[1]).toMatchObject({ error: "failure after disconnect", meta: { persistence: "committed", partialOutput: "before disconnect" } });
  expect(calls).toBe(1);
  expect((await send(runtime, "disconnect", false)).status).toBe(409);
  expect(calls).toBe(1);
});

test("journal failure rolls back trace and response, exposes unsaved evidence and recovers an unknown turn without replay", async () => {
  const { make } = fixture(failingProvider);
  const first = await make();
  // Fail a real SQLite write after the trace insert, not a mock of failTurn.
  const sql = (first.localStore as unknown as { db: Database }).db;
  sql.exec(`CREATE TEMP TRIGGER reject_failed_message BEFORE INSERT ON session_messages
    WHEN NEW.actor = 'agent' BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END`);
  const { body } = await send(first, "write-failure");
  expect(body.error).toBe("provider refused:write-failure");
  expect(body.meta).toMatchObject({ persistence: "failed", persistenceError: "injected journal failure", nativeOutcome: "unknown",
    partialOutput: "partial:write-failure" });
  expect(first.localStore!.turn("write-failure")?.status).toBe("active");
  expect(first.localStore!.messages("main")).toHaveLength(1);
  expect(first.localStore!.traceForTurn("write-failure")).toBeUndefined();
  const trace = await (await first.app.request(`/api/traces/${body.traceId}`)).json();
  expect(trace.root.annotations.failure.persistence).toBe("failed");
  const cached = [{ actor: "agent", turnId: "write-failure", content: body.error, traceId: body.traceId, meta: body.meta }];
  first.close();
  const second = await make();
  expect(second.localStore!.turn("write-failure")?.status).toBe("interrupted");
  const history = await (await second.app.request("/api/messages?threadId=main")).json();
  const recovered = mergeMessageHistory(cached, history.messages).find((message: any) => message.actor === "agent");
  expect(recovered.traceId).toBeUndefined();
  expect(recovered.meta).toMatchObject({ inputEvidence: "unavailable", nativeOutcome: "unknown", persistence: "committed",
    browserFailureEvidence: { persistence: "failed", partialOutput: "partial:write-failure" } });
  expect((await send(second, "write-failure", false)).status).toBe(409);
});

test("an error event observer cannot suppress the failed SSE terminal or durable original error", async () => {
  const runtime = await fixture(failingProvider).make();
  runtime.events.pushError = () => { throw new Error("observer broke"); };
  const { body } = await send(runtime, "observer");
  expect(body.error).toBe("provider refused:observer");
  expect(runtime.localStore!.messages("main").at(-1)?.error).toBe("provider refused:observer");
});
