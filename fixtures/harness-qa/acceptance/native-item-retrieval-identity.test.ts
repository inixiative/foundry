import { expect, test } from "bun:test";
import type { NativeEvidence, NativeToolEvidence } from "../../../packages/core/src/native-evidence";
import { NativeSampleGuard } from "../../../scripts/native-sample-guard";
import { publicationFact, retrievalFacts, verifyRetrievalTurn } from "../../../scripts/native-retrieval-guard";
import { sha256 } from "../../../scripts/stage-native-package";

function fixture() {
  const owner = { threadId: "logical", projectId: "P", generation: "g", messageId: "m", dispatchId: "d", providerSessionKey: "logical" };
  const bridgeId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const result = `${retrievalFacts[0]}\n${publicationFact}`;
  const record: NativeToolEvidence["record"] = { id: "receipt", bridgeId, operation: "foundry_memory", owner,
    association: { kind: "registered-admission-window", admissionId: "admission", owner },
    nativeCorrelation: "unknown", sdkRequestId: 1, sdkSessionId: "sdk", startedAt: 1, finishedAt: 2,
    arguments: { query: "T3", limit: 10 }, result, digest: sha256(result), status: "ok" };
  const tool: NativeToolEvidence = { record, persistence: "committed", publication: "published" };
  const native: NativeEvidence = { schema: 1, owner, admissionId: "admission", nativeOutcome: "completed",
    localOutcome: "resolved", transportOutcome: "open", nativeSessionId: "native-session",
    threadId: "native-thread", turnId: "native-turn", terminal: { type: "turn/completed", turnId: "native-turn" },
    bridge: { id: bridgeId, configurationHash: "config", tools: [tool] } };
  const invocation = { operation: record.operation, owner: { threadId: owner.threadId, projectId: owner.projectId },
    generation: owner.generation, sdkRequestId: record.sdkRequestId, sdkSessionId: record.sdkSessionId,
    startedAt: 1, finishedAt: 2, status: "ok", digest: record.digest, nativeCorrelation: "unknown",
    capture: { id: record.id, bridgeId, association: record.association } };
  const events: NativeEvidence[] = [
    { ...native, kind: "tool_use", itemId: "native-item", toolName: `mcp__foundry_${bridgeId.replaceAll("-", "")}__foundry_memory`, toolInput: { query: "T3" } },
    { ...native, kind: "tool_result", itemId: "native-item", toolOutput: `${result}\n${JSON.stringify({ invocation })}` },
  ];
  return { native, events, tools: [tool], fact: retrievalFacts[0], writes: 1, spawns: 1, persistence: "committed", httpStatus: 200 };
}

test("receipt verifier accepts an exact native thread/turn/item pair without inventing a call ID", () => {
  const input = fixture(), before = JSON.stringify(input);
  const guard = new NativeSampleGuard(); guard.begin();
  expect(verifyRetrievalTurn(guard, input).valid).toBe(true);
  expect(JSON.stringify(input)).toBe(before);
  expect(input.events.every(e => e.callId === undefined)).toBe(true);
});

for (const mode of ["foreign-thread", "foreign-turn", "foreign-item", "absent-thread", "absent-turn", "mixed-call-item", "duplicate-result", "coherent-foreign-thread", "coherent-foreign-turn"] as const) {
  test(`item receipt join refuses ${mode} and closes further admission`, () => {
    const input = fixture();
    if (mode === "foreign-thread") input.events[1] = { ...input.events[1], threadId: "other" };
    if (mode === "foreign-turn") input.events[1] = { ...input.events[1], turnId: "other" };
    if (mode === "foreign-item") input.events[1] = { ...input.events[1], itemId: "other" };
    if (mode === "absent-thread") input.events = input.events.map(e => ({ ...e, threadId: undefined }));
    if (mode === "absent-turn") input.events = input.events.map(e => ({ ...e, turnId: undefined }));
    if (mode === "mixed-call-item") input.events[0] = { ...input.events[0], itemId: undefined, callId: "native-item" };
    if (mode === "duplicate-result") input.events.push({ ...input.events[1] });
    if (mode === "coherent-foreign-thread") input.events = input.events.map(e => ({ ...e, threadId: "foreign-native-thread" }));
    if (mode === "coherent-foreign-turn") input.events = input.events.map(e => ({ ...e, turnId: "foreign-native-turn" }));
    const guard = new NativeSampleGuard(); guard.begin();
    expect(verifyRetrievalTurn(guard, input).valid).toBe(false);
    expect(() => guard.begin()).toThrow();
  });
}

test("existing call-ID receipt joins remain supported", () => {
  const input = fixture(); input.events = input.events.map(e => ({ ...e, itemId: undefined, callId: "native-call" }));
  const guard = new NativeSampleGuard(); guard.begin();
  expect(verifyRetrievalTurn(guard, input).valid).toBe(true);
});

test("observed Claude begin alias preserves call receipt identity without rewriting saved evidence", () => {
  const input = fixture();
  // The installed Claude normalizer emits block.id in both fields on tool_use,
  // then emits only tool_use_id as callId on tool_result. Verified in the actual
  // i1-t3-reviewed-claude-20260907t1153 capture, not a synthesized app-server ID.
  input.events[0] = { ...input.events[0], callId: "toolu_observed", itemId: "toolu_observed" };
  input.events[1] = { ...input.events[1], callId: "toolu_observed", itemId: undefined };
  const before = JSON.stringify(input);
  const guard = new NativeSampleGuard(); guard.begin();
  expect(verifyRetrievalTurn(guard, input).valid).toBe(true);
  expect(JSON.stringify(input)).toBe(before);
});
