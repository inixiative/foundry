import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, EventStream } from "../../../packages/core/src/index";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { ThreadFactory, buildAgents } from "../../../packages/foundry/src/agents/thread-factory";
import { SessionBackedProvider } from "../../../packages/foundry/src/providers/session-backed";
import type { SessionAdapter } from "../../../packages/foundry/src/providers/session-adapter";
import { starterConfig } from "../../../packages/foundry/src/viewer/config";
import { KnowledgePersistence } from "../../../packages/foundry/src/persistence/knowledge-persistence";
import { LocalSessionStore } from "../../../packages/foundry/src/persistence/local-session-store";

const fact = "Keep rollback checkpoint K before applying migration Z.";
const answer = JSON.stringify({ decision: "learn", knowledge: fact, facts: [fact] });
const tick = () => Bun.sleep(0);

// Real runtime, provider, and durable CAS; only the native process is controlled.
function fixture(initiallyInspectable = true, softTimeoutMs = 5, hardTimeoutMs = 250) {
  let inspectable = initiallyInspectable, sends = 0, releases = 0;
  const listeners: Array<(value: unknown) => void> = [];
  const attempt: Record<string, unknown> = {
    admissionId: "independent-native-review", dispatch: "attempted", nativeOutcome: "unknown",
    localOutcome: "rejected", localFailure: "timeout", transportOutcome: "open",
    externalSessionId: "independent-native-binding", rpcRequestId: 19, rpcOutcome: "pending",
  };
  const session = {
    admissionProtocol: "prewrite-v1", externalSessionId: "independent-native-binding",
    async start() {}, kill() {}, onEvent(fn: (value: unknown) => void) { listeners.push(fn); },
    inspectAttempt(id: string) { return inspectable && id === attempt.admissionId ? structuredClone(attempt) : undefined; },
    async send(_prompt: string, opts?: { onAdmission?: (value: unknown) => Promise<void> }) {
      await opts?.onAdmission?.({ ...attempt, dispatch: "not-dispatched", localOutcome: "pending" });
      sends++;
      throw Object.assign(Error("INDEPENDENT_LOCAL_TIMEOUT"), { attempt: structuredClone(attempt) });
    },
  };
  const adapter: SessionAdapter = {
    runtime: "codex", async createSession() { return session as never; },
    async getExternalSessionId() { return "independent-native-binding"; },
    async clearSession() { throw Error("unexpected rebind"); },
    async releaseIdleSession() { releases++; return "released"; },
  };
  const provider = new SessionBackedProvider({ id: "native-independent", adapter, defaultModel: "controlled" });
  const config = starterConfig("controlled", "controlled");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "controlled", model: "controlled",
    prompt: "Work", temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const layer = new ContextLayer({ id: "conventions", prompt: "Preserve checkpoint instructions" });
  layer.set("Migration domain knowledge");
  const stack = new ContextStack([layer]);
  const manager = new ThreadRuntimeManager({ config, log() {}, warn() {},
    domains: [{ domain: "conventions", layerId: "conventions", guardTriggers: [] }],
    learning: { timeoutMs: softTimeoutMs, hardTimeoutMs, reviewProvider: provider },
    llm: { id: "flow", async complete() {
      return { model: "controlled", content: '{"domains":["conventions"],"layers":["conventions"],"confidence":1}' };
    } },
  });
  const store = new LocalSessionStore(":memory:");
  const persistence = new KnowledgePersistence(manager, store, new EventStream(), []);
  const factory = new ThreadFactory({ stack, runtime: manager, agents: buildAgents(config, stack, {
    provider: { id: "controlled", async complete() { return { model: "controlled", content: "WORK_DONE" }; } },
  }) });
  const thread = factory.create("independent-learning", { projectId: "independent-project" });
  const runtime = manager.get(thread.id)!;
  const knowledge = runtime.domainLibrarians.get("conventions")!.threadKnowledge;
  return {
    thread, runtime, knowledge, store, persistence,
    get sends() { return sends; }, get releases() { return releases; },
    async start() { await thread.dispatch("worker", "Independent work", undefined, { messageId: "original" }); await tick(); },
    emit(patch: Record<string, unknown> = {}) {
      inspectable = true;
      Object.assign(attempt, { nativeOutcome: "completed", content: answer, terminal: { type: "task_complete" } }, patch);
      for (const listener of listeners) listener({ ...attempt, kind: "result" });
    },
    async close() {
      manager.disposeAll(); inspectable = true; attempt.rpcOutcome = "resolved";
      for (const listener of listeners) listener({ ...attempt, kind: "result" });
      await runtime.learningSettled(); await tick(); await tick(); store.close();
    },
  };
}

