import { expect, test } from "bun:test";
import type { NativeEvidence, NativeOwner, ToolCallObservation } from "@inixiative/foundry-core";
import { createNativeToolProjector } from "../src/agents/native-tool-projection";

// Owned native tool events become exactly one ordinary tool observation per identity; everything
// foreign, unregistered, unmatched, duplicate or identity-less is dropped and counted, never invented.

const owner: NativeOwner = { threadId: "t", projectId: "P", generation: "g1", messageId: "m1", dispatchId: "d1" };
const base = (over: Partial<NativeEvidence>): NativeEvidence => ({ schema: 1, owner, admissionId: "adm-1", nativeOutcome: "unknown", dispatch: "attempted", ...over });

function projector(clock = [10, 25]) {
  const seen: ToolCallObservation[] = []; let i = 0;
  const p = createNativeToolProjector({ owner, observeTool: o => seen.push(o), now: () => clock[Math.min(i++, clock.length - 1)]! });
  p.register(base({ dispatch: "not-dispatched" }));
  return { p, seen };
}

test("a registered begin/result pair projects one observation with tool identity, input, output, ok, duration and sequence", () => {
  const { p, seen } = projector();
  p.observe(base({ kind: "tool_use", callId: "c1", toolName: "Bash", toolServer: "native", toolInput: { command: "bun check" }, observedAt: 100 }));
  p.observe(base({ kind: "tool_result", callId: "c1", toolName: "Bash", toolServer: "native", toolOutput: "PASS", toolError: false, observedAt: 140 }));
  expect(seen).toEqual([{ callId: "c1", tool: "native/Bash", inputSummary: JSON.stringify({ command: "bun check" }), ok: true, outputSummary: "PASS", durationMs: 40, sequence: 1 }]);
  expect(p.diagnostics).toMatchObject({ projected: 1, duplicates: 0, unmatched: 0, foreign: 0, unregistered: 0 });
});

test("native item identity without a call id is a logical id, kept distinct from call ids", () => {
  const { p, seen } = projector();
  p.observe(base({ kind: "tool_use", itemId: "it-9", toolName: "Read", toolInput: { path: "a" } }));
  p.observe(base({ kind: "tool_result", itemId: "it-9", toolName: "Read", toolOutput: "contents" }));
  expect(seen[0]!.callId).toBe("item:it-9"); expect(seen[0]!.tool).toBe("Read"); expect(seen[0]!.ok).toBeUndefined(); // no error flag stated → unknown, not success
});

test("omitted non-text output and error without text stay explicit; nothing is turned into success", () => {
  const { p, seen } = projector();
  p.observe(base({ kind: "tool_use", callId: "c2", toolName: "Read", toolInput: { path: "img.png" } }));
  p.observe(base({ kind: "tool_result", callId: "c2", toolName: "Read", toolOutputOmitted: true, toolOutputOmittedTypes: ["image"] }));
  p.observe(base({ kind: "tool_use", callId: "c3", toolName: "Bash", toolInput: { command: "false" } }));
  p.observe(base({ kind: "tool_result", callId: "c3", toolName: "Bash", toolError: true }));
  p.observe(base({ kind: "tool_use", callId: "c4", toolName: "Write", toolInputOmitted: "binary" }));
  p.observe(base({ kind: "tool_result", callId: "c4", toolName: "Write", toolOutput: "ok", toolError: false }));
  expect(seen[0]).toMatchObject({ callId: "c2", outputSummary: "[public non-text result omitted (image)]" }); expect(seen[0]!.ok).toBeUndefined();
  expect(seen[1]).toMatchObject({ callId: "c3", ok: false, error: "[public error text unavailable]" }); expect(seen[1]!.outputSummary).toBeUndefined();
  expect(seen[2]).toMatchObject({ callId: "c4", inputSummary: "[public tool input omitted: binary]", ok: true, outputSummary: "ok" });
  expect(seen.map(o => o.sequence)).toEqual([1, 2, 3]);
});

test("duplicates, late repeats, results without a begin and tool-name mismatches are dropped and counted", () => {
  const { p, seen } = projector();
  p.observe(base({ kind: "tool_use", callId: "c1", toolName: "Bash", toolInput: {} }));
  p.observe(base({ kind: "tool_use", callId: "c1", toolName: "Bash", toolInput: { later: true } })); // duplicate begin: first wins
  p.observe(base({ kind: "tool_result", callId: "c1", toolName: "Bash", toolOutput: "first" }));
  p.observe(base({ kind: "tool_result", callId: "c1", toolName: "Bash", toolOutput: "late repeat" }));
  p.observe(base({ kind: "tool_result", callId: "orphan", toolName: "Bash", toolOutput: "no begin" }));
  p.observe(base({ kind: "tool_use", callId: "c5", toolName: "Bash", toolInput: {} }));
  p.observe(base({ kind: "tool_result", callId: "c5", toolName: "Write", toolOutput: "renamed" }));
  expect(seen.map(o => [o.callId, o.outputSummary])).toEqual([["c1", "first"]]);
  expect(seen[0]!.inputSummary).toBe("{}");
  expect(p.diagnostics).toMatchObject({ projected: 1, duplicates: 2, unmatched: 2 });
});

