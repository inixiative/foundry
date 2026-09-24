import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, EventStream, Harness, InterventionLog, type LLMProvider } from "../../../packages/core/src";
import { buildAgents, ThreadFactory } from "../../../packages/foundry/src/agents/thread-factory";
import { ConfigStore, defaultProjectAgents, starterConfig } from "../../../packages/foundry/src/viewer/config";
import { createViewer } from "../../../packages/foundry/src/viewer/server";
import { readMessageStream } from "../../../packages/foundry/src/viewer/ui/conversation-state.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

async function fixture(provider: LLMProvider) {
  const dir = mkdtempSync(join(tmpdir(), "foundry-independent-failure-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const config = starterConfig("fixture", "fixture");
  config.agents = { artificer: defaultProjectAgents("fixture", "fixture").artificer };
  const configStore = new ConfigStore(dir);
  await configStore.save(config);
  const make = () => {
    const stack = new ContextStack();
    const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider }) });
    const thread = factory.create("failure-owner");
    const harness = new Harness(thread);
    harness.setDefaultExecutor("artificer");
    const viewer = createViewer({ harness, eventStream: new EventStream(),
      interventions: new InterventionLog(thread.signals), configStore, configDir: dir, threadFactory: factory });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      for (const item of viewer.directory.all()) item.dispose();
      viewer.localStore!.close();
    };
    cleanup.push(close);
    return { ...viewer, thread, close };
  };
  return { make, dir };
}

function post(app: ReturnType<typeof createViewer>["app"], id: string, message: string, stream = false) {
  return app.request(`/api/messages${stream ? "/stream" : ""}`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, threadId: "failure-owner", message }) });
}

test("independent G4: pre-provider rejection stays inspectable without invented provider input", async () => {
  let calls = 0;
  const { make } = await fixture({ id: "fixture", async complete() { calls++; return { model: "fixture", content: "UNEXPECTED" }; } });
  const first = make();
  first.thread.middleware.use("reject-before-provider", async () => { throw new Error("Preparation rejected"); });
  const response = await post(first.app, "before-provider", "ORIGINAL-PREP-INPUT");
  expect(response.status).toBe(500);
  const failed = await response.json();
  expect(calls).toBe(0);
  expect(failed.traceId).toBeString();
  expect(failed.meta.inputEvidence).toBe("unavailable");
  expect(failed.meta.injection?.providerMessages).toBeUndefined();
  first.close();
  const second = make();
  const trace = await (await second.app.request(`/api/traces/${failed.traceId}`)).json();
  expect(trace.messageId).toBe("before-provider");
  expect(trace.root.status).toBe("error");
  expect(trace.root.input).toBe("ORIGINAL-PREP-INPUT");
  expect((await post(second.app, "before-provider", "ORIGINAL-PREP-INPUT")).status).toBe(409);
  expect(calls).toBe(0);
});

test("independent G4: overlapping failed streams retain only their own partial output and provider input after restart", async () => {
  let calls = 0;
  let started = 0;
  let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  const { make } = await fixture({ id: "fixture",
    async complete() { throw new Error("Streaming route must use stream"); },
    async *stream(messages) {
      calls++;
      const input = messages.find(m => m.role === "user")!.content;
      yield { type: "text" as const, text: `PARTIAL:${input}` };
      if (++started === 2) release();
      await both;
      throw new Error(`FAILED:${input}`);
    },
  });
  const first = make();
  const events: Record<string, any[]> = { A: [], B: [] };
  await Promise.all(["A", "B"].map(async id => {
    const response = await post(first.app, `failed-${id}`, `INPUT-${id}`, true);
    await readMessageStream(response.body!, (event: unknown) => events[id].push(event));
  }));
  expect(started).toBe(2);
  first.close();
  const second = make();
  const history = await (await second.app.request("/api/messages?threadId=failure-owner")).json();
  for (const id of ["A", "B"]) {
    const terminal = events[id].at(-1);
    expect(terminal.type).toBe("error");
    expect(events[id].some(e => e.type === "done")).toBe(false);
    expect(terminal.meta.partialOutput).toBe(`PARTIAL:INPUT-${id}`);
    expect(terminal.meta.inputEvidence).toBe("provider-boundary-recorded");
    const saved = history.messages.find((m: any) => m.turnId === `failed-${id}` && m.actor === "agent");
    expect(saved.traceId).toBe(terminal.traceId);
    expect(saved.meta.partialOutput).toBe(`PARTIAL:INPUT-${id}`);
    expect(saved.meta.injection.providerMessages.find((m: any) => m.role === "user").content).toBe(`INPUT-${id}`);
    const trace = await (await second.app.request(`/api/traces/${saved.traceId}`)).json();
    expect(trace.messageId).toBe(`failed-${id}`);
    expect(trace.root.status).toBe("error");
    expect(JSON.stringify(trace)).not.toContain(`INPUT-${id === "A" ? "B" : "A"}`);
  }
  expect(calls).toBe(2);
  expect((await post(second.app, "failed-A", "INPUT-A", true)).status).toBe(409);
  expect(calls).toBe(2);
});

