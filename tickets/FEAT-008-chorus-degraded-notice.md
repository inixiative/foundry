# FEAT-008: A degraded chorus shows in the thread, with Retry

**Status**: Built (inixiative-19, lane 3a)
**Priority**: High
**Created**: 2026-11-01

---

## What Aron decided

Wardens are a chorus. On a timeout the turn proceeds without them (unchanged). Aron, 2026-11-01, on Layer 1 timing out: "timeout is fine, alert a degraded state in the thread w/ retry cta's in the thread".

Silence stays the default for the main thread. The change: when Wardens go unheard, the thread shows it, and the person can ask those Wardens again.

## What counts as degraded

A Warden is degraded at one moment when the system, not the Warden, decided it said nothing. The moments are the user's message, a handoff brief, a consumed work item, and the post-turn guard.

| Recorded as | Degraded as | Silent? |
|---|---|---|
| advice `decision: 'timeout'` (the orchestrator's deadline fired; the call still runs) | `timeout`. Layer 1 for a one-layer Warden (the default), unknown for a staged one | yes |
| advice `decision: 'error'` | `timeout` when the failing stage's trace says `timedOut`, else `error`; layer = that stage + 1 (1 for a one-layer Warden) | yes |
| advice `decision: 'excluded'`, or guard status `not-admitted` (never admitted in time) | `not-started` | yes |
| advice `skipped: cold-cache` for a Warden whose cache missed its warm deadline (`warmWithin` shortfall) | `not-started`, "not warm in time" | yes |
| a check in `GuardReport.failed` (`provider-error`, `invalid-response`) | `error`, with the layer from its staged run | yes |
| `classified.fallback` (a later layer failed after Layer 1 answered) and the Warden did not speak | the failing layer, its kind | yes: Layer 1 said yes, and the pointer was lost |
| the same, but the Warden did speak (a pointing Layer 1's answer stood) | the failing layer, its kind | **no**: shown as "spoke from Layer 1 only, unconfirmed" |
| the whole fan-out failed (a between-turn ask threw; the guard flow threw) | every Warden that would have been asked, `error` | yes |

**Not degraded:**
- `no-comment` and `contribute`.
- `skipped` (prefilter, guard triggers, or a cold cache with no warm deadline missed).
- `omitted`. The Warden spoke; the composition budget chose, and the choice is recorded in `omissions`. Asking again would hit the same budget.

**Known limits:**
- **Guard stages have no per-stage deadline**, so a slow guard is a provider error, never "Layer 1 timed out".
- **`preMessage` throwing.** The turn fails visibly and no advice row is written. The turn's own error is what shows.

## What the journal records

- **`degraded`** on `advice` and `guard-outcome` rows. It is derived where the row is written (`agents/chorus-degraded.ts`, pure) and journalled once, so the viewer, ACP and the turn view read one field. It is written at write time because three facts exist only then: the Warden's layer count, which Wardens missed their warm deadline, and which were asked when a whole fan-out failed. Large stage traces also spill out of SQL's reach (`journal-content.ts` references nested records), so the message index could not derive it there. There are no users, so no old rows need it.
- **`moment`** on every advice row: the text the Wardens were asked on, so Retry asks the same moment. It is stored through the journal's content store, deduplicated by hash once it reaches 1 KB.
- **`retryOf`** on a retry's row (same turn).
- **`chorus-dismiss`** phase rows, `{of: [row ids], by}`.
- **"Open"** is derived at read time (`turnChorus`): a degraded row with no later `retryOf` and no dismissal.
- **Readers of "the" advice row skip retry rows:**
  - `turn-timeline.ts` (pre-plan chorus and `saidNow`)
  - `inspector-data.js` `expertParticipants`
  - `feedback/service.ts` exposure timing
  - `acp/src/context.ts`

## Where it shows

- **In the thread, at that turn.** Under the agent message: "The chorus was degraded on this turn: on the message security (Layer 1 timed out); … The turn went on without them." It has two buttons, **Retry** and **Dismiss**. After a retry it reads "The degraded Wardens were asked again; anything they said rides with your next message." A retry that fails again shows its own notice.
- **Context bar.** The newest turn's open notice adds a line under the existing setup notice, with the same class: "Chorus degraded on the last turn: N Wardens went unheard. Retry". This is separate from the in-session "could not be held" line, which is a different condition.
- **Thread status colour.** Unchanged. A degraded chorus does not stop the turn (not red), and nothing waits on the person (not orange).
- **ACP.** The "Foundry: context" item adds a "Chorus degraded…" line and `_meta.foundry.degraded`. A guard row with `degraded` becomes a "Foundry: guard" comment. ACP has no action channel to the daemon for this, so hosts are told and pointed to the viewer for Retry.
- **Data path.** The message index puts the turn's `chorus` (`TurnChorus`) on its agent row, read in SQLite from `degraded`, `retryOf` and `of`. Those keys are kept inline by the journal's spill (`SQL_READ_KEYS`). A journalled row already emits a `journal` event, so the viewer reconciles without new plumbing. `chorus` is server-owned in the history merge.

## Retry

`POST /api/threads/:threadId/turns/:turnId/chorus/retry` (202 `{started, busy, unavailable}`), and `/chorus/dismiss`.

**Advice rows.** The retry asks only the row's degraded Wardens, on its `moment`, through the existing between-turn path: `ThreadRuntime._askBetweenTurns` → `FlowOrchestrator.retry` → `_between` (restricted to those Wardens). That path journals the row and calls `queueNotes`. The note is `retry:<row id>:<domain>`, "The X Warden chimed in on your earlier message (asked again): …", and it rides with the next turn to be prepared. Nothing reaches a running turn.

**Guard rows.** The retry guards exactly the calls the row recorded (`activity.calls`, by call id), rebuilt from the journalled native history, through `_guardActivity` → `postAction({only})`. It is journalled as a `guard-outcome` with `retryOf` and `correlation: 'retry'`. The retry is refused, with the reason, when the row elided calls (`overflow`) or the journal no longer holds a call or its output. `filesAffected` and the original clipping are not journalled, so the retry asks on the same calls, not the same bytes.

**Shared rules for both kinds:**
- The moment is the same. The thread state and knowledge are the current ones.
- The thread's runtime must be live; otherwise 409 "open the thread to retry".
- A row already being retried is reported as `busy`. The lock is in memory, per thread, and does not survive a restart.
- Rows on an observed subagent's node (its briefs and guards) live on that node and are not shown on the main thread.
- Retry is offered while the raw rows exist. They age out after `journal.rawMiddlewareDays`, and the reduced entries do not carry `degraded`.

"Retry all" (re-ask every Warden, not only the failed ones) is left out, because Wardens that already answered would repeat chimes the thread already has.

## Open

- **A timed-out call keeps running** (`_trackOutstanding`), and its late answer is dropped. A Retry while it still holds the Warden's decision capacity queues behind it. Journalling the late answer ("answered late: …") would make many Retries unnecessary, but it is a separate change.
- **Staged Wardens on an orchestrator timeout** record layer unknown. Recording the stage in flight needs the stage index from `runStages`, and `classify/run.ts` is being changed in parallel (`carryWhy`).

## Primitives used

| Concern | Existing primitive (path) |
|---|---|
| Stage outcomes | `classify/run.ts` `runStages` → `ClassifyStageTrace.timedOut/error`, `ClassifyResult.fallback`; read only, unchanged |
| Guard "not completed" | `GuardReport.failed` (`agents/flow-orchestrator.ts`) |
| Cold Wardens | `FlowOrchestrator.warmWithin` shortfalls |
| Journal | `ThreadRuntime._journalPhase` (`advice`, `guard-outcome`), `LocalSessionStore.appendPhase` / `phaseHistory`, `SQL_READ_KEYS` |
| Fan-out and delivery | `FlowOrchestrator._between`, `ThreadRuntime._askBetweenTurns`, `betweenTurnNotes`, `queueNotes` (the "chimed in on the handoff" path) |
| Guard | `ThreadRuntime._guardActivity` → `FlowOrchestrator.postAction` |
| Thread view refresh | `journal` events on `thread:<id>` → `reconcileTargets` → `messageIndex` |
| Notice | `context-bar-setup--degraded` in `conversation.js`; a message-level notice beside `TurnFeedback` |
| Route reach | `threadFactory.runtime.get(threadId)` (as `viewer/server.ts` already does) |
| ACP | `packages/acp/src/context.ts`, `guard.ts` |
