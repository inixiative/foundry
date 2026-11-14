# Scheduler

Schedules get work running on a timer: each run starts a new thread with the schedule's prompt as its first message, and that thread runs to completion on its own. Aron, 2026-11-14: "Things that are running on a schedule can definitely, whatever that's doing, run completely. I should be able to go see past runs of the schedule. It should show up in attention if it needs to… It's just a way of getting things running on a schedule."

Code: `packages/foundry/src/scheduler/` (`types.ts`, `due.ts`, `scheduler.ts`, `agent-tools.ts`), the API in `viewer/routes/schedules.ts`, the viewer's Scheduled rail in `viewer/ui/schedules.js`.

## Schedules are local

A schedule lives in this Foundry's settings (`.foundry/settings.json`): `scheduler.schedules` at the top level for Global and the scopes, `projects[id].scheduler.schedules` for a project. A repository's committed `.foundry/project.json` may not hold one; it is refused by name. Why: a schedule spends its owner's capacity on its owner's machine, so a teammate cloning a repo should never inherit someone else's timers (decision 2026-11-14, `docs/rules/foundry-harness.md` in the org repo).

Every edit goes through `ConfigStore.update`, so it is validated, persisted and audited in `.foundry/audit.jsonl` like any settings change.

## A schedule

| Field | Meaning |
|---|---|
| `id` | lowercase slug, unique across this Foundry; run ids and the history key on it |
| `name` | what it does; runs are named `<name> · <date>` |
| `prompt` | the first message of each run's thread, written for an agent with no memory of where it was set |
| `when` | `{every: "15m" \| "2h" \| "1d"}` (at least 5m), `{cron: "m h dom mon dow", tz?}`, or `{at: ISO time}` once |
| `worker`, `role`, `model`, `effort` | what runs start on; absent, the Where's defaults |
| `scope` | top-level only: `forge` or `feedback`, so runs are Forge Master or Feedback threads |
| `paused` | kept but not running |
| `since` | Foundry's: due times count from here |
| `draft` | Foundry's: an agent proposed it and the owner has not accepted it (`{threadId}` of the proposer) |

**Where** is the project, Global, or a scope, the same choice as the New thread picker's Where. A run thread is made by the same `createThread` path as `POST /api/threads`, so it gets that Where's worker, role and composition.

## When a schedule runs

The scheduler checks every 15 seconds (`makeUnrefInterval`), and once when the daemon starts. For each schedule that is on (not paused, not a draft, its project enabled and not archived):

- **Due times count from `since`.** `since` resets when a schedule is made, when its `when` changes, when it is resumed, and when a draft is accepted, so nothing it missed while off runs afterwards.
- **Exactly once per due time.** Each due time is claimed in the journal's `scheduler_runs` table (`schedule:<id>:<dueAt>`) before its thread is started; a claimed id is never started again, across ticks and restarts.
- **Missed while Foundry was off.** A recurring schedule runs once, at its latest due time, and its run records how many earlier due times it caught up on. A once-only (`at`) schedule runs if it is under an hour late (`ONCE_GRACE_MS`), and is otherwise recorded as skipped (missed).
- **Overlap.** If the previous run's thread still has a turn queued or running, the new due time is recorded as skipped (overlap). It is never queued behind it.
- **Run now** starts a run by hand at any time, including when the schedule is paused (`schedule:<id>:now:<ts>`). It is never allowed on a draft.

Each run records `started` (with its thread), `skipped` or `failed`, with the reason. The history stays after a schedule is removed.

## A run is an ordinary thread

The run's first turn carries a schedule origin (`TurnOrigin.schedule`). Because of that origin:
- the prompt is not wrapped as an outside member's post (it is the owner's, set ahead of time);
- the message shows as "Scheduled run" in the conversation (`meta.scheduledRun`);
- the thread header carries a "scheduled · <name>" pill (`meta.scheduledBy`) that opens the schedule.

From there it is a thread like any other. It works to completion, asks with `set_status needs-you` when it needs a decision (so it shows in Attention, like any thread), and can be opened, steered or archived.

A run's turn is not the owner's own instruction (`ConversationService.ownerInstructed` is false), so anything a run asks for that needs the owner's word, a new schedule included, waits for him.

## Agents and schedules

An agent has three tools on the thread's record (Foundry's own, never asking for approval):

- `set_schedule` makes or replaces a schedule.
- `remove_schedule` removes one.
- `list_schedules` lists them all.

The rule (Aron, 2026-11-14): "If you tell an agent to do a schedule, it should do it. If it decides to do a schedule on its own, then it should prompt you."

- In a turn the owner's own message opened, with no other party's words taken in, the schedule is made at once.
- Otherwise it is saved as a **draft**:
  - A draft never runs.
  - The proposing thread is set to Needs-you, so it shows in Attention, and the Scheduled tab counts drafts.
  - The owner accepts it in the Scheduled view, or saves it from the edit form, and it runs from then on. The proposing thread's ask is cleared.
  - Reject removes it.
- A live schedule is changed or removed only on the owner's instruction. An agent may change or remove its own draft.

## The Scheduled view

The left rail's Scheduled tab lists schedules grouped by Where, each showing its time, its next run or why it has none (paused, a draft), and its last result. Opening one shows:
- its prompt;
- Run now, Pause or Resume, Edit, and Remove (Accept and Reject on a draft);
- its past runs, each with its outcome, reason and a link to its thread.

\+ New schedule opens the same form. The list is the `schedules` data stream (a snapshot, then the full list on every change).

## API

All behind the viewer's operator authentication; every call is the owner's.

| Route | Does |
|---|---|
| `GET /api/schedules` | every schedule with `where`, `nextDueAt`, `lastRun` |
| `GET /api/schedules/:id/runs?limit=` | its runs, newest first (default 50, at most 500) |
| `PUT /api/schedules/:id` | `{schedule, where}`: make or replace; never a draft |
| `DELETE /api/schedules/:id` | remove; runs stay |
| `POST /api/schedules/:id/pause` | `{paused}` |
| `POST /api/schedules/:id/accept` | accept a draft |
| `POST /api/schedules/:id/run` | run now |

## Budgets

Foundry never checks a budget ahead of a run. A run makes its requests like any thread, routed through the Signets this Foundry holds for that actor and project, and Kingdom applies the budget when the request is made. A refused request fails the run like any turn. Why (Aron, 2026-11-14): "Budget should be processed at the time of Kingdom… It's just going to try to make a request"; Foundry cannot know a budget's state, Kingdom can.

## Not built yet

- **Triggers** (a run started by a Kingdom integration event instead of a time) wait on the Signet event stream reaching a release. A trigger answers events as they arrive and never catches up on ones missed while its stream was down (Aron, 2026-11-14: "That would be more of a different ask").
