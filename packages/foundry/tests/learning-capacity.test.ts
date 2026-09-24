import { afterEach, expect, test } from "bun:test";
import { ContextLayer, ContextStack, EventStream, type LLMProvider } from "@inixiative/foundry-core";
import { ThreadRuntimeManager, scopedProvider } from "../src/agents/thread-runtime";
import { ThreadFactory, buildAgents } from "../src/agents/thread-factory";
import { starterConfig } from "../src/viewer/config";
import { KnowledgePersistence } from "../src/persistence/knowledge-persistence";
import { LocalSessionStore } from "../src/persistence/local-session-store";
import { OpenAIProvider } from "../src/providers/openai";
import { AnthropicProvider } from "../src/providers/anthropic";
import { GeminiProvider } from "../src/providers/gemini";
import { SessionBackedProvider } from "../src/providers/session-backed";
import { GatedProvider } from "../src/providers/gated";
import { resolveLearningSettings } from "../src/agents/learning-config";

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });
const abstain = { model: "controlled", content: '{"decision":"abstain"}' };
function held<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(provider: LLMProvider, store = new LocalSessionStore(":memory:"), hardTimeoutMs = 1000) {
  const config = starterConfig("controlled", "controlled");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "controlled", model: "controlled", prompt: "Work",
    temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const layer = new ContextLayer({ id: "security" }); layer.set("Configured domain");
  const stack = new ContextStack([layer]); const events = new EventStream();
  const manager = new ThreadRuntimeManager({ config, log() {}, warn() {}, eventStream: events,
    domains: [{ domain: "security", layerId: "security", guardTriggers: [] }],
    learning: { reviewProvider: provider, timeoutMs: 2, hardTimeoutMs },
    llm: { id: "flow", async complete() { return { model: "flow", content: '{"domains":["security"],"layers":["security"],"confidence":1}' }; } } });
  const factory = new ThreadFactory({ stack, runtime: manager, agents: buildAgents(config, stack, { provider: {
    id: "central", async complete() { return { model: "central", content: "COMPLETED_CENTRAL_OUTPUT" }; },
  } }) });
  // Persistence attaches before runtime creation, exercising reused/new runtime restoration.
  const persistence = new KnowledgePersistence(manager, store, events, []);
  const thread = factory.create("capacity", { projectId: "P" }); const runtime = manager.get(thread.id)!;
  closes.push(() => { manager.disposeAll(); });
  return { manager, factory, thread, runtime, store, persistence, async send(id: string) {
    return thread.dispatch("worker", `Independent ${id}`, undefined, { messageId: id });
  }, history() { return store.learningHistory(thread.id, 1000).map(row => row.signal.content as any); } };
}

test("review refused during owned native cleanup is durably deferred with job/evidence and no second native send", async () => {
  let sends=0; const exit=held<"released">();
  const adapter:any={runtime:"claude-code",getExternalSessionId:async()=>"own",clearSession:async()=>{throw Error("no rebind");},
    createSession:async()=>({admissionProtocol:"prewrite-v1",start:async()=>{},send:async(_prompt:string,opts:any)=>{await opts.onAdmission?.({admissionId:"owned-review-admission",dispatch:"not-dispatched",nativeOutcome:"unknown",localOutcome:"pending"});sends++;return {admissionId:"owned-review-admission",nativeOutcome:"completed",content:abstain.content,externalSessionId:"own",events:[{kind:"result",raw:{type:"result",subtype:"success",session_id:"own"}}]};}}),releaseIdleSession:()=>exit.promise};
  const provider=new SessionBackedProvider({id:"native",adapter,defaultModel:"controlled"});
  const f=fixture(provider);closes.push(()=>{exit.resolve("released");f.manager.disposeAll();f.store.close();});
  await f.send("one");await f.runtime.learningSettled();await Bun.sleep(0);
  await f.send("two");await f.runtime.learningSettled();
  const deferred=f.history().find(r=>r.decision==="deferred"&&r.job?.evidence?.messageId==="two");
  expect(deferred?.admission).toBe("not-admitted");
  expect(deferred).toBeDefined();expect(deferred.reason).toContain("not admitted");expect(deferred.job.threadId).toBe("capacity");
  expect(sends).toBe(1);expect(f.history().some(r=>r.decision==="error"&&r.job?.evidence?.messageId==="two")).toBe(false);
  exit.resolve("released");
});

