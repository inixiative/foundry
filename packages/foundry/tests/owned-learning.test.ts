import { afterEach, expect, test } from "bun:test";
import { ContextLayer, ContextStack, EventStream, computeHash, type CompletionOpts, type LLMMessage } from "@inixiative/foundry-core";
import { ThreadRuntimeManager, type LearningConfig } from "../src/agents/thread-runtime";
import { ThreadFactory, buildAgents } from "../src/agents/thread-factory";
import { starterConfig } from "../src/viewer/config";
import { LocalSessionStore } from "../src/persistence/local-session-store";
import { KnowledgePersistence } from "../src/persistence/knowledge-persistence";
import { resolveLearningSettings, validateLearningSettings } from "../src/agents/learning-config";

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });
const fact = "Zephyr rollback requires migration order C before B.";
const answer = (knowledge = fact) => JSON.stringify({ decision: "learn", knowledge, facts: [fact], reason: "observed" });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => Bun.sleep(0);
function fixture(review: (messages: LLMMessage[], opts: CompletionOpts) => Promise<string> | string, learning: LearningConfig = {}) {
  const config = starterConfig("mock", "mock");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "mock", model: "mock", prompt: "Work", temperature: 0,
    visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const layer = new ContextLayer({ id: "security", prompt: "Configured instructions" }); layer.set("Configured domain knowledge");
  const stack = new ContextStack([layer]); const inputs: LLMMessage[][] = [];
  const calls: Array<{ messages: LLMMessage[]; opts: CompletionOpts }> = [];
  const events = new EventStream();
  const manager = new ThreadRuntimeManager({ config, log: () => {}, warn: () => {}, learning: { timeoutMs: 5, hardTimeoutMs: 200, ...learning },
    domains: [{ domain: "security", layerId: "security", guardTriggers: [] }], llm: { id: "controlled", complete: async (messages, opts = {}) => {
      if (messages.some(m => m.content.includes("## Completed work"))) {
        calls.push({ messages: structuredClone(messages), opts: structuredClone(opts) });
        return { model: "controlled", content: await review(messages, opts) };
      }
      return { model: "controlled", content: '{"domains":["security"],"layers":["security"],"confidence":1}' };
    } } });
  const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, { provider: { id: "mock", complete: async messages => {
    inputs.push(structuredClone(messages)); return { model: "mock", content: "Completed verified work" };
  } } }), runtime: manager });
  const thread = factory.create("owned", { projectId: "P" }); const runtime = manager.get(thread.id)!;
  const store = new LocalSessionStore(":memory:");
  const persistence = new KnowledgePersistence(manager, store, events, [thread]);
  closes.push(() => { manager.disposeAll(); store.close(); });
  return { manager, factory, thread, runtime, store, persistence, calls, inputs, knowledge: runtime.domainLibrarians.get("security")!.threadKnowledge };
}

test("delayed owned review commits after soft expiry; immediate work does not wait and the first post-commit input receives the fact", async () => {
  const held = deferred<string>(); const f = fixture(() => held.promise);
  await f.thread.dispatch("worker", "Investigate rollback", undefined, { messageId: "origin" });
  await Bun.sleep(10);
  const immediate = await f.thread.dispatch("worker", "Continue", undefined, { messageId: "immediate" });
  expect(f.calls).toHaveLength(1);
  expect(immediate.meta?.delivery).toMatchObject({ learningBarrier: { outcome: "pending", waitedMs: 0 } });
  expect(JSON.stringify(f.inputs[1])).not.toContain(fact);
  expect(f.runtime.learningState.domains.security.status).toBe("delayed");
  held.resolve(answer()); await f.runtime.learningSettled();
  expect(f.store.knowledge("owned")!.domains.security.content).toBe(fact);
  await f.thread.dispatch("worker", "Next independent request"); await f.runtime.learningSettled();
  expect(JSON.stringify(f.inputs[2])).toContain(fact);
  expect(JSON.stringify(f.inputs[1])).not.toContain(fact);
  const other = f.factory.create("other", { projectId: "P" });
  await other.dispatch("worker", "Other work"); await f.manager.get("other")!.learningSettled();
  expect(JSON.stringify(f.inputs[3])).not.toContain(fact);
});

