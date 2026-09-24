import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, SignalBus, type LLMMessage, type LLMProvider } from "@inixiative/foundry-core";
import { Cartographer } from "../src/agents/cartographer";
import { DomainLibrarian } from "../src/agents/domain-librarian";
import { FlowOrchestrator, type FlowTimingConfig } from "../src/agents/flow-orchestrator";
import { Librarian } from "../src/agents/librarian";
// @ts-ignore untyped viewer module (plain JS); the package tsconfig resolves it, the strict single-file command has no declaration for it
import { expertParticipants, participantRequest } from "../src/viewer/ui/inspector-data.js";

// Author cases for advice-phase request capture (Fable, CORE-006 LI). Controlled providers only; no model.
// The parent's protected expert-phase-provenance fixture proves the protocol is findable in the historical
// record; these cover attribution, freezing, failure paths, absence semantics and the inspector projection.

const PROTOCOL_HEADING = "## Response protocol (advice phase)";
type Respond = (messages: LLMMessage[]) => Promise<string> | string;
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

function harness(domains: Record<string, { knowledge: string; respond: Respond }>, timing: FlowTimingConfig = {}) {
  const signals = new SignalBus(), calls = new Map<string, LLMMessage[][]>(), caches = new Map<string, ContextLayer>();
  for (const [id, d] of Object.entries(domains)) { const cache = new ContextLayer({ id, segment: "domain-knowledge" }); if (d.knowledge) cache.set(d.knowledge); caches.set(id, cache); }
  const stack = new ContextStack([...caches.values()]);
  const librarian = new Librarian({ stack, signals });
  const cartographer = new Cartographer({ stack, signals, llm: { id: "controlled-route", async complete() {
    return { model: "controlled", content: JSON.stringify({ layers: [], domains: Object.keys(domains), confidence: 1 }) }; } } });
  const experts = new Map(Object.entries(domains).map(([id, d]) => {
    const llm: LLMProvider = { id: `controlled-${id}`, async complete(messages) { calls.set(id, [...(calls.get(id) ?? []), structuredClone(messages)]); return { model: "controlled", content: await d.respond(messages) }; } };
    return [id, new DomainLibrarian({ domain: id, cache: caches.get(id)!, signals, advisePrompt: `INSTRUCTIONS(${id}): assess ${id}.`, llm })];
  }));
  const flow = new FlowOrchestrator({ stack, signals, librarian, cartographer, domainLibrarians: experts, ...timing });
  return { flow, calls, caches, dispose() { flow.dispose(); cartographer.dispose(); librarian.dispose(); } };
}
const advice = (snippet: string) => JSON.stringify({ layers: [], snippets: [snippet], confidence: 1 });

test("recorded request equals the exact provider input, is frozen with the sealed plan beside the three unchanged segments, and never enters the central injection", async () => {
  const h = harness({ architecture: { knowledge: "DOMAIN_BEFORE: readers keep working.", respond: () => advice("Keep the legacy reader regression") } });
  try {
    const plan = await h.flow.preMessage("Add preferred names", { messageId: "turn-1", threadId: "thread-1", projectId: "project-1" });
    const prepared = await h.flow.hydrateDelta(plan);
    const supplied = h.calls.get("architecture")![0]!;
    const c = plan.contributions[0]!;
    expect(c.decision).toBe("contribute");
    expect(c.request.status).toBe("supplied");
    if (c.request.status !== "supplied") throw Error("unreachable");
    expect(c.request.messages).toEqual(supplied); // exact equality with what the provider received
    expect(c.request.providerId).toBe("controlled-architecture"); expect(c.request.phase).toBe("advice");
    expect(c.request.capturedAt).toBeGreaterThanOrEqual(plan.input.capturedAt); expect(c.request.capturedAt).toBeLessThanOrEqual(plan.sealedAt);
    expect(supplied[1]!.content).toContain(PROTOCOL_HEADING); expect(supplied[1]!.content).toContain("## Domain cache (architecture)");
    expect(Object.isFrozen(c.request)).toBe(true); expect(Object.isFrozen(c.request.messages)).toBe(true); expect(Object.isFrozen(c.request.messages[0])).toBe(true);
    // The three owned parts are exactly what they were, and the request sits beside them, not inside them.
    expect(c.segments).toEqual({ instructions: "INSTRUCTIONS(architecture): assess architecture.", domainKnowledge: "DOMAIN_BEFORE: readers keep working.", threadKnowledge: "" });
    expect(Object.keys(c.segments)).toEqual(["instructions", "domainKnowledge", "threadKnowledge"]);
    const participant = prepared.decoration.participants[0]!;
    expect(participant.request).toEqual(c.request); expect(participant.segments).toEqual(c.segments);
    expect(Object.keys(participant.provenance)).not.toContain("request");
    // A later cache change cannot reach the sealed record.
    const sealed = JSON.stringify({ plan, decoration: prepared.decoration });
    h.caches.get("architecture")!.set("DOMAIN_AFTER: changed after the turn.");
    expect(JSON.stringify({ plan, decoration: prepared.decoration })).toBe(sealed); expect(sealed).not.toContain("DOMAIN_AFTER");
    // No new central injection: the raw request stays in inspection metadata, out of the delivered prose.
    expect(prepared.content).not.toContain(PROTOCOL_HEADING); expect(prepared.content).not.toContain("## Domain cache");
    for (const block of prepared.decoration.blocks) { expect(block.text).not.toContain(PROTOCOL_HEADING); expect(block.text).not.toContain("## Domain cache"); }
    expect(prepared.content).toContain("Keep the legacy reader regression");
  } finally { h.dispose(); }
});

