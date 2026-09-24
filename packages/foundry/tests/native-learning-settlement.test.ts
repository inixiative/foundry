import { afterEach, expect, test } from "bun:test";
import { ContextLayer, ContextStack, EventStream, type LLMMessage, type NativeEvidence, type NativeOwner } from "@inixiative/foundry-core";
import { ThreadRuntimeManager, scopedProvider } from "../src/agents/thread-runtime";
import { ThreadFactory, buildAgents } from "../src/agents/thread-factory";
import { SessionBackedProvider } from "../src/providers/session-backed";
import type { SessionAdapter } from "../src/providers/session-adapter";
import { starterConfig } from "../src/viewer/config";
import { KnowledgePersistence } from "../src/persistence/knowledge-persistence";
import { LocalSessionStore } from "../src/persistence/local-session-store";
// @ts-expect-error Browser helper intentionally remains JavaScript.
import { knowledgeInspectionSummary } from "../src/viewer/ui/inspector-data.js";

// Production runtime/provider/SQLite; the native transport alone is controlled.
const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });
const fact = "Zephyr rollback requires migration C before B.";
const answer = JSON.stringify({ decision: "learn", knowledge: fact, facts: [fact] });
const tick = () => Bun.sleep(0);
type Inspection = "available" | "missing" | "error";
function fixture(hardTimeoutMs = 500, clock?: () => number, release?: () => Promise<"released" | "unknown">, inspection: Inspection = "available") {
  const listeners: Array<(value: unknown) => void> = [];
  let sends = 0, releases = 0;
  const attempt: Record<string, unknown> = { admissionId: "native-review-1", dispatch: "attempted", nativeOutcome: "unknown",
    localOutcome: "rejected", localFailure: "timeout", transportOutcome: "open", externalSessionId: "owned-binding" };
  const session = { admissionProtocol: "prewrite-v1", externalSessionId: "owned-binding", async start() {}, kill() {},
    onEvent(fn: (event: unknown) => void) { listeners.push(fn); },
    inspectAttempt(id: string) {
      if (inspection === "error") throw Error("TRANSIENT_INSPECTION_FAILURE");
      return inspection === "available" && id === attempt.admissionId ? structuredClone(attempt) : undefined;
    },
    async send(_prompt: string, opts?: { onAdmission?: (value: unknown) => Promise<void> }) {
      await opts?.onAdmission?.({ ...attempt, dispatch: "not-dispatched", localOutcome: "pending" });
      sends++; throw Object.assign(Error("ORIGINAL_LOCAL_TIMEOUT"), { attempt: structuredClone(attempt) });
    } };
  const adapter: SessionAdapter = { runtime: "claude-code", async createSession() { return session as never; },
    async getExternalSessionId() { return "owned-binding"; }, async clearSession() { throw Error("no binding changes"); },
    async releaseIdleSession() { releases++; return release ? release() : "released"; } };
  const provider = new SessionBackedProvider({ id: "native-controlled", adapter, defaultModel: "explicit-model" });
  const config = starterConfig("mock", "mock");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "mock", model: "mock", prompt: "Work", temperature: 0,
    visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const layer = new ContextLayer({ id: "security", prompt: "Reviewer instructions" }); layer.set("Configured domain knowledge");
  const stack = new ContextStack([layer]), inputs: LLMMessage[][] = [], events = new EventStream();
  const manager = new ThreadRuntimeManager({ config, log() {}, warn() {}, domains: [{ domain: "security", layerId: "security", guardTriggers: [] }],
    learning: { timeoutMs: 2, hardTimeoutMs, clock, reviewProvider: provider }, llm: { id: "flow", async complete() {
      return { model: "flow", content: '{"domains":["security"],"layers":["security"],"confidence":1}' };
    } } });
  const factory = new ThreadFactory({ stack, runtime: manager, agents: buildAgents(config, stack, { provider: { id: "mock", async complete(messages) {
    inputs.push(structuredClone(messages)); return { model: "mock", content: "CENTRAL_COMPLETED" };
  } } }) });
  const store = new LocalSessionStore(":memory:"), persistence = new KnowledgePersistence(manager, store, events, []);
  const thread = factory.create("learning-native", { projectId: "P" }), runtime = manager.get(thread.id)!;
  const knowledge = runtime.domainLibrarians.get("security")!.threadKnowledge;
  closes.push(() => { manager.disposeAll(); store.close(); });
  return { provider, manager, factory, thread, runtime, store, persistence, inputs, attempt, knowledge,
    get sends() { return sends; }, get releases() { return releases; },
    setInspection(value: Inspection) { inspection = value; },
    async send(id = "original") { const result = await thread.dispatch("worker", `Independent ${id}`, undefined, { messageId: id }); await tick(); return result; },
    emit(patch: Record<string, unknown> = {}) { Object.assign(attempt, { nativeOutcome: "completed", content: answer,
      terminal: { type: "result", subtype: "success" } }, patch); for (const fn of listeners) fn({ ...attempt, kind: "result" }); },
    history() { return store.learningHistory(thread.id, 1000).map(row => row.signal.content as Record<string, any>); },
  };
}