test("hot queue is bounded while active; overflow and hard-closed payloads become durable evidence links", async () => {
  const wait = held<typeof abstain>(); let calls = 0;
  const f = fixture({ id: "unknown", async complete() { calls++; return wait.promise; } }, undefined, 100);
  closes.unshift(() => f.store.close());
  await f.send("first");
  for (let i = 0; i < 24; i++) await f.send(`queued-${i}`);
  expect(f.runtime.learningState.domains.security.queued).toBeLessThanOrEqual(8);
  expect(f.history().filter(r => r.decision === "deferred")).toHaveLength(16);
  await f.runtime.learningSettled();
  expect(f.runtime.learningState.domains.security.queued).toBe(0);
  expect(f.history().filter(r => r.decision === "deferred")).toHaveLength(24);
  expect(f.history().filter(r => r.decision === "deferred").every(r => r.owner.projectId === "P" && !r.userMessage && !r.output)).toBe(true);
  wait.resolve(abstain); await Bun.sleep(0);
  expect(calls).toBe(1);
  expect(f.history().some(r => r.decision === "capacity-settled" && r.capacity === "settled")).toBe(true);
  expect(f.runtime.reconcileReviewCapacity("security")).toBe(true);
  expect(calls).toBe(1); // reconciliation is not admission or replay
  await f.send("distinct-after-explicit-reconciliation"); await f.runtime.learningSettled();
  expect(calls).toBe(2);
});

test("unknown error remains closed across runtime reconstruction and never calls releaseIdle", async () => {
  let calls = 0, releases = 0;
  const provider: LLMProvider = { id: "not-a-native-looking-name", completionLifecycle: { kind: "session",
    settlement: () => "unknown", async releaseIdle() { releases++; return "released"; } },
    async complete() { calls++; throw Error("unknown native operation"); } };
  const f = fixture(provider); closes.unshift(() => f.store.close());
  await f.send("first"); await f.runtime.learningSettled(); f.manager.disposeAll();
  expect(f.runtime.reconcileReviewCapacity("security")).toBe(false);
  const next = fixture(provider, f.store);
  const result = await next.send("new-distinct"); await next.runtime.learningSettled();
  expect(calls).toBe(1); expect(releases).toBe(0);
  expect(result.meta?.delivery).toMatchObject({ learningBarrier: { outcome: "closed", pending: [] } });
  expect(next.history().at(-1)).toMatchObject({ decision: "deferred", evidence: { messageId: "new-distinct" } });
});

test("disposed stateless late settlement releases only original occupancy; replacement cannot steal it", async () => {
  const wait = held<typeof abstain>(); let calls = 0, releases = 0;
  const f = fixture({ id: "request-provider", completionLifecycle: { kind: "request", settlement: () => "settled",
    async releaseIdle() { releases++; return "released"; } }, async complete() { calls++; return wait.promise; } });
  closes.unshift(() => f.store.close());
  await f.send("first"); f.runtime.dispose();
  const replacement = f.factory.create("capacity", { projectId: "P" }); const blocked = f.manager.get("capacity")!;
  await replacement.dispatch("worker", "while unknown"); await blocked.learningSettled(); expect(calls).toBe(1);
  wait.resolve(abstain); await f.runtime.learningSettled(); await Bun.sleep(0);
  expect(releases).toBe(1); expect(f.history().some(r => r.decision === "discarded" && r.capacity === "settled")).toBe(true);
  blocked.dispose();
  const ready = f.factory.create("capacity", { projectId: "P" });
  await ready.dispatch("worker", "new work after settlement"); await f.manager.get("capacity")!.learningSettled();
  expect(calls).toBe(2);
});