test("review freezes all three segments, full knowledge tail, owner/base and separate phase options", async () => {
  const f = fixture(() => '{"decision":"abstain"}', { reviewOpts: { model: "explicit-review-model", maxTokens: 1600, thinking: "high" } });
  const base = f.runtime.knowledgeSnapshot(); const content = "K".repeat(3900) + " REQUIRED-TAIL";
  base.domains.security = { ...base.domains.security, content, hash: computeHash(content), revision: 1 };
  f.runtime.restoreKnowledge(base);
  await f.thread.dispatch("worker", "Review current work", undefined, { messageId: "complete-input" }); await f.runtime.learningSettled();
  const call = f.calls[0];
  expect(JSON.stringify(call.messages)).toContain(content);
  expect(JSON.stringify(call.messages)).toContain("Configured domain knowledge");
  expect(call.messages[0].content).toContain("reviewer");
  expect(call.opts).toMatchObject({ model: "explicit-review-model", maxTokens: 1600, thinking: "high", timeout: 0, tools: false, maxTurns: 1 });
  expect(call.opts.threadId).toContain(":review:");
  expect(f.runtime.learningState.domains.security.job).toMatchObject({ threadId: "owned", projectId: "P", base: { revision: 1, hash: computeHash(content) }, evidence: { messageId: "complete-input" } });
});

for (const raw of ["null", "[]", "42", "true", "bad-json", answer("x".repeat(4001)), JSON.stringify({ decision: "abstain", facts: ["x".repeat(1001)] }), " ".repeat(20001)]) {
  test(`invalid reviewer output is recorded without publication: ${raw.slice(0, 30)}`, async () => {
    const f = fixture(() => raw); await f.thread.dispatch("worker", "Work"); await f.runtime.learningSettled();
    expect(f.knowledge.revision).toBe(0);
    expect(f.knowledge.history.at(-1)?.decision).toBe("invalid");
    expect(f.store.learningHistory("owned").at(-1)?.signal.content).toMatchObject({ decision: "invalid" });
  });
}

test("hard expiry is permanent; late result reconciles occupancy only and queued evidence cannot launch another review", async () => {
  const held = deferred<string>(); const f = fixture(() => held.promise, { hardTimeoutMs: 20 });
  await f.thread.dispatch("worker", "First"); await f.thread.dispatch("worker", "Queued");
  await f.runtime.learningSettled();
  expect(f.runtime.learningOutstanding).toBe(1); expect(f.calls).toHaveLength(1);
  held.resolve(answer()); await tick(); await tick();
  expect(f.knowledge.revision).toBe(0); expect(f.runtime.learningOutstanding).toBe(0);
  expect(f.calls).toHaveLength(1);
  expect(f.runtime.learningState.domains.security).toMatchObject({ status: "expired", queued: 0, closed: true });
  expect(f.store.learningHistory("owned").some(row => (row.signal.content as any).decision === "deferred")).toBe(true);
});

test("restore and disposal invalidate a pending base without losing its terminal evidence", async () => {
  for (const mode of ["restore", "dispose"]) {
    const held = deferred<string>(); const f = fixture(() => held.promise);
    await f.thread.dispatch("worker", "First");
    if (mode === "dispose") f.runtime.dispose(); else f.runtime.restoreKnowledge(f.runtime.knowledgeSnapshot());
    held.resolve(answer()); await f.runtime.learningSettled();
    expect(f.knowledge.revision).toBe(0);
    expect(f.knowledge.history.at(-1)?.decision).toBe(mode === "dispose" ? "discarded" : "stale");
  }
});

test("real SQL failure rolls back candidate/event and preserves completed output and old revision", async () => {
  const held = deferred<string>(); const f = fixture(() => held.promise);
  const result = await f.thread.dispatch("worker", "Complete then fail storage");
  (f.store as any).db.exec("CREATE TRIGGER deny_learning BEFORE INSERT ON session_knowledge BEGIN SELECT RAISE(ABORT, 'owned SQL failure'); END");
  held.resolve(answer()); await f.runtime.learningSettled();
  expect(result.output).toBe("Completed verified work");
  expect(f.store.knowledge("owned")).toBeUndefined(); expect(f.knowledge.revision).toBe(0);
  expect(f.persistence.inspect("owned")).toMatchObject({ status: "blocked" });
  expect(f.store.learningHistory("owned").some(row => (row.signal.content as any).decision === "write-failed")).toBe(true);
  const replacement = f.factory.create("owned", { projectId: "P" });
  expect(replacement.disposed).toBe(true); // replacement is not an implicit storage repair/retry
});

