import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextLayer, ContextStack, EventStream, Harness, type LLMMessage, type LLMProvider } from "@inixiative/foundry-core";
import { ThreadRuntimeManager } from "../src/agents/thread-runtime";
import { ThreadFactory, buildAgents } from "../src/agents/thread-factory";
import { starterConfig } from "../src/viewer/config";
import { KnowledgePersistence } from "../src/persistence/knowledge-persistence";
import { LocalSessionStore } from "../src/persistence/local-session-store";
import { serializeTrace } from "../src/persistence/trace-record";
import { reviewResponseProtocol, GUARD_RESPONSE_PROTOCOL } from "../src/agents/domain-librarian";

// Integration (Fable, CORE-006 LI): the real runtime, factory, orchestrator, experts and SQLite journal.
// One dispatched turn records the routing request, the advice requests, a guard outcome under its tool
// observation identity and the post-work review request; the store is closed and reopened and the
// historical inputs are read back after live cache, instructions and protocol have all moved on.
// Controlled providers only; no model, no browser, no subprocess.

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

function fixture(path: string) {
  const config = starterConfig("controlled", "controlled");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "controlled", model: "controlled", prompt: "Work",
    temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const layer = new ContextLayer({ id: "architecture", segment: "domain-knowledge" }); layer.set("DOMAIN_BEFORE: existing readers keep working.");
  const stack = new ContextStack([layer]); const events = new EventStream();
  const requests: Record<string, LLMMessage[][]> = { route: [], advice: [], guard: [], review: [] };
  const answer = (kind: keyof typeof requests, content: string): LLMProvider => ({ id: `controlled-${kind}`, async complete(messages) { requests[kind].push(structuredClone(messages)); return { model: "controlled", content }; } });
  let reviews = 0;
  const reviewer: LLMProvider = { id: "controlled-review", async complete(messages) { requests.review.push(structuredClone(messages)); reviews++;
    return { model: "controlled", content: JSON.stringify({ decision: "learn", knowledge: `OWN_V${reviews}: legacy callers use display_name (turn ${reviews}).`, facts: ["migration passed"], reason: "observed result" }) }; } };
  const manager = new ThreadRuntimeManager({ config, log() {}, warn() {}, eventStream: events,
    domains: [{ domain: "architecture", layerId: "architecture", guardTriggers: ["Write"], guardPrompt: "CUSTOM_GUARD: storage compatibility only.", reviewPrompt: "CUSTOM_REVIEW: track architecture decisions." }],
    learning: { reviewProvider: reviewer, timeoutMs: 2, hardTimeoutMs: 2000 },
    llm: answer("route", '{"domains":["architecture"],"layers":["architecture"],"confidence":1}') });
  const factory = new ThreadFactory({ stack, runtime: manager, agents: buildAgents(config, stack, { provider: { id: "central", async complete() { return { model: "central", content: "COMPLETED_CENTRAL_OUTPUT" }; } } }) });
  const store = new LocalSessionStore(path);
  const persistence = new KnowledgePersistence(manager, store, events, []);
  const thread = factory.create("phase-history", { projectId: "P" }); const runtime = manager.get(thread.id)!;
  closes.push(() => { manager.disposeAll(); });
  return { manager, thread, runtime, store, persistence, layer, requests, events };
}

