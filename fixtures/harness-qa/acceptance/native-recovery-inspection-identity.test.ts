import { expect, test } from "bun:test";
import { RecoveryCaptureGate, verifyRecoveryContinuity } from "../../../scripts/native-foundry-sample";
import type { NativeEvidence, OwnedAdmissionInspection } from "../../../packages/core/src/native-evidence";

function evidence(n: number): NativeEvidence {
  return { schema: 1, admissionId: `admission-${n}`, threadId: "native-thread", nativeSessionId: "native-session",
    turnId: `turn-${n}`, owner: { threadId: "sample", projectId: "project", generation: "generation",
      messageId: `message-${n}`, dispatchId: `dispatch-${n}`, providerSessionKey: "sample" },
    nativeOutcome: "completed", localOutcome: "resolved", rpcOutcome: "resolved", transportOutcome: "open",
    terminal: { type: "turn/completed", turnId: `turn-${n}` },
    bridge: { id: `bridge-${n}`, configurationHash: `configuration-${n}`, tools: [] },
    configuration: { engine: "app-server", requestedModel: "gpt-6-astra", requestedEffort: "xhigh",
      requestedMaxTurns: null, turnBudgetEnforcement: "unavailable", tokenBudget: "unavailable", effortBudget: "unavailable",
      history: { source: n === 1 ? "thread/start" : "thread/resume", available: true, hasMore: false,
        turns: n === 1 ? [] : [{ id: "turn-1", status: "completed" }] } } };
}
const inspection = (e: NativeEvidence): OwnedAdmissionInspection => ({ evidence: e,
  capacity: "settled", call: "settled", cleanup: "not-requested" });

test("recovery accepts matching native inspection and cold binding with an actual old turn", () => {
  const gate = new RecoveryCaptureGate();
  for (const n of [1, 2]) {
    const e = evidence(n);
    gate.spawn(); gate.admit(); gate.verify(e, inspection(e));
    gate.release(e.owner!, e.admissionId!, "released", true);
  }
  expect(gate.snapshot().complete).toBe(true);
});

for (const field of ["threadId", "turnId", "nativeSessionId"] as const) {
  test(`recovery refuses a settled inspection with contradictory ${field}`, () => {
    const gate = new RecoveryCaptureGate(), e = evidence(1);
    gate.spawn(); gate.admit();
    expect(() => gate.verify(e, inspection({ ...e, [field]: "foreign-native-identity" }))).toThrow();
    expect(() => gate.spawn()).toThrow();
    expect(gate.snapshot().verified).toBe(0);
  });
}

test("recovery refuses a settled inspection carrying a different terminal turn", () => {
  const gate = new RecoveryCaptureGate(), e = evidence(1);
  gate.spawn(); gate.admit();
  expect(() => gate.verify(e, inspection({ ...e, terminal: { type: "turn/completed", turnId: "foreign" } }))).toThrow();
  expect(gate.snapshot().verified).toBe(0);
});

for (const change of [
  (e: NativeEvidence) => ({ ...e, threadId: "foreign" }),
  (e: NativeEvidence) => ({ ...e, bridge: evidence(1).bridge }),
  (e: NativeEvidence) => ({ ...e, configuration: { ...e.configuration!, history: {
    ...e.configuration!.history!, turns: [] } } }),
]) test("cold continuation refuses changed binding, stale bridge or absent old turn", () => {
  const gate = new RecoveryCaptureGate(), first = evidence(1);
  gate.spawn(); gate.admit(); gate.verify(first, inspection(first));
  gate.release(first.owner!, first.admissionId!, "released", true);
  const second = change(evidence(2)); gate.spawn(); gate.admit();
  expect(() => gate.verify(second, inspection(second))).toThrow();
  expect(gate.snapshot().complete).toBe(false);
});

test("continuity cannot count a nonce repeated in a nested prepared tool result", () => {
  const nonce = "RECALL_NONCE_independent";
  const input = { phase: 2, nonce, prepared: [{ role: "user", content: "Recall prior work" }],
    output: `RECALL:${nonce}`, events: [{ kind: "tool_result" as const, toolOutput: "new fact" }], tools: [] };
  expect(verifyRecoveryContinuity(input).valid).toBe(true);
  expect(verifyRecoveryContinuity({ ...input, prepared: [{ role: "tool", content: [{ text: nonce }] }] }).valid).toBe(false);
  expect(verifyRecoveryContinuity({ ...input, output: `RECALL:${nonce}\nRECALL:${nonce}` }).valid).toBe(false);
});
