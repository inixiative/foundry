import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, SignalBus, type LLMMessage, type Signal } from "@inixiative/foundry-core";
import { Cartographer } from "../src/agents/cartographer";
import { DomainLibrarian, GUARD_RESPONSE_PROTOCOL, validateGuardResponse } from "../src/agents/domain-librarian";
import { FlowOrchestrator } from "../src/agents/flow-orchestrator";
import { Librarian } from "../src/agents/librarian";

// Author cases for the guard-phase outcome contract (Fable, CORE-006 LI). Controlled providers only; no model.
// The parent's protected domain-guard-evidence fixture proves failures differ from a completed all-clear;
// these pin the statuses, bounded errors, protocol/parts layout, private-state isolation and the report.

const observation = { tool: "Write", input: { file_path: "contacts.ts" }, output: "Changed schema" };
type Respond = (messages: LLMMessage[]) => Promise<string> | string;
function fixture(respond: Respond, options: { domain?: string; guardPrompt?: string; knowledge?: string | null; signals?: SignalBus } = {}) {
  const domain = options.domain ?? "architecture", signals = options.signals ?? new SignalBus();
  const cache = new ContextLayer({ id: domain, segment: "domain-knowledge" });
  if (options.knowledge !== null) cache.set(options.knowledge ?? `DOMAIN_KNOWLEDGE(${domain}): preserve compatibility.`);
  const requests: LLMMessage[][] = [], emitted: Signal[] = [];
  for (const kind of ["security_concern", "correction"]) signals.on(kind, s => { emitted.push(s); });
  const lib = new DomainLibrarian({ domain, cache, signals, guardTriggers: ["Write"], ...(options.guardPrompt ? { guardPrompt: options.guardPrompt } : {}),
    llm: { id: `controlled-guard-${domain}`, async complete(messages) { requests.push(structuredClone(messages)); return { model: "controlled", content: await respond(messages) }; } } });
  return { lib, requests, emitted, cache, signals };
}
const learn = (lib: DomainLibrarian, text: string) => lib.threadKnowledge.learn(text, { kind: "dispatch", id: `verified-${text.length}`, ok: true, timestamp: 1 }, "reviewer");

test("valid empty findings and actual findings both complete; findings are normalized and emitted as signals", async () => {
  const clear = fixture(() => '{"findings":[]}');
  const cleared = await clear.lib.guard(observation);
  expect(cleared).toMatchObject({ findings: [], ran: true, status: "completed", threadKnowledgeRevision: 0, request: { status: "supplied", phase: "guard", providerId: "controlled-guard-architecture" } });
  if (cleared.request.status === "supplied") expect(cleared.request.messages).toEqual(clear.requests[0]!); // exact provider input, retained on the result
  expect(clear.emitted).toHaveLength(0);
  const found = fixture(() => '```json\n{"findings":[{"severity":"critical","description":"Schema drops legacy column","location":"contacts.ts:12","extra":"ignored"},{"severity":"advisory","description":"Add a migration test"}]}\n```');
  const result = await found.lib.guard(observation, "COMMON_EVIDENCE");
  expect(result).toMatchObject({ ran: true, status: "completed", threadKnowledgeRevision: 0, findings: [
    { severity: "critical", description: "Schema drops legacy column", location: "contacts.ts:12" }, { severity: "advisory", description: "Add a migration test" }] });
  expect(result.findings[0]).toEqual({ severity: "critical", description: "Schema drops legacy column", location: "contacts.ts:12" });
  expect(found.emitted.map(s => [s.kind, (s.content as any).severity])).toEqual([["security_concern", "critical"], ["correction", "advisory"]]);
});

test("invalid schema is an explicit invalid-response with a bounded error that never echoes the answer; nothing is emitted", async () => {
  const secret = "PRIVATE_GUARD_OUTPUT_SENTINEL";
  const completed = await fixture(() => '{"findings":[]}').lib.guard(observation);
  for (const bad of [`not json ${secret}`, `{"assessment":"${secret}"}`, `{"findings":"${secret}"}`, `[{"severity":"critical","description":"${secret}"}]`,
    `{"findings":[{"description":"${secret}"}]}`, `{"findings":[{"severity":"high","description":"${secret}"}]}`, `{"findings":[{"severity":"critical","description":"  "}]}`,
    `{"findings":[{"severity":"critical","description":"d","location":7}]}`, `{"findings":[null]}`, `{"findings":[{"severity":"advisory","description":"${"x".repeat(20_001)}"}]}`]) {
    const f = fixture(() => bad);
    const result = await f.lib.guard(observation);
    expect(result).toMatchObject({ findings: [], ran: true, status: "invalid-response" });
    expect(result.admission).toBeUndefined();
    expect(typeof result.error).toBe("string"); expect(result.error!.length).toBeLessThan(200); expect(result.error).not.toContain(secret); expect(result.error).not.toContain("xxxx");
    expect(result).not.toEqual(completed); expect(f.emitted).toHaveLength(0); expect(f.requests).toHaveLength(1);
  }
  expect(validateGuardResponse(42)).toEqual({ error: "guard response is not text" });
  expect(validateGuardResponse('{"findings":[{"severity":"advisory","description":"ok","suggestion":"do"}]}')).toEqual({ findings: [{ severity: "advisory", description: "ok", suggestion: "do" }] });
});