test("durable success followed by publication failure is reconciliation-needed, never unsaved or replayed", async () => {
  const held = deferred<string>(); const f = fixture(() => held.promise);
  await f.thread.dispatch("worker", "Work");
  f.knowledge.layer.set = () => { throw Error("publication observer failed"); };
  held.resolve(answer()); await f.runtime.learningSettled();
  expect(f.store.knowledge("owned")!.domains.security.content).toBe(fact);
  expect(f.persistence.inspect("owned")).toMatchObject({ status: "reconciliation-needed" });
  expect(f.calls).toHaveLength(1); expect(f.inputs).toHaveLength(1);
});

test("terminal at the hard boundary latches closed before candidate validation and never drains queued work", async () => {
  let now = 0; const held = deferred<string>();
  const f = fixture(() => held.promise, { clock: () => now });
  await f.thread.dispatch("worker", "First"); await f.thread.dispatch("worker", "Queued");
  now = 200; held.resolve(answer()); await f.runtime.learningSettled(); await tick();
  expect(f.calls).toHaveLength(1); expect(f.knowledge.revision).toBe(0);
  expect(f.runtime.learningState.domains.security.status).toBe("expired");
});

test("deadline crossed inside SQL transaction rolls back and permanently closes eligibility", async () => {
  let now = 0; const held = deferred<string>(); const f = fixture(() => held.promise, { clock: () => now });
  await f.thread.dispatch("worker", "First"); await f.thread.dispatch("worker", "Queued");
  const saveThread = f.store.saveThread.bind(f.store);
  f.store.saveThread = thread => { saveThread(thread); now = 200; };
  held.resolve(answer()); await f.runtime.learningSettled(); await tick();
  expect(f.store.knowledge("owned")).toBeUndefined(); expect(f.knowledge.revision).toBe(0);
  expect(f.calls).toHaveLength(1); expect(f.runtime.learningState.domains.security.status).toBe("expired");
});

test("foreign/snapshot job objects cannot exercise the live admission's commit authority", async () => {
  const held = deferred<string>(); const f = fixture(() => held.promise);
  await f.thread.dispatch("worker", "First");
  const snapshot = f.runtime.learningState.domains.security.job!;
  expect(f.runtime.reviewEligible(snapshot)).toBe(false);
  expect(f.runtime.reviewEligible({ ...snapshot, threadId: "foreign" })).toBe(false);
  snapshot.base.evidence.push({ kind: "signal", id: "tamper", timestamp: 0 });
  expect(f.runtime.learningState.domains.security.job!.base.evidence).toHaveLength(0);
  held.resolve(answer()); await f.runtime.learningSettled();
  expect(f.knowledge.revision).toBe(1);
});

test("the journal rejects stale bases and duplicate evidence while retaining the original committed revision", async () => {
  const f = fixture(() => answer()); await f.thread.dispatch("worker", "First"); await f.runtime.learningSettled();
  const prior = f.store.knowledge("owned")!; const event = f.store.learningHistory("owned").find(e => (e.signal.content as any).decision === "learned")!.signal;
  const job = (event.content as any).job;
  expect(f.store.saveKnowledge(f.thread, prior, event, { job, eligible: () => true })).toBe("duplicate");
  const forged = { ...job, id: "another-review" };
  expect(f.store.saveKnowledge(f.thread, prior, { ...event, id: forged.id, content: { ...(event.content as any), job: forged } }, { job: forged, eligible: () => true })).toBe("stale");
  expect(f.store.knowledge("owned")).toEqual(prior);
});

test("unknown occupancy survives runtime disposal and cannot launch a replacement review generation", async () => {
  const held = deferred<string>(); const f = fixture(() => held.promise);
  await f.thread.dispatch("worker", "First"); f.runtime.dispose();
  const replacement = f.factory.create("owned", { projectId: "P" });
  await replacement.dispatch("worker", "Independent new request");
  await f.manager.get("owned")!.learningSettled();
  expect(f.calls).toHaveLength(1);
  expect(f.manager.get("owned")!.learningState.domains.security.status).toBe("blocked-previous-occupancy");
  held.resolve(answer()); await f.runtime.learningSettled();
  expect(f.knowledge.revision).toBe(0);
});

test("a local reviewer failure keeps its original error and blocks automatic replacement calls", async () => {
  const f = fixture(async () => { throw Error("original provider transport failure"); });
  await f.thread.dispatch("worker", "First"); await f.runtime.learningSettled();
  await f.thread.dispatch("worker", "Queued"); await f.runtime.learningSettled();
  expect(f.calls).toHaveLength(1);
  expect(f.knowledge.history.find(record => record.decision === "error")).toMatchObject({ reason: "original provider transport failure" });
  expect(f.knowledge.history.at(-1)?.decision).toBe("deferred");
  expect(f.runtime.learningState.domains.security.nativeOutcome).toBe("unknown");
});

