# Correct discovery result ordering

Continue SAME Fable/Foundry session after actual end_turn10:13:58.386Z and durable
final. Parent read entire docs/T3-owned-discovery-handoff.md. Scoped contract and
existing positives retained, but independent guard review REOPENED two cases.
Same goal/count6-next8, no self-acceptance, models, staging or live changes.

New independent acceptance/native-discovery-order.test.ts has one valid control
and two negatives. With matching exact references/full owners/memory receipts,
both result-before-discovery-begin and result-after-dependent-memory-begin are
accepted and unlock admission2. Current explainDiscovery checks only begin index.
Require discovery begin < discovery result < first dependent memory begin;
reject impossible result-before-begin even without a dependent call. Preserve
exact ownership, references and one-pair accounting. Do not reorder evidence to
make it fit or relax any independent assertions.

Parent correction10:16Z: initial10:15 report was46pass/3fail because the new
positive control omitted transportOutcome:open. Parent fixed that fixture setup;
no production edit. Corrected combined3files47pass/2fail187assertions, actual
valid:true/admittedAgain:true reproduced in both malformed sequences:
.foundry/qa/2026-09-07T10-16-33.069Z-60e1f1f9-cbf2-42b4-bd39-4c1dd8de9838-G5/report.json.
Stable9f8bec804a39a058d364855743a88983f81fa633db7c00765733bf915c1c010c.
Initial report .foundry/qa/2026-09-07T10-15-34.621Z-838a17cb-7f91-4c95-8400-41ae435b6411-G5/report.json
is retained but cannot prove admission unlock. Existing15provenance/31focused
passed in both. Use the corrected current independent fixture unchanged.
Run the unchanged independent3+15 plus focused cases with types/hashes. Own guard,
focused test and appended handoff only; Astra I2 remains active, no shared fields
or sibling/provider edits. Append exact correction evidence/limits to
docs/T3-owned-discovery-handoff.md. No frozen capture changes, root installs,
restarts, credentials, binding changes, agents or commits. Use apply_patch.