test("independent G4: failed evidence transaction is reported honestly and cannot trigger automatic reexecution", async () => {
  let calls = 0;
  const { make, dir } = await fixture({ id: "fixture", async complete() { calls++; throw new Error("ACTUAL-PROVIDER-FAILURE"); } });
  const bootstrap = make();
  bootstrap.close();
  const db = new Database(join(dir, "sessions.sqlite"));
  db.exec("CREATE TRIGGER reject_failed_trace BEFORE INSERT ON session_traces BEGIN SELECT RAISE(ABORT, 'INJECTED-JOURNAL-FAILURE'); END");
  db.close();
  const first = make();
  const response = await post(first.app, "journal-failure", "Keep the original request");
  expect(response.status).toBe(500);
  const body = await response.json();
  expect(body.error).toContain("ACTUAL-PROVIDER-FAILURE");
  expect(body.meta.persistence).toBe("failed");
  expect(body.meta.persistenceError).toContain("INJECTED-JOURNAL-FAILURE");
  expect(first.localStore!.turn("journal-failure")?.status).toBe("active");
  expect(first.localStore!.messages("failure-owner").filter(m => m.actor === "agent")).toHaveLength(0);
  first.close();
  const second = make();
  expect(second.localStore!.turn("journal-failure")?.status).toBe("interrupted");
  expect((await post(second.app, "journal-failure", "Keep the original request")).status).toBe(409);
  expect(calls).toBe(1);
});

for (const streaming of [false, true]) {
  test(`independent G4: ${streaming ? "SSE" : "HTTP"} successful execution is not rewritten as failed when its commit fails`, async () => {
    let calls = 0;
    const output = "CONFIRMED-EXECUTOR-OUTPUT";
    const { make, dir } = await fixture({ id: "fixture",
      async complete() { calls++; return { model: "fixture", content: output }; },
      async *stream() { calls++; yield { type: "text" as const, text: output }; },
    });
    const bootstrap = make(); bootstrap.close();
    const db = new Database(join(dir, "sessions.sqlite"));
    db.exec("CREATE TRIGGER reject_success_trace BEFORE INSERT ON session_traces BEGIN SELECT RAISE(ABORT, 'COMPLETION-JOURNAL-FAILURE'); END");
    db.close();
    const first = make();
    const response = await post(first.app, `unsaved-success-${streaming}`, "Complete the work once", streaming);
    let terminal: any;
    if (streaming) {
      await readMessageStream(response.body!, (event: any) => { if (["done", "error"].includes(event.type)) terminal = event; });
    } else terminal = await response.json();
    expect(calls).toBe(1);
    expect(terminal.output).toBe(output);
    expect(terminal.meta.persistence).toBe("failed");
    expect(terminal.meta.persistenceError).toContain("COMPLETION-JOURNAL-FAILURE");
    expect(terminal.meta.turnStatus).not.toBe("failed");
    expect(terminal.error ?? "").not.toContain("Execution failed");
    expect(terminal.meta.partialOutput).toBeUndefined();
    expect(terminal.trace.stages[0].status).toBe("ok");
    // A provider completion is not by itself proof of a native terminal event.
    // Keep the completed output without inventing native delivery semantics.
    expect((await post(first.app, `unsaved-success-${streaming}`, "Complete the work once", streaming)).status).toBe(409);
    expect(calls).toBe(1);
  });
}
