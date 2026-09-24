import { expect, test } from "bun:test";
// @ts-ignore untyped viewer module (plain JS); the package tsconfig resolves it
import { routingRequest, guardOutcomes, learningEntries, participantRequest } from "../src/viewer/ui/inspector-data.js";

// Inspector projections for the historical phase record (Fable, CORE-006 LI). Recorded fields only;
// absence is labelled; nothing is recomputed from current source, cache or protocol.

const supplied = { status: "supplied", phase: "route", providerId: "controlled-route", capturedAt: 7, messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }] };

test("routing: recorded status, selection and exact request; missing plan or older trace is not recorded", () => {
  const trace = { root: { annotations: { injectionPlan: { routing: { status: "routed", domains: ["architecture"], layers: ["architecture"], confidence: 1, elapsedMs: 3, request: supplied } } } } };
  expect(routingRequest(trace)).toEqual({ state: "recorded", status: "routed", reason: null, domains: ["architecture"], layers: ["architecture"], confidence: 1, elapsedMs: 3,
    request: { state: "recorded", phase: "route", providerId: "controlled-route", capturedAt: 7, messages: supplied.messages } });
  const fallback = routingRequest({ root: { annotations: { injectionPlan: { routing: { status: "fallback", reason: "no route within 10ms", domains: [], layers: [], confidence: 0, request: { status: "not-sent", phase: "route", reason: "empty-map" } } } } } });
  expect(fallback).toMatchObject({ state: "recorded", status: "fallback", reason: "no route within 10ms", request: { state: "not-sent", reason: "empty-map" } });
  expect(routingRequest({ root: { annotations: {} } })).toEqual({ state: "not-recorded" });
  expect(routingRequest(undefined)).toEqual({ state: "not-recorded" });
  expect(routingRequest({ root: { annotations: { injectionPlan: { routing: { status: "routed" } } } } }).request).toEqual({ state: "not-recorded" }); // older plan without request
});

test("guards: per-observation status with per-expert outcomes; pending and failed checks are never an all-clear; absent record is null", () => {
  const trace = { root: { annotations: { guards: [
    { observation: { signalId: "s1", tool: "Write", callId: "c1", dispatchId: "d1", agentId: "worker" }, status: "reported", domainsChecked: ["architecture", "testing"], failed: ["testing"], findings: 1, critical: 0, outcomes: [
      { domain: "architecture", status: "completed", findings: 1, threadKnowledgeRevision: 1, request: { ...supplied, phase: "guard" } },
      { domain: "testing", status: "provider-error", findings: 0, error: "CONTROLLED_REFUSAL", admission: { nativeOutcome: "unknown", localOutcome: "rejected", dispatch: "attempted" }, request: { status: "not-sent", phase: "guard", reason: "cold-cache" } },
    ] },
    { observation: { signalId: "s2", tool: "Bash" }, status: "pending" },
    { observation: { signalId: "s3", tool: "Edit", callId: "c3" }, status: "failed", error: "post-action threw" },
  ] } } };
  const guards = guardOutcomes(trace)!;
  expect(guards).toHaveLength(3);
  expect(guards[0]).toMatchObject({ tool: "Write", callId: "c1", dispatchId: "d1", agentId: "worker", status: "reported", failed: ["testing"], findings: 1, critical: 0 });
  expect(guards[0]!.outcomes[0]).toEqual({ domain: "architecture", status: "completed", findings: 1, error: null, admission: null, revision: 1, reference: null, requestRecord: null,
    request: { state: "recorded", phase: "guard", providerId: "controlled-route", capturedAt: 7, messages: supplied.messages } });
  expect(guards[0]!.outcomes[1]).toMatchObject({ domain: "testing", status: "provider-error", findings: 0, error: "CONTROLLED_REFUSAL", admission: { nativeOutcome: "unknown" }, request: { state: "not-sent", reason: "cold-cache" } });
  expect(guards[1]).toMatchObject({ tool: "Bash", callId: null, status: "pending", outcomes: [], failed: [], findings: null });
  expect(guards[2]).toMatchObject({ tool: "Edit", status: "failed", error: "post-action threw", outcomes: [] });
  expect(guardOutcomes({ root: { annotations: {} } })).toBeNull();
  expect(guardOutcomes(undefined)).toBeNull();
  expect(guardOutcomes({ root: { annotations: { guards: [] } } })).toEqual([]);
});

test("learning entries carry the review request state and job id; malformed shapes are not read as evidence", () => {
  const history = [
    { storedAt: 10, signal: { id: "a", content: { domain: "architecture", decision: "learned", revision: 2, job: { id: "review-1", base: { revision: 1 } }, evidence: { messageId: "turn-1" }, request: { ...supplied, phase: "review", providerId: "controlled-review" } } } },
    { storedAt: 11, signal: { id: "b", content: { domain: "architecture", decision: "discarded", reason: "disposed", request: { status: "not-sent", phase: "review", reason: "review call not started" } } } },
    { storedAt: 12, signal: { id: "c", content: { domain: "architecture", decision: "abstain" } } },
    { storedAt: 13, signal: { id: "d", content: { domain: "architecture", decision: "error", request: { status: "supplied", messages: "not-an-array" } } } },
  ];
  const entries = learningEntries(history);
  expect(entries.map((e: any) => [e.decision, e.jobId, e.request.state])).toEqual([["learned", "review-1", "recorded"], ["discarded", null, "not-sent"], ["abstain", null, "not-recorded"], ["error", null, "not-recorded"]]);
  expect(entries[0]!.request.messages).toEqual(supplied.messages); expect(entries[0]!.request.providerId).toBe("controlled-review");
  expect(entries[1]!.request.reason).toBe("review call not started");
  expect(participantRequest({ status: "supplied", phase: "review", providerId: "p", capturedAt: 1, messages: [{ role: "user", content: "x" }, { role: "user" }] }).messages).toEqual([{ role: "user", content: "x" }]);
});