test("concurrent experts: each recorded request is attributed to its own domain even when completions settle in reverse order", async () => {
  const testingDone = gate();
  const h = harness({
    architecture: { knowledge: "ARCH_KNOWLEDGE", respond: async () => { await testingDone.promise; return advice("architecture guidance"); } },
    testing: { knowledge: "TEST_KNOWLEDGE", respond: () => { setTimeout(testingDone.resolve, 0); return advice("testing guidance"); } },
  });
  try {
    const plan = await h.flow.preMessage("Add preferred names");
    expect(plan.contributions.map(c => c.domain)).toEqual(["architecture", "testing"]);
    for (const c of plan.contributions) {
      expect(c.decision).toBe("contribute"); if (c.request.status !== "supplied") throw Error(`${c.domain} request not supplied`);
      expect(c.request.messages).toEqual(h.calls.get(c.domain)![0]!); expect(c.request.providerId).toBe(`controlled-${c.domain}`);
      expect(c.request.messages[0]!.content).toBe(`INSTRUCTIONS(${c.domain}): assess ${c.domain}.`);
      expect(c.request.messages[1]!.content).toContain(`## Domain cache (${c.domain})`);
      const other = c.domain === "architecture" ? "TEST_KNOWLEDGE" : "ARCH_KNOWLEDGE";
      expect(JSON.stringify(c.request)).not.toContain(other); expect(JSON.stringify(c.request)).not.toContain(`INSTRUCTIONS(${c.domain === "architecture" ? "testing" : "architecture"})`);
    }
  } finally { h.dispose(); }
});

test("provider error, timeout and late settlement: the request is retained with the failure and the sealed record is never rewritten", async () => {
  const release = gate(); let lateAnswered = false;
  const h = harness({
    erroring: { knowledge: "E_KNOWLEDGE", respond: () => { throw Error("CONTROLLED_PROVIDER_FAILURE"); } },
    slow: { knowledge: "S_KNOWLEDGE", respond: async () => { await release.promise; lateAnswered = true; return advice("LATE_ANSWER"); } },
  }, { adviseTimeoutMs: 25 });
  try {
    const plan = await h.flow.preMessage("Add preferred names");
    const prepared = await h.flow.hydrateDelta(plan);
    const [erroring, slow] = plan.contributions;
    expect(erroring!.decision).toBe("error"); expect(erroring!.reason).toBe("CONTROLLED_PROVIDER_FAILURE");
    expect(erroring!.request.status).toBe("supplied"); if (erroring!.request.status === "supplied") expect(erroring!.request.messages).toEqual(h.calls.get("erroring")![0]!);
    expect(slow!.decision).toBe("timeout"); expect(slow!.request.status).toBe("supplied");
    if (slow!.request.status === "supplied") { expect(slow!.request.messages).toEqual(h.calls.get("slow")![0]!); expect(slow!.request.messages[1]!.content).toContain(PROTOCOL_HEADING); }
    expect(plan.outstanding).toEqual([{ kind: "advise", participant: "slow", startedAt: slow!.provenance.startedAt }]);
    const sealed = JSON.stringify({ plan, decoration: prepared.decoration });
    release.resolve(); await new Promise(r => setTimeout(r, 5)); expect(lateAnswered).toBe(true);
    expect(JSON.stringify({ plan, decoration: prepared.decoration })).toBe(sealed); expect(sealed).not.toContain("LATE_ANSWER");
    expect(prepared.decoration.participants.map(p => [p.id, p.decision, p.request?.status])).toEqual([["erroring", "error", "supplied"], ["slow", "timeout", "supplied"]]);
  } finally { h.dispose(); }
});