test("foreign owners, unregistered admissions and identity-less events never become this dispatch's evidence", () => {
  const { p, seen } = projector();
  const other: NativeOwner = { ...owner, dispatchId: "d2" };
  p.observe({ ...base({ kind: "tool_use", callId: "x", toolName: "Bash", toolInput: {} }), owner: other });
  p.observe({ ...base({ kind: "tool_result", callId: "x", toolName: "Bash", toolOutput: "foreign" }), owner: other });
  p.observe(base({ kind: "tool_use", callId: "y", toolName: "Bash", toolInput: {}, admissionId: "adm-unregistered" }));
  p.observe(base({ kind: "tool_result", callId: "y", toolName: "Bash", toolOutput: "unregistered", admissionId: "adm-unregistered" }));
  p.observe(base({ kind: "tool_use", toolName: "Bash", toolInput: {} }));
  p.observe(base({ kind: "tool_result", toolName: "Bash", toolOutput: "no identity" }));
  p.observe(base({ kind: "text", text: "not a tool event" }));
  p.observe({ ...base({ kind: "tool_use", callId: "gen", toolName: "Bash", toolInput: {} }), owner: { ...owner, generation: "g2" } });
  expect(seen).toEqual([]);
  expect(p.diagnostics).toMatchObject({ projected: 0, foreign: 3, unregistered: 2, identityMissing: 2 });
});

test("provider-admitted owner with the expected pool key is accepted; later events must match that exact registered owner", () => {
  const seen: ToolCallObservation[] = [];
  const p = createNativeToolProjector({ owner, expectedPool: owner.threadId, observeTool: o => seen.push(o) });
  const admitted: NativeOwner = { ...owner, providerSessionKey: owner.threadId };
  p.register({ schema: 1, owner: admitted, admissionId: "adm-p", nativeOutcome: "unknown" });
  // An event that drops the pool key the provider stamped is not the same owner.
  p.observe(base({ kind: "tool_use", callId: "k", toolName: "Bash", toolInput: {}, admissionId: "adm-p" }));
  expect(p.diagnostics.foreign).toBe(1);
  p.observe({ ...base({ kind: "tool_use", callId: "k", toolName: "Bash", toolInput: {}, admissionId: "adm-p" }), owner: admitted });
  p.observe({ ...base({ kind: "tool_result", callId: "k", toolName: "Bash", toolOutput: "pooled", toolError: false, admissionId: "adm-p" }), owner: admitted });
  expect(seen.map(o => o.outputSummary)).toEqual(["pooled"]);
  // A registration naming another pool, or a review job, is foreign for the central dispatch.
  p.register({ schema: 1, owner: { ...owner, providerSessionKey: `${owner.threadId}:aux:review:g1:domain:testing` }, admissionId: "adm-aux", nativeOutcome: "unknown" });
  p.register({ schema: 1, owner: { ...owner, providerSessionKey: owner.threadId, reviewJobId: "job-1" }, admissionId: "adm-review", nativeOutcome: "unknown" });
  p.observe({ ...base({ kind: "tool_result", callId: "z", toolName: "Bash", toolOutput: "aux", admissionId: "adm-aux" }), owner: { ...owner, providerSessionKey: `${owner.threadId}:aux:review:g1:domain:testing` } });
  expect(p.diagnostics.foreign).toBe(4); expect(seen).toHaveLength(1);
});

test("a registration from a foreign owner does not admit that admission for this dispatch", () => {
  const seen: ToolCallObservation[] = [];
  const p = createNativeToolProjector({ owner, observeTool: o => seen.push(o) });
  p.register({ schema: 1, owner: { ...owner, messageId: "other" }, admissionId: "adm-x", nativeOutcome: "unknown" });
  p.observe(base({ kind: "tool_use", callId: "c", toolName: "Bash", toolInput: {}, admissionId: "adm-x" }));
  p.observe(base({ kind: "tool_result", callId: "c", toolName: "Bash", toolOutput: "x", admissionId: "adm-x" }));
  expect(seen).toEqual([]); expect(p.diagnostics).toMatchObject({ foreign: 1, unregistered: 2 });
});
