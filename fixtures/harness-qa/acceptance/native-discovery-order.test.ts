import { expect, test } from "bun:test";
import type { NativeEvidence, NativeToolEvidence } from "../../../packages/core/src/native-evidence";
import { NativeSampleGuard } from "../../../scripts/native-sample-guard";
import { publicationFact, retrievalFacts, verifyRetrievalTurn } from "../../../scripts/native-retrieval-guard";
import { sha256 } from "../../../scripts/stage-native-package";

function fixture(order: "valid" | "result-before-begin" | "result-after-memory") {
  const owner = { threadId: "sample", projectId: "P", generation: "g", messageId: "m", dispatchId: "d", providerSessionKey: "pool" };
  const bridgeId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name = `mcp__foundry_${bridgeId.replaceAll("-", "")}__foundry_memory`;
  const result = `${retrievalFacts[0]}\n${publicationFact}`;
  const tool: NativeToolEvidence = { record: {
    id: "owned-operation", bridgeId, operation: "foundry_memory", owner,
    association: { kind: "registered-admission-window", admissionId: "admission", owner },
    nativeCorrelation: "unknown", sdkRequestId: 1, sdkSessionId: "sdk", startedAt: 1, finishedAt: 2,
    arguments: { query: "T3", limit: 10 }, result, digest: sha256(result), status: "ok",
  }, persistence: "committed", publication: "published" };
  const native: NativeEvidence = { schema: 1, owner, admissionId: "admission", nativeOutcome: "completed",
    localOutcome: "resolved", transportOutcome: "open", nativeSessionId: "owned-native", terminal: { type: "result" },
    bridge: { id: bridgeId, configurationHash: "config", tools: [tool] } };
  const invocation = { operation: "foundry_memory", owner: { threadId: owner.threadId, projectId: owner.projectId },
    generation: owner.generation, sdkRequestId: 1, sdkSessionId: "sdk", startedAt: 1, finishedAt: 2,
    status: "ok", digest: tool.record.digest, nativeCorrelation: "unknown",
    capture: { id: tool.record.id, bridgeId, association: tool.record.association } };
  const begin: NativeEvidence = { ...native, kind: "tool_use", callId: "discovery", toolName: "ToolSearch", toolInput: { query: `select:${name}` } };
  const end = { ...native, kind: "tool_result" as const, callId: "discovery", toolOutput: "", toolError: false, toolReferences: [name] };
  const memoryBegin: NativeEvidence = { ...native, kind: "tool_use", callId: "memory", toolName: name, toolInput: { query: "T3", limit: 10 } };
  const memoryEnd: NativeEvidence = { ...native, kind: "tool_result", callId: "memory", toolOutput: `${result}\n${JSON.stringify({ invocation })}` };
  const events = order === "valid" ? [begin, end, memoryBegin, memoryEnd]
    : order === "result-before-begin" ? [end, begin, memoryBegin, memoryEnd] : [begin, memoryBegin, end, memoryEnd];
  return { native, events, tools: [tool], fact: retrievalFacts[0], writes: 1, spawns: 1, persistence: "committed", httpStatus: 200 };
}

test("control: complete owned discovery precedes dependent memory invocation", () => {
  const guard = new NativeSampleGuard(); guard.begin();
  expect(verifyRetrievalTurn(guard, fixture("valid")).valid).toBe(true);
  expect(guard.begin()).toBe(2);
});

for (const order of ["result-before-begin", "result-after-memory"] as const) test(`discovery refuses ${order} despite matching references and memory receipts`, () => {
  const guard = new NativeSampleGuard(); guard.begin();
  const result = verifyRetrievalTurn(guard, fixture(order));
  let admittedAgain = false;
  try { admittedAgain = guard.begin() === 2; } catch { /* Expected closed guard. */ }
  expect({ valid: result.valid, admittedAgain }).toEqual({ valid: false, admittedAgain: false });
  expect(result.diagnostics.discovery[0].refusal).toBe("discovery-order");
});

for (const side of ["begin", "end", "both"] as const) test(`discovery refuses mixed call/item identity on ${side}`, () => {
  const input = fixture("valid");
  if (side !== "end") input.events[0] = { ...input.events[0], itemId: "ambiguous-item" };
  if (side !== "begin") input.events[1] = { ...input.events[1], itemId: "ambiguous-item" };
  const guard = new NativeSampleGuard(); guard.begin();
  expect(verifyRetrievalTurn(guard, input).valid).toBe(false);
  expect(() => guard.begin()).toThrow();
});

test("observed Claude discovery begin may carry its identical legacy item alias", () => {
  const input = fixture("valid");
  input.events[0] = { ...input.events[0], itemId: input.events[0].callId };
  const guard = new NativeSampleGuard(); guard.begin();
  expect(verifyRetrievalTurn(guard, input).valid).toBe(true);
});
