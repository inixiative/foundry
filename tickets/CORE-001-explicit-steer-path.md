# CORE-001: An explicit steer path into the active turn

**Status**: 📝 Proposed (not built)
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-10-31
**Updated**: 2026-10-31

---

## Overview

A message sent while a turn is running can only queue: it becomes a `queued` turn (`packages/foundry/src/persistence/local-session-store.ts:58`). agent-session can already steer an in-flight Codex turn (`HarnessSession.push` → `turn/steer`, agent-session `src/codex-session.ts:888-938`). Nothing in Foundry calls `push`.

Add an **explicit** steer path:
- per message in the viewer;
- through a config option over ACP.

When the session's transport declares `TRANSPORTS[transport].push === 'steer'`, the message goes into the active turn. Otherwise it queues as today.

**Queue stays the default.** Whether follow-ups steer by default changes what sending a message means. That is Q3 in the source doc, for Aron.

## Why

- T3 Code now steers human follow-ups by default (#24718).
- Paseo steers agent-to-agent sends.
- Ours can do neither, although the capability sits one call away.
- Mid-turn delivery is also the route a parent turn needs for a child's finish or question notice (Q2).

## Existing machinery to use

| Concern | Primitive |
|---|---|
| Delivery | `HarnessSession.push` (agent-session `src/harness-session.ts`) |
| Capability check | `TRANSPORTS` descriptors (agent-session `src/transport.ts`) |
| Fallback | `queued` turns (`local-session-store.ts:1423,1442`) |
| Turn control | `TurnService` (`packages/foundry/src/turns/turn-service.ts`); interrupt at `:417` |
| ACP | `session/set_config_option` (`packages/acp/src/agent.ts:844`) |

No new queue machinery: COMPARISON adopt #6 (a queue-vs-steer policy) stays not adopted.

## Acceptance

- [ ] A steer during an active Codex turn reaches that turn, and the journal records it as a steer, not a new turn.
- [ ] On a transport with `push: 'none'` (Claude until AS-008), the same request queues, and the reason is visible.
- [ ] The default is unchanged (queue).
- [ ] A cassette covers the Codex steer.

## Related

Oracle `docs/foundry/reference/COMPARISON.md` §0 (parity refresh, 2026-10-31); agent-session AS-008 (Claude steer).
