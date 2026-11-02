# CORE-001: Steering into the active turn, on by default

**Status**: ✅ Built 2026-11-02 (needs agent-session with AS-008).
**Assignee**: inixiative-cd
**Priority**: Medium
**Created**: 2026-10-31
**Updated**: 2026-11-02

---

## Overview

A message sent while a turn is running used to only queue. Now it steers into that turn by default.

**Decided (Aron, 2026-11-01):** "I think that should be a toggle for steering. I think steering should be on by default. Things which are queued can obviously be steered, even regardless of the toggle. There should be an action there."

- **A `steer` toggle, on by default.** With it on, a message sent during an active turn goes into that turn. With it off, it queues as before.
- **A queued message can always be steered**, whatever the toggle says, through "Steer now" on the queued item. It leaves the queue and goes into the active turn.
- **Where the runtime can't steer**, the message queues and the reason is shown, on the item and on the disabled "Steer now".

## Why

- A follow-up mid-turn is usually a correction to the work in progress. Queuing it means the turn finishes on the wrong course first.
- T3 Code steers human follow-ups by default and has the same per-item action on its queue (`promote_to_steer`). Paseo steers agent-to-agent sends.
- Mid-turn delivery is also the route a parent turn needs for a child's finish notice or question (FEAT-004).

## What each runtime does

| Runtime (transport) | Steer | How |
|---|---|---|
| Claude Code (`claude-cli`) | yes | A stream-json user message with `priority: "next"` and a `uuid`, tracked by `command_lifecycle` (agent-session AS-008). Taken in after the next tool result; when the reply was already final, it runs right after as a follow-on result of the same turn. A stop withdraws a steer not yet started (`cancel_async_message`). Live-verified on claude 2.1.316. |
| Codex (`codex-app-server`) | yes | `turn/steer` against the owned turn. |
| Muse (`muse-serve`) | yes | `turn/steer` (Meta's SDK wire types; no live steer run yet). |
| Claude through the Agent SDK (`claude-agent-sdk`) | no | Queues, with the reason: the SDK stream's `command_lifecycle` frames are unverified. |

## As built

One path. Every send is accepted durably as before: a `queued` turn holding the user's message, journalled when it was sent. Steering takes that queued turn into the running one:

- **`TurnService.deliver`** (both send routes): accept, then, when the turn was queued behind a running one and the request (`delivery: 'steer' | 'queue'`) or the `steer` setting says so, steer it now.
- **`TurnService.steerQueued`** ("Steer now", `POST /api/threads/:threadId/turns/:turnId/steer`): the running turn's runtime gets the message through its `NativeSteer` handle (`push`). On success the queued turn settles **`steered`** (a terminal turn status: no native turn, no agent message of its own; a `steered` phase row names the turn that answered it), its sender gets a `steered` terminal with `into`, and the running turn's live activity gets a `steer` row. Otherwise it stays queued and the result says why: no running turn, the running turn hasn't reached its runtime, the runtime can't steer, it refused, a message with images, a member's post.
- **The steer handle** comes from the executor at native admission, beside the stop (`NativeObservation.steerable`, `providers/session-backed.ts` `steerHandle`): `push` where the session's transport declares `push: 'steer'`, else the reason. The live turn shows it (`StreamBufferSnapshot.steer`), so the viewer knows before sending.
- **The setting** `steer`: Foundry-wide (`PATCH /api/settings/threads`), and per project, yours over the repository's `.foundry/project.json` over Foundry's (`GET/PUT /api/projects/:id/steer`, scope `me | everyone`). The launch view carries the effective value.
- **Viewer:** ↵ sends (steers in with steering on), ⌘↵ queues; the composer's line says which, or why it would queue; queued rows have "Steer now" (disabled with the reason when the running turn can't take one); a steered message is marked "Steered into the running turn"; the right panel's "When you send during a turn" and Settings › Threads set it.
- **ACP:** a `steer` session config option (category `_steer`); a prompt steered in is answered when the turn it went into ends.

## Existing machinery used

| Concern | Primitive |
|---|---|
| Delivery | `HarnessSession.push` (agent-session), now returning `PushOutcome` |
| Capability | `TRANSPORTS[kind].capabilities.push` |
| Queued items, and taking one off the queue | `queued` turns and the per-thread `SerializedQueue`; the same live-turn settle path a stop uses |
| Turn control | `TurnService`; the handle travels like `NativeInterrupt` (`interruptible`) |
| The toggle | Foundry settings and the repository's `.foundry/project.json` (`readRepositorySettings` / `writeRepositorySetting`) |
| ACP | `session/set_config_option` |

## Not done

- **Wardens don't advise on a steered message.** The pre-message flow runs per turn; a steer enters a running turn, so its text gets no `user-message` advice. A steer that matters for a Warden is seen at the turn's guard.
- **A queued item mid-steer refuses a stop** (409) until the runtime answers (at most ~10 s). If the running turn is stopped meanwhile, Claude withdraws the steer and the message stays queued, then runs as its own turn.

## Acceptance

- [x] With the toggle on (the default), a message during an active turn reaches that turn. The journal records it as a steer (`steered`), not a run.
- [x] With the toggle off, the same message queues.
- [x] "Steer now" on a queued item steers it into the active turn with the toggle off, and removes it from the queue.
- [x] On a transport with `push: 'none'`, the message queues, and the reason is visible on the item and on the disabled "Steer now".
- [x] Recorded runs cover the Claude steer (agent-session `fixtures/claude-steer/`); the Codex steer is covered by agent-session's `turn/steer` tests.

## Related

Oracle `docs/foundry/reference/COMPARISON.md` §0 (Q3, resolved 2026-11-01); agent-session AS-008 (Claude steer); FEAT-004 (child notices to the parent).
