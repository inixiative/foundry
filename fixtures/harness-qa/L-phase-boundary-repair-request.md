# Finish phase lifecycle correctness and demonstrate the inspector

Continue the CORE-006 local expert loop in this existing Foundry session. Your
acfca53b task is terminal: native end_turn09:43:52.260Z, message
msg_011Ceqkn5irZbNnDUhzToeNv, matching durable1788860632343, empty buffer.
Astra04a41bd3 review/measurement is now terminal10:08:08.416Z, matching
durable1788862088434 and empty buffer. Its quiet measurement slot has ended.
Parent read FULL docs/LS-phase-review-and-measurement-handoff.md, relevant source,
scratch reproductions, and independently reproduced its three findings in a
permanent test. You are the sole production source and owned browser QA owner.

Read that full review and your prior pending/completed phase handoffs. LI remains
open; source-level captures without correct ownership or rendered evidence are
not the user's requested experience. Preserve the three independently owned expert
parts, shared attributed evidence, and separate phase protocol. Herald remains
selective cross-thread evidence, not global private memory. Pooling stays deferred.

## Required repair

1. An actual configured requested-input SQLite write failure quarantines/disposes
   the runtime, yet a new ordinary reviewer complete() is still called because the
   callback swallows that error. Preserve the original failure and quarantine;
   refuse admission after owner closure for every provider, without inventing a
   native acknowledgment or retry. Distinguish absent optional persistence from
   failed configured persistence. Audit the analogous guard/route/advice journal
   failures and bounded-record overflow: already-supplied input must not become
   successful durable capture, and failure must be inspectable. Do not block the
   central turn on background reviews or turn a persistence error into all-clear.
2. appendPhase idempotency must validate all immutable association fields, not
   only thread/body: original thread, turn, dispatch, phase and exact record. Reject
   contradictory acknowledgment without changing the original row. Cover null
   correlations and legitimate exact replay. Keep the existing journal, not a
   parallel store or a schema reset.
3. Join guard outcomes to their explicit requestRecord (and the recorded mapping)
   with matching observation/domain/owner association. Never select the latest
   same-domain request by convenience. Preserve other pending invocations, missing
   references and conflicts honestly instead of silently coalescing histories.
   Add duplicate observation and foreign/missing reference controls. Avoid making
   a same-domain fallback that reintroduces incorrect historical inputs.

Protected parent packages/foundry/tests/phase-history-boundary-contract.test.ts
SHA256 d834b0e63fd51f0f4607ec73ad5b2da1a53d5ed6d77d2ad568ed4bfd0a176c4b
is 0pass/3fail/5assertions on these defects. G3
.foundry/qa/2026-09-08T10-13-10.744Z-5b289757-f933-4179-abda-b69bb4da9cf9-G3/report.json.
Explicit standalone strict types pass. Earlier parent fixture metadata/literal
typing mistakes are corrected; no production/assertion change was used. Preserve
this test and all previous parent contracts. Extend coverage in your own file.
The guard contract also requires the second invocation to remain pending, not
merely selecting the first request while hiding the other one.

## Finish the user-facing proof

Obtain actual rendered historical inspection in a fresh, owned local browser
fixture using the existing Playwright harness and real runtime/HTTP/file-backed
SQLite with controlled model responses. You own the browser slot; parent and Astra
are not running concurrent measurements. Existing Mac CUA is locked: do not retry
or bypass that lock, attach to the user's browser, or use ambient browser state as
permission. Use owned headless Playwright and keep screenshots for parent viewing.
Known runtime module:
/Users/agreenspan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright

Demonstrate old-message inspection showing original instructions, domain knowledge,
own thread understanding and actual phase input; pending review/guard becoming
settled under the original identity after the main turn ends; next-turn consumption
of committed knowledge; failed/quarantined and legacy absence states; history after
reopen while current configuration/state differs. Make uncorrelated guard history
reachable without fabricating a turn association. Cover desktop and narrow mobile,
select the real right-panel controls, and assert displayed content/absence plus
overlap/console failures. Do not replace the app with a standalone mock panel.

Use existing samples and fixture APIs, not another parallel application framework.
Keep source edits scoped to phase lifecycle/persistence/inspection and necessary
tests. If one rendered condition cannot be exercised, retain the actual attempt,
error and owned cleanup, explain the exact missing step, and do not claim completion
from projections or skip the browser silently again.

## Verification and delivery

Run focused default-budget tests for the new defects, original pending/phase/guard/
review/ownership/recovery boundaries, plus package and relevant standalone types.
Retain the first failures and source identities. Do not change protected assertions,
raise existing timeouts, run broad full suites repeatedly or turn failed totals into
passes by adding unrelated counts. The intermittent setup copy delay remains open:
Astra's instrumented eleven-file124pass, two-file26pass/3fail, uninstrumented
eleven-file124pass are distinct conditions, all with4browser skips. The two-file
delay is at actual cp await with live JS heartbeats; filesystem cause is not proven.
Do not change copy behavior or LS diagnostics in this task. A setup failure must be
retained and distinguished from UI/correctness failure, not retried until green.

No real model experiment, install/live4400/4407 restart, account/binding change,
native process kill, immutable candidate patch, release/count advance or commit.
Continue visibly in this Foundry session. Deliver
docs/L-phase-boundary-repair-handoff.md with findings/resolutions, exact retained
commands/results, changed-file hashes, actual screenshot paths, owned cleanup,
remaining gaps and the next action toward the real learned-next-turn native loop.
The full original tools/subsessions/recovery/lineage/artifacts/tags/latest-model
fidelity, Herald and matched Astra/Fable capability/latency scope stays required.
