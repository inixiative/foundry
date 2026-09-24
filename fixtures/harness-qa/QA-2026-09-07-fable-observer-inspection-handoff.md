# Fable: live observer reconciliation and learning inspection (2026-09-07, ~04:50-05:10Z)

Bounded UI implementation; self-verified, not self-accepted. Supervisor decides after
independent browser/native checks. Astra provisional lead count 5, checkpoint 6.
No learning runtime, provider, sibling or persistence implementation was edited; no
viewer route changed (the existing durable endpoints were sufficient). No native
probe, dependency, server, restart, live config/binding change, publication or agent.

## What the operator can now do

- **Watch externally admitted Foundry work without reload.** An open tab receives the
  owned `dispatch` (and `error`) WebSocket events for a thread and reconciles that
  thread's history from the durable journal within one debounce window (~400 ms).
  Token-level `context_loaded` events and layer events never trigger a fetch.
- **Keep what only this tab knows.** A stream still running in this tab is never
  replaced by the journal row for the same turn; completed results that only reached
  the browser stay browser-only beside the journal's interrupted row; legacy rows
  without identity are preserved; rows naming another thread are refused. When
  nothing changed the cache array is reused, so the composer and scroll stay still.
- **Inactive threads reconcile in place.** Events for a cached but inactive thread
  update that thread's cache only; the active `messages` signal is untouched.
  Switching to a cached thread performs one late fetch into that cache, even if the
  user switches again before it returns. Returning to a visible tab reconciles the
  active thread once.
- **Inspect historical learning in Turn Context.** A new "Learning and delivery at
  this turn" section reads the immutable delivery record from the trace, or from the
  matching durable message metadata when the trace lacks it. It shows the recorded
  barrier outcome (`pending` with domains and outstanding review counts, `none`, the
  retired `timeout`, or an unfamiliar recorded status shown verbatim), the added wait
  (0 ms), "the input used the revision committed at that time", and the delivered
  layer ledger with drift. It never reads current runtime state and never rewrites
  the prior input. Unrecorded metadata is "not recorded (older record)".
- **Inspect current knowledge in the thread view.** "Thread knowledge (current)"
  calls the existing `GET /api/threads/:id/knowledge` and shows, per domain: review
  status (known statuses named; unknown future statuses shown as recorded, never as
  pending), queued count and evidence identities, latest durable revision with
  author/hash/time, native outcome (`unknown`), local settlement, persistence, review
  job ownership (job id, thread, project, generation, epoch, base revision/hash,
  originating message, admission and eligibility times), and requested configuration
  labeled "requested; the native engine has not acknowledged these values" with the
  token/effort limit labels (`not enforced by the native facade`, `support
  unverified`, `not requested`). Instructions, configured domain knowledge and thread
  knowledge are three separate collapsible sections; thread knowledge names whether
  it is the copy frozen at review admission or the latest durable commit.
  `unavailable`, `blocked` and `reconciliation-needed` are shown with their error.

## Files

- `packages/foundry/src/viewer/ui/conversation-state.js`: `reconcileTargets(event)`,
  `reconcileThreadMessages(cache, server, threadId)`.
- `packages/foundry/src/viewer/ui/inspector-data.js`: `deliverySummary(trace, message)`,
  `knowledgeInspectionSummary(payload)`.
- `packages/foundry/src/viewer/ui/store.js`: `knowledgeInspection` signal,
  `loadKnowledge`, `requestReconcile`, per-thread debounced reconciliation from
  `flushEvents`, late reconcile on `selectThread`, `visibilitychange` handler.
- `packages/foundry/src/viewer/ui/detail-drawer.js`: `LearningDeliveryDetail` in the
  Turn Context tab; `KnowledgeInspection`/`KnowledgeDomain` in the thread view.
