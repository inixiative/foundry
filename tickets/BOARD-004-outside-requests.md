# BOARD-004: Parties off your machine: requests, standing Signets, and sessions that wait for you

**Status**: 🆕 Not Started (Kingdom FEAT-023 first)
**Assignee**: TBD
**Priority**: High
**Created**: 2026-10-31
**Updated**: 2026-11-01

---

## Overview

Aron, 2026-10-31 (Q1): "Everyone who's not on your computer needs a signet." Teammates are included.
- The org may put a standing Signet in place.
- Anyone may request one.
- A teammate may start a session in your project: "It should probably still start… It can maybe go get some context… but it shouldn't respond. It shouldn't do anything until you decide, even if it has a signet."

## Three cases (planning doc §7)

1. **No Signet: an incoming message.** It sits apart from the lanes, and nothing runs (10-24 guide). Before it is shown, G1 screens it (BOARD-005). "Grant" deep-links to Kingdom's approve flow, on the F1 invite-link precedent. No approval UI is rebuilt in Foundry.
2. **A Signet request.** It reaches the Foundry in `hostedSignetRequests`, which already arrive on every snapshot. Kingdom FEAT-023 adds the `appEvents` notice, on the `inviteOrganizationUser/appEvents.ts` precedent. Foundry renders it as a card.
3. **A holder of a Signet with `thread.open` opens a session.** `thread.open` is new (Kingdom FEAT-023), and Foundry mints the thread id. Planning doc §7.2:
   - **The wait.** The conversation pause gains the reason `'awaiting-owner'` (`pf/conversations/types.ts:81`), plus a pending `ActionQueue` prompt, which puts it in Needs you. Both survive a restart. The thread status is the existing `waiting`.
   - **The member reads nothing while it waits.** `visibleTo` narrows that member to `own` until Aron decides. The draft reply is a `send_to_member` under `review` (`service.ts:1185`). On proceed, the view widens and the opening findings become readable; the agent is told so in its opening prompt.
   - **Read-only.** `ToolRules` gains `defaults`. The waiting overlay is `defaults: 'deny'` plus an allow set (`file:read`, named read tools, read-only MCP globs). Today the gate defaults to `allow`, and `net:api` covers every MCP call (`pf/turns/tool-gate.ts:80-81`, `native-tools.ts:42-43`).
   - **Codex is out in v1.** Codex refuses structural rules (`session-adapter.ts:286-289`), so a Codex-executor project refuses `thread.open`, with the reason.
   - **Aron decides:** proceed (lift the pause; Signet terms and normal tool levels), take over, or decline (the teammate is told).

## Open questions

- **Q-C, the classifier on a Signet.** Proposed reading: it may lift the wait for a class of requests. It comes later, behind an experiment.

## Related

- Planning doc §7; VIEWER-001; BOARD-005; Kingdom FEAT-023.
