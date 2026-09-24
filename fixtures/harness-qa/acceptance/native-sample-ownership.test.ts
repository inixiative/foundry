import { expect, test } from "bun:test";
import { NativeSampleGuard } from "../../../scripts/native-sample-guard";
import type { NativeEvidence } from "../../../packages/core/src/native-evidence";

function completion(index = 1) {
  const owner = { threadId: "sample", projectId: "i1-fixture", generation: "generation-1", messageId: `sample-${index}`, dispatchId: `dispatch-${index}` };
  const identity = { schema: 1 as const, owner, admissionId: `admission-${index}`, nativeSessionId: "native-binding", turnId: `native-turn-${index}` };
  const result: NativeEvidence = { ...identity, nativeOutcome: "completed", localOutcome: "resolved", transportOutcome: "open", dispatch: "attempted", rpcOutcome: "resolved", terminal: { type: "task_complete", turnId: identity.turnId } };
  const events: NativeEvidence[] = [
    { ...identity, nativeOutcome: "unknown", kind: "tool_use", callId: `call-${index}` },
    { ...identity, nativeOutcome: "unknown", kind: "tool_result", callId: `call-${index}`, toolOutput: "1.3.14 CONTROLLED_SENTINEL" },
  ];
  return { result, events };
}

test("two distinct owned admissions with matching tool results pass without native execution", () => {
  const guard = new NativeSampleGuard();
  for (const index of [1, 2]) {
    const { result, events } = completion(index);
    guard.begin();
    expect(guard.verify(result, events, "CONTROLLED_SENTINEL", index, 1)).toBe(true);
  }
  expect(guard.snapshot().verified).toBe(2);
  expect(() => guard.begin()).toThrow();
});

test("matching sentinel text from a different admission cannot verify the current sample", () => {
  const guard = new NativeSampleGuard(); guard.begin();
  const { result, events } = completion();
  const foreign = events.map(event => ({ ...event, admissionId: "foreign-admission" }));
  expect(guard.verify(result, foreign, "CONTROLLED_SENTINEL", 1, 1)).toBe(false);
  expect(() => guard.begin()).toThrow();
});

test("tool evidence from a replaced runtime generation cannot verify current work", () => {
  const guard = new NativeSampleGuard(); guard.begin();
  const { result, events } = completion();
  const stale = events.map(event => ({ ...event, owner: { ...event.owner!, generation: "replaced-generation" } }));
  expect(guard.verify(result, stale, "CONTROLLED_SENTINEL", 1, 1)).toBe(false);
});

test("a contradictory native terminal turn identity cannot verify completion", () => {
  const guard = new NativeSampleGuard(); guard.begin();
  const { result, events } = completion();
  expect(guard.verify({ ...result, terminal: { type: "task_complete", turnId: "foreign-turn" } }, events, "CONTROLLED_SENTINEL", 1, 1)).toBe(false);
});

test("replaying the first native admission cannot count as a second independent task", () => {
  const guard = new NativeSampleGuard();
  const { result, events } = completion();
  guard.begin(); expect(guard.verify(result, events, "CONTROLLED_SENTINEL", 1, 1)).toBe(true);
  guard.begin();
  expect(guard.verify(result, events, "CONTROLLED_SENTINEL", 2, 1)).toBe(false);
});

test("verification without an outstanding admission never advances the verified count", () => {
  const guard = new NativeSampleGuard();
  const { result, events } = completion();
  expect(guard.verify(result, events, "CONTROLLED_SENTINEL", 0, 1)).toBe(false);
  expect(guard.snapshot().verified).toBe(0);
});

test("the same outstanding admission cannot be verified twice", () => {
  const guard = new NativeSampleGuard(); guard.begin();
  const { result, events } = completion();
  expect(guard.verify(result, events, "CONTROLLED_SENTINEL", 1, 1)).toBe(true);
  expect(guard.verify(result, events, "CONTROLLED_SENTINEL", 1, 1)).toBe(false);
  expect(guard.snapshot().verified).toBe(1);
});
