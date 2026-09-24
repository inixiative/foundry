# Record observation correction and opposite startup review

Continue in the SAME Fable/native session after actual end_turn07:18:48.888Z for
turn_74dfbe74-72cd-449a-9133-f38a8efdabf8. Supervisor read the full Correction2 and
changed source. Independent54 cases343assertions, source types/diff pass stable
b2abc515a1d7a1982c6be9b426dbb60243addce3b66e0c31aa1005b5a34df686:
.foundry/qa/2026-09-07T07-19-59.665Z-59ca3b4c-e58c-4c51-845d-b41918acb1cd-G5/report.json.
Late owned evidence now survives both termination boundaries. Preserve that fix
and the real proxy recursion correction. Broad T2/native acceptance stays open.

## Small owned correction

New native-record-subscription.test.ts has3 actual in-memory SDK cases:
1positive/2fail, strict types pass:
.foundry/qa/2026-09-07T07-21-20.548Z-6af2a2f3-88e8-436e-99f1-033a02fda28f-G5/report.json.
onRecord listeners ignore returned promises/thenables, unlike onInvocation. An
asynchronous observer rejection is not counted (0 instead of1); a throwing then
accessor is not inspected/isolated under the stated common observer contract
(0 synchronous failures instead of1). The rejection test attaches its own catch
only to prevent an unrelated Bun unhandled-rejection crash masking the diagnostic
assertion. A real unhandled rejected callback remains a runtime risk. Unsubscribe
and retained history pass. This is relevant before T3 attaches async journal work.

Apply the same existing isolated invocation-observer behavior to record listeners:
sealed immutable record, no awaited journal observer on the retrieval path, bounded
fixed diagnostics, asynchronous rejection handled, no reads of rejected/thrown
payloads, hostile then accessor cannot mask tool success. Reuse a small shared
notification helper if it removes the actual duplication. Preserve exact-once and
late record collection. Run unchanged3 plus prior54 and types/diff, update the T2
handoff. No native models, deployment or new architecture scope.

## Independent review of supervisor startup fix

Read scripts/owned-session-adapter.ts, scripts/start-harness-lead.ts and
fixtures/harness-qa/acceptance/lead-adapter-capabilities.test.ts. The old local
tracked wrapper dropped describeConstruction, observedConfiguration and
releaseIdleSession; it also advertised a no-op bindSignals on unsupported adapters.
Supervisor extracted that wrapper unchanged, reproduced4 failures at
.foundry/qa/2026-09-07T07-14-52.119Z-31b2ba45-7bb5-4ca2-a532-8b9b6dc35c0a-G5/report.json,
then forwarded available capabilities with their real receiver. Both actual adapter
constructors are tested WITHOUT start/send/native spawn, plus held release and
failed construction. Startup uses existing fromSettingsConfig then explicit codex
runtime (same lead runtime), keeping auxiliary defaults unchanged; no saved config,
live server or binding was changed. TrackedSession derives from the adapter return
type instead of requiring an unavailable root dependency import.

Final61 startup/profile/adapter/config cases302assertions and source types/diff
pass at .foundry/qa/2026-09-07T07-17-12.207Z-d59b0f31-91e3-4530-b8f2-5ff6107bcddb-G5/report.json,
but whole-tree fingerprint is STALE under your concurrent MCP edits. Explicit
strict types on both scripts/test pass. Do not present that report as a release
revision. Independently review the small change, run focused checks with file
hashes, and record accept/reopen plus concrete residual risks in
docs/lead-startup-capability-review.md. Review only; do not edit startup/test files
or restart the lead. Supervisor owns implementation corrections and acceptance.

Finally read the PREPARED T3-native-bridge-integration-request.md and flag any
concrete interface contradiction in your review, especially process-lifetime
bridge versus per-admission lease, native correlation and durable async records.
Do not implement T3 while Astra is still changing I0/I1 or claim its WIP handoff
is complete. Leave exact next actionable findings, not another broad plan.

Own only the small MCP observer correction/tests/T2 handoff and the new read-only
startup/T3 review document. No core/provider/adapter/runtime/journal/UI/sibling
edits, root install, native calls, agents, account/credential/binding changes, live
restart, publication or commits. Full goal/count6-next8 unchanged.
