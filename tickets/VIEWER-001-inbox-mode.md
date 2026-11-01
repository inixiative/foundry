# VIEWER-001: The attention board

**Status**: 📐 Spec (blocked on BOARD-001's spec answers)
**Assignee**: TBD
**Priority**: High
**Created**: 2026-10-23
**Updated**: 2026-10-31

---

## Overview

The attention board is the default Foundry view once basic setup is done: one list of open threads across every project, things that need Aron first, with the thread beside it. Projects stays a tab next to it ("Active | Projects").

It replaces the 10-23 "inbox mode beside directory mode" idea. The directory is still how you find any thread; the board is where you work.

## Why (Aron)

2026-10-23: when something comes up that needs work, it should "start a session already, with the agent in context". It shouldn't be "go and say, okay, this thing happened" followed by starting a session yourself.

2026-10-31: "I want this attention view. I think that's the primary place I'd like to work." And "It's just the list on the left of the open threads… one is private, one is shared… just to keep you from putting your foot in your mouth a lot."

## What it shows

- **Two zones in the left column.** Private on top, shared below. A thread sits in the shared zone exactly while it has a live member other than its owner (BOARD-001); when the last one leaves it moves back.
- **Every project, one list.** Global threads are in it too.
- **A card per thread:**
  - source (Slack / Email / Linear / the project name);
  - title;
  - one state word (Working, New, Draft ready, Starting, Back on your list, Shared until <day>, Overlaps your thread);
  - an activity dot.
- **Order.** Attention items first, then running threads, each by recency.
- **Goals on a thread.** An inbound item that joins an existing thread (BOARD-003, matched by the first Herald, AGENT-001) adds a goal to it ("2 · PayPal option, from Priya's email"). It is not just one more message.

## What counts as needing Aron (first cut, for Aron to confirm)

- a pending `ActionQueue` prompt: a tool ask (`pf/turns/tool-gate.ts:181`), a held send (`pf/conversations/service.ts:1185`), a held shared answer (BOARD-001), or feedback;
- a hand-back: a turn finished since Aron last opened the thread (needs a new "seen by Aron" mark, see below);
- a new inbound item (BOARD-003);
- a pending access request from outside (BOARD-004).

## Built on

| Need | Existing piece | Change |
|---|---|---|
| Thread rows | `threads` stream, `pf/viewer/data-streams.ts:130-170`; `ThreadList`/`ThreadNode`, `pf/viewer/ui/thread-tree.js` | A cross-project stream (`threads:all`) and a zone field from the conversation summary |
| Status | Thread status (`pc/thread.ts:16`), turn status (`pf/persistence/local-session-store.ts:58`) | — |
| Prompts | `prompts` stream (`data-streams.ts:172-185`), `promptCounts` (`pf/viewer/ui/store.js:86-92`) | — |
| Unread | `ConversationService.summary` (`service.ts:747-758`) | Today "unread" means *not yet delivered to the agent*. The board needs a second mark, *not yet seen by Aron* (last-opened seq per thread), so that hand-backs show |

No new store: the board is a filter and a sort over these streams, plus the seen-by-Aron mark.

## Open questions (for Aron)

- Is the first cut above the right set?
- Board as the default view: right after setup, or only once a project has a chorus?
- Should the board also show other machines' threads (his Foundry on another machine)? That goes through Kingdom, so it isn't in v1.

## Related

- Planning doc: Oracle `docs/foundry/ATTENTION-BOARD.md` §5.
- BOARD-001 (zones come from links), BOARD-003 (inbound items), BOARD-004 (outside requests), AGENT-001 (thread matching).
- ACP: other clients' turns aren't live in ACP (`packages/acp/src/agent.ts:334-367`). This is tracked in inixiative-77's T3/Paseo parity review.
