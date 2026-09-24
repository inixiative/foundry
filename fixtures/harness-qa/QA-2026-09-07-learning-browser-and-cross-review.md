# Learning/browser independent QA and cross-review

2026-09-07, supervisor. Previous goal turn: progress (new durable test evidence,
verified native terminal/server states and updated continuing supervision). This
turn adds independent SQL/browser evidence and new same-session review admissions.
Full objective unchanged; accepted Astra slice count stays 5, checkpoint 6.

## Actual completion and current ownership

- Fable S1 explicit-compaction correction ended 04:29:54.561Z in its existing
  native da000690-899a-4128-a868-b9a024aeeaa0. Dedicated sibling handoff:
  docs/S1-compaction-evidence-correction.md. No new live compaction capture.
- Astra owned-learning task ended 04:35:30.941Z, native turn
  01a07a0a-00e2-7e72-b1d4-4376e28351d7. Read docs/G3-owned-learning-handoff.md.
  Its sequential final baseline claims 1,138 executions; the 04:33:06.747Z report
  was a millisecond output-directory collision and is not valid independent
  evidence. Use its separate sequential refresh reports, not the collided output.
- New Fable read-only learning review: G3-owned-learning-fable-review-request.md,
  Foundry turn_3e34aa90-0a51-48df-af23-7c8427889058, HTTP200/matching start;
  actual same-native tools verified 04:40:17.742Z and 04:43:51.164Z. It must review
  correctness, capacity, lifecycle and the historical serial-barrier contract,
  then return QA-2026-09-07-fable-owned-learning-review.md. No source ownership.
- New Astra lead review/design: I-native-integration-astra-review-request.md,
  Foundry turn_0c8fa716-7249-4fa3-ba27-f01e5bdbb88a, HTTP200/matching start;
  actual native task_started 04:39:08.977Z, turn
  01a07a29-b5aa-7242-ae4b-210e560466de. It reviews Fable compaction plus latest
  provider binding/model evidence and proposes executable I/T adoption with
  authoritative scoped tools, native outcomes, learning reconciliation and real
  in-Foundry sample work. Output docs/I-native-integration-review-and-plan.md.
  No install, source/default change, restart, native probe or publication allowed.

Both servers returned HTTP200. Opening the lead browser through the app returned
queued, not proof of a visible refreshed tab. No live process was restarted.

## Independent tests

The new learning-durable-boundary test initially had one pass and one fixture
setup failure: a second SQLite connection could not install its trigger because
LocalSessionStore deliberately uses exclusive locking. This is not a production
rollback regression. The fixture now installs a real revision-2-only SQL abort
trigger through its existing private test connection. It does not replace the
store's save method or relax an assertion; delayed-status writes remain allowed,
so the failure specifically targets publication of the replacement revision.

- Two real HTTP/SQLite cases pass at 04:38:17.575Z-G3: delayed fact commits and
  returns after journal reconstruction without user repetition; a later SQL
  commit failure preserves previous durable/live revision and completed output,
  with explicit blocked inspection and no uncommitted fact in message history.
  Reconstruction here covers the precreated matching runtime's knowledge, not
  full project/thread topology recovery. Strict standalone ES2023 types pass.
- All eight independent learning cases across learning-review-input,
  learning-owned-runtime and learning-durable-boundary pass at
  .foundry/qa/2026-09-07T04-41-21.528Z-G3/report.json, types/diff pass,
  stable fingerprint 47a2762aca1673745850f645249a3c4997f2dfbea2ea20550e9e9b9f5b6f09f0.
- All 21 independent native cases across seven explicit files pass with both
  repository manifests stable: sibling .qa/s0-cross-2026-09-07T04-38-54.022Z/report.json,
  Foundry .foundry/qa/2026-09-07T04-38-54.047Z-G5/report.json. This includes immutable
  real continuation recordings and explicit-compaction negative/synthetic cases,
  not live positive compaction or complete S1/native parity acceptance.
- All 14 independent provider model/profile/binding/evidence cases pass at
  .foundry/qa/2026-09-07T04-42-04.141Z-G5/report.json, types/diff pass, stable
  fingerprint ef5230ee96b79a2dcf08d914570f5ca3ee18a58dd144f8395e6a0eb11d2bb29d.
  Opposite-model review remains separate from those passing checks.

## Browser results: six positives, two failures

New repeatable script scripts/check-owned-learning-viewer.ts composes production
runtime, viewer, HTTP, SQLite and WebSocket paths with controlled reviewer and
executor. It owns and closes its disposable server/browser; no native model or
live work state is used. Run with bundled Playwright via FOUNDRY_QA_PLAYWRIGHT.

Authoritative report:
.foundry/qa/owned-learning-visual/2026-09-07T04-43-19.771Z/report.json.
Screenshots, exact provider inputs, pending/committed knowledge and received
WebSocket events are retained alongside it. The earlier 04:41:01.143Z pending
check was a false positive matching its turn ID; the corrected fixture uses IDs
without status words. Do not count that earlier pending result as acceptance.

Verified positives: an immediate request reports backend pending with waitedMs0
and uses the old committed context. After release and durable commit, the next
request receives the Zephyr fact. The prior trace remains deeply identical.
Reloaded Turn Context displays the old input without the fact and the new input
with it at widths 333, 390 and 1440 (six cases), no detected horizontal overflow
or browser exceptions. This is controlled functional evidence, not native speed.

