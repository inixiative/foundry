# Memory Selection: Independent Integration Baseline

Supervisor-owned file: fixtures/harness-qa/acceptance/memory-selection.test.ts.
Command: `bun scripts/harness-check.ts G3 fixtures/harness-qa/acceptance/memory-selection.test.ts`.
Initial report: .foundry/qa/2026-09-07T01-30-40.353Z-G3/report.json.

One ordinary failure and one pass. The production file-memory source resolver,
layer/agent builders, ThreadFactory and ThreadRuntimeManager dispatch to a capturing
LLMProvider. This is not a standalone selector assertion. No native model calls,
credentials, live server restart or user memory records are involved.

The first case seeds an old relevant observation and explicit convention, then
grows unrelated tool-result records from20 to160. At each dispatch both required
sentinels reach actual provider messages, and the complete stored audit inventory
is byte-for-byte equivalent before/after selection. The older observation remains
searchable. After160 irrelevant records, delivered input is226634 characters,
failing a deliberately generous32000-character ceiling. A second assertion limits
growth between the two measurements to8000 characters, but the initial run stops
at the earlier ceiling failure. These are character guards for a small controlled
case, not model token budgets or latency/capacity acceptance.

The second case passes: the actual provider receives its own and explicitly global
conventions, but not private conventions from a same-named thread in another
project or unowned legacy records. Selection deletes or mutates none of them.

Foundry's source fingerprint is stable during this run:
1f1ecdb18876c84e3b761a367887aff292369ba4bdbb65d7c6a167e619b42d62.
The implementation is concurrently assigned to Fable; this report is a red
baseline, not completed-change acceptance. Preserve this independent file when
implementing. Re-run after native implementation completion with a stable source
fingerprint, then broaden independent checks for omission provenance, oversized
requirements, generated learning, historical snapshots, retrieval and restart.
The test captures delivery, not whether a real model follows the delivered rule.
That native learned-convention scenario remains a later rollout gate.

## In-Progress Adversarial Check at01:39-01:40Z

The initial two cases now pass against Fable's in-progress implementation. Four
new ordinary acceptance cases fail, and this slice is not ready for acceptance:

1. An1878-character explicit requirement fits the6000-character source budget,
   but the default1200-character prefix excerpt removes its mandatory ending.
   The provider receives the introduction plus an excerpt marker, not the rule.
   Preserve fitting pinned requirements in full; oversized requirements need
   explicit handling that does not silently substitute their introduction.
2. A3000-character observation matches the query only near its middle. Selection
   correctly labels the record relevant but injects only the unrelated prefix.
   The matching rollback fact never reaches the provider. The excerpt must carry
   the selected evidence, with truthful offsets/provenance, not merely a record ID.
3. A record excluded by retrievalLimit is subsequently selected by recent fallback,
   but its omission remains in the report. It is counted as both selected and
   omitted, so inspector and injected summary disagree with actual delivery.
4. Changing layer focus from alpha to beta while an async load for alpha is pending
   produces alpha content/source report but labels the layer selection with beta's
   focus hash and marks it warm. Keep the load's captured revision/focus together;
   if focus changed, reselect or mark stale, never relabel old input as new.

The first two extend the same provider-boundary integration file. Reports:
.foundry/qa/2026-09-07T01-39-38.332Z-G3/report.json (2pass/2fail), stable source hash
d9f7221e111e6185bf379bf316059c0fd7cfe2a18aec1522d98dcc35cf0b1e01.
The last two are fixtures/harness-qa/acceptance/memory-selection-provenance.test.ts,
using the real selector and a controlled async ContextSource. Report:
.foundry/qa/2026-09-07T01-40-33.706Z-G3/report.json (0pass/2fail), stable source hash
031bad65e75581846ab5c2bfac498186261bbee06e8da4272cd5bcde501cffd3.
Each run was stable separately; the two hashes are not claimed to be one revision.

Relevant implementation: selectMemory/excerpt in core adapters/file-memory.ts,
and ContextLayer.setFocus/_doWarm in core context-layer.ts. Fable is still actively
implementing, so these are reproducible in-progress defects, not a judgment on a
finished handoff. Preserve the tests, rerun both explicit files after completion,
and send a bounded corrective request if the failures remain. Do not count a
size-only improvement as retention/provenance acceptance.