for (const inspection of ["missing", "error"] as const) {
  test(`transient ${inspection} inspection retains original eligibility and commits once without releasing pending RPC`, async () => {
    const f = fixture(500, undefined, undefined, inspection); await f.send();
    const job = f.runtime.learningState.domains.security.job!;
    await Bun.sleep(4);
    expect(await f.runtime.reconcileNativeReview("security", job.id)).toBe(false);
    expect(f.runtime.learningState.domains.security).toMatchObject({ status: "delayed", closed: false,
      capacity: "unknown", localError: "ORIGINAL_LOCAL_TIMEOUT", job });
    expect(f.releases).toBe(0); expect(f.sends).toBe(1);
    f.setInspection("available"); f.emit({ rpcRequestId: 7, rpcOutcome: "pending" });
    await Bun.sleep(25);
    expect(f.knowledge.content).toBe(fact);
    expect(f.store.knowledge(f.thread.id)?.domains.security.content).toBe(fact);
    expect(f.runtime.learningState.domains.security).toMatchObject({ capacity: "unknown", job });
    expect(f.releases).toBe(0); expect(f.sends).toBe(1);
    f.emit({ rpcOutcome: "resolved" }); await f.runtime.learningSettled(); await tick();
    f.emit(); await tick();
    expect(f.knowledge.revision).toBe(1);
    expect(f.history().filter(row => row.decision === "learned")).toHaveLength(1);
    expect(f.sends).toBe(1);
  });

  test(`${inspection} inspection through hard expiry defers queued work durably; later observation cannot reopen it`, async () => {
    const f = fixture(40, undefined, undefined, inspection); await f.send();
    const job = f.runtime.learningState.domains.security.job!;
    const result = await f.send("queued");
    expect(result.output).toBe("CENTRAL_COMPLETED");
    expect(f.runtime.learningState.domains.security).toMatchObject({ closed: false, queued: 1, capacity: "unknown" });
    expect(f.sends).toBe(1); expect(f.releases).toBe(0);
    await f.runtime.learningSettled();
    expect(f.runtime.learningState.domains.security).toMatchObject({ status: "expired", closed: true, queued: 0 });
    expect(f.history().filter(row => row.decision === "deferred")).toHaveLength(1);
    f.setInspection("available"); f.emit(); await tick(); await tick();
    expect(f.knowledge.revision).toBe(0); expect(f.sends).toBe(1);
    expect(f.runtime.learningState.domains.security).toMatchObject({ status: "expired", closed: true, job, capacity: "settled" });
  });
}

