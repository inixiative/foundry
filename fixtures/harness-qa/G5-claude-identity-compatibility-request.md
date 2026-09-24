# Correct the real Claude identity regression before guard acceptance

Continue SAME Fable/Foundry session after actual end_turn12:18:51.825Z, durable
final and complete docs/G5-native-item-guard-handoff.md read. Parent does NOT
accept the guard yet. Same goal/count7-next8. You retain both ROOT guard files
and focused tests; the disclosed native-sample-guard.ts extension is necessary
and approved for this identity correction, not requested reverted. Astra owns
runner/provider work and will opposite-review final guard after your handoff.

Parent source inspection and real-recording replay expose a genuine regression:
the unchanged installed Claude normalizer src/claude-code-session.ts:796-797 emits
block.id into BOTH callId and itemId on tool_use; user tool_result emits only
tool_use_id into callId. This is actual existing normalized evidence, not a new
app-server synthetic call ID. All three first-turn tool_use events in the accepted
frozen Claude capture have this same-value alias, including ToolSearch.

Replayed frozen actual SQL through current root guard8e3e493814c8ee36f78fd3d1e361abeb2353898120fd0320a38b0b007d2045fb
and sample guard5e6b2232f3e9dde82bdd15878ecb305aaa1b0c13a1e7a0721e80e72a695837bc:
sample-1 FAIL, both valid memory receipt joins refused identity-mixed; discovery
diagnostic says accepted, but mixed begin invalidates aggregate/terminal. The
recording itself remains valid under its original frozen guard. Your handoff's
claim that actual Claude evidence is unaffected was not tested and is false for
this new guard. Append correction; don't modify the frozen recording or package.

Exact sample:
.foundry/qa/adoption-694bcdf8-4a78-43e1-a566-795f5c084aeb/foundry/.foundry/qa/i1-t3-reviewed-claude-20260907t1153
DBfd4759ecb66aa1e3cf21e44ced2db923986e40df442634c3fef98fa40ad899ca and
report6d48188738b763a50d7281a5242bb52e45dc662de2fb88d5f42088720be16723 unchanged.
Use read-only SQL/safe scratch copy if desired, never hidden reasoning or credentials.
Read record JSON from session_native and session_native_tools; agent message
meta.native in session_messages is authoritative admitted evidence. Replay each
turn in order using a fresh NativeSampleGuard, begin then verifyRetrievalTurn,
original events/tool records/fact/HTTP/persistence/writes1or2/spawns1. No model calls.

Parent additions preserve every prior assertion:
- native-item-retrieval-identity.test.ts now12 includes observed Claude begin
  same-value alias + call-only result positive, requiring no evidence mutation.
- native-discovery-order.test.ts now7 includes3different-valued mixed negatives
  plus observed same-value Claude discovery begin positive. Original3order cases
  unchanged. Previous32case run12:16:28 was green for narrower fixtures; it is not
  proof of real Claude compatibility.
Combined12+7+15provenance =34cases32pass/2fail, strict types pass:
.foundry/qa/2026-09-07T12-19-27.866Z-3311523f-7486-4137-871f-02a735e9ad87-G5/report.json.

Correct the contract from actual source/evidence: a present call ID may have a
documented identical legacy item alias; this is not the same as contradictory
mixed identities. Keep the call namespace authoritative for those observed
aliases, never synthesize or rewrite fields. Pure item pairs still require exact
native thread/turn/item and cannot cross-join call results merely because values
match. Different-valued dual identity must remain refused. Avoid model-name/id
prefix guesses or stripping actual fields from recordings to make tests green.
Your authored tests requiring blanket rejection of equal aliases encoded the
wrong assumption; revise only those expectations with an explicit evidence-based
explanation and retain mismatched/cross-namespace/foreign/duplicate coverage.

Require new parent34green, focused guards/source SDK compatibility and replay of
BOTH actual Claude admissions under current guard. Preserve exact receipt/full
owner/bridge/args/digest/discovery/terminal/capacity checks. Record before/after
hashes and actual replay details; no retry/staging/capture or candidate edits.
Append correction to docs/G5-native-item-guard-handoff.md. Full product goal stays.
