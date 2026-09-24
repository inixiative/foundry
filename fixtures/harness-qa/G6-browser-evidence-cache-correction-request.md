# Preserve browser-only evidence during optional-cache fallback

Continuation after Fable d7f82a97 completed: native end_turn15:02:59.151Z,
durable completed row, empty live buffers and full G6 handoff independently read.
Parent reran original index regression + history tests successfully; full G6
acceptance remains open. Same ROOT UI/cache ownership; parent owns unchanged
independent acceptance fixtures. First checkpoint this new correction before edits.

Parent reproduced a real merge -> persistence -> reload evidence-loss path in
fixtures/harness-qa/acceptance/browser-only-evidence-cache.test.ts (1FAIL/2PASS,
10assertions), stable76d4442d396cbcbd4f4c907f9de687bf4ed5842c948683e98e4ff0cef3d5e9e8:
.foundry/qa/2026-09-07T14-57-52.489Z-7381983d-6bcc-4420-ba9a-be95c95afdb7-G6/report.json.
Fixturea834bc8b4e741e2fcd733d8dcaadaa9682fa6b4abc9222ec2876e6c934225a23;
conversation-state4e51dadb836dbb93ddfb94a27af898f31dedcbe012de02ca62de3656f92c96ee.
Strict ES2023/ESNext/bundler/Bun types with --allowJs pass. Initial command without
--allowJs failed TS7016 for this existing JS module; corrected command passes,
not a product type failure.

mergeMessageHistory correctly preserves local failure metadata alongside an
interrupted committed journal row as meta.browserFailureEvidence. The resulting
row has storage=server. isDurableRow then treats that entire row as disposable
server cache. Under quota pressure and with another browser-only row present,
the transient-only fallback succeeds but saves only that other row, omitting the
failure evidence. Reload demonstrably loses the synthetic observed-tool sentinel.
The marked not-cached row has no per-row warning, incorrectly suggesting all its
content can be recovered from the server. Ownership/persistence is field-specific.

Correct the cache eligibility/preservation boundary so any browser-only evidence
survives fallback. Do not copy hidden provider detail unnecessarily, discard actual
unsaved output, alter the server record, or replay completed work. Test successful
fallback and fully refused writes, reload, interrupted journal reconciliation and
browser-only failure notices. Keep plain durable rows optional. Add a focused
browser quota scenario proving that extra evidence remains inspectable after
reload, with original server evidence still distinct.

Separate parent control confirms actual updateTurnMessage clears saved status on
a streaming delta before a refused write; that workflow passes. Do not infer the
dropped author test's hypothetical stale status is a product bug without a real
mutation path. The demonstrated loss above is different and must not be deferred
as a pre-existing limit. It directly affects the rock-solid inspection experience.

Checkpoint before edits and after tests in the G6 handoff. No source ownership
expansion, root installs, live restart, native/account/binding/candidate changes.

## Also correct a directly observed inspection claim

Parent's read-only scripts/check-live-viewer-observer.ts opened isolated fresh
Chromium against existing4400/4407, without shared browser storage or POSTs.
.foundry/qa/live-observer/2026-09-07T15-01-43.693Z/report.json and four screenshots
show current request IDs at1440/390, no page exceptions or horizontal overflow.
Both old backends return only {status,snapshot,history} from /knowledge; neither
returns learning. detail-drawer.js nevertheless displays "not reporting (no owned
runtime for this thread)". Missing live-state data is NOT evidence of runtime
absence, especially for a legacy server. Use truthful unavailable/not-reported
wording and preserve the durable snapshot/history. Test missing learning versus
explicit reported live state, malformed response and empty snapshot, using real
inspector rendering where practical. Do not infer runtime absence or wipe state.

Fresh pages can show latest history via legacy /api/messages fallback despite the
new /history route404. Existing CUA tabs show older history, cause not yet established.
Do not reload/clear those shared tabs: some history is browser-only. No live server
restart is authorized here. Fix only the data interpretation/UI wording in your
existing inspection ownership, not backend/native adoption. Parent is recording
actual old10s post-hook timeouts as the lead's next live-rollout dependency.
