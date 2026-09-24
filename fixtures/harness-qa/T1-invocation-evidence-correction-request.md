# T1 correction: immutable invocation evidence and observer isolation

Continue in the SAME Fable Foundry/native session after verified actual public
end_turn06:09:37.508Z for turn_f31b9283-2782-4e9b-8e22-f73f18365e5c. Supervisor
read your full T1 handoff and independently ran22 SDK cases/96 assertions plus
source types/diff, stable05a703f4eb5f4276dd9c401eb9dd47d9f91df01a1ba4851d91fce41d50235a19
at06:15:29.454Z-5b95d36b-7686-4f30-a559-489f1dfb7da9-G5. Those positives hold
for the tested scope; T1 is not accepted or installed into native sessions.

Independent review found two Medium evidence/observer defects, reproduced as
three failures plus one positive in the new unchanged acceptance file
fixtures/harness-qa/acceptance/native-tool-invocation-evidence.test.ts. Report:
.foundry/qa/2026-09-07T06-20-03.230Z-287754e7-728f-48ec-a0bd-6b2ff010ac39-G5/report.json.
Its explicit strictES2023 typecheck passes. Actual SDK initialize/callTool through
in-memory transport, synthetic controlled facts only, no native model calls.

1. finish() calls onInvocation synchronously without isolation. A thrown observer
   error converts a successful retrieval to an SDK tool error, hides its data and
   exposes the observer error instead, while local history already says ok.
2. Only the outer record is frozen. An observer mutates record.owner.projectId
   before serialization and forges the SDK-delivered owner; a history caller can
   mutate record.owner.threadId and rewrite retained evidence. This does not
   establish scope access escalation; it does corrupt the attribution contract.

Fix the owned record boundary without repeatedly cloning all history. Preserve
immutable nested owner evidence and exact delivered-text digest. Observer failure
must not replace successful tool output, refusal or original execution error;
keep bounded truthful observer-failure diagnostics without retaining arbitrary
error strings/private payload or converting them into native correlation. Account
for rejected asynchronous observers where the public callback contract permits
them, without an unhandled rejection or serial observer wait on retrieval. Keep
record creation/serialization and callback sequencing coherent. Review revocation
on exceptional awaited paths so errors cannot bypass the authority check. Do not
claim that no read occurred if revocation was discovered after a backend read.

Own only the existing MCP modules and focused package tests plus your T1 handoff.
Astra is actively implementing I0/I1 in core/provider/adapter/runtime/journal/UI,
sibling package interfaces and staging utilities. Do not touch those or independent
assertions/shared graphs/dependency/settings files. Manual edits via apply_patch.
No native probes, new agents, server restart, credentials/bindings, publication,
commits or root installation. Keep the current read-only grant and all scope,
same-ID replacement, three-part conventions and actual memory search/get behavior.

Reproduce the new four tests RED before changes. Then run unchanged seven scope
and four invocation cases, focused MCP tests and relevant scoped-memory tests,
source and explicit strict test types/diff sequentially. Use unique report paths
and truthful source fingerprints; Astra's concurrent integration may move source.
Do not weaken tests or call a stale combined report release acceptance. Append a
correction section to docs/T1-live-scoped-tools-handoff.md with exact evidence.

Return for opposite review/supervisor independent verification; no self-acceptance.
Next is T2 actual authenticated live-runtime proxy/native launch and correlation,
not permanently local SDK-only success. Full CORE-003/004/005/AS-001..005 goal stays:
native tools/events/learning/artifacts/tags/right-panel/lineage/subsessions/model
efforts, no meaningful capacity/latency loss and subscription-independent work.
Astra remains provisional lead at six accepted slices; next checkpoint eight or
a serious regression. Your correction is disjoint and does not interrupt I0/I1.
