import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextLayer, ContextStack, EventStream, Harness, SignalBus, type LLMMessage, type LLMProvider } from "@inixiative/foundry-core";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { ThreadFactory, buildAgents } from "../src/agents/thread-factory";
import { starterConfig } from "../src/viewer/config";
import { KnowledgePersistence } from "../src/persistence/knowledge-persistence";
import { LocalSessionStore } from "../src/persistence/local-session-store";
import { serializeTrace } from "../src/persistence/trace-record";
import { Cartographer } from "../src/agents/cartographer";
import { DomainLibrarian, GUARD_RESPONSE_PROTOCOL } from "../src/agents/domain-librarian";
import { FlowOrchestrator } from "../src/agents/flow-orchestrator";
import { Librarian } from "../src/agents/librarian";
// @ts-ignore untyped viewer module (plain JS)
import { guardOutcomes, routingRequest, expertParticipants, participantRequest } from "../src/viewer/ui/inspector-data.js";

// Pending and late phase durability (Fable, CORE-006 LI). Real runtime, factory, Harness, orchestrator, experts,
// knowledge persistence and a file-backed SQLite journal; controlled providers only. No model, browser or subprocess.

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });
function gate() { let resolve!: (v: string) => void, reject!: (e: unknown) => void; const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
const GUARD = "## Response protocol (guard phase)";
async function until(predicate: () => boolean, label: string, ms = 1500) { const end = performance.now() + ms; while (!predicate()) { if (performance.now() > end) throw Error(`deadline: ${label}`); await Bun.sleep(2); } }

function fixture(path: string, opts: { guard?: (messages: LLMMessage[]) => Promise<string> | string; central?: () => string; journal?: boolean } = {}) {
  const config = starterConfig("controlled", "controlled");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "controlled", model: "controlled", prompt: "Work", temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const layer = new ContextLayer({ id: "architecture", segment: "domain-knowledge" }); layer.set("DOMAIN_BEFORE: existing readers keep working.");
  const stack = new ContextStack([layer]); const events = new EventStream();
  const aux: LLMMessage[][] = [];
  const auxiliary: LLMProvider = { id: "controlled-aux", async complete(messages) { aux.push(structuredClone(messages));
    if (messages.some(m => m.content.includes(GUARD))) return { model: "controlled", content: await (opts.guard ?? (() => '{"findings":[]}'))(messages) };
    if (messages.some(m => m.content.includes("## Message to route"))) return { model: "controlled", content: '{"domains":["architecture"],"layers":["architecture"],"confidence":1}' };
    return { model: "controlled", content: '{"layers":["architecture"],"snippets":["Keep legacy readers"],"confidence":1}' }; } };
  const reviewer: LLMProvider = { id: "controlled-review", async complete() { return { model: "controlled", content: '{"decision":"abstain","reason":"nothing new"}' }; } };
  const manager = new ThreadRuntimeManager({ config, log() {}, warn() {}, eventStream: events,
    domains: [{ domain: "architecture", layerId: "architecture", guardTriggers: ["Write"], guardPrompt: "CUSTOM_GUARD: storage only." }],
    learning: { reviewProvider: reviewer, timeoutMs: 2, hardTimeoutMs: 2000 }, llm: auxiliary });
  const factory = new ThreadFactory({ stack, runtime: manager, agents: buildAgents(config, stack, { provider: { id: "central", async complete() { return { model: "central", content: (opts.central ?? (() => "COMPLETED_CENTRAL_OUTPUT"))() }; } } }) });
  const store = new LocalSessionStore(path);
  if (opts.journal !== false) new KnowledgePersistence(manager, store, events, []);
  const thread = factory.create("durability", { projectId: "P" }); const runtime = manager.get(thread.id)!;
  closes.push(() => { manager.disposeAll(); });
  const harness = new Harness(thread); harness.setDefaultExecutor("worker");
  let tools = 0;
  const observe = (dispatchId: string | undefined) => thread.signals.emit({ id: `sig-tool-${++tools}`, kind: "tool_observation", source: `thread:${thread.id}`, timestamp: Date.now(),
    content: { threadId: thread.id, dispatchId, agentId: "worker", tool: "Write", callId: `call-${tools}`, input: { file_path: "contacts.ts" }, ok: true, output: "Changed schema" } });
  // A real tool observation on the live dispatch, not awaited: central work is never delayed by guards.
  thread.middleware.use("test-tool-observation", async (ctx, next) => { void observe(ctx.dispatchId); return next(); });
  const turn = async (turnId: string, message: string) => {
    store.beginTurn(thread, turnId, message);
    try {
      const sent = await harness.send({ id: turnId, payload: message, timestamp: Date.now() } as any);
      store.completeTurn(thread, turnId, String(sent.result.output ?? ""), { ...(sent.result.meta ?? {}) }, serializeTrace(sent.trace));
      return { ok: true as const, sent };
    } catch (error) { store.failTurn(thread, turnId, String((error as Error)?.message ?? error)); return { ok: false as const, error }; }
  };
  return { manager, thread, runtime, store, layer, aux, turn, observe, events };
}

test("a held guard's exact request is durable before its answer; the late outcome reconciles the original record after the turn is journalled", async () => {
  const held = gate(); const dir = await mkdtemp(join(tmpdir(), "phase-durability-")); const path = join(dir, "sessions.sqlite");
  const f = fixture(path, { guard: () => held.promise }); closes.push(() => { held.resolve('{"findings":[]}'); f.store.close(); });
  const done = await f.turn("turn-1", "Add preferred names");
  expect(done.ok).toBe(true);
  await f.runtime.learningSettled();
  await until(() => f.store.phaseHistory(f.thread.id, { turnId: "turn-1" }).some(r => r.phase === "guard-request"), "guard request journalled");
  // Journalled while the guard provider is still holding: route, advice and the guard request, no outcome.
  const before = f.store.phaseHistory(f.thread.id, { turnId: "turn-1" });
  expect(before.map(r => r.phase)).toEqual(["route", "advice", "guard-request"]);
  const request = before[2]!;
  expect(request.dispatchId).toBeTruthy(); expect(request.turnId).toBe("turn-1");
  expect(request.record).toMatchObject({ correlation: "live-dispatch", domain: "architecture", threadKnowledgeRevision: 0, observation: { signalId: "sig-tool-1", tool: "Write", callId: "call-1", agentId: "worker" } });
  const guardCall = f.aux.find(ms => ms.some(m => m.content.includes(GUARD)))!;
  expect((request.record.request as any).messages).toEqual(guardCall);
  expect((request.record.request as any).messages[0]).toEqual({ role: "system", content: "CUSTOM_GUARD: storage only." });
  // The completed turn's own meta says the guard is pending; nothing anywhere says all-clear.
  const detail = f.store.turnDetail(f.thread.id, "turn-1")!;
  const pending = guardOutcomes({ detail })!;
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ source: "journal", status: "pending", correlation: "live-dispatch", tool: "Write", callId: "call-1", failed: [], findings: null });
  expect(pending[0]!.outcomes).toEqual([{ domain: "architecture", status: "pending", findings: 0, error: null, admission: null, revision: 0, reference: "unreferenced", requestRecord: request.id, request: { state: "recorded", phase: "guard", providerId: "controlled-aux", capturedAt: (request.record.request as any).capturedAt, messages: guardCall } }]);
  expect((detail.messages.find(m => m.actor === "agent")!.meta as any).phases.guards[0].status).toBe("pending");
  expect((detail.messages.find(m => m.actor === "agent")!.meta as any).phases.journal).toEqual({ route: "durable", advice: "durable" });
  // Late answer: the outcome row references the original request; the request row is unchanged.
  held.resolve('{"findings":[]}');
  await until(() => f.store.phaseHistory(f.thread.id, { turnId: "turn-1" }).some(r => r.phase === "guard-outcome"), "guard outcome journalled");
  const after = f.store.phaseHistory(f.thread.id, { turnId: "turn-1" });
  expect(after.map(r => r.phase)).toEqual(["route", "advice", "guard-request", "guard-outcome"]);
  expect(after[2]).toEqual(request);
  const outcome = after[3]!.record as any;
  expect(outcome).toMatchObject({ status: "reported", correlation: "live-dispatch", failed: [], findings: 0, requests: { architecture: request.id } });
  expect(outcome.outcomes[0]).toMatchObject({ domain: "architecture", status: "completed", findings: 0, requestRecord: request.id, requestState: "supplied" });
  expect(outcome.outcomes[0].request).toBeUndefined(); // referenced, not repeated
  f.store.close();
  const reopened = new LocalSessionStore(path); closes.push(() => reopened.close());
  const settled = guardOutcomes({ detail: reopened.turnDetail(f.thread.id, "turn-1") })!;
  expect(settled[0]).toMatchObject({ status: "reported", failed: [], findings: 0 });
  expect(settled[0]!.outcomes[0]).toMatchObject({ domain: "architecture", status: "completed", request: { state: "recorded", messages: guardCall } });
  expect(routingRequest({ detail: reopened.turnDetail(f.thread.id, "turn-1") })).toMatchObject({ state: "recorded", status: "routed", request: { state: "recorded", providerId: "controlled-aux" } });
});