test("explicit review configuration is resolved faithfully; unavailable providers and invalid budgets fail closed", () => {
  const native = { id: "claude-code", complete: async () => ({ model: "requested", content: "" }) };
  const other = { ...native, id: "other" };
  const resolved = resolveLearningSettings({ review: { provider: "other", model: "chosen", maxTokens: 1700, thinking: "high" } }, new Map([["other", other]]), native, "central");
  expect(resolved.reviewProvider).toBe(other); expect(resolved.reviewOpts).toMatchObject({ model: "chosen", maxTokens: 1700, thinking: "high" });
  expect(resolveLearningSettings(undefined, new Map(), native, "central").reviewOpts!.model).toBe("central");
  expect(() => resolveLearningSettings({ review: { provider: "missing" } }, new Map(), native)).toThrow("unavailable");
  for (const invalid of [null, [], { review: { tools: true } }, { review: { maxTokens: 0 } }, { hardTimeoutMs: 5 }, { maxKnowledgeChars: 4001 }, { review: { thinking: "ultra" } }]) {
    expect(() => validateLearningSettings(invalid)).toThrow();
  }
});

test("a real layer mutation observer failure preserves durable commit and records reconciliation before any signal observer", async () => {
  const held = deferred<string>(); const f = fixture(() => held.promise);
  await f.thread.dispatch("worker", "Work");
  f.knowledge.layer.onMutation(() => { throw Error("original mutation observer error"); });
  f.thread.signals.emit = async () => { throw Error("secondary signal observer error"); };
  held.resolve(answer()); await f.runtime.learningSettled();
  expect(f.store.knowledge("owned")!.domains.security.content).toBe(fact);
  expect(f.persistence.inspect("owned")).toMatchObject({ status: "reconciliation-needed" });
  expect((f.persistence.inspect("owned") as any).error).toContain("original mutation observer error");
  expect(f.inputs).toHaveLength(1); expect(f.runtime.disposed).toBe(true);
});

test("a foreign owner change during review cannot commit and does not adopt the old queue", async () => {
  const held = deferred<string>(); const f = fixture(() => held.promise);
  await f.thread.dispatch("worker", "First"); await f.thread.dispatch("worker", "Queued");
  f.thread.meta.projectId = "Q";
  held.resolve(answer()); await f.runtime.learningSettled();
  expect(f.knowledge.revision).toBe(0); expect(f.store.knowledge("owned")).toBeUndefined();
  expect(f.calls).toHaveLength(1);
  expect(f.knowledge.history.some(record => record.decision === "foreign")).toBe(true);
  // The review's durable "requested" record predates the owner change and is not a commit; no outcome was journalled.
  expect(f.store.learningHistory("owned").filter(row => (row.signal.content as { decision?: string }).decision !== "requested")).toHaveLength(0);
});

test("a foreign dispatch envelope is diagnosed without admitting or retaining its private review payload", async () => {
  const f = fixture(() => answer());
  await f.thread.signals.emit({ id: "foreign-dispatch", kind: "dispatch", source: "worker", timestamp: Date.now(), content: {
    threadId: "another-thread", agentId: "worker", payload: "FOREIGN-PRIVATE", output: "FOREIGN-PRIVATE", ok: true,
  } });
  await f.runtime.learningSettled();
  expect(f.calls).toHaveLength(0); expect(f.knowledge.revision).toBe(0);
  expect(f.knowledge.history.at(-1)?.decision).toBe("foreign");
  expect(JSON.stringify(f.runtime.learningState)).not.toContain("FOREIGN-PRIVATE");
});

test("unavailable native budgets stay unenforced and configured knowledge is never silently clipped", async () => {
  let sends = 0;
  const f = fixture(() => '{"decision":"abstain"}', { reviewProvider: { id: "claude-code", complete: async () => {
    sends++; return { model: "requested-not-acknowledged", content: '{"decision":"abstain"}' };
  } }, reviewOpts: { thinking: "high" } });
  f.runtime.domainLibrarians.get("security")!.cache.set("C".repeat(40001));
  await f.thread.dispatch("worker", "Work"); await f.runtime.learningSettled();
  expect(sends).toBe(0);
  expect(f.knowledge.history.at(-1)?.decision).toBe("invalid");
  expect(f.runtime.learningState.domains.security.job!.budgets).toMatchObject({ nativeTokens: "requested-unenforced", nativeEffort: "requested-unenforced" });
});
