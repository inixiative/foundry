# Supervisor review: transport lifecycle and sample corrections

Latest07:10Z: Fable first lifecycle correction actually ended07:05:44.266Z.
Supervisor read the complete correction and source, independently reran49 cases
(304 assertions), types/diff on stable
f09d37e8acf5c3e418e0abdc01de9d7e9f080fc9d91bea2b7155d065cb5c7a2e:
.foundry/qa/2026-09-07T07-07-37.134Z-18c239b1-8227-4be8-84ed-ef3f56dc3aec-G5/report.json.
Earlier three lifecycle defects are corrected. Two new actual HTTP/SDK held-read
tests fail: the onInvocation callback receives late completion/refusal after SDK
termination or bridge close, but bridge.invocations() loses it. Exact evidence:
.foundry/qa/2026-09-07T07-08-46.629Z-816af97f-d104-4924-99d1-d2823c66556b-G5/report.json.
Strict test types pass. No native calls. Same-session bounded
T2-late-tool-evidence-correction-request.md dispatched as
turn_74dfbe74-72cd-449a-9133-f38a8efdabf8, HTTP200/start confirmed; subsequent
actual native Bash activity verified07:10:52.910Z in the same session. Preserve corrected transport
capacity/cleanup and T1 diagnostics while retaining late owned evidence exactly
once without retaining every closed server forever or faking delivery/cancel.
Astra still WIP; latest actual public tool result07:03:29.053Z, no current terminal.
Prepared I1 request now includes four manifest negatives below; do not dispatch
until terminal/full handoff or duplicate anything Astra has already corrected.

As of 07:00Z. Progress, not full gate or goal acceptance. Same long-term goal and
provisional Astra lead; six accepted slices, checkpoint eight or serious regression.

Update07:06Z: new independent manifest5cases yield1positive4RED, strict types pass:
.foundry/qa/2026-09-07T07-05-11.919Z-677f45b1-1d9c-4c35-9809-9632e812d2ea-G5/report.json.
checkNative accepts empty/omitted-entry manifests, incorrect sourceDigest and
unlisted installed source. Ordinary hash mismatch refuses correctly. Controlled
inert temporary packages, no native calls. The original isolated7file candidate
was separately rechecked successfully with its originalf2c2f8f274f1... digest and
prewrite-v1. No frozen files were modified. Current readiness correction request
has an override distinguishing resolved ten sample/input cases and updated runner
cleanup/hash source from new manifest defects and remaining actual runner testing.
Still NOT dispatched before Astra terminal; WIP native task remains active with
last verified public commentary06:58:36.074Z. Native processes43025/95751 were
revalidated live07:02:57Z. Prior goal turn and this turn both made concrete progress.

## Independent evidence

- Four actual HTTP/SDK transport lifecycle cases: one positive, three failures.
  Pending initialize exceeded maxSessions=1 (200 instead of429); connect-only
  verification retained one logical SDK session; failed initialize retained its
  allocated server (zero closed of one created). No model calls. Report:
  .foundry/qa/2026-09-07T06-53-37.984Z-83ef9ee9-40a7-4996-8128-fafc5433eb70-G5/report.json.
  Explicit strict ES2023 test types passed separately. The ordinary source gate
  stopped at the failed tests, so that red report does not imply a full type run.
- Astra's active changes now pass all ten unchanged independent sample ownership
  and public tool-input projection cases, 27 assertions, source types and diff
  check. Stable fingerprint:
  cd77153f9ea169b07dc904dc8d557458540cd70037a4c0d2ecddfd3b899bf5ab.
  Report: .foundry/qa/2026-09-07T06-59-45.140Z-8ddd7149-88ec-4a81-a70f-2fc67bbb77e3-G5/report.json.
  This supersedes the seven earlier failures, not the remaining runner-path,
  artifact/command verification, partial setup or full native acceptance work.

## Current ownership

Fable first T2 implementation actually ended06:43:53.720Z, native session
da000690-899a-4128-a868-b9a024aeeaa0. Full handoff and source reviewed. Bounded
T2-transport-lifecycle-correction-request.md dispatched through Foundry4400 as
turn_817cda84-8d4a-4786-a220-70a3c8fe60ce at06:59:44Z. HTTP200/start and durable
user row confirmed; those alone are not proof of native execution. Subsequent
actual public native Bash tool activity verified07:02:19.863Z in the same session,
so the correction is now running. Do not send another task before its terminal.
Correction owns only MCP transport/proxy/tests/handoff, preserves invocation
evidence and no-native-cancel semantics, and requires unchanged independent cases.

Astra I0/I1 turn_e404ef4d-d4b4-4751-8546-2813a35d437a remains active in the same
native task01a07a79-b506-7a52-a600-485bfbef9760. Actual public commentary06:58:36.074Z
reports controlled both-engine route tests and candidate freeze work. Its handoff
file still says WIP; await actual terminal and complete handoff. The prepared
I1-sample-ownership-correction-request.md remains NOT dispatched. Recheck it against
the now-green ten cases and final runner source; only remaining findings belong
in a subsequent request. Do not duplicate resolved corrections or interrupt work.

## Next gates

Independent T2 correction review and full I0/I1 handoff review, then opposite-model
review, a fresh frozen installed candidate, controlled actual runner-path checks,
and separately supervised bounded both-engine native samples. Preserve owned
terminal/unknown outcomes; no automatic retry, native rebinding or rollout.
Root dependencies and both live backends are unchanged. Actual native tools,
lineage/subsessions/fork/recovery, learning, artifact and right-panel inspection,
account-qualified pooling, complete models/effort and measured capacity/latency
parity remain open. Prepared G7 latency correction stays queued after integration;
historical live traces show approximately30s pre-executor waits, not parity.

Browser inventory confirms existing visible Foundry Fable4400 and Astra4407 tabs.
No new browser tab, server restart or model probe was necessary for this review.
