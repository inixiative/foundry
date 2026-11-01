# BOARD-002: The other side's thread: a bridge, not a chat

**Status**: 🆕 Not Started (built together with BOARD-001)
**Assignee**: TBD
**Priority**: High
**Created**: 2026-10-31
**Updated**: 2026-11-01

---

## Overview

The other party's thread is F2 of `docs/reference/CONVERSATIONS.md` §4.9, already specced:
- the joining Foundry opens the Kingdom-held stream for each conversation Signet it holds;
- it feeds each append into a thread of its own;
- its agent posts back with `kingdom_post`.

That agent is a second voice in the shared thread (Aron, Q8: "it's just a bridge to a session, so they can bring their agent to us"). It is not a read-only replica.

- **Where the thread lives:** in the joiner's **shared** zone, carrying the sidecar's per-turn layer ("shared with Aron's agent; you see what was said, not Aron's tools or context").
- **Depth:** its own `maxAgentTurns` bounds its agent's answers to the feed.
- **Locally:** for Aron's own Codex, the same path runs in-process.
- **No chat:** people with no agent don't get one. They stay in Slack and are answered there (BOARD-003).
- **Who can be a member:** a party on Foundry ACP gets the sidecar from its local Foundry daemon. An ACP client on its own is never a member.

## Built on

| Need | Existing piece |
|---|---|
| The live stream | Kingdom `accessThread` / `thread.subscribe`; client `InstallationSocket.openThread` (`@inixiative/signet` `src/installationSocket.ts`) |
| Posting back, held | `kingdom_post` (`pf/tools/kingdom-post.ts`), the one held-outbound mechanism |
| A thread fed from outside | The joining side's `admit`. **New:** the host's feed needs a member identity there, because `admit` builds its member from a frame's `signetId` today (`service.ts:190`) |
| Archive disclosure | The joiner's Archive captures the host's shared content, so the grant says so. CONVERSATIONS §4.8 is the reverse case |
| One-off read | `thread.read` on `KingdomAccessTool` (`pf/tools/kingdom-access.ts`) |

## Definition of done

- Sam's Foundry holds a thread with exactly the shared entries, in order, and no tool calls.
- It survives a restart and a Kingdom resync.
- Aron's local Codex takes part through the same `admit` and `visibleTo` code.

## Related

- BOARD-001; planning doc §4.7.