test("publication failure audit is durable before a hanging observer and survives reconstruction", async () => {
  let calls = 0;
  const f = fixture({ id: "request", async complete() { calls++; return { model: "controlled", content: '{"decision":"learn","knowledge":"Zephyr rollback C before B"}' }; } });
  closes.unshift(() => f.store.close());
  f.runtime.domainLibrarians.get("security")!.threadKnowledge.layer.set = () => { throw Error("publication broke"); };
  f.thread.signals.on("domain_learning", async signal => {
    if ((signal.content as any).decision === "reconciliation-needed") await new Promise(() => {});
  });
  const result = await f.send("fact"); await f.runtime.learningSettled();
  expect(result.output).toBe("COMPLETED_CENTRAL_OUTPUT");
  expect(f.persistence.inspect("capacity")).toMatchObject({ status: "reconciliation-needed" });
  expect(f.history().find(r => r.decision === "reconciliation-needed")).toMatchObject({ persistence: "reconciliation-needed", reason: expect.stringContaining("publication broke") });
  const next = fixture({ id: "request", async complete() { throw Error("must not run on restoration"); } }, f.store);
  expect(next.runtime.knowledgeSnapshot().domains.security.content).toBe("Zephyr rollback C before B");
  expect(next.history().some(r => r.decision === "reconciliation-needed")).toBe(true);
  expect(calls).toBe(1);
});

test("a rejected audit write is blocked and cannot be presented as durable deferral", async () => {
  const f = fixture({ id: "unknown", async complete() { throw Error("unknown"); } }); closes.unshift(() => f.store.close());
  await f.send("first"); await f.runtime.learningSettled();
  (f.store as any).db.exec("CREATE TRIGGER deny_audit BEFORE INSERT ON session_learning BEGIN SELECT RAISE(ABORT, 'audit denied'); END");
  const result = await f.send("refused-write");
  expect(result.output).toBe("COMPLETED_CENTRAL_OUTPUT");
  expect(f.persistence.inspect("capacity")).toMatchObject({ status: "blocked" });
  expect(f.history().some(r => r.evidence.messageId === "refused-write")).toBe(false);
});

for (const Provider of [OpenAIProvider, AnthropicProvider, GeminiProvider]) {
  test(`${Provider.name} owns completed HTTP-error evidence; arbitrary and foreign errors remain unknown through wrappers`, async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("completed 503", { status: 503 }); } });
    closes.push(() => server.stop(true));
    const provider = new Provider({ apiKey: "test-only", baseUrl: `http://127.0.0.1:${server.port}` });
    const wrapped = scopedProvider(new GatedProvider({ provider, gate: { policy: {}, require: async () => {} } as any, threadId: "T" }), { threadId: "T" });
    let failure: unknown;
    try { await wrapped.complete([{ role: "user", content: "controlled" }]); } catch (error) { failure = error; }
    expect(wrapped.completionLifecycle?.settlement({ error: failure })).toBe("settled");
    expect(wrapped.completionLifecycle?.settlement({ error: Error("completed 503") })).toBe("unknown");
    const other = new Provider({ apiKey: "test-only" });
    expect(other.completionLifecycle.settlement({ error: failure })).toBe("unknown");
  });
}

test("native cleanup refuses unknown work and retains a confirmed idle review binding", async () => {
  for (const confirmed of [false, true]) {
    let kills = 0, clears = 0;
    const session = { start: async () => {}, kill: () => { kills++; }, send: async () => ({ content: "done", externalSessionId: "own-binding",
      events: confirmed ? [{ kind: "result", raw: { type: "result", subtype: "success", session_id: "own-binding" } }] : [] }) };
    const provider = new SessionBackedProvider({ id: "arbitrary-native-id", defaultModel: "requested", defaultCwd: "/controlled",
      adapter: { runtime: "claude-code", createSession: async () => session, getExternalSessionId: async () => "own-binding",
        releaseIdleSession: async () => { session.kill(); return "released"; }, clearSession: async () => { clears++; } } as any });
    const opts = { threadId: "T:aux:review:owned:domain:security" };
    const result = await provider.complete([{ role: "user", content: "work" }], opts);
    expect(provider.completionLifecycle.settlement({ result })).toBe(confirmed ? "settled" : "unknown");
    expect(await provider.completionLifecycle.releaseIdle!(opts)).toBe(confirmed ? "released" : "unknown");
    expect(kills).toBe(confirmed ? 1 : 0); expect(clears).toBe(0);
    expect(await provider.completionLifecycle.releaseIdle!({ threadId: "central" })).toBe("unavailable");
  }
});

