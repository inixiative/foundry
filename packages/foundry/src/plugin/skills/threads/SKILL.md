---
name: threads
description: Use in a Foundry thread when work should split off, or when deciding whether to continue here. Covers continuing in this thread versus forking into a new thread with fork_thread, and checking sibling threads with foundry_threads before starting overlapping work.
---

# Threads: here, or a new one

A Foundry thread is one line of work the person follows. Keep it about one outcome.

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
