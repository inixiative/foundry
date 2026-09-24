Continue in this SAME native Fable session. Your memory correction completed
02:32:34.789Z; Astra's S1 historical correction completed02:36:20.544Z. Supervisor
has verified matching Foundry results and rerun independent checks. Two bounded
tasks follow; keep their ownership and acceptance distinct.

First, finish the one missed memory validation boundary from the prior request:
ConfigStore.load still assigns an unchecked merged configuration. Supervisor's
new acceptance/memory-load-native-boundary.test.ts has two RED cases for invalid
global/project settings loaded from disk, plus one GREEN native-executor guard
case. Evidence .foundry/qa/2026-09-07T02-36-00.648Z-G3/report.json. The test fixture
then received its missing required staleness:0 field and passes standalone strict
TypeScript; no assertions changed. Reproduce before editing.

Validate the merged candidate BEFORE replacing live settings or setting loaded
state. On invalid persisted policy, fail explicitly, keep last working live
configuration, and do not overwrite the invalid file with defaults. Preserve
valid legacy configs and normal default/provider merges. Use the existing shared
validator; no second validator or unrelated configuration rewrite.

Correct your handoff's unsupported claim that the required-context guard is
API-only: supervisor verified production ThreadFactory -> Executor -> real
SessionBackedProvider configuration blocks before native createSession, with an
inspectable injection conflict. That case passes without spawning any native
process. This does NOT establish a native retrieval bridge or live rollout.

Supervisor independently passed all16 cases in the earlier FIVE memory files:
.foundry/qa/2026-09-07T02-33-53.509Z-G3/report.json. Your assigned HTTP validation
also passes the three subsequently added memory-policy-routes.test.ts cases.
Full baseline .foundry/qa/2026-09-07T02-34-14.434Z-baseline/report.json passes;
actual historical Selection UI333/390/1440 passes in
.foundry/qa/memory-selection-visual/2026-09-07T02-34-13.384Z/report.json.
After the load fix, explicitly run all SIX independent memory files (19 cases):
memory-selection.test.ts, memory-selection-provenance.test.ts,
memory-required-retrieval.test.ts, memory-selection-review.test.ts,
memory-policy-routes.test.ts, memory-load-native-boundary.test.ts, all under
fixtures/harness-qa/acceptance. Run focused config cases, types and baseline.
Update your dedicated handoff with exact stable evidence; no self-approval.

Second, READ-ONLY re-review Astra's S1 historical correction in ../agent-session.
Read its docs/S1-identity-outcome-handoff.md latest section and actual changes
against your prior QA-2026-09-07-fable-S1-review.md. Supervisor reran all14 native
independent cases via explicit four-file cross-check:
../agent-session/.qa/s0-cross-2026-09-07T02-36-46.071Z/report.json and
.foundry/qa/2026-09-07T02-36-46.089Z-G5/report.json; sibling suite/types:
../agent-session/.qa/s0-2026-09-07T02-36-47.439Z/report.json. All pass, with
108 ordinary +2 expected S4 tests. No native probes or Foundry adoption happened.
Verify historical transport attribution, current unresolved work/late evidence,
unowned/foreign event retention without binding adoption or active-turn pollution,
immutable history and safe observer diagnostics. Check that raw unknown native
events remain distinct from user-facing content and sanitizer privacy is retained.
Revisit your findings, report concrete remaining blockers, and state a bounded
source-slice accept/reopen verdict. Do not edit the sibling or self-review memory.

Give a brief leadership/scope checkpoint recommendation conditional on supervisor
acceptance. Keep native two-admission continuation, I integration, T scoped tools,
streaming/cancellation/usage, attachments/tags/inspection, fork/rewind/subsessions,
latest model/effort, three-part decoration and subscription-independent continuity
explicit. The code-only slice cannot satisfy full native S1/G5. Count is still3;
supervisor decides acceptance and checkpoint advancement, not the implementer.

No new agents, native probes, server restarts, dependencies, credentials/bindings,
commits or publication. Source edits only for the narrow Foundry load fix and
its tests/handoff; sibling and shared graph/independent fixtures remain read-only.
Keep this within the known25-turn central cap and give an honest partial handoff
if needed. Do not replay old work or replace the native session.