test("provider error is a provider-error with the provider's lifecycle classification when it exposes one, otherwise unknown; a model run is never implied", async () => {
  const plain = fixture(() => { throw Error("CONTROLLED_REFUSAL_WITH_NO_CHECK"); });
  const refused = await plain.lib.guard(observation);
  expect(refused).toMatchObject({ findings: [], ran: true, status: "provider-error", error: "CONTROLLED_REFUSAL_WITH_NO_CHECK", admission: "unknown", threadKnowledgeRevision: 0, request: { status: "supplied", phase: "guard" } });
  if (refused.request.status === "supplied") expect(refused.request.messages).toEqual(plain.requests[0]!); // the failed call keeps its exact request
  expect(plain.emitted).toHaveLength(0);
  const classified = fixture(() => { throw Object.assign(Error("local waiter rejected"), { native: { nativeOutcome: "unknown", localOutcome: "rejected", dispatch: "attempted", admissionId: "adm-1", content: "PARTIAL_PRIVATE" } }); });
  const unknownNative = await classified.lib.guard(observation);
  expect(unknownNative).toMatchObject({ status: "provider-error", admission: { nativeOutcome: "unknown", localOutcome: "rejected", dispatch: "attempted" } });
  expect(JSON.stringify(unknownNative)).not.toContain("PARTIAL_PRIVATE"); expect(Object.keys(unknownNative.admission as object)).toEqual(["nativeOutcome", "localOutcome", "dispatch"]);
  const notAdmitted = fixture(() => { throw Object.assign(Error("refused before dispatch"), { native: { nativeOutcome: "unknown", localOutcome: "rejected", dispatch: "not-dispatched" } }); });
  expect((await notAdmitted.lib.guard(observation)).admission).toEqual({ nativeOutcome: "unknown", localOutcome: "rejected", dispatch: "not-dispatched" });
  const long = fixture(() => { throw Error("E".repeat(1_000)); });
  expect((await long.lib.guard(observation)).error!.length).toBe(200);
});

test("scoped no-admission: a trigger-gated tool is skipped and a cold cache is cold-cache; neither calls the provider or invents a result", async () => {
  const gated = fixture(() => '{"findings":[]}');
  expect(await gated.lib.guard({ tool: "Read", input: {} })).toEqual({ findings: [], ran: false, status: "skipped", request: { status: "not-sent", phase: "guard", reason: "skipped" } });
  const cold = fixture(() => '{"findings":[]}', { knowledge: null });
  expect(await cold.lib.guard(observation)).toEqual({ findings: [], ran: true, status: "cold-cache", error: "cold-cache", request: { status: "not-sent", phase: "guard", reason: "cold-cache" } });
  expect(gated.requests).toHaveLength(0); expect(cold.requests).toHaveLength(0);
});

test("configured instructions stay verbatim as the system message; the guard protocol, this domain's own frozen understanding, its knowledge and the shared evidence are separate user parts; another domain's private state never enters", async () => {
  const signals = new SignalBus();
  const a = fixture(() => '{"findings":[]}', { guardPrompt: "CUSTOM_GUARD_INSTRUCTIONS: check storage compatibility only.", signals });
  const b = fixture(() => '{"findings":[]}', { domain: "testing", signals });
  learn(a.lib, "A_OWN_INTERPRETATION: legacy callers use display_name."); learn(b.lib, "B_PRIVATE_INTERPRETATION: flaky timer test.");
  const live = await a.lib.guard(observation, "COMMON_EVIDENCE: migration being edited.");
  expect(live.threadKnowledgeRevision).toBe(1);
  const [system, user] = a.requests[0]!;
  expect(system).toEqual({ role: "system", content: "CUSTOM_GUARD_INSTRUCTIONS: check storage compatibility only." });
  expect(user!.role).toBe("user"); expect(user!.content).toContain(GUARD_RESPONSE_PROTOCOL); expect(user!.content).toContain("## Response protocol (guard phase)");
  expect(user!.content).not.toContain("Respond with JSON only.\n"); expect(system!.content).not.toContain("findings");
  for (const part of ["## Domain cache (architecture)\nDOMAIN_KNOWLEDGE(architecture)", "## Your understanding of this thread\nA_OWN_INTERPRETATION", "## Thread state\nCOMMON_EVIDENCE", "## Tool observation\nTool: Write"]) expect(user!.content).toContain(part);
  expect(user!.content.indexOf("## Domain cache")).toBeLessThan(user!.content.indexOf("## Your understanding")); expect(user!.content.indexOf("## Your understanding")).toBeLessThan(user!.content.indexOf("## Thread state"));
  expect(user!.content).not.toContain("B_PRIVATE_INTERPRETATION"); expect(user!.content).not.toContain("testing");
  // Frozen by the caller: a later learning cannot enter a request already prepared from the frozen revision.
  const slow = fixture(async () => { await Bun.sleep(5); return '{"findings":[]}'; });
  learn(slow.lib, "FROZEN_V1");
  const pending = slow.lib.guard(observation, undefined, { threadKnowledge: "FROZEN_V1", threadKnowledgeRevision: 1 });
  learn(slow.lib, "LATER_V2");
  const frozen = await pending;
  expect(frozen.threadKnowledgeRevision).toBe(1); expect(slow.requests[0]![1]!.content).toContain("FROZEN_V1"); expect(slow.requests[0]![1]!.content).not.toContain("LATER_V2");
  const unknownRevision = await fixture(() => '{"findings":[]}').lib.guard(observation, undefined, { threadKnowledge: "SUPPLIED_WITHOUT_REVISION" });
  expect(unknownRevision.threadKnowledgeRevision).toBeUndefined(); expect(unknownRevision.status).toBe("completed");
});

