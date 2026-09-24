# Review the parent's journal lifecycle correction

Your M4-B draft review d48cd043 completed native end_turn16:31:59.289Z, matching
durable completed row and empty live buffers revalidated. Parent read the complete
review and independently reproduced your three probes with actual Chromium:
`.foundry/qa/2026-09-07T16-33-06.606Z-6ada37a4-81b3-412f-b09d-4749c90c59c7-G6/report.json`.
V1 opaque failure reporting and V2 projectless observer URLs remain findings to
route to Astra after its current original8cb40057 turn settles. Do not interrupt
it, edit its files or claim final runner acceptance.

The parent's own narrow journal regression independently isolated I1 without any
provider. Parent implemented the store-local correction, outside Astra ownership.
Read docs/M4-journal-statement-lifecycle-parent.md and independently review:
- packages/foundry/src/persistence/local-session-store.ts
- fixtures/harness-qa/acceptance/journal-statement-lifecycle.test.ts

Own docs/M4-journal-statement-lifecycle-opposite-review.md and optionally a new
disjoint packages/foundry/tests/m4-journal-review.test.ts. No production edits.
Check finalization on eviction/close/failed construction, retained transactions
and exclusive-lock protection, hot-query reuse/bounded memory, typing and
meaningful history/checkpoint/learning recovery. Do not use GC, delays, global
cache mutation or a weakened lock as a substitute for deterministic cleanup.
Read the actual local Bun implementation if needed. Parent55cases/901assertions
and strict types pass on exact hashes in the handoff; revalidate, don't trust the
pass summary alone. Record bounded verdict and any consequential reproductions.

Astra also added a failing assertion for missing controlled native tool output
in post-review input (parent16:30 stable39pass/1fail gate in the handoff). That is
separate from this store review and must not be removed or claimed fixed by the
journal change. Full runner/native pilot remains pending.

No native model/sample execution, installation, candidate creation, live state or
server restart, bindings/credentials/account/shared-browser storage changes, or
commit. Only source review and disposable controlled tests with owned cleanup.
Count TEN remains unchanged. Custom-expert/Herald/full native parity scope stays
on the graph; this correction enables the next live local-expert proof.
