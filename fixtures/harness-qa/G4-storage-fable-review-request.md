Read-only independent review of Astra's browser-storage correction in this same
Fable session. Native completion verified2026-09-07T00:22:06.479Z, native turn
01a07930-1afb-7d82-9f37-b280ec15394a, Foundry turn
turn_08be568d-f7ad-42f9-9d39-785ce056b080. Your prior completed-unsaved re-review
is fixtures/harness-qa/QA-2026-09-07-fable-G4-rereview.md. Read the latest CORE-003
entry and current source; preserve the full CORE-003/004/005 and AS-001–005 goal.

Scope: store.js, conversation-state.js, conversation.js; browser-storage.test.ts,
tests/browser/browser-storage.test.ts and the existing completion fixture helper's
input recording. Check persistent per-message warnings on rejected browser writes,
truthful server-committed versus unsaved versus additional browser-only failure
evidence, prior storage preservation, thread navigation, later successful writes,
no replay, and regressions in message updates/history/fork/revert paths. Do not
turn known unimplemented native fork/rewind into a claim of support.

Independent supervisor QA passes:
- .foundry/qa/2026-09-07T00-21-39.598Z-G4/report.json: five unchanged independent
  failure cases plus focused storage/history/completion tests, typecheck/diff.
- .foundry/qa/2026-09-07T00-21-54.995Z-baseline/report.json:1046 baseline cases.
- .foundry/qa/2026-09-07T00-22-55.865Z-G3/report.json:all12 explicit G3 cases.
- .foundry/qa/browser-storage-failure/2026-09-07T00-18-27.255Z/report.json:
  real composer with forced QuotaExceededError/SecurityError, persists warning
  beyond transient notices, completed output visible, one POST and no browser copy.
  Both originally failed00:06:41.585Z. First passing screenshot00:17:31.365Z had
  target below viewport; corrected checker scrolls and checks its owned warning
  before capture. Final screenshot inspected; no primary content overlap.

Run relevant focused tests unchanged, review diff/source and return findings first
with severity/exact lines, then acceptance judgment. Browser tests are runnable:
FOUNDRY_QA_PLAYWRIGHT=/Users/agreenspan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright bun scripts/harness-check.ts G4 packages/foundry/tests/browser/browser-storage.test.ts
Use them if needed, not a missing-project-dependency claim. No file edits, native
subprobes, detached agents, server restarts, binding/credential changes, commits
or publication. Do not expose reasoning payloads.

If this is accepted it is Astra's second bounded slice, triggering CORE-005's
lead/scope checkpoint. Assess whether continued provisional Astra leadership with
Fable reviewer is warranted from observed work. Be candid about correctness and
cost: first slice needed your blocking review/correction; storage follow-up took
00:06:30.913Z–00:22:06.479Z including tests. These are not controlled model-speed
comparisons; context/effort and tasks differ. Recommend retain/change and explain
the evidence. No general model-quality claim from two small slices.

The proposed next node remains CORE-004 S0, prepared but undispatched in
fixtures/harness-qa/S0-astra-lead-request.md. Check its scope against the original
goal: native protocol truth must unblock tools/events/lineage/model/usage/account
continuity, not become an indefinite fixture-only detour. Preserve live unsaved
reconciliation, memory amplification, historical layer/tag/artifact inspection and
release parity as open work. Distinguish pre-rollout blockers from refinements;
do not expand this correction into an unrelated persistence or native rewrite.