test("successful, failed and thrown guard controls: findings are recorded, a provider failure is listed as not completed, a thrown guard is provider-error with an unobserved request", async () => {
  let mode: "findings" | "throw" = "findings";
  const dir = await mkdtemp(join(tmpdir(), "phase-durability-")); const path = join(dir, "sessions.sqlite");
  const f = fixture(path, { guard: () => { if (mode === "throw") throw Error("CONTROLLED_GUARD_REFUSAL"); return '{"findings":[{"severity":"advisory","description":"Add a migration test"}]}'; } });
  closes.push(() => f.store.close());
  expect((await f.turn("turn-1", "Add preferred names")).ok).toBe(true);
  await until(() => f.store.phaseHistory(f.thread.id, { turnId: "turn-1" }).some(r => r.phase === "guard-outcome"), "outcome 1");
  const one = guardOutcomes({ detail: f.store.turnDetail(f.thread.id, "turn-1") })!;
  expect(one[0]).toMatchObject({ status: "reported", failed: [], findings: 1, critical: 0 });
  expect(one[0]!.outcomes[0]).toMatchObject({ domain: "architecture", status: "completed", findings: 1, request: { state: "recorded" } });
  mode = "throw";
  expect((await f.turn("turn-2", "Rename column")).ok).toBe(true);
  await until(() => f.store.phaseHistory(f.thread.id, { turnId: "turn-2" }).some(r => r.phase === "guard-outcome"), "outcome 2");
  const two = guardOutcomes({ detail: f.store.turnDetail(f.thread.id, "turn-2") })!;
  expect(two[0]).toMatchObject({ status: "reported", failed: ["architecture"], findings: 0 });
  expect(two[0]!.outcomes[0]).toMatchObject({ domain: "architecture", status: "provider-error", error: "CONTROLLED_GUARD_REFUSAL", admission: "unknown", request: { state: "recorded" } });
  // A guard that throws before its call boundary: the request is unobserved, never "not sent".
  const lib = f.runtime.domainLibrarians.get("architecture")!;
  Object.defineProperty(lib, "guard", { value: async () => { throw Error("thrown before the boundary"); }, configurable: true });
  const report = await f.runtime.flowOrchestrator.postAction({ tool: "Write", input: {} });
  expect(report.outcomes[0]).toMatchObject({ domain: "architecture", status: "provider-error", request: { status: "unobserved", phase: "guard" } });
  expect(participantRequest(report.outcomes[0]!.request)).toEqual({ state: "unobserved", phase: "guard", reason: "guard threw before its request was observed" });
});