Reproduced gaps:

1. An already-open observer receives three owned WebSocket events but does not
   show externally submitted completed work within the 2.5s observation bound.
   Reload recovers it. Source confirms store.js scheduleRefresh updates traces,
   threads and prompts; loadThreads loads messages only if its cache is empty.
   The user must be able to watch the continuing Foundry lead without reload.
   Fix reconciliation of active/inactive histories without losing local unsaved
   output, duplicating messages, replaying work, or cross-writing thread caches.
2. Turn Context omits the recorded pending-learning state and distinction between
   last committed knowledge and outstanding review. The endpoint reports delayed
   with owned job evidence, and the result retains pending/waitedMs0, but the
   visible panel exposes neither. Add usable historical delivery/learning state
   and current owned review inspection without rewriting prior inputs, treating
   historical pending as current pending, or presenting requested config as ACK.

## Next actions and acceptance boundaries

Read actual review terminals before redispatch. Resolve the old domain-learning
immediate-wait test explicitly: no added central wait, visible pending with the
last committed revision, then automatic causal knowledge on first post-commit
request. Preserve the old failure report and replacement coverage; do not simply
delete a red test or label it expected. Fable's review informs that decision.

After reviews, assign the browser refresh/inspection correction and reviewed I/T
implementation with disjoint ownership. Typed native propagation and actual MCP
project-scope cases remain RED as recorded in native-adoption-readiness. No engine
adoption or required-context relaxation has occurred. Current servers still run
earlier accepted builds; local learning source is not deployed. Native learning
sampling and safe lease reconciliation follow reviewed integration rather than
replaying historical model replies or unknown occupied work.

Retain the full native sessions/tools/subsessions, artifact/attachment/tag/right
panel, model/effort/usage/capacity/latency and subscription-pooling goal. Bounded
learning safety is not permanent permission to stall background work or discard
queued evidence; that remaining capacity/recovery behavior must be implemented.

## Review completion and independently reproduced blockers, 04:53Z

Fable's actual learning review ended04:45:35.008Z. Verdict **reopen**; see its
dedicated review. Frozen inputs, CAS and ordinary causal learning pass, but closed
leases create misleading pending state, unbounded retention and no audit for
never-admitted evidence. Its recommendation to distinguish settled stateless
calls from unknown native occupancy is sound; provider IDs alone are not proof
of that distinction. Auxiliary cleanup must not blindly clear an active unknown
worker or equate local disposal with native cancellation. Explicit phase settings
must not silently downgrade an operator's requested model.

Supervisor added learning-closed-capacity.test.ts. Four independent RED cases at
.foundry/qa/2026-09-07T04-50-36.947Z-G3/report.json:

- Closed unknown review remains reported pending after32 later dispatches.
- Those32 never-admitted payloads remain queued instead of bounded refusal records.
- Later refused evidence has no durable learning-history record.
- Actual OpenAIProvider against a disposable loopback HTTP server receives a
  completed503 for the first review, then never reviews a distinct later work item.
  No external network/model/account was used. Unknown-native policy controls make
  exactly one controlled call, preserving no-replay coverage.

G3-closed-capacity-correction-request.md is **prepared, not dispatched**. Wait for
Astra's current review/design terminal, then send the correction in the same lead
session. It covers explicit non-admission/closed-state evidence, stateless versus
unknown occupancy, faithful phase defaults and safe auxiliary lifecycle, durable
publication-failure audit and consistency. Native terminal reconciliation still
requires I; never accept permanent background disablement as the final product.

Fable is now implementing the disjoint viewer correction:
G4-live-observer-learning-inspector-request.md, Foundry
turn_b84d2fd3-d38b-4f07-92b6-5b39eeb7964b, HTTP200/matching start; actual tools
verified04:50:50.481Z. Expected handoff
QA-2026-09-07-fable-observer-inspection-handoff.md. Do not redispatch while active.

Supervisor explicitly accepted both models' nonblocking contract clarification
and replaced only the obsolete serial-wait case in domain-learning.test.ts with
two cases: immediate committed-context/pending/waitedMs0, and a new request after
the production domain_learning learned signal receives the fact without user
repetition. No test-only settling helper precedes either behavior assertion;
helpers run only in cleanup. Existing domain concurrency and ownership cases
remain. Removed an invalid unused maxTokens fixture config property for strict
types, not a behavior assertion. All4 cases/types/diff pass at
.foundry/qa/2026-09-07T04-51-27.074Z-G3/report.json. Original failure remains in
the earlier report and Fable review; it was not relabeled expected. There are now
16 independent learning cases across five files:12 passing and4 closed-capacity
RED, not a green whole-learning acceptance.

Astra's public review update04:49:29.468Z identifies an additional provider
configuration-array boundary. Supervisor independently added a third case to
native-model-evidence-ownership.test.ts: appending a fabricated fact through the
public observedConfiguration collection manufactures later nativeModel despite
no model acknowledgment on the synthetic native stream. RED2pass/1fail at
.foundry/qa/2026-09-07T04-53-24.193Z-G5/report.json. Individual frozen event objects
do not protect the mutable collection. Model suite now totals15 cases, with this
new failure; the prior14-pass report remains valid only for its narrower cases.
Await Astra's completed review/design handoff before choosing the correction and
local adoption sequence. No source rollout or native capture has occurred.