- Tests: `packages/foundry/tests/observer-reconciliation.test.ts` (10 unit cases,
  written RED first: append-once and stable identity, in-tab stream preserved,
  completed-unsaved kept beside interrupted row, foreign rows refused, event
  targets, delivery summary from trace and from message, unknown barrier outcome,
  knowledge summary with segments/ownership/requested labels, durable snapshot
  without job, unknown status / unavailable / missing runtime);
  `packages/foundry/tests/browser/observer-inspection.test.ts` (3 opt-in browser
  cases: live external work with no duplicate rows or submissions across active and
  inactive threads and a quick double switch; storage failure keeps observed work
  visible with the "Browser copy not saved" label; historical pending in Turn
  Context unchanged after commit plus current knowledge inspection, with
  screenshots and overflow checks at 333/390/1440).

## Commands and evidence

Environment: `FOUNDRY_QA_PLAYWRIGHT=/Users/agreenspan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright` (Playwright 1.62.1, Chrome channel).

| Command | Result |
|---|---|
| `bun test packages/foundry/tests/observer-reconciliation.test.ts` before implementation | RED: module exports missing |
| same, after implementation | 10 pass / 0 fail |
| `bun scripts/check-owned-learning-viewer.ts` (independent, unchanged) | **passed: true**, 8/8 checks: external-message-observer true (3 events), pending-learning-inspection true (backend delayed, waitedMs 0), six historical-input checks at 333/390/1440 with no overflow; report `.foundry/qa/owned-learning-visual/2026-09-07T04-57-22.231Z/report.json` |
| `bun scripts/harness-check.ts G3` over observer-reconciliation, conversation-state, browser-storage (unit), completion-persistence, browser/memory-selection-inspector, browser/browser-storage, browser/unsaved-completion | 34 pass / 0 fail, typecheck and diff pass; **stale** (`sourceChangedDuringChecks: true`, my own test edit landed during fingerprinting): `.foundry/qa/2026-09-07T04-58-05.335Z-G3` |
| `bun test packages/foundry/tests/browser/observer-inspection.test.ts` | cases 1 and 2 pass; case 3 initially failed on two of my own assertions (expected `learned` where the controlled post-commit review abstains; expected the "latest durable commit" title where a frozen job segment exists). Both assertions corrected. |
| `harness-check G3` over all eight files at 05:01:40Z | 36 pass / 1 fail (case 3, before its second assertion fix), **stale**: `.foundry/qa/2026-09-07T05-01-40.739Z-G3-zi1EiZ` |
| Rerun of case 3 after the fixes, 05:02-05:04Z | **blocked by a concurrent edit**: `POST /api/messages` returned 500 `Execution failed: undefined is not an object (evaluating 'this._pendingReviews.get')` from `thread-runtime.ts` (modified 05:01:54Z); Astra's own `owned-learning.test.ts` fails across the board on that tree. Not a UI defect; not mine to edit. |

The final stable rerun (independent script unchanged, the eight-file G3, screenshots)
is recorded in the "Final rerun" section below when the learning runtime tree is
coherent again. Until then the independent script's 04:57:22Z green run on the
pre-edit tree is the authoritative evidence for the two reproduced gaps.

## Remaining gaps and limits

- Reconnect still reloads the page (existing behavior in `connect()`): a WebSocket
  reconnect is treated as a server restart. That loses in-flight stream state on a
  transient network blip. Changing it needs a server boot identity to distinguish
  restart from reconnect; not done here.
- Reconciliation fetches at most 200 messages per thread; threads longer than that
  reconcile only their most recent 200 rows (the initial load already has this bound).
- The Turn Context learning section depends on the durable message being in the
  active thread's loaded list. A trace opened from the global trace list for another
  thread shows "not recorded" rather than fetching that message.
- Knowledge inspection refreshes on `domain_learning` events for the active thread,
  on thread switch, on visibility and by button. It is live state and can lag the
  journal by one debounce window; a stale tab and a committed snapshot remain
  distinct facts. History shows decision/domain/revision/reason, not payloads.
- No native behavior is proven: controlled reviewer/executor only. Requested
  model/effort/tokens are shown as requested; nothing here is native acknowledgment.
