---
name: loop
description: Use in a Foundry thread when work will take several rounds of build, check and fix (a failing suite to get green, a migration to verify, a tuning run, a review to answer), not for a single pass. Covers set_loop (start or revise the loop), loop_round (record each round), stop_loop (end it), shown in the Loop tab.
---

# The thread's loop (`set_loop`, `loop_round`, `stop_loop`)

The plan is what the person wants; the loop is the process you repeat to get there. The Loop tab shows it: the goal, one round's steps, the check that ends it, and every round with its result.

## When

| Moment | Do |
|---|---|
| You see the work needs repeated rounds (the first check fails in several places, a tuning run, "keep going until green") | `set_loop` before the first round |
| A round ends | `loop_round` with `pass`, `fail` or `partial` and a note of what it found or changed |
| The round's steps change | `set_loop` again: the running loop keeps its rounds |
| The `until` check passes | `stop_loop` `{result: "done"}` |
| You hit `maxRounds`, a blocker, or the person changes course | `stop_loop` `{result: "stopped", reason}`, then tell the person and `set_status` |

Skip it for a single build-and-check pass: that's the plan's strategy.

## What goes in

```json
{
  "goal": "Viewer browser suite green",
  "steps": [{ "text": "Run bun run test:browser" }, { "text": "Fix the first failing spec" }],
  "until": "bun run test:browser passes twice in a row",
  "maxRounds": 6
}
```

- `until` is a check anyone can run, not a feeling ("the suite passes", "p95 under 200 ms").
- `maxRounds`: when to stop and ask instead of grinding. When `loop_round` says the limit is reached, stop.
- A round's note says what changed and what the check showed, in a line: "Fixed the drawer race; 2 specs still fail on focus".

Curated loops you can reuse across threads are coming soon (Foundry settings).