test("a malformed result after an inspection gap is final invalid evidence, not eligible for a later duplicate repair", async () => {
  const f = fixture(500, undefined, undefined, "missing"); await f.send(); await tick();
  f.setInspection("available"); f.emit({ content: "null" }); await f.runtime.learningSettled();
  expect(f.runtime.learningState.domains.security.status).toBe("invalid");
  f.emit(); await tick();
  expect(f.knowledge.revision).toBe(0); expect(f.sends).toBe(1);
});

for (const mode of ["dispose", "restore", "transport", "sql", "publication"] as const) {
  test(`transient inspection errors preserve the ${mode} boundary when the original result becomes observable`, async () => {
    const f = fixture(500, undefined, undefined, "error"); const result = await f.send();
    const job = f.runtime.learningState.domains.security.job!;
    expect(await f.runtime.reconcileNativeReview("security", job.id)).toBe(false);
    if (mode === "dispose") f.runtime.dispose();
    if (mode === "restore") f.runtime.restoreKnowledge(f.runtime.knowledgeSnapshot());
    if (mode === "transport") f.attempt.transportOutcome = "failed";
    if (mode === "sql") (f.store as any).db.exec("CREATE TRIGGER deny_i2_gap BEFORE INSERT ON session_knowledge BEGIN SELECT RAISE(ABORT, 'I2_GAP_SQL_FAILURE'); END");
    if (mode === "publication") f.knowledge.layer.set = () => { throw Error("I2_GAP_PUBLICATION_FAILURE"); };
    f.setInspection("available"); f.emit(); await f.runtime.learningSettled(); await tick();
    expect(result.output).toBe("CENTRAL_COMPLETED"); expect(f.sends).toBe(1);
    expect(f.runtime.learningState.domains.security.localError).toBe("ORIGINAL_LOCAL_TIMEOUT");
    if (mode === "publication") {
      expect(f.store.knowledge(f.thread.id)?.domains.security.content).toBe(fact);
      expect(f.persistence.inspect(f.thread.id).status).toBe("reconciliation-needed");
    } else if (mode === "sql") {
      expect(f.store.knowledge(f.thread.id)).toBeUndefined(); expect(f.persistence.inspect(f.thread.id).status).toBe("blocked");
    } else if (mode === "transport") {
      expect(f.knowledge.content).toBe(fact);
      expect(f.runtime.learningState.domains.security.transportOutcome).toBe("failed");
    } else expect(f.knowledge.revision).toBe(0);
  });
}

test("eligible late native result survives rejected local waiter, commits once and next independent input sees the fact", async () => {
  const f = fixture(); const result = await f.send();
  await Bun.sleep(4);
  expect(f.runtime.learningState.domains.security).toMatchObject({ status: "delayed", localSettled: true, capacity: "unknown", nativeOutcome: "unknown" });
  expect(result.output).toBe("CENTRAL_COMPLETED");
  f.emit(); await f.runtime.learningSettled(); await tick(); // cleanup is a separate owned exit, not a learning ACK
  expect(f.knowledge.content).toBe(fact); expect(f.knowledge.revision).toBe(1);
  expect(f.runtime.learningState.domains.security).toMatchObject({ nativeOutcome: "completed", localOutcome: "rejected", status: "learned", capacity: "settled" });
  const frozen = f.runtime.learningState; f.emit(); await tick();
  expect(f.knowledge.revision).toBe(1); expect(frozen.domains.security.status).toBe("learned");
  expect(f.history().filter(row => row.decision === "learned")).toHaveLength(1);
  expect(f.sends).toBe(1);
  // Inspect the prepared input without admitting another background review.
  f.runtime.dispose(); const restored = f.factory.create(f.thread.id, { projectId: "P" });
  await restored.dispatch("worker", "Unrelated next task");
  expect(JSON.stringify(f.inputs.at(-1))).toContain(fact);
});

