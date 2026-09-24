Continue the SAME Fable native work session after actual end_turn03:34:46.871Z.
Supervisor retained your matching provider-correction/recorder-review response in
QA-2026-09-07-fable-provenance-and-recorder-review.md. Both independent provider
files/nine cases passed independently at03:33:39.821Z-G5, but Astra review and
combined baseline remain pending; no provider rollout or self-acceptance.

Your MCP ordering concern is now independently reproduced through the actual
sibling recorder and production CodexMcpSession. New unchanged supervisor file
fixtures/harness-qa/acceptance/native-continuation-ordering.test.ts has two RED
cases: native terminal90ms after RPC inside a300ms admission deadline stops after
~58ms, and RPC-only completion stops after~53ms despite a140ms deadline. Report
.foundry/qa/2026-09-07T03-37-43.055Z-G5/report.json. Standalone strict types pass.
This is synthetic ordering evidence, not an observed real capture failure.

Own a narrow corrective slice in sibling scripts/s0/continuation.ts, continuation-
plan.ts, continuation-record.ts, related offline tests and a dedicated handoff.
Astra is actively changing Foundry core/runtime/selection, not these files. Do
not edit sibling production engine source, Foundry production, independent tests,
shared ledgers, dependency files or existing recordings. No native capture yet.

Replace the fixed settle interval as the effective native-completion deadline
with a bounded wait for the CURRENT owned admission's native outcome. Keep a
single monotonic admission deadline, not a fresh full timeout after each phase.
No second send on first rejection, unknown, failed terminal, transport/observer/
checkpoint failure. A delayed matching terminal within that deadline may permit
normal second admission if all original identity/tool/transport guards pass.
After deadline, stop admission permanently, retain unknown ownership and allow
only reconciliation/cleanup on the same late terminal or owned process exit.
Never resume run(), re-send, fork or reset native identity. Preserve immutable
historical local-result snapshots separately from later native evidence.
Cover terminal/RPC orderings, foreign/duplicate terminals, missing terminal,
late reconciliation, already-exited transport and observer/write failures.

Version precondition: supervisor independently ran bun --version and got1.3.14.
This controlled experiment intentionally pins that version and the existing
sanitizer literals. Make the pin explicit in the plan/provenance/preflight
contract with a clear no-model-process preflight failure on mismatch. It is not
necessary to generalize arbitrary version literals or loosen redaction to run
this experiment; report the portability limitation instead. Do not silently
claim portability or a different version's successful capture.

Run both independent ordering tests RED then GREEN unchanged. Add this file to
the sibling cross-check allowlist without changing the old four. Run ALL FIVE
independent native files explicitly (previous14 plus these2), sibling full suite,
script/source types, diff and before/after fingerprints. Preserve original13
recordings, prior production sources and single-turn behavior. Test plan mode
only; --capture remains unauthorized until supervisor plus Astra read-only review.

Return a dedicated correction handoff with exact evidence. You may not approve
your own correction; Astra will review it after its current selection slice.
Use apply_patch for manual edits, no Python/shell file-writing shortcuts. No
agents, work/review binding changes, credentials, server restarts, package
integration/publication, commits or broader recorder architecture changes.

The full goal remains unchanged, Astra provisional lead count4/next6. After these
corrections/reviews, the intended next native step is one separately authorized
two-admission disposable capture per active engine, then I/T adoption/tool bridge,
not an endless offline-only substitute. Native tools/events/cancel/usage, model/
effort/budget, causal three-part decoration, artifacts/attachments/tags/inspection,
fork/rewind/subsessions and subscription-independent logical work remain required.
