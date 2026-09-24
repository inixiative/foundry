import { expect, test } from "bun:test";
import type { NativeEvidence, NativeToolEvidence } from "../../../packages/core/src/native-evidence";
import { NativeSampleGuard } from "../../../scripts/native-sample-guard";
import { publicationFact, retrievalFacts, verifyRetrievalTurn } from "../../../scripts/native-retrieval-guard";
import { sha256 } from "../../../scripts/stage-native-package";

// Public verifier fixtures, not a claim about observed native wire encoding.
function fixture() {
  const owner = { threadId: "sample", projectId: "P", generation: "g", messageId: "m", dispatchId: "d", reviewJobId: "review", providerSessionKey: "pool" };
  const bridgeId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const result = `${retrievalFacts[0]}\n${publicationFact}`;
  const tool: NativeToolEvidence = {
    record: { id: "operation-owned", bridgeId, operation: "foundry_memory", owner,
      association: { kind: "registered-admission-window", admissionId: "a", owner },
      nativeCorrelation: "unknown", sdkRequestId: 1, sdkSessionId: "sdk-owned",
      startedAt: 1, finishedAt: 2, arguments: { query: "T3", limit: 10 }, result,
      digest: sha256(result), status: "ok" },
    persistence: "committed", publication: "published",
  };
  const native: NativeEvidence = { schema: 1, owner, admissionId: "a", nativeOutcome: "completed",
    localOutcome: "resolved", transportOutcome: "open", nativeSessionId: "native-owned",
    terminal: { type: "result" }, bridge: { id: bridgeId, configurationHash: "configuration", tools: [tool] } };
  const record = tool.record;
  const invocation = { operation: record.operation, owner: { threadId: owner.threadId, projectId: owner.projectId }, generation: owner.generation,
    sdkRequestId: record.sdkRequestId, sdkSessionId: record.sdkSessionId, startedAt: 1, finishedAt: 2,
    status: "ok", digest: record.digest, nativeCorrelation: "unknown",
    capture: { id: record.id, bridgeId, association: record.association } };
  const events: NativeEvidence[] = [
    { ...native, kind: "tool_use", callId: "call-owned", toolName: `mcp__foundry_${bridgeId.replaceAll("-", "")}__foundry_memory`, toolInput: { query: "T3", limit: 10 } },
    { ...native, kind: "tool_result", callId: "call-owned", toolOutput: `${result}\n${JSON.stringify({ invocation })}` },
  ];
  return { native, events, tools: [tool], fact: retrievalFacts[0], writes: 1, spawns: 1, persistence: "committed", httpStatus: 200 };
}

test("retrieval provenance accepts an exact owned bridge, arguments and public result", () => {
  const guard = new NativeSampleGuard(); guard.begin();
  expect(verifyRetrievalTurn(guard, fixture()).valid).toBe(true);
  expect(guard.begin()).toBe(2);
});

for (const mode of ["foreign-server", "foreign-record-bridge", "different-arguments", "different-dispatch", "different-review-job", "different-provider-pool", "unassociated-record", "unstructured-marker-echo"] as const) {
  test(`retrieval provenance refuses ${mode} without permitting another admission`, () => {
    const input = fixture();
    const tool = input.tools[0];
    if (mode === "foreign-server") input.events[0] = { ...input.events[0], toolName: `mcp__foundry_${"b".repeat(32)}__foundry_memory` };
    if (mode === "foreign-record-bridge") input.tools[0] = { ...tool, record: { ...tool.record, bridgeId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" } };
    if (mode === "different-arguments") input.events[0] = { ...input.events[0], toolInput: { id: "not-the-recorded-query" } };
    if (mode === "unassociated-record") input.tools[0] = { ...tool, record: { ...tool.record, association: { ...tool.record.association, kind: "unassociated" } } };
    if (["different-dispatch", "different-review-job", "different-provider-pool"].includes(mode)) {
      const key = mode === "different-dispatch" ? "dispatchId" : mode === "different-review-job" ? "reviewJobId" : "providerSessionKey";
      input.tools[0] = { ...tool, record: { ...tool.record, association: { ...tool.record.association, owner: { ...tool.record.association.owner!, [key]: "foreign" } } } };
    }
    if (mode === "unstructured-marker-echo") input.events[1] = { ...input.events[1], toolOutput: `${tool.record.result}\nUnverified quoted markers: ${tool.record.id} ${tool.record.digest}` };
    const guard = new NativeSampleGuard(); guard.begin();
    expect(verifyRetrievalTurn(guard, input).valid).toBe(false);
    expect(() => guard.begin()).toThrow();
  });
}

for (const mode of ["coherent-foreign-bridge", "coherent-unassociated", "coherent-foreign-review", "coherent-foreign-pool", "duplicate-record-join", "duplicate-record-with-one-pair"] as const) {
  test(`retrieval provenance rejects ${mode} even when copied receipt fields agree`, () => {
    const input = fixture();
    let tool = input.tools[0];
    const boundary = input.events[1].toolOutput!.lastIndexOf("\n");
    const receipt = JSON.parse(input.events[1].toolOutput!.slice(boundary + 1));
    if (mode === "coherent-foreign-bridge") {
      const bridgeId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      tool = { ...tool, record: { ...tool.record, bridgeId } };
      receipt.invocation.capture.bridgeId = bridgeId;
      input.events[0] = { ...input.events[0], toolName: `mcp__foundry_${bridgeId.replaceAll("-", "")}__foundry_memory` };
    }
    if (mode === "coherent-unassociated") {
      tool = { ...tool, record: { ...tool.record, association: { ...tool.record.association, kind: "unassociated" } } };
      receipt.invocation.capture.association = tool.record.association;
    }
    if (mode === "coherent-foreign-review" || mode === "coherent-foreign-pool") {
      const key = mode === "coherent-foreign-review" ? "reviewJobId" : "providerSessionKey";
      const owner = { ...tool.record.association.owner!, [key]: "foreign" };
      tool = { ...tool, record: { ...tool.record, association: { ...tool.record.association, owner } } };
      receipt.invocation.capture.association = tool.record.association;
      input.events = input.events.map(event => ({ ...event, owner }));
    }
    input.tools = [tool];
    input.events[1] = { ...input.events[1], toolOutput: `${tool.record.result}\n${JSON.stringify(receipt)}` };
    if (mode === "duplicate-record-join") {
      input.tools.push(tool);
      input.events.push(...input.events.map(event => ({ ...event, callId: "second-call-with-no-unique-record" })));
    }
    if (mode === "duplicate-record-with-one-pair") input.tools.push(tool);
    const guard = new NativeSampleGuard(); guard.begin();
    const valid = verifyRetrievalTurn(guard, input).valid;
    let admittedAgain = false;
    try { admittedAgain = guard.begin() === 2; } catch { /* Required fail-closed outcome. */ }
    expect({ valid, admittedAgain }).toEqual({ valid: false, admittedAgain: false });
  });
}