test("orchestrator: the guard report and emitted observation carry each domain's outcome; a failed check is never counted as an all-clear; each guard sees only its own frozen understanding", async () => {
  const signals = new SignalBus();
  const arch = fixture(() => '{"findings":[{"severity":"advisory","description":"Add a migration test"}]}', { signals });
  const testing = fixture(() => { throw Object.assign(Error("CONTROLLED_REFUSAL"), { native: { nativeOutcome: "unknown", localOutcome: "rejected", dispatch: "attempted" } }); }, { domain: "testing", signals });
  const malformed = fixture(() => '{"assessment":"looks fine"}', { domain: "security", signals });
  learn(arch.lib, "ARCH_OWN"); learn(testing.lib, "TEST_OWN");
  const stack = new ContextStack([arch.cache, testing.cache, malformed.cache]);
  const librarian = new Librarian({ stack, signals });
  const cartographer = new Cartographer({ stack, signals, llm: { id: "controlled-route", async complete() { return { model: "controlled", content: '{"layers":[],"domains":[],"confidence":1}' }; } } });
  const flow = new FlowOrchestrator({ stack, signals, librarian, cartographer, domainLibrarians: new Map([["architecture", arch.lib], ["testing", testing.lib], ["security", malformed.lib]]) });
  const observed: Signal[] = []; signals.on("tool_observation", s => { if (s.source === "flow-orchestrator") observed.push(s); });
  try {
    const report = await flow.postAction(observation);
    expect(report.domainsChecked).toEqual(["architecture", "testing", "security"]);
    expect(report.findings).toEqual([{ severity: "advisory", description: "Add a migration test" }]); expect(report.critical).toEqual([]); expect(report.advisory).toHaveLength(1);
    expect(report.outcomes.map(({ request, ...rest }) => rest)).toEqual([
      { domain: "architecture", status: "completed", findings: 1, threadKnowledgeRevision: 1 },
      { domain: "testing", status: "provider-error", findings: 0, error: "CONTROLLED_REFUSAL", admission: { nativeOutcome: "unknown", localOutcome: "rejected", dispatch: "attempted" }, threadKnowledgeRevision: 1 },
      { domain: "security", status: "invalid-response", findings: 0, error: 'guard response requires "findings": array', threadKnowledgeRevision: 0 },
    ]);
    for (const [i, name] of (["architecture", "testing", "security"] as const).entries()) {
      const request = report.outcomes[i]!.request!; expect(request.status).toBe("supplied");
      if (request.status === "supplied") expect(request.messages).toEqual(({ architecture: arch, testing, security: malformed })[name].requests[0]!);
    }
    expect(report.failed).toEqual(["testing", "security"]);
    expect(observed).toHaveLength(1);
    const content = observed[0]!.content as Record<string, unknown>;
    expect(content).toMatchObject({ tool: "Write", guardsRan: ["architecture", "testing", "security"], guardsFailed: ["testing", "security"], findingsCount: 1, criticalCount: 0 });
    expect(content.guardOutcomes).toEqual(report.outcomes);
    expect(arch.requests[0]![1]!.content).toContain("ARCH_OWN"); expect(arch.requests[0]![1]!.content).not.toContain("TEST_OWN");
    expect(testing.requests[0]![1]!.content).toContain("TEST_OWN"); expect(testing.requests[0]![1]!.content).not.toContain("ARCH_OWN");
    expect(JSON.stringify(report)).not.toContain("looks fine");
  } finally { flow.dispose(); cartographer.dispose(); librarian.dispose(); }
});
