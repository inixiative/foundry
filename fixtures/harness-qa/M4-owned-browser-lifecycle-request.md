# Implement owned browser lifecycle, without touching the active runner

Your30f5ecc1 completed native end_turn18:19:11.060Z, matching durable final
1788805151115 and empty live buffers. Parent read FULL section7 of the bootstrap
opposite review. Its single-invocation F1 is a concrete pilot prerequisite.

New independent zero-model characterization through the real runner/factory:
.foundry/qa/parent-browser-liveness-ITGP1j/report.json (18:20:29.991Z).
A held observer constructor leaves no files; releasing it to throw then produces
a truthful failed report. A held close after controlled open refusal leaves only
checkpoint-1, with cleanup still not-started, until close is released. No native
session was constructed, zero sends, both original promises released, final
reports retained and all local resources closed. This proves ordering, not the
internal cause of the original real Chromium stalls or completed-native loss.

Implement a narrow owned Chromium lifecycle in scripts/owned-browser.ts with
tests in packages/foundry/tests/owned-browser.test.ts. This module is justified
by needing a distinct local browser process owner and bounded construction/close,
not a second execution engine or merely splitting a file for parallelism.
Only these two new source/test files and docs/M4-owned-browser-handoff.md are yours.
Astra owns the active settlement correction in native-domain-loop.ts/composition/
tests. DO NOT edit them, the current bootstrap diagnostics, checker, vendor,
parent fixtures, or any live/candidate state. Provide the minimal integration
contract and exact call sites in your handoff; parent will authorize integration
after Astra's terminal. Helper-only success is NOT runner/product acceptance.

Inspect the installed reviewed Playwright APIs before choosing implementation.
The owner should cover a single launched browser and its connection, permit
bounded construction operations, and expose truthful idempotent cleanup with
stage/progress observations. Preserve the10s launch and8s readiness budgets;
do not enlarge them or weaken existing real browser assertions. A progress
callback should allow the runner to durably record browser-setup before awaiting
launch/newPage/attachment; report native/session state belongs to the runner.

If graceful browser close stalls, a fallback may terminate ONLY the exact local
browser child acquired by this owner, then verify its exit. Never pkill, match
process names, kill an arbitrary PID, touch shared/user Chrome profiles, or kill
any model/bridge/server worker. Never claim cleanup complete because an observer
timeout expired. Preserve original failures and late-returning handle ownership;
do not launch a replacement. If a handle/exit is genuinely unavailable, report
that explicitly. Ensure pending timers/listeners/late promises have intentional
ownership and cannot introduce unhandled rejection or a duplicate release.
Do not collect arbitrary stderr, payloads, browser storage or credentials.

Test acquisition failure, stalled construction with an acquired handle, stalled
graceful close and exact fallback exit, failed/unconfirmed exit, idempotent close,
late resolution, and normal real Chromium launch/page/close with bounded public
phase evidence. Controlled fake child/process cases must be labeled, distinct
from a real browser test. Real tests use a fresh isolated owned Chrome only,
bundled Playwright at /Users/agreenspan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright.
No native model/sample, package install, candidate, saved-server restart,
account/binding/credential/shared-browser edits or commits.

Keep this proportionate: the goal is to unblock reliable native artifact capture,
not create a generalized job framework. Full F2 rendered-disconnected coverage,
original psHtK1 cause, mixed-fault stress, and final runner report/checkpoint
integration remain explicit until actually exercised. Source hashes, exact tests,
retained failures and known limits go in the handoff. No count advance. The full
native local expert loop, configured experts and Herald order remains unchanged.
