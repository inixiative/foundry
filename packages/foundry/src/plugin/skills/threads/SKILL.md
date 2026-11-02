---
name: threads
description: Use in a Foundry thread before handing back (status), when the thread's outcome becomes clear or changes (rename), when work should split off, or before overlapping work. Covers set_status (needs-you, blocked, done, clear), rename_thread, fork_thread, and foundry_threads.
---

# Threads: status, name, here or a new one

A Foundry thread is one line of work the person follows among many. Keep it about one outcome, and keep its name and status true: they are all the person sees on the board.

## Status (`set_status`), before you hand back

Foundry already shows what it can see: working, queued, a failed turn, an approval waiting, archived. You say what it can't:

| You are handing back because | Call |
|---|---|
| You wait on the person: a question, a decision, a review | `set_status` `{status: "needs-you", text: "Which table should sessions write to?"}` (orange) |
| You can't go on: a missing credential, permission or dependency | `{status: "blocked", text: "No GitHub token for inixiative/kingdom"}` (red) |
| The ask is finished | `{status: "done", text: "Login endpoint merged"}` (blue), or mark the plan's last outcome `done` |
| A status you set no longer holds | `{status: "clear"}` |

`text` is one line the person reads on the board. The person's next message clears the status. A turn that just ends with no status reads as done, so say `needs-you` whenever your answer ends in a question.

## Name (`rename_thread`)

Foundry names a new thread from the person's first message. Rename it when the outcome becomes clear or changes: the outcome in 3–7 plain words ("Fix flaky login test", not "Working on tests"; no status words). Once you rename it, Foundry's namer leaves it to you. A name the person gave is theirs: the tool refuses, and you ask them.

## Here, or a new one

| Situation | Do |
|---|---|
| Next step of the same outcome | Continue here; update the plan (`set_plan`) |
| The person says "take this and do it in its own thread" | `fork_thread` with `name` and `task` |
| A separate outcome turned up while working | Note it as an outcome with status `you` and ask; don't fork on your own |
| Unsure whether someone else is on it | `foundry_threads` first |

## `fork_thread`

Starts a new top-level thread that carries this conversation so far. It runs at once only when the person's own message asked for it; otherwise the person is asked to confirm.

- `name`: the new thread's name, the outcome in 3–7 plain words ("Watchtower: machine badges").
- `task`: the first message the fork works on, complete enough to start without this thread.

```json
{ "name": "Kingdom project link in settings", "task": "Move the Kingdom project link into its own kingdomProject setting and…" }
```

## `foundry_threads`

Lists the other live threads in this project (description and status). Call it before starting work that could collide with another thread (same files, same feature), not on every turn.