test("exact owner inspection is key-order independent and rejects foreign jobs/generations/pools", async () => {
  const f = fixture(); await f.send();
  const native = f.history().find(row => row.decision === "native-admission")!.native as NativeEvidence;
  const owner = Object.fromEntries(Object.entries(native.owner!).reverse()) as unknown as NativeOwner;
  expect(await f.provider.inspectOwnedAdmission(owner, native.admissionId!)).toMatchObject({ admissionId: native.admissionId });
  for (const key of ["reviewJobId", "generation", "providerSessionKey", "projectId"] as const) {
    expect(await f.provider.inspectOwnedAdmission({ ...owner, [key]: "foreign" }, native.admissionId!)).toBeUndefined();
  }
  f.emit(); await f.runtime.learningSettled();
});

test("native terminal while RPC remains pending retains occupancy; read-only reconciliation after RPC settles performs no replay", async () => {
  const f = fixture(); await f.send();
  f.emit({ rpcRequestId: 7, rpcOutcome: "pending" }); await tick();
  expect(f.runtime.learningState.domains.security).toMatchObject({ nativeOutcome: "completed", capacity: "unknown", rpcOutcome: "pending" });
  await Bun.sleep(25);
  expect(f.knowledge.content).toBe(fact); // commit eligibility does not mean free RPC capacity
  expect(f.releases).toBe(0); expect(f.sends).toBe(1);
  f.attempt.rpcOutcome = "resolved";
  await f.runtime.reconcileNativeReview("security", f.runtime.learningState.domains.security.job!.id);
  await f.runtime.learningSettled(); expect(f.knowledge.content).toBe(fact); expect(f.sends).toBe(1);
});

test("hard expiry permanently closes eligibility; late native evidence settles only the original lease and survives reconstruction", async () => {
  const f = fixture(20); await f.send(); await f.send("queued"); await f.runtime.learningSettled();
  expect(f.runtime.learningState.domains.security.status).toBe("expired");
  const originalJob = f.runtime.learningState.domains.security.job!;
  expect(f.history().filter(row => row.decision === "deferred")).toHaveLength(1);
  f.emit(); await tick(); await tick();
  expect(f.runtime.learningState.domains.security).toMatchObject({ status: "expired", closed: true, nativeOutcome: "completed", capacity: "settled" });
  expect(f.knowledge.revision).toBe(0); expect(f.sends).toBe(1);
  expect(await f.runtime.reconcileNativeReview("security", "foreign-job")).toBe(false);
  expect(f.runtime.learningState.domains.security.job).toEqual(originalJob);
  f.runtime.dispose(); const next = f.factory.create(f.thread.id, { projectId: "P" });
  const restored = f.manager.get(next.id)!;
  expect(restored.learningState.domains.security).toMatchObject({ closed: true, job: { id: originalJob.id }, nativeOutcome: "completed" });
  expect(await restored.reconcileNativeReview("security", originalJob.id)).toBe(false);
  await next.dispatch("worker", "New distinct work while restored closure remains"); await restored.learningSettled();
  expect(f.sends).toBe(1);
});

test("deadline boundary is latched before accepting terminal; later RPC response cannot reopen or drain", async () => {
  let now = 0; const f = fixture(100, () => now); await f.send(); await f.send("queued");
  now = 100; f.emit({ rpcRequestId: 8, rpcOutcome: "pending" }); await f.runtime.learningSettled();
  expect(f.knowledge.revision).toBe(0); expect(f.runtime.learningState.domains.security.status).toBe("expired");
  f.attempt.rpcOutcome = "resolved";
  expect(await f.runtime.reconcileNativeReview("security", f.runtime.learningState.domains.security.job!.id)).toBe(true);
  expect(f.sends).toBe(1); expect(f.knowledge.revision).toBe(0); expect(f.runtime.learningState.domains.security.closed).toBe(true);
});