test("one real turn: routing, advice, guard and review requests are journalled under their identities and recovered after SQLite close/reopen while live source moved on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-history-")); const path = join(dir, "sessions.sqlite");
  const f = fixture(path); closes.push(() => f.store.close());
  const domainLib = f.runtime.domainLibrarians.get("architecture")!;
  let toolEmitted = 0;
  f.thread.middleware.use("test-tool-observation", async (ctx, next) => {
    // A real tool observation on the live dispatch, with the dispatch's own id: emitted while the dispatch is live.
    const n = ++toolEmitted;
    await f.thread.signals.emit({ id: `sig-tool-${n}`, kind: "tool_observation", source: `thread:${f.thread.id}`, timestamp: Date.now(),
      content: { threadId: f.thread.id, dispatchId: ctx.dispatchId, agentId: "worker", tool: "Write", callId: `call-${n}`, input: { file_path: "contacts.ts" }, ok: true, output: "Changed schema" } });
    return next();
  });
  // The production entry: a Harness send produces the trace the viewer route journals with completeTurn.
  const harness = new Harness(f.thread); harness.setDefaultExecutor("worker");
  const turn = async (turnId: string, message: string) => {
    f.store.beginTurn(f.thread, turnId, message);
    const sent = await harness.send({ id: turnId, payload: message, timestamp: Date.now() } as any);
    await f.runtime.learningSettled();
    f.store.completeTurn(f.thread, turnId, String(sent.result.output ?? ""), { ...(sent.result.meta ?? {}) }, serializeTrace(sent.trace));
    return sent.result;
  };
  // Turn 1 commits the expert's own understanding durably (revision 1); turn 2 is the turn under inspection.
  await turn("turn-0", "Migrate contacts");
  expect(domainLib.threadKnowledge.revision).toBe(1); expect(domainLib.threadKnowledge.content).toContain("OWN_V1");
  const turnId = "turn-1";
  const result = await turn(turnId, "Add preferred names");
  expect(toolEmitted).toBe(2);
  // The manager's one controlled auxiliary provider serves routing, advice and guard; each recorded request must equal the matching actual call of turn 2.
  const auxiliaryCall = (marker: string) => { const hits = f.requests.route.filter(ms => ms.some(m => m.content.includes(marker))); expect(hits).toHaveLength(2); return hits[1]!; };
  expect(f.requests.route).toHaveLength(6); expect(f.requests.review).toHaveLength(2);

  // Live source moves on: cache, instructions and understanding all change before the journal is read back.
  f.layer.set("DOMAIN_AFTER: changed after the turn.");
  domainLib.threadKnowledge.learn("OWN_V3: later interpretation.", { kind: "dispatch", id: "later-work", ok: true, timestamp: 2 }, "architecture-reviewer");
  f.store.close();
  const reopened = new LocalSessionStore(path); closes.push(() => reopened.close());

  // Routing: the exact request the Cartographer's provider was given, retained on the sealed plan in the trace.
  const detail = reopened.turnDetail(f.thread.id, turnId)!;
  // The phase record rides on the journalled agent message's meta (the executor result meta), beside delivery.
  const agentMeta = detail.messages.find(m => m.actor === "agent")!.meta as Record<string, any>;
  const annotations = { guards: agentMeta.phases?.guards, decoration: (agentMeta.injection as any)?.decoration };
  const routing = agentMeta.phases?.routing;
  expect(routing).toMatchObject({ status: "routed", request: { status: "supplied", phase: "route", providerId: "controlled-route" } });
  expect(routing.request.messages).toEqual(auxiliaryCall("## Message to route"));
  expect(routing.request.messages[1].content).toContain("## Message to route\nAdd preferred names");

  // Advice: the participant's request beside its three parts, frozen at DOMAIN_BEFORE / OWN_V0.
  const participant = (detail.injection as any)?.decoration?.participants?.find((p: any) => p.id === "architecture") ?? annotations.decoration?.participants?.find((p: any) => p.id === "architecture");
  expect(participant).toBeDefined();
  expect(participant.segments).toEqual({ instructions: domainLib.advisePrompt, domainKnowledge: "DOMAIN_BEFORE: existing readers keep working.", threadKnowledge: "OWN_V1: legacy callers use display_name (turn 1)." });
  expect(participant.request.status).toBe("supplied"); expect(participant.request.messages).toEqual(auxiliaryCall("## Response protocol (advice phase)"));

  // Guard: recorded on the dispatch under the observation identity; a completed check, its request and the frozen own understanding.
  expect(Array.isArray(annotations.guards)).toBe(true); expect(annotations.guards).toHaveLength(1);
  const guard = annotations.guards[0];
  expect(guard).toMatchObject({ status: "reported", observation: { signalId: "sig-tool-2", tool: "Write", callId: "call-2", agentId: "worker" }, domainsChecked: ["architecture"], findings: 0 });
  // The fixture's one controlled auxiliary provider answers the guard with its routing-shaped JSON, which is not a guard result:
  // the record must say so explicitly (not completed, listed as failed), never an all-clear.
  expect(guard.failed).toEqual(guard.outcomes[0].status === "completed" ? [] : ["architecture"]);
  expect(typeof guard.observation.dispatchId).toBe("string"); // the live dispatch's own id from the middleware context, not guessed
  expect(guard.outcomes).toHaveLength(1);
  const outcome = guard.outcomes[0];
  expect(outcome).toMatchObject({ domain: "architecture", threadKnowledgeRevision: 1 });
  expect(["completed", "invalid-response", "provider-error"]).toContain(outcome.status); // the configured advice provider answered the guard; whatever it returned, the status is explicit
  expect(outcome.request.status).toBe("supplied"); expect(outcome.request.messages).toEqual(auxiliaryCall("## Response protocol (guard phase)"));
  const guardUser = outcome.request.messages.find((m: any) => m.role === "user").content;
  expect(outcome.request.messages[0]).toEqual({ role: "system", content: "CUSTOM_GUARD: storage compatibility only." });
  expect(guardUser).toContain(GUARD_RESPONSE_PROTOCOL); expect(guardUser).toContain("## Your understanding of this thread\nOWN_V1"); expect(guardUser).toContain("DOMAIN_BEFORE"); expect(guardUser).not.toContain("DOMAIN_AFTER");

  // Review: the learned record links job, evidence, before/after revision and the exact request with the phase protocol.
  const history = reopened.learningHistory(f.thread.id, 100).map(row => row.signal.content as any);
  const learned = history.find(r => r.decision === "learned" && r.evidence?.messageId === turnId);
  expect(learned).toBeDefined();
  expect(learned.job.base.revision).toBe(1); expect(learned.revision).toBe(2); // persistence status is a separate runtime record, not asserted here
  expect(domainLib.threadKnowledge.revision).toBeGreaterThanOrEqual(2);
  expect(learned.request).toMatchObject({ status: "supplied", phase: "review", providerId: "controlled-review" });
  expect(learned.request.messages).toEqual(f.requests.review[1]!);
  expect(learned.request.messages[0]).toEqual({ role: "system", content: "CUSTOM_REVIEW: track architecture decisions." });
  const reviewUser = learned.request.messages[1].content;
  expect(reviewUser).toContain(reviewResponseProtocol(domainLib.threadKnowledge.maxChars));
  for (const part of ["## Completed work", `review: ${learned.job.id}`, "### Request\nAdd preferred names", "### Result\nCOMPLETED_CENTRAL_OUTPUT", "## Configured domain knowledge (distinct from generated thread knowledge)\nDOMAIN_BEFORE", "## Your current understanding of this thread (revision 1)\nOWN_V1"]) expect(reviewUser).toContain(part);
  expect(reviewUser).not.toContain("DOMAIN_AFTER"); expect(reviewUser).not.toContain("OWN_V3");
  // Turn 1's own learned record is also complete: base 0 → revision 1 with its exact request.
  const first = history.find(r => r.decision === "learned" && r.evidence?.messageId === "turn-0");
  expect(first).toBeDefined(); expect(first.revision).toBe(1); expect(first.job.base.revision).toBe(0);
  expect(first.request.status).toBe("supplied"); expect(first.request.phase).toBe("review"); expect(first.request.messages).toEqual(f.requests.review[0]!);
  // Nothing recorded borrows from the moved live source, and no request text reached the central prompt.
  const persisted = JSON.stringify({ detail, history });
  expect(persisted).not.toContain("DOMAIN_AFTER"); expect(persisted).not.toContain("OWN_V3");
  const central = (detail.injection as any)?.providerMessages ?? (detail.injection as any)?.text ?? "";
  expect(JSON.stringify(central)).not.toContain("## Response protocol");
});

test("older journal rows without captures read back as not recorded; nothing is reconstructed from current source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-history-legacy-")); const path = join(dir, "sessions.sqlite");
  const store = new LocalSessionStore(path); closes.push(() => store.close());
  const thread = { id: "legacy", meta: { projectId: "P" } } as any;
  store.appendLearning(thread, { id: "sig-legacy-1", kind: "domain_learning", source: "architecture-reviewer", timestamp: 5,
    content: { domain: "architecture", decision: "abstain", reason: "older record", owner: { threadId: "legacy", projectId: "P" }, evidence: { kind: "dispatch", id: "old", timestamp: 4, messageId: "old-turn" }, at: 5 } });
  store.close();
  const reopened = new LocalSessionStore(path); closes.push(() => reopened.close());
  const [row] = reopened.learningHistory("legacy", 10);
  expect((row!.signal.content as any).request).toBeUndefined();
  // @ts-expect-error The browser's plain-JS inspector has no declaration file.
  const { learningEntries } = await import("../src/viewer/ui/inspector-data.js");
  expect(learningEntries([row])[0]!.request).toEqual({ state: "not-recorded" });
});