- Closed/non-admitted statuses that Astra may add render as "recorded status … (not
  interpreted by this viewer)" until the label set is extended.

## Instructions for the independent reviewer

1. Run the unchanged independent script with the environment above; expect
   `passed: true` and 8/8 checks; open `live-observer.png` and `pending-inspector.png`.
2. Run `bun scripts/harness-check.ts G3` over the eight files listed above (one
   invocation); expect 37 pass with a stable fingerprint. Each browser case writes
   `.foundry/qa/observer-*/report.json` with checks, page errors and screenshots
   (`turn-context-{333,390,1440}.png`, `knowledge-{333,390,1440}.png`).
3. In a disposable viewer, open two tabs on one thread, submit from one, and confirm
   the other shows the reply without reload; then submit to a second thread while
   viewing the first and confirm nothing appears in the first, and the second shows
   it on switch. Open Turn Context on a reply admitted while a review was pending
   and confirm the section says pending/0 ms and does not change after the review
   commits. Confirm "Thread knowledge (current)" shows the committed revision and
   labels configuration as requested, not acknowledged.
4. Do not treat any of this as native evidence or as acceptance of the learning
   runtime; the reopened lease/queue findings are Astra's.

## Final rerun (actual result of the first admission)

After the two assertion fixes, `bun test packages/foundry/tests/browser/observer-inspection.test.ts`
passed 3/3 at ~05:07Z, and the eight-file `harness-check G3` ran 37 pass / 0 fail
(`.foundry/qa/2026-09-07T05-06-52.809Z-a7bffe63-…-G3`) but was **source-stale**
(`sourceChangedDuringChecks: true`, Astra's concurrent runtime edits). The admission
then terminated with native `error_max_turns` immediately after that tool result, so
no end-of-turn summary followed. This section, written in a distinct correction
admission on the same binding, records that result; nothing from that turn was
replayed.

## Correction: current-knowledge observer ordering (2026-09-07, ~05:18-05:45Z)

Supervisor's independent `scripts/check-knowledge-observer-order.ts` reproduced a
blocker in my store: after revision 0, a held revision 1 request and a later
revision 2 request; the older request then completed with HTTP 200 and replaced
revision 2 in store and panel. RED report
`.foundry/qa/knowledge-observer-order/2026-09-07T05-08-45.084Z-f90f42ad-…-G4/report.json`
(observedRevision 1, olderResponseStatus 200, store.js `f886cc31…7fce`).

### Root causes and fixes (store and drawer only)
1. **No request ownership.** `loadKnowledge` published whichever response resolved
   last. Now each call takes a per-thread request id from a monotonic sequence; a
   response publishes only if it is still the latest request for its thread AND the
   thread is still active. Older same-thread successes or failures are dropped and
   counted (`superseded`). Selection A-B-A therefore cannot be overwritten by A's first
   request; a later-issued request wins regardless of revision number or runtime
   generation, so arrival time and revision are never used as "latest".
   Pending state is explicit: issuing a request marks the current state
   `pending: true` (panel: "refresh in progress; showing the last observed state"),
   and a new thread shows "Loading…" until its own latest request returns.
2. **History reconcile ownership.** `_reconcileThread` now records a per-thread
   request id and discards an older `/api/messages` response that resolves after a
   newer request; writes always go to the requesting thread's own cache and mirror to
   `messages` only when that thread is active. The previous in-flight coalescing was
   replaced by this ownership check (still one fetch per 400 ms debounce window).
3. **Chromium cache lock.** Timelines from my fixture showed a newer identical GET
   reaching the server only when the held one finished or after exactly 20 s:
   Chromium serializes identical cacheable GETs behind an HTTP-cache lock. Both live
   fetches now use `cache: "no-store"`, so a stalled older request can no longer delay
   the newer request it must lose to. This also affected the independent script's
   timing, though its assertions still held.

### Tests (actual store behavior in the real page, not helpers)
`packages/foundry/tests/browser/knowledge-observer-order.test.ts` (opt-in, controlled
HTTP responders over the real viewer/store/browser; every held response is released
before the server stops so failures report evidence instead of hanging). Written and
run RED first (0/3 on the unchanged store). Cases:
- older same-thread success dropped; older failure (503) dropped after a newer
  success; a newer `unavailable` state kept over an older held success; runtime
  generation change where the older-issued request carries a higher revision loses
  to the later-issued lower revision; manual Refresh and programmatic refresh paths;
  `superseded` count visible.
- A-B-A selection: the held first-A response cannot overwrite the later A request;
  B's revision never shows on A; pending indicator shown while a newer request is
  outstanding.
- late history after thread switch: the held A response lands only in A's cache
  while B is active; B's list is untouched; A's legacy browser-only row and
  completed-unsaved row survive; an older history response resolving after a newer
  one does not regress the cache.

### Commands and evidence (all with `FOUNDRY_QA_PLAYWRIGHT=…/node_modules/playwright`)
| Command | Result |
|---|---|
| `bun test packages/foundry/tests/browser/knowledge-observer-order.test.ts` before fix | 0 pass / 3 fail (RED; first case failed on revision overwrite, the others on the same defect plus fixture hang later fixed) |
| same, after fix | **3 pass / 0 fail**; first-case server timeline: every held response released within ms of the newer one, `superseded 4`; reports `.foundry/qa/knowledge-order-same-thread-*/`, `knowledge-order-a-b-a-*/`, `history-order-thread-switch-*/` with `same-thread.png`, `history-order.png` |
| `bun scripts/check-knowledge-observer-order.ts` (independent, unchanged) after fix | **passed: true**, observedRevision 2, olderResponseStatus 200, sourceChanged false, store.js `c2ba8d2dbb149a709d255598ded87c986456f05391c1e88db16624d4e1d04988`; `.foundry/qa/knowledge-observer-order/2026-09-07T05-42-02.968Z-35f23b61-…-G4/report.json` (an earlier green at 05-25-24 preceded the no-store change and is not cited) |
| `bun test packages/foundry/tests/owned-learning.test.ts` (Astra's suite, probe only) | 25 pass at 05:42Z; runtime coherent again |
| `bun scripts/check-owned-learning-viewer.ts` (original eight checks, unchanged) | **passed: true**, failures []; `.foundry/qa/owned-learning-visual/2026-09-07T05-42-24.087Z/report.json` with `live-observer.png`, `pending-inspector.png`, `history-{2,3}-{333,390,1440}.png` |
| `bun test packages/foundry/tests/browser/observer-inspection.test.ts` | 3 pass / 0 fail |
| `bun scripts/harness-check.ts G3` over nine files: observer-reconciliation, conversation-state, browser-storage (unit), completion-persistence, browser/memory-selection-inspector, browser/browser-storage, browser/unsaved-completion, browser/observer-inspection, browser/knowledge-observer-order | **40 pass / 0 fail**, typecheck and diff pass, `verification: passed`, `sourceChangedDuringChecks: false`, fingerprint `07e8e8cf3450d4dc2864d5332565e0154701ba426bf6f33950d950beac3e0eb8` before and after; `.foundry/qa/2026-09-07T05-42-41.356Z-4613dc72-…-G3/report.json` |

Final UI source hashes at the end of this correction (SHA-256): store.js
`c2ba8d2dbb149a709d255598ded87c986456f05391c1e88db16624d4e1d04988` (identical to the
file the independent script verified), detail-drawer.js
`0dcc62fb159098b09404702eabf62ead5934e8ee65514cfa99a160ed1ec04e39`. The only other
file changed in this correction is the new test above and this handoff.

### Gaps
- Ownership is per browser tab and per thread; two tabs remain independent observers.
- The superseded counter is a session-level diagnostic, not persisted.
- Streaming rows in the late-history case are covered by unit tests
  (`reconcileThreadMessages`) and the earlier observer case, not by a held-stream
  browser case.
- No native behavior is involved or claimed; controlled HTTP only.