test("cleanup pending is durable unknown capacity, retains original binding/owner, and replacement cannot launch", async () => {
  let exit!: () => void; const held = new Promise<"released">(resolve => { exit = () => resolve("released"); });
  const f = fixture(500, undefined, () => held); await f.send(); f.emit(); await f.runtime.learningSettled(); await tick();
  expect(f.runtime.learningState.domains.security).toMatchObject({ status: "learned", cleanup: "releasing", capacity: "unknown" });
  const original = f.runtime.learningState.domains.security.job!;
  expect(f.store.learningCapacity(f.thread.id).at(-1)?.content).toMatchObject({ cleanup: "releasing", capacity: "unknown", native: { owner: { reviewJobId: original.id } } });
  f.runtime.dispose(); const next = f.factory.create(f.thread.id, { projectId: "P" });
  await next.dispatch("worker", "No replacement while cleanup unknown"); await f.manager.get(next.id)!.learningSettled();
  expect(f.sends).toBe(1); exit(); await tick();
  expect(f.runtime.learningState.domains.security.cleanup).toBe("released");
  expect(f.provider.warmProfile(original.threadId)).toBeUndefined();
});

for (const content of ["null", "[]", "invalid-json", "x".repeat(20001), JSON.stringify({ decision: "learn", knowledge: "K".repeat(4001) })]) {
  test(`late public answer uses the same bounded parser: ${content.slice(0, 12)}`, async () => {
    const f = fixture(); await f.send(); f.emit({ content }); await f.runtime.learningSettled();
    expect(f.knowledge.revision).toBe(0); expect(f.runtime.learningState.domains.security.status).toBe("invalid"); expect(f.sends).toBe(1);
  });
}

test("foreign native admission cannot settle current work or change retained snapshots", async () => {
  const f = fixture(); await f.send(); const before = f.runtime.learningState;
  f.emit({ admissionId: "foreign-native-admission" }); await tick();
  expect(f.runtime.learningState.domains.security.nativeOutcome).toBe("unknown"); expect(f.knowledge.revision).toBe(0);
  f.emit({ admissionId: "native-review-1" }); await f.runtime.learningSettled();
  expect(before.domains.security.nativeOutcome).toBe("unknown"); expect(f.knowledge.revision).toBe(1);
});

for (const mode of ["dispose", "restore", "transport", "sql", "publication"] as const) test(`late settlement preserves ${mode} boundary`, async () => {
  const f = fixture(); const result = await f.send();
  if (mode === "dispose") f.runtime.dispose();
  if (mode === "restore") f.runtime.restoreKnowledge(f.runtime.knowledgeSnapshot());
  if (mode === "transport") { f.attempt.transportOutcome = "failed"; await f.runtime.reconcileNativeReview("security", f.runtime.learningState.domains.security.job!.id);
    expect(f.runtime.learningState.domains.security.capacity).toBe("unknown"); expect(f.releases).toBe(0); }
  if (mode === "sql") (f.store as any).db.exec("CREATE TRIGGER deny_i2 BEFORE INSERT ON session_knowledge BEGIN SELECT RAISE(ABORT, 'I2_SQL_FAILURE'); END");
  if (mode === "publication") f.knowledge.layer.set = () => { throw Error("I2_PUBLICATION_FAILURE"); };
  f.emit(); await f.runtime.learningSettled(); await tick();
  expect(result.output).toBe("CENTRAL_COMPLETED"); expect(f.sends).toBe(1);
  if (mode === "publication") { expect(f.store.knowledge(f.thread.id)?.domains.security.content).toBe(fact);
    expect(f.persistence.inspect(f.thread.id).status).toBe("reconciliation-needed"); }
  else if (mode === "sql") { expect(f.store.knowledge(f.thread.id)).toBeUndefined(); expect(f.persistence.inspect(f.thread.id).status).toBe("blocked"); }
  else if (mode !== "transport") expect(f.knowledge.revision).toBe(0);
});