test("a failed central turn retains the sealed routing and advice requests with their three parts; the inspector reads them without an artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-durability-")); const path = join(dir, "sessions.sqlite");
  const f = fixture(path, { central: () => { throw Error("CONTROLLED_EXECUTOR_FAILURE"); } }); closes.push(() => f.store.close());
  const failed = await f.turn("turn-1", "Add preferred names");
  expect(failed.ok).toBe(false);
  await until(() => f.store.phaseHistory(f.thread.id, { turnId: "turn-1" }).length >= 2, "sealed rows");
  const detail = f.store.turnDetail(f.thread.id, "turn-1")!;
  expect(detail.turn.status).toBe("failed"); expect(detail.injection).toBeNull();
  const phases = detail.phases.map(r => r.phase); expect(phases.slice(0, 2)).toEqual(["route", "advice"]);
  const advice = detail.phases[1]!.record as any;
  expect(advice.participants[0]).toMatchObject({ domain: "architecture", decision: "contribute", segments: { instructions: f.runtime.domainLibrarians.get("architecture")!.advisePrompt, domainKnowledge: "DOMAIN_BEFORE: existing readers keep working.", threadKnowledge: "" }, request: { status: "supplied", phase: "advice" } });
  f.layer.set("DOMAIN_AFTER");
  const participants = expertParticipants(detail.injection, detail.phases)!;
  expect(participants.participants[0]).toMatchObject({ id: "architecture", decision: "contribute", segments: { domainKnowledge: "DOMAIN_BEFORE: existing readers keep working." }, request: { state: "recorded", phase: "advice" } });
  expect(JSON.stringify(detail)).not.toContain("DOMAIN_AFTER");
  expect(routingRequest({ detail })).toMatchObject({ state: "recorded", status: "routed", request: { state: "recorded" } });
});

