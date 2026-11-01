---
name: plan
description: Use before starting any task that will edit files in a Foundry thread, and again when it changes and before handing back. Foundry's set_plan tool (mcp__foundry__set_plan) records the thread's plan (outcomes with status, pains, strategy, reasons, and technical rows naming the existing system used per concern) so the person sees it in the Plan tab; without it the Plan tab is empty.
---

# The thread's plan (`set_plan`)

The Plan tab shows what this thread is doing and why. It reads only what you record with `set_plan`; until you call it, Plan says "not recorded yet".

## When

1. **Start:** once you understand a non-trivial ask (more than a one-line answer), before building.
2. **On change:** an outcome is done or starts, the strategy changes, a technical decision is made or reversed.
3. **Hand-back:** before you give the turn back, make the statuses true.

Skip it for questions, one-line fixes and chat.

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

Each section you give replaces that section; sections you leave out keep their last value. To move one outcome to `done`, send the whole `outcomes` list with the new status.

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