test("late cleanup uses registered admission cwd, never a later scoped completion's cwd", async () => {
  const released: string[] = [], attempts = new Map<string, Record<string, unknown>>();
  const locations = new WeakMap<object, string>();
  const pool = "logical:aux:review:g:domain:security";
  const adapter: SessionAdapter = { runtime: "claude-code", async getExternalSessionId() { return "binding"; }, async clearSession() { throw Error("no rebind"); },
    async createSession(opts) {
      const evidence = { admissionId: opts.cwd, nativeOutcome: opts.cwd === "A" ? "unknown" : "completed", localOutcome: "rejected", dispatch: "attempted", terminal: { type: "result" } };
      attempts.set(opts.cwd, evidence);
      const session = { async start() {}, kill() {}, admissionProtocol: "prewrite-v1", inspectAttempt(id: string) { return id === opts.cwd ? evidence : undefined; },
        async send(_prompt: string, send?: { onAdmission?: (value: unknown) => Promise<void> }) {
          await send?.onAdmission?.({ ...evidence, nativeOutcome: "unknown", dispatch: "not-dispatched" });
          if (opts.cwd === "A") throw Object.assign(Error("original timeout"), { attempt: evidence });
          return { ...evidence, content: "completed", events: [] };
        } };
      locations.set(session, opts.cwd); return session as never;
    }, async releaseIdleSession(session) { released.push(locations.get(session)!); return "released"; } };
  const provider = new SessionBackedProvider({ id: "controlled", adapter, defaultModel: "controlled" });
  let cwd = "A"; const scoped = scopedProvider(provider, { threadId: pool, cwd: () => cwd });
  const owners: NativeOwner[] = [];
  for (const location of ["A", "B"]) {
    cwd = location;
    try { await scoped.complete([{ role: "user", content: "controlled" }], { nativeObservation: {
      owner: { threadId: "logical", generation: "g", dispatchId: location, reviewJobId: location },
      register(native) { owners.push(native.owner!); }, observe() {},
    } }); } catch (error) { expect(String(error)).toContain("original timeout"); }
  }
  attempts.get("A")!.nativeOutcome = "completed";
  expect(await scoped.completionLifecycle?.releaseOwnedAdmission?.(owners[0], "A")).toBe("released");
  expect(released).toEqual(["A"]);
  expect(await scoped.completionLifecycle?.releaseOwnedAdmission?.({ ...owners[1], reviewJobId: "foreign" }, "B")).toBe("unavailable");
  expect(released).toEqual(["A"]);
});

test("current knowledge inspection separates completed native work, rejected waiter and unresolved cleanup", () => {
  const summary = knowledgeInspectionSummary({ status: "durable", learning: { domains: { security: {
    status: "learned", nativeOutcome: "completed", localOutcome: "rejected", localError: "ORIGINAL_LOCAL_TIMEOUT",
    rpcOutcome: "resolved", transportOutcome: "open", cleanup: "releasing", capacity: "unknown", closed: true,
    native: { admissionId: "original-admission", owner: { providerSessionKey: "original-pool" } },
  } } } });
  expect(summary.domains[0].lifecycle).toEqual({ admissionId: "original-admission", providerSessionKey: "original-pool",
    localOutcome: "rejected", localError: "ORIGINAL_LOCAL_TIMEOUT", rpcOutcome: "resolved", transportOutcome: "open",
    capacity: "unknown", cleanup: "releasing", eligibility: "closed" });
  expect(knowledgeInspectionSummary({ status: "empty", learning: { domains: { security: { status: "idle" } } } }).domains[0].lifecycle.capacity).toBe("unavailable");
});

test("a completed cleanup refusal is unknown, not an eternally pending cleanup promise", async () => {
  const f = fixture(500, undefined, async () => "unknown"); await f.send(); f.emit(); await f.runtime.learningSettled(); await tick();
  const native = f.runtime.learningState.domains.security.native!;
  expect(await f.provider.completionLifecycle.inspectOwnedAdmission!(native.owner!, native.admissionId!))
    .toMatchObject({ cleanup: "unknown", capacity: "unknown", call: "settled" });
  expect(f.sends).toBe(1); expect(f.releases).toBe(1);
});
