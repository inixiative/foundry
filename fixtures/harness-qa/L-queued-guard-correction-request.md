# Correct the queued-future-request occupancy failure

September8 after08:55Z: SUPERSEDED, NEVER DISPATCHED. Astra independently found and
fixed this issue before6fa32af2 completed; the parent protected regression now
passes unchanged in21test/341assertion G3 08:53:04.690Z-b9d0dc69. Preserve this
request as history, not the next assignment. See the current QA ledger.

This request is to be dispatched only AFTER your current LA turn6fa32af2 has an
authoritative native terminal, matching durable final and empty live buffer, and
parent has read its full final handoff. It does not interrupt or authorize a second
concurrent source task. Continue the full CORE-006 objective in the same Foundry
session; no native retry or acceptance is authorized.

Parent independently reproduced a queue defect while reviewing LA. Read
docs/L-local-expiry-parent-queue-finding.md and protected new
packages/foundry/tests/domain-loop-queued-guards.test.ts. G3
.foundry/qa/2026-09-08T08-32-00.622Z-d043c116-c5d6-4a87-a364-6138b224442a-G3/report.json
is RED0pass/1fail/4assertions, stable before/after source,178ms. Focused strict types
pass. The failure is exactly advice-queue-refused, not an import/typing/timeout error;
the fixture releases all controlled handles. Keep all fixture bytes/assertions intact.

The actual composition HTTP turn remains open; pre-advice finishes; the first of
three native guards is held while two successors queue without native admission.
After the first settles, the second's scan of all other same-pool budget calls
includes the third unsent request. No native identity can exist for that future
request, so the scan falsely closes global admission. Correct the ordering boundary:
only relevant predecessors/originals can block a queued request. Keep exact owner,
native outcome, call, capacity and cleanup inspection for those predecessors. Do not
ignore an unresolved earlier original, relabel later work admitted, send replacements,
reset the budget, relax ceilings/deadlines, or special-case the fixture.

Own only scripts/domain-loop-composition.ts, your NEW focused author test if needed,
and docs/L-queued-guard-correction-handoff.md. Preserve the LA failure-classification
work, initial Harness policy, existing protected tests and parent new tests. No
DomainLibrarian/Flow/core/provider/runtime/journal/UI edits: Fable0e4071e3 owns the
separate guard-outcome and owned-understanding correction. The current inspector
copy was shortened by parent after advice-capture terminal; do not overwrite it.

Add/retain FIFO evidence that all three legitimate guards enter once, without
overlapping a predecessor's unresolved original. Run the unchanged parent fixture,
your default10s/15s local-expiry and ownership controls, policy and existing runner
regressions with strict types. Existing larger gates do not override this RED.
Retain real result hashes/resource evidence, label concurrent dependency drift, and
stop for parent/opposite review before any native/browser/install/candidate/live/
account/binding/commit operation. If another boundary is exposed, report it directly.
No claim that this fixes the earlier filesystem stall or browser-order fault.

Minor new-test review note: in domain-loop-local-expiry.test.ts the assertion
Date.now() >= now() samples the left side before the right and can fail across a
millisecond tick. Capture the comparison baseline before the tested read rather
than using that reversed sampling order; retain the actual hard-deadline assertion.
No production clock or deadline change is requested.
