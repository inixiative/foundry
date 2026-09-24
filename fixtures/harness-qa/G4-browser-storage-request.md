Continue as provisional lead in the same Astra session. Your G4 completed-unsaved
correction is independently accepted as a bounded slice, not acceptance of G4 or
native parity. Accepted lead slice count1. Fable's actual native end_turn was
2026-09-07T00:04:31.727Z, Foundry turn turn_6cfd6e33-96a7-4af8-8bf4-1fd79e375b3a.
Read its verbatim review at fixtures/harness-qa/QA-2026-09-07-fable-G4-rereview.md
and the supervisor's real SIGKILL/browser-witness evidence in the failure QA record.

Before primary rollout or S0, close the review's browser-storage failure defect.
_persistLocal silently catches quota/security/serialization errors while completed
unsaved output is presented as browser-only evidence. A transient toast alone is
insufficient when it vanishes: retain a truthful per-thread/per-message volatile
state and persistent visible warning that this result exists only in this tab and
may be lost on reload/close. Do not imply a server-committed result was lost merely
because its optional browser cache failed. Keep the completed output accessible
in memory, preserve existing storage when writes fail, and do not replay work.
Use existing UI/state patterns; do not add a new persistence engine or retry loop.

Lead a narrowly scoped fix in store.js, conversation-state.js/conversation.js
and focused tests as needed. Preserve all other dirty changes. Test actual composer
with localStorage.setItem throwing QuotaExceededError/SecurityError only for
foundry message keys: completed unsaved output remains visible, a persistent
storage warning survives re-render/thread navigation, no false saved status and
no extra provider execution. Cover committed-result distinction and restoration
of honest status after a later successful write. Keep HTTP/SSE completion and
existing partial-output/history behavior intact. Independent supervisor browser
checker will be separate; do not edit acceptance files/scripts.

Run focused tests, relevant real headless browser tests using the existing bundled
Playwright runtime, all five unchanged independent G4 cases, full baseline/typecheck
and twelve G3 cases. Record exact evidence, scope and limitations in CORE-003, then
return for independent verification/review. No active server restart, native probes,
binding/account/credential/dependency edits, detached agents, commits or publication.

The full goal remains unchanged. S0-astra-lead-request.md is prepared but NOT yet
dispatched; after this pre-rollout fix, continue the native capability graph. Treat
Fable's 'few snapshots exceed quota' claim as an unmeasured hypothesis, not a
quantitative fact; the real defect is silent failure under any rejected write.