test("cold cache and deadline exclusion record why no request was made; no request evidence is invented", async () => {
  const cold = harness({ architecture: { knowledge: "", respond: () => advice("never") } });
  try {
    const plan = await cold.flow.preMessage("Add preferred names");
    expect(plan.contributions[0]).toMatchObject({ decision: "abstain", reason: "cold-cache", request: { status: "not-sent", phase: "advice", reason: "cold-cache" } });
    expect(cold.calls.size).toBe(0);
    expect(JSON.stringify(plan.contributions[0]!.request)).not.toContain(PROTOCOL_HEADING);
  } finally { cold.dispose(); }
  const excluded = harness({
    first: { knowledge: "F_KNOWLEDGE", respond: () => new Promise<string>(r => setTimeout(() => r(advice("first")), 60)) },
    queued: { knowledge: "Q_KNOWLEDGE", respond: () => advice("queued") },
  }, { maxAdviseParallel: 1, planTimeoutMs: 15 });
  try {
    const plan = await excluded.flow.preMessage("Add preferred names");
    const [first, queued] = plan.contributions;
    expect(first!.decision).toBe("timeout"); expect(first!.request.status).toBe("supplied");
    expect(queued).toMatchObject({ decision: "excluded", reason: "deadline-queued", request: { status: "not-sent", phase: "advice", reason: "deadline-queued" } });
    expect(excluded.calls.has("queued")).toBe(false);
    await new Promise(r => setTimeout(r, 70)); // let the outstanding controlled call settle before disposal
  } finally { excluded.dispose(); }
});

test("inspector: reloaded records project the exact recorded request; not-sent and older records are labelled, never filled from current source", async () => {
  const h = harness({ architecture: { knowledge: "DOMAIN_BEFORE", respond: () => advice("guidance") }, cold: { knowledge: "", respond: () => advice("never") } });
  try {
    const plan = await h.flow.preMessage("Add preferred names");
    const prepared = await h.flow.hydrateDelta(plan);
    // The journal stores the turn record as JSON text; a JSON round trip is the persisted form.
    const reloaded = JSON.parse(JSON.stringify({ decoration: prepared.decoration, userMessage: "Add preferred names", blocks: [] }));
    h.caches.get("architecture")!.set("DOMAIN_AFTER");
    const record = expertParticipants(reloaded)!;
    const [architecture, cold] = record.participants as Array<{ id: string; request: any; segments: Record<string, string> }>;
    expect(architecture!.request).toMatchObject({ state: "recorded", phase: "advice", providerId: "controlled-architecture" });
    expect(architecture!.request.messages).toEqual(h.calls.get("architecture")![0]!);
    expect(architecture!.request.messages[1].content).toContain(PROTOCOL_HEADING);
    expect(architecture!.segments).toEqual({ instructions: "INSTRUCTIONS(architecture): assess architecture.", domainKnowledge: "DOMAIN_BEFORE", threadKnowledge: "" });
    expect(JSON.stringify(record)).not.toContain("DOMAIN_AFTER");
    expect(cold!.request).toEqual({ state: "not-sent", phase: "advice", reason: "cold-cache" });
  } finally { h.dispose(); }
  // Older record: participants without the field say not recorded; the three parts are untouched.
  const older = expertParticipants({ decoration: { participants: [{ id: "architecture", decision: "contribute", segments: { instructions: "I", domainKnowledge: "D", threadKnowledge: "" }, provenance: {} }] } })!;
  expect(older.participants[0]!.request).toEqual({ state: "not-recorded" });
  expect(older.participants[0]!.segments).toEqual({ instructions: "I", domainKnowledge: "D", threadKnowledge: "" });
  expect(participantRequest(undefined)).toEqual({ state: "not-recorded" });
  expect(participantRequest({ status: "supplied" })).toEqual({ state: "not-recorded" }); // malformed: no messages array
  expect(participantRequest({ status: "supplied", phase: "advice", providerId: "p", capturedAt: 7, messages: [{ role: "system", content: "S" }, { role: "user", content: 4 }, null] }))
    .toEqual({ state: "recorded", phase: "advice", providerId: "p", capturedAt: 7, messages: [{ role: "system", content: "S" }] });
  expect(participantRequest({ status: "not-sent", phase: "advice", reason: "" })).toEqual({ state: "not-sent", phase: "advice", reason: null });
});
