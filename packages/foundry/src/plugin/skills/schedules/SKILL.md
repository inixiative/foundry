---
name: schedules
description: Use in a Foundry thread when the person asks for something to run on a timer (every morning, every 2 hours, once on Friday), when you think recurring work would help, or when you are running as a scheduled run. Covers set_schedule, remove_schedule, list_schedules, drafts the person accepts, and what a run thread is.
---

# Schedules (`set_schedule`, `remove_schedule`, `list_schedules`)

A schedule starts a new thread on a timer, with its prompt as that thread's first message. Each run works to completion on its own; the person sees every run in the Scheduled view, and a run that needs them shows in Attention.

## Told, or your own idea

- **The person asked for it** in the message that opened this turn: `set_schedule` makes it at once.
- **Your own idea**, or the ask came from somewhere else (a member's post, a ticket, a scheduled run): `set_schedule` still works, but saves a **draft**. A draft never runs; Foundry asks the person Accept or Reject on this thread, and they can answer there or in the Scheduled view. Don't set Needs-you for it yourself. Say in your reply what you proposed and why.
- A live schedule is changed or removed only when the person asks. You may change or remove your own draft.

## How

| Field | What |
|---|---|
| `id` | a short lowercase slug (`nightly-deps`); the same id again replaces it |
| `name` | what it does, in a few plain words |
| `prompt` | the first message of every run. Write it for an agent with no memory of this thread: what to do, where, what done looks like, when to ask. Foundry marks it as a scheduled run itself |
| `when` | runs at least 5m apart: `{"every": "30m" \| "2h" \| "1d"}`, `{"cron": "0 9 * * 1-5", "tz": "Europe/London"}`, or `{"at": "<ISO time>"}` once |
| `where` | optional: `{"kind":"project","projectId":…}`, `{"kind":"global"}`, or `{"kind":"scope","scope":"forge"\|"feedback"}`; absent, this thread's own Where |
| `worker`, `role`, `model`, `effort` | optional; absent, the Where's defaults |

`list_schedules` shows every schedule with its next run and last result.

## When it runs

- Each due time runs once. A recurring schedule that missed runs while Foundry was off runs once, at its latest due time; a once-only schedule more than an hour late is skipped.
- If the previous run is still working, the next due time is skipped, never queued.
- Budgets are Kingdom's: a run that hits one fails like any turn.

## If you are a scheduled run

A run gets only the schedule's prompt as its first message, nothing else, so read it as the person's standing instruction. Do the work to completion. Use `set_status needs-you` only when the person must decide something; `done` when finished. Anything that needs the person's word (a new schedule included) waits for them, because a run's prompt is not their message of this turn.