test("eligible completed native knowledge commits while RPC capacity remains occupied", async () => {
  const f = fixture();
  try {
    await f.start(); f.emit();
    await Bun.sleep(60);
    expect(f.runtime.learningState.domains.conventions).toMatchObject({ nativeOutcome: "completed", rpcOutcome: "pending", capacity: "unknown" });
    expect(f.releases).toBe(0); expect(f.sends).toBe(1);
    expect(f.knowledge.content).toBe(fact);
    expect(f.store.knowledge(f.thread.id)?.domains.conventions.content).toBe(fact);
    f.emit(); await tick(); expect(f.knowledge.revision).toBe(1);
    await Bun.sleep(260);
    expect(f.knowledge.content).toBe(fact); expect(f.releases).toBe(0);
  } finally { await f.close(); }
});

test("temporary missing inspection does not close an admitted review before its hard deadline", async () => {
  const f = fixture(false);
  try {
    await f.start(); await Bun.sleep(10);
    expect(f.sends).toBe(1); expect(f.releases).toBe(0);
    f.emit({ rpcOutcome: "resolved" });
    await Bun.sleep(60);
    expect(f.knowledge.content).toBe(fact);
    expect(f.knowledge.revision).toBe(1);
    expect(f.store.knowledge(f.thread.id)?.domains.conventions.content).toBe(fact);
    expect(f.sends).toBe(1);
  } finally { await f.close(); }
});

test("control: native and RPC terminal within eligibility publish once", async () => {
  const f = fixture();
  try {
    await f.start(); f.emit({ rpcOutcome: "resolved" });
    await f.runtime.learningSettled();
    expect(f.knowledge.content).toBe(fact);
    expect(f.store.knowledge(f.thread.id)?.domains.conventions.content).toBe(fact);
    f.emit({ rpcOutcome: "resolved" }); await tick();
    expect(f.knowledge.revision).toBe(1); expect(f.sends).toBe(1);
  } finally { await f.close(); }
});

test("control: first native result after hard closure never publishes", async () => {
  const f = fixture();
  try {
    await f.start(); await f.runtime.learningSettled();
    expect(f.runtime.learningState.domains.conventions.status).toBe("expired");
    f.emit({ rpcOutcome: "resolved" }); await tick(); await tick();
    expect(f.knowledge.revision).toBe(0);
    expect(f.store.knowledge(f.thread.id)?.domains.conventions.content ?? "").toBe("");
    expect(f.sends).toBe(1);
  } finally { await f.close(); }
});

test("central dispatch does not await an unresolved owned native review or admit a replacement", async () => {
  const f = fixture();
  let pending: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.start();
    pending = f.thread.dispatch("worker", "Independent next task", undefined, { messageId: "next-task" });
    const outcome = await Promise.race([
      pending.then(() => "central-completed"),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve("waiting-on-review"), 100); }),
    ]);
    expect(outcome).toBe("central-completed");
    expect(f.sends).toBe(1); expect(f.releases).toBe(0);
    expect(f.runtime.learningState.domains.conventions.capacity).toBe("unknown");
    expect(f.knowledge.revision).toBe(0);
  } finally { clearTimeout(timer); await pending; await f.close(); }
});

test("soft observation deadline cannot relabel already committed knowledge while RPC remains occupied", async () => {
  const f = fixture(true, 100, 1000);
  try {
    await f.start(); f.emit(); await Bun.sleep(40);
    expect(f.knowledge.revision).toBe(1);
    expect(f.runtime.learningState.domains.conventions.status).toBe("learned");
    await Bun.sleep(120);
    expect(f.runtime.learningState.domains.conventions).toMatchObject({ status: "learned", capacity: "unknown", rpcOutcome: "pending" });
    expect(f.knowledge.content).toBe(fact);
    expect(f.store.knowledge(f.thread.id)?.domains.conventions.content).toBe(fact);
    expect(f.sends).toBe(1); expect(f.releases).toBe(0);
  } finally { await f.close(); }
});
