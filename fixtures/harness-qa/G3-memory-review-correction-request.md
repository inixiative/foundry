Continue the memory-selection implementation in this SAME native Fable session.
Your S1 review completed02:16:40.518Z and is preserved in QA-2026-09-07-fable-S1-review.md.
Astra's opposite-model memory review completed02:20:02.471Z and is preserved in
fixtures/harness-qa/QA-2026-09-07-astra-memory-review.md. It reopens four concrete
findings. Astra is separately correcting S1 in ../agent-session. You own Foundry
memory/core/configuration/inspector tests only, not the sibling or shared graphs.

Supervisor reproduced the new findings independently. Read these files unchanged:
- acceptance/memory-required-retrieval.test.ts (1 failure), evidence
  .foundry/qa/2026-09-07T02-15-57.608Z-G3/report.json; detail
  fixtures/harness-qa/QA-2026-09-07-required-memory-retrieval.md.
- acceptance/memory-selection-review.test.ts (6 failures: two failed-refresh
  focus races, three invalid policy inputs, invalid config patch), evidence
  .foundry/qa/2026-09-07T02-22-27.813Z-G3/report.json.
Both acceptance paths above are relative to fixtures/harness-qa. Their standalone
strict TypeScript checks pass. Original memory-selection.test.ts (4) and
memory-selection-provenance.test.ts (2) are also unchanged and must stay green.

Fix the behavior and actual boundaries, not just sentinel cases:
1. Never execute without mandatory omitted requirements merely because the prompt
   says to use a memory tool. Native sessions currently lack Foundry's scoped
   retrieval bridge. For this correction supply required content intact or block
   with an explicit inspectable error before provider execution when retrieval is
   unavailable. Do not blindly dump the audit log or silently drop a rule. A real
   native scoped-tool bridge remains an explicit next integration node, not a
   capability to invent or implement ad hoc inside this correction.
2. Failed initial refresh OR failed focus-triggered retry must preserve truthful
   content/focus provenance and leave wrong-focus content stale, not warm. Consider
   no selection report, manual set, restore and concurrent focus changes too.
3. Validate selection policy at runtime: supported numeric types, finite integers
   and sensible bounds, kind arrays, invalid JSON values. Validate source creation
   and persisted/operator configuration at load/save/global and project patch
   boundaries. Reject invalid policy without mutating live settings or persisted
   working settings. Route-level project mutation before store validation must
   not poison the current configuration. Prefer one shared validator over copies.
4. Fix your opt-in browser test's nonexistent cleanup?.(): use typed fixture.close(),
   and cover browser launch failure, partial setup and cleanup exceptions so all
   owned server/browser/runtime/store/temp resources are released. Supervisor's
   separate scripts/check-memory-selection-viewer.ts already proves actual
   historical Selection rendering; do not weaken or edit that checker.

Preserve the full original contract: instructions/domain knowledge/thread knowledge,
owned searchable audit history, immutable historical selection and exact prepared
input, privacy, causal learning, native tool/artifact/attachment/tag inspection,
lineage/subsessions, latest models/efforts and subscription-independent continuity.
Character budget is not token/latency/native retention proof. Oversized required
context blocking is honest bounded behavior, not the final no-capacity-loss goal.

Keep the correction within the installed central25-turn native limit; prioritize
correctness and give a precise partial handoff if unfinished rather than claim
acceptance. No native probes, new agents, dependency changes, commits, publication,
credential/binding changes or primary4400/lead4407 restart. Do not alter live
session configuration to evade the limit. Preserve all dirty changes.

Run the new tests RED before edits, then all FOUR independent memory files
explicitly through harness-check G3 (13 cases), focused core/config/route/browser
tests, strict types and full baseline. Verify stable source and retain exact
reports. Add focused tests for configuration rejection without poisoning state
and cleanup on launch failure. The baseline alone omits independent acceptance.
Update your dedicated memory handoff, not shared ledgers. Return for independent
QA and Astra read-only review. No self-approval; accepted count remains3.
