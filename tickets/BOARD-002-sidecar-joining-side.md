# BOARD-002: The sidecar: the joining side's copy of a shared thread

**Status**: 🆕 Not Started (built together with BOARD-001 once Aron answers Q0/Q4/Q8)
**Assignee**: TBD
**Priority**: High
**Created**: 2026-10-31
**Updated**: 2026-10-31

---

## Overview

The other party's duplicate thread is F2 of `docs/reference/CONVERSATIONS.md` §4.9, already specced:
- the joining Foundry opens the Kingdom-held stream for each conversation Signet it holds;
- it feeds each append into a thread of its own;
- its agent posts back with `kingdom_post`.

Under BOARD-001 that thread becomes a first-class thread in the joiner's **shared** zone. It carries the sidecar's per-turn layer ("everything here came from Aron's shared thread; he may also have private turns you have not seen"). Its own `maxAgentTurns` bounds its agent's answers to the feed. Locally, for Aron's own Codex, the sidecar is a Codex-runtime thread on the same Foundry, linked in-process.

A party on Foundry ACP only gets the sidecar from its local Foundry daemon. An ACP client is never a member on its own, because only a Foundry holds the record of what was shared (Aron: "Foundry ACP, at least").

## Built on

| Need | Existing piece |
|---|---|
| The joiner's Archive captures the host's shared content; the grant has to say so | CONVERSATIONS §4.8 (the reverse case) |
| The live stream | Kingdom `accessThread` / `thread.subscribe`; client `InstallationSocket.openThread` (`@inixiative/signet` `src/installationSocket.ts`) |
| Posting back, held | `kingdom_post` (`pf/tools/kingdom-post.ts`), the one held-outbound mechanism |
| A thread fed from outside | The post-in point (`admit`) on the joining side. **New:** the host's feed needs a member identity there (`admit` builds its member from a frame's `signetId` today, `service.ts:190`), so the sidecar's own `maxAgentTurns` can bound its agent |
| One-off read | `thread.read` on `KingdomAccessTool` (`pf/tools/kingdom-access.ts`) |

## Definition of done

- Sam's Foundry holds a sidecar that contains exactly the shared entries, in order.
- The sidecar never contains a private entry from either side.
- The sidecar survives a restart and a Kingdom resync.
- Aron's local Codex takes part through the same `admit` and `visibleTo` code.

## Related

- BOARD-001.
- Planning doc §4.6.
