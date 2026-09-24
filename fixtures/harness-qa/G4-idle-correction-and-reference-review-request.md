# Close the missing-idle admission gap, then review reference integration

Continue SAME Astra/Foundry/native session after actual R0 terminal11:14:19.969Z,
matching durable final and full handoff read. Same full goal/count6-next8.
Final Codex788be251bf652bde03021721bacab5e7471232b3b1d31f850163a9c41771a662.

Task A: fix one reproduced source gap in your R0 ownership boundary. Installed
Thread schema requires status. Current condition accepts absent status and sends
turn/start on a cold stored binding, despite your comment/criterion saying
missing status is not idle acknowledgment. Preserve original binding, no work
write, no silent fresh/retry when native runtime state is missing or unknown.
Do not leave this as a future adapter-only guard; the public existing class must
not turn unknown runtime state into new work. Known idle and known active controls
must still behave correctly. Keep native/local/RPC/cleanup distinctions.

Parent original wire/outcome fixtures now supply explicit idle status and empty
turn history, and wire turn/start replies supply valid owned Turn objects.
These strengthen previously permissive setup, not weaken existing assertions.
Added missing-status negative and active-status control. Combined12cases11pass/
1fail37assertions, strict types pass, source788... unchanged before/after:
.foundry/qa/2026-09-07T11-15-31.400Z-834e02e8-5297-4661-a9bd-59c2822c95f1-G5/report.json.
Only missing-status case RED. Keep all parent assertions unchanged; add focused
source tests for absent/null/unknown/native active versus explicit idle. Run
scoped tests/types and old MCP ownership regressions, no full staging/baseline
churn for this correction. Append exact correction/limits to R0 handoff.

Task B, read-only: opposite review full docs/T3-claude-reference-handoff.md,
sibling Claude/harness event fields and Foundry core/provider public projection.
Fable's normalizer and projection finished, no production edits active there.
Parent4referencecases/type/diff PASS at11:07:05; Fable68focused/guard/provenance
tests positive, actual CLI wire shape still unproven. Review malformed/partial
references, omitted labels, exact query/tool/call/owner/ordering guard, detached
arrays/private data and unchanged ordinary text. Note own-authored original
guard parts; do not self-review them as independent. Run focused independent
reference/discovery/provenance/projection tests with scoped hashes/types.
Write docs/T3-reference-opposite-review.md with ordered findings and source/
candidate/native readiness split. No self-acceptance/count advance.

Fable simultaneously read-only reviews R0. Only sibling Codex source/tests may
change in Task A; report exact final hash promptly and don't edit reference
production files. No native calls, staging/install, root changes, live restart,
credentials/accounts/bindings, commits or extra agents. Full native recovery/
bridge/history/I2/artifact/inspection/pooling/latency goal unchanged. Return with
concrete R1/R2 integration boundary from your existing graph; implementation of
that boundary follows reviewed R0/reference source, not another general study.
Use apply_patch for manual edits.
