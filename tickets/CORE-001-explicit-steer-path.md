# CORE-001: Steering into the active turn, on by default

**Status**: 📝 Proposed (not built). Shape decided by Aron 2026-11-01.
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-10-31
**Updated**: 2026-11-01

---

## Overview

A message sent while a turn is running can only queue: it becomes a `queued` turn (`packages/foundry/src/persistence/local-session-store.ts:58`). agent-session can already steer an in-flight Codex turn (`HarnessSession.push` → `turn/steer`, agent-session `src/codex-session.ts:888-938`). Nothing in Foundry calls `push`.

**Decided (Aron, 2026-11-01):** "I think that should be a toggle for steering. I think steering should be on by default. Things which are queued can obviously be steered, even regardless of the toggle. There should be an action there."

- **A `steer` toggle, on by default.** With it on, a message sent during an active turn goes into that turn. With it off, it queues as today.
- **A queued message can always be steered**, whatever the toggle says, through a "steer now" action on the queued item. It leaves the queue and goes into the active turn.
- **Where the transport can't steer**, the message queues and the reason is shown. That is `TRANSPORTS[transport].push !== 'steer'`, which means Claude until agent-session AS-008 lands. "Steer now" is offered but disabled, with the same reason.

The toggle is a setting with the usual "for me / for everyone" scopes (personal over the repo's `.foundry/`). The viewer shows it beside the composer. Over ACP it is a session config option.

## Why

- T3 Code steers human follow-ups by default (#24718) and has the same per-item action on its queue (`promote_to_steer`). Paseo steers agent-to-agent sends.
- A follow-up mid-turn is usually a correction to the work in progress. Queuing it means the turn finishes on the wrong course first.
- Mid-turn delivery is also the route a parent turn needs for a child's finish notice or question (FEAT-004).

## Existing machinery to use

| Concern | Primitive |
|---|---|
| Delivery | `HarnessSession.push` (agent-session `src/harness-session.ts`) |
| Capability check | `TRANSPORTS` descriptors (agent-session `src/transport.ts`) |
| Queued items, and taking one off the queue | `queued` turns (`local-session-store.ts:1423,1442`) |
| Turn control | `TurnService` (`packages/foundry/src/turns/turn-service.ts`); interrupt at `:417` |
| The toggle | Foundry settings (personal over repo `.foundry/`, CLAUDE.md "Foundry project settings live in the repo") |
| ACP | `session/set_config_option` (`packages/acp/src/agent.ts:844`) |

No new queue machinery.

## Acceptance

- [ ] With the toggle on (the default), a message during an active Codex turn reaches that turn. The journal records it as a steer, not a new turn.
- [ ] With the toggle off, the same message queues.
- [ ] "Steer now" on a queued item steers it into the active turn with the toggle off, and removes it from the queue.
- [ ] On a transport with `push: 'none'` (Claude until AS-008), the message queues, and the reason is visible on the item and on the disabled "steer now".
- [ ] A cassette covers the Codex steer.

## Related

Oracle `docs/foundry/reference/COMPARISON.md` §0 (Q3, resolved 2026-11-01); agent-session AS-008 (Claude steer); FEAT-004 (child notices to the parent).
