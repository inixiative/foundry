---
name: plan
description: Use before starting any task that will edit files in a Foundry thread, again when it changes, and before handing back; also when Foundry adds "this thread has no plan yet" to a message. Covers set_plan (record or update the plan, mark to move one outcome), get_plan (read it back after a compaction), clear_plan, and Foundry's own drafts; the person sees the plan in the Plan tab.
---

# The thread's plan (`set_plan`)

The Plan tab shows what this thread is doing and why. It reads only what you record with `set_plan`; until you call it, Plan says "not recorded yet".

## When

1. **Start:** once you understand a non-trivial ask (more than a one-line answer), before building.
2. **On change:** an outcome is done or starts, the strategy changes, a technical decision is made or reversed.
3. **Hand-back:** before you give the turn back, make the statuses true.

Skip it for questions, one-line fixes and chat.

When a message brings new work to a thread with no plan, Foundry adds a line to it: "Foundry: this thread has no plan yet…". That is the moment to call `set_plan`. If you don't, Foundry drafts a plan from the conversation after the turn (`draftedBy: 'foundry'`, shown as a draft); your first `set_plan` replaces the draft whole.

## What goes in

| Section | One line each | Example |
|---|---|---|
| `outcomes` | what the person gets, with `status`: `todo`, `doing`, `done`, `you` (waits on the person) | "Board shows each thread's machine" · doing |
| `pains` | what hurts today | "Plan reads 'not recorded yet'" |
| `strategy` | how the work goes, in order | "Stamp the device on thread meta" |
| `reasons` | why this way, not another | "The device id already exists in device.json" |
| `technical` | one row per concern the work touches | see below |

Lines are short (labeling rules: the outcome, 3–7 plain words); put more in `detail`.

## Technical rows: name what exists

For each concern (auth, permissions, db access, requests, locks, jobs, events, errors, settings, …) say which existing system you use and where it lives:

- `reuse` / `extend` / `combine` / `refactor` / `migrate`: `system` is the existing primitive, `path` where it lives.
- `new`: only when nothing fits. `reason` says what the closest system is, what would have made it fit, and why that is wrong here. "Doesn't match exactly" is not a reason.
- `none`: the concern needs nothing.

## Sections replace, others stay

Each section you give replaces that section; sections you leave out keep their last value. To move outcomes without resending the list, use `mark`: `{"mark": [{"outcome": "Board shows each thread's machine", "status": "done"}]}` (the outcome's exact text, or its number from 1). An outcome newly `done` shows the thread as done with that text, until the person's next message.

## Read, clear

- `get_plan`: what Foundry shows for this thread (name and who gave it, status, plan and whether Foundry drafted it, loop). Use it after a compaction or when resuming, before changing the plan.
- `clear_plan`: the work the plan described was dropped. Record the new one with `set_plan`.

Work that needs several rounds of build, check and fix also gets a loop (the `loop` skill): the plan is what you want, the loop is how you get there.

## Example

```json
{
  "outcomes": [{ "text": "Board shows each thread's machine", "status": "doing" }],
  "strategy": [{ "text": "Stamp the device on thread meta", "detail": "From ~/.foundry/device.json, once per thread" }],
  "technical": [
    { "concern": "identity", "decision": "reuse", "system": "readLocalDevice", "path": "packages/foundry/src/devices/local-inventory.ts", "reason": "The device id already exists and /api/devices reports it" }
  ]
}
```
