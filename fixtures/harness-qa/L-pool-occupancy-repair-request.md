# P02b: correct original admission ownership across pool reuse

Continue the full Foundry goal in this existing visible Fable session. You own the
next source/test slot; Astra is idle and parent will remain read-only while you work.
Read CORE-006, docs/L-delivery-parent-acceptance.md and
docs/L-pool-occupancy-parent-investigation.md first. P02a has bounded independent
acceptance, not full release; the combined runner gate remains failed32/7/4skip.

Reproduce the pilot02 occupancy mechanism before changing it. Use the actual
SessionBackedProvider and production domain-loop composition with controlled owned
sessions: A completes its RPC/native work and is released with resource exit proof;
B reuses its logical pool/native resume ID with a DISTINCT physical session and a
held RPC. Inspect and reconcile both originals. A must not regress to pending due
to B's logical-key counter, and B must remain occupied. After B truly settles,
normal C review admission must not be refused by stale A occupancy. Preserve RED.

Repair the underlying ownership/lifecycle model, not merely the fixture. Explicitly
distinguish original admission RPC settlement, captured physical session cleanup,
and current logical-pool occupancy. Do not infer capacity from native terminal text,
make settlement unconditionally monotonic, clear a legitimately closed stop latch,
cancel/replay work, or replace unknown originals. If reinspection spans awaits,
cover a newly arriving caller so there is no check-then-admit race.

Cover same-physical-session overlapping admissions, pending RPC after native
terminal, unknown cleanup, failed originals, foreign owner, observer failure,
late settlement and distinct physical generations with the same resumed native ID.
Use existing ownership capabilities and production admission paths. If evidence
disproves the mechanism, record the real mechanism and repair that instead.

Keep changes scoped. Preserve P02a proof/phase contracts, parent tests, protected
runner/R1/R2 assertions and existing timeout budgets. No subscription pooling,
native CLI/model experiment, root install, candidate mutation, account/binding
change, server restart, commit or unrelated process signal. This is session-resource
occupancy correctness, not account pooling. No other native pilot is authorized.

Run focused production-provider/ownership/composition tests and strict/package
types with exact immutable command/source/exit evidence. Any failed broad gate
stays failed; do not hide it with a passing isolated subset. No broad retry matrix
or LS sampling is needed here. Await every owned test process and clean up every
acquired resource through its original handle. No browser is needed for this scope.

Write docs/L-pool-occupancy-repair-handoff.md: causal reproduction, code ownership
model, RED and unchanged-budget GREEN commands/counts/receipts, remaining failures,
exact source hashes, cleanup evidence and next graph node. Preserve original
pilot02 and all prior evidence. State explicit limits: controlled evidence is not
native capacity/latency acceptance. Then finish this Foundry turn for independent
parent review. P02c startup and the remaining native loop/full goal stay open.
