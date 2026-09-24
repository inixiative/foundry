# Fix late evidence navigation, then opposite-review the completed M0 boundary

Continuation after dbc3c876 completed: native end_turn15:50:52.587Z, matching
durable completed row, empty live buffers, complete M1 final handoff read by
parent. This is a new bounded request, not a replay. Same UI/store/test ownership.
Astra remains active on M4-A startup; do not edit startup or runtime/M0 helper.

Parent independently reran unchanged snapshot-evidence, browser-cache and
history-index acceptance plus inspector/legacy pins:21PASS/98assertions, types
and diff PASS, stable96da49d57b54bc260b0e819746918305dc64dba27af192d991b9626b92ae3ba9.
.foundry/qa/2026-09-07T15-51-49.641Z-06db7f57-592b-448c-bf32-2455c37efd26-G6/report.json.
Parent read the11/11 browser report and viewed scrolled desktop testing and mobile
architecture segments; actual three parts are readable. Snapshot omission is
fixed. This does not accept the new navigation boundary below.

## Independently reproduced navigation regression

New parent acceptance/expert-evidence-navigation.browser.test.ts runs real M0
factory/journal/viewer/store in isolated Chromium, holding only the delivery of
GET /api/threads/a/turns/owned-a-evidence/detail. It starts openTurnDetail(a,...),
calls actual store.selectThread(b), then releases the original owned A response.
activeThreadId remains b but currentTrace.selectedTurn becomes A, and the real
drawer displays owned-a-evidence under B. No mocked journal body/native activity.
This is operator-context misattribution, not evidence of a server authorization
leak. selectThread clears currentTrace but doesn't invalidate traceSequence; the
new openTurnDetail path tests sequence only, unlike loadTraceDetail's thread guard.

RED0PASS/1FAIL/3assertions; page errors0, cleanup[], screenshot visually reviewed:
.foundry/qa/parent-expert-navigation-aHGZda/report.json and1440-after-thread-switch.png.
Gate .foundry/qa/2026-09-07T15-53-40.330Z-15644d34-572a-48d6-8742-eae4461d8940-G6/report.json,
stable95f07ed08dee094be094e50fdbef1adec102386a7d58731727b331634dfe5e0a.
Strict test types --allowJs PASS. Original test unchanged by you. Storee9b271c8,
drawer542400da, helper875b3599 at repro. No parent process remains live.

Correct the navigation ownership consistently: reject old responses after thread
switch, also A -> B -> A generation changes, a newer selected turn, and clear /
selection dismissal. Do not re-open a dismissed panel from an older success,
error response or catch. Keep direct detail navigation for evidence outside the
loaded page and same-thread current requests working. Use existing selection
identity/sequence mechanisms; no extra history store, blanket reload or polling.
Add focused actual browser ordering controls and preserve the original parent RED.

## Then opposite review M0 (read-only)

After the correction checkpoint, review docs/M0-domain-loop-handoff.md, the M0
runtime privacy projection and successful structured-reason retention, source
scenario and lifecycle/owned learning contracts. Parent already independently
passed4/84 and checked all16 retained journals via scripts/check-m0-artifacts.ts
(exact paths in canonical latest15:30 entry). Review what those artifacts prove,
not a worker's claim. No direct opening original frozen native databases and no
whole-tree/runtime edit. Any real gaps require precise source/evidence references.
Write docs/M0-domain-loop-opposite-review.md with verdict and clearly separate
source/controlled, installed, and live scope. The runtime successful-reason fix is
already present and verified; do not continue calling it an active omission.
Do not hold this review for unfinished M4-A or self-certify live adoption.

Checkpoint before edits and after focused/browser/type checks; complete both
handoffs within the bounded turn if feasible. No candidate/install, live restart,
native sample, credential/configuration/binding, shared-browser or commit changes.
Count remains eight pending parent acceptance. Live local-expert execution remains
the next product dependency before Herald; pooling remains deferred.