test("review defaults follow the supplied flow profile; an explicit central profile is never downgraded", () => {
  const flow: LLMProvider = { id: "flow", async complete() { return abstain; } };
  const central: LLMProvider = { id: "central", async complete() { return abstain; } };
  const providers = new Map([[flow.id, flow], [central.id, central]]);
  const defaults = resolveLearningSettings(undefined, providers, flow, "configured-flow-model");
  expect(defaults.reviewProvider).toBe(flow); expect(defaults.reviewOpts?.model).toBe("configured-flow-model");
  const explicit = resolveLearningSettings({ review: { provider: "central", model: "explicit-strong-model", thinking: "high" } }, providers, flow, "configured-flow-model");
  expect(explicit.reviewProvider).toBe(central); expect(explicit.reviewOpts).toMatchObject({ model: "explicit-strong-model", thinking: "high" });
  expect(scopedProvider({ id: "uncontracted", async complete() { return abstain; } }, { threadId: "T" }).completionLifecycle).toBeUndefined();
});

test("native cleanup cannot lose a concurrent unknown call behind another completion", async () => {
  let kills = 0; const unknown = held<any>(); let sends = 0;
  const session = { start: async () => {}, kill: () => { kills++; }, send: async () => ++sends === 1 ? unknown.promise : ({ content: "done", externalSessionId: "own",
    events: [{ kind: "result", raw: { type: "result", subtype: "success", session_id: "own" } }] }) };
  const provider = new SessionBackedProvider({ id: "native", defaultModel: "requested", adapter: { runtime: "claude-code",
    createSession: async () => session, getExternalSessionId: async () => "own" } as any });
  const opts = { threadId: "T:aux:review:owned:domain:security" };
  const first = provider.complete([{ role: "user", content: "one" }], opts);
  await Bun.sleep(0);
  await provider.complete([{ role: "user", content: "two" }], opts);
  expect(await provider.completionLifecycle.releaseIdle!(opts)).toBe("unknown");
  unknown.resolve({ content: "local-only", externalSessionId: "own", events: [] }); await first;
  expect(await provider.completionLifecycle.releaseIdle!(opts)).toBe("unknown"); expect(kills).toBe(0);
});

test("pending owned exit prevents new admission and pool eviction until actual release evidence", async () => {
  let sends = 0, creates = 0, clears = 0; const exit = held<"released">();
  const adapter = { runtime: "claude-code", getExternalSessionId: async () => "retained-binding",
    createSession: async () => { creates++; return { start: async () => {}, kill() {}, send: async () => {
      sends++; return { content: "done", externalSessionId: "retained-binding", events: [
        { kind: "result", raw: { type: "result", subtype: "success", session_id: "retained-binding" } },
      ] };
    } }; }, releaseIdleSession: () => exit.promise, clearSession: async () => { clears++; } };
  const provider = new SessionBackedProvider({ id: "native", adapter: adapter as any, defaultModel: "controlled" });
  const opts = { threadId: "T:aux:review:g:domain:security" };
  await provider.complete([{ role: "user", content: "first" }], opts);
  const release = provider.completionLifecycle.releaseIdle!(opts); await Bun.sleep(0);
  await expect(provider.complete([{ role: "user", content: "while exiting" }], opts)).rejects.toThrow("not admitted");
  expect(sends).toBe(1); expect(creates).toBe(1); expect(provider.warmProfile(opts.threadId)).toBeDefined();
  exit.resolve("released"); expect(await release).toBe("released");
  expect(provider.warmProfile(opts.threadId)).toBeUndefined();
  await provider.complete([{ role: "user", content: "distinct after exit" }], opts);
  expect(sends).toBe(2); expect(creates).toBe(2); expect(clears).toBe(0);
});

test("cleanup keeps the completed call's cwd when the owning thread changes worktree", async () => {
  let cwd = "/owned/original"; const wait = held<typeof abstain>(); let released: unknown;
  const provider = scopedProvider({ id: "owned", complete: async () => wait.promise,
    completionLifecycle: { kind: "session", settlement: () => "settled", async releaseIdle(opts) { released = opts; return "released"; } },
  }, { threadId: "T:aux:review:owned", cwd: () => cwd });
  const work = provider.complete([{ role: "user", content: "work" }]);
  cwd = "/owned/new-worktree"; wait.resolve(abstain); await work;
  await provider.completionLifecycle!.releaseIdle!({});
  expect(released).toMatchObject({ threadId: "T:aux:review:owned", cwd: "/owned/original" });
});