test("an observation whose dispatch is no longer live stays explicitly uncorrelated; journal appends are idempotent; a fresh journal reads empty phases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-durability-")); const path = join(dir, "sessions.sqlite");
  const f = fixture(path); closes.push(() => f.store.close());
  expect((await f.turn("turn-1", "Add preferred names")).ok).toBe(true);
  await until(() => f.store.phaseHistory(f.thread.id, { turnId: "turn-1" }).some(r => r.phase === "guard-outcome"), "outcome 1");
  await f.observe("dispatch-gone"); // emitted after the dispatch left the runtime
  await until(() => f.store.phaseHistory(f.thread.id, { uncorrelated: true }).some(r => r.phase === "guard-outcome"), "uncorrelated outcome");
  const loose = f.store.phaseHistory(f.thread.id, { uncorrelated: true });
  expect(loose.map(r => r.phase)).toEqual(["guard-request", "guard-outcome"]);
  expect(loose.every(r => r.turnId === null && r.dispatchId === "dispatch-gone" && r.record.correlation === "dispatch-not-live")).toBe(true);
  expect(f.store.phaseHistory(f.thread.id, { turnId: "turn-1" }).map(r => r.phase)).toEqual(["route", "advice", "guard-request", "guard-outcome"]);
  expect(f.store.phaseHistory(f.thread.id, { dispatchId: "dispatch-gone" })).toHaveLength(2);
  const row = loose[0]!;
  f.store.appendPhase(f.thread, { id: row.id, turnId: row.turnId, dispatchId: row.dispatchId, phase: row.phase as any, record: row.record }); // same bytes: no-op
  expect(() => f.store.appendPhase(f.thread, { id: row.id, turnId: row.turnId, dispatchId: row.dispatchId, phase: row.phase as any, record: { changed: true } })).toThrow("identity conflict");
  const fresh = new LocalSessionStore(join(dir, "fresh.sqlite")); closes.push(() => fresh.close());
  fresh.beginTurn({ id: "legacy", meta: { projectId: "P" } } as any, "old-turn", "old");
  fresh.failTurn({ id: "legacy", meta: { projectId: "P" } } as any, "old-turn", "older record");
  const legacy = fresh.turnDetail("legacy", "old-turn")!;
  expect(legacy.phases).toEqual([]); expect(guardOutcomes({ detail: legacy })).toBeNull(); expect(routingRequest({ detail: legacy })).toEqual({ state: "not-recorded" });
});

export { fixture as durabilityFixture, until as untilSettled };

test("review records say whether their requested record reached the journal; without a journal the status is explicit, not a silent success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-durability-")); const path = join(dir, "sessions.sqlite");
  const f = fixture(path); closes.push(() => f.store.close());
  expect((await f.turn("turn-1", "Add preferred names")).ok).toBe(true); await f.runtime.learningSettled();
  const rows = f.store.learningHistory(f.thread.id, 100).map(r => r.signal.content as any).filter(r => r.evidence?.messageId === "turn-1");
  expect(rows.map(r => r.decision)).toEqual(["requested", "abstain"]);
  expect(rows[0]).toMatchObject({ request: { status: "supplied", phase: "review" }, eligibility: "open" }); expect(rows[0].capacity).toBeUndefined(); expect(rows[0].native).toBeUndefined();
  expect(rows[1]).toMatchObject({ requestJournal: "durable", request: { status: "supplied" } });
  const g = fixture(join(dir, "no-journal.sqlite"), { journal: false }); closes.push(() => g.store.close());
  expect((await g.turn("turn-1", "Add preferred names")).ok).toBe(true); await g.runtime.learningSettled();
  // The requested record is journal-only: the expert's in-memory history holds outcomes only, and each outcome says the journal was unavailable.
  const memory = g.runtime.domainLibrarians.get("architecture")!.threadKnowledge.history.filter((r: any) => r.evidence?.messageId === "turn-1");
  expect(memory.map((r: any) => r.decision)).toEqual(["abstain"]);
  expect((memory[0] as any).requestJournal).toBe("absent"); expect((memory[0] as any).request.status).toBe("supplied");
  const inMemoryWithJournal = f.runtime.domainLibrarians.get("architecture")!.threadKnowledge.history.filter((r: any) => r.evidence?.messageId === "turn-1");
  expect(inMemoryWithJournal.map((r: any) => r.decision)).toEqual(["abstain"]); // never "requested" in memory
  expect((g.store.turnDetail(g.thread.id, "turn-1")!.messages.find(m => m.actor === "agent")!.meta as any).phases.journal).toEqual({ route: "absent", advice: "absent" });
});
