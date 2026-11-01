# BOARD-001: Shared threads: one member path, private entries, and what each side was shown

**Status**: 📐 Spec awaiting Aron (questions Q1–Q4)
**Assignee**: TBD
**Priority**: High
**Created**: 2026-10-31
**Updated**: 2026-10-31

---

## Overview

A shared thread is one conversation that each party holds as its own thread on its own machine: the **main thread** on the host and a **sidecar** on each other party. Both hold every *shared* entry. Aron's own Codex and another person's agent join through **one member path**. Only the transport differs:
- in-process on one machine;
- Kingdom and a Signet between machines.

Private messages never reach the other side. **The wrapper records what was shared; it is not left to the agent's memory.**

This revises the 2026-10-19 split in `docs/reference/CONVERSATIONS.md` §3.2 and §4.7. That doc changes only once Aron approves.

## Why (Aron, 2026-10-31)

- "the thing that allows us to bring our own Codex agent into a session is something that we could use to bring another agent from another person… into our session"
- "Signet is the machinery for the untrusted layer, but only for the untrusted layer. Everything else should have one uniform sort of process, interface, and protocol."
- "The thread is one single thread… Behind the scenes, we will have a duplicate Codex thread running on their machine that has everything in. Maybe that's a /private or @private command…"
- "I don't know if the agents are going to be very good at keeping straight what they said and didn't say… I think that's going to be pretty essential."

## Pieces (planning doc revision 2, after its adversarial review)

There is no new link record. Members, local or remote, use the one post-in point (`admit`) and the one read-off point (`subscribe` → `threadEntryOf` → `visibleTo`).

| Piece | Extends (path) |
|---|---|
| `ConversationMember.kind` gains `local` (folding `local-herald` into it is put to Aron, Q0). The hard-coded `signet` sites move to the member's kind | `@inixiative/signet` `src/threads.ts:114`; `pf/conversations/view.ts:46`, `service.ts:190,387,416,771`; `MemberPostRecord` and its dedupe key |
| An in-process transport: a local subscriber on the same subscribe path, posting into `admit` | `pf/conversations/service.ts:315-374` |
| Each journal entry carries a `private` mark set at write (no `CorpusTier` fits a roster; planning doc §4.3) | `session_journal` |
| A per-reader filter: members never see private entries. The owner's views and `journalHistory` keep them. Archive entries are stamped with the mark | `visibleTo` (`view.ts`); `pf/turns/journal-history.ts:74`; `pf/archives/capture.ts:205-230` |
| A held answer is its own state. The answer stays one `message` row; release writes an `answer-released` row that members read (subscribe cursors pass every row, `service.ts:370-378`). Owners see the message, members see the release; `journalHistory` and capture skip the release copy. Outbound stays `review` | `outbound-resolution` pattern; `ActionQueue` (`service.ts:1185`) |
| A disclosure check on everything about to leave (held answers and every `send_to_member`, private turns included), against private entries and any composed context the member may not see (`VISIBLE_TO`, `corpus-compiler.ts:89-94`). Under `review` it annotates. Under `auto` it would decide, so that waits for an experiment and Aron (Q4) | `@inixiative/foundry/classify`; the `experiment` skill |
| A per-turn layer ("SHARED / PRIVATE; shared with Sam up to #N; you hold private turns Sam hasn't been shown") | Beside `conversation-floor`, `pf/conversations/roster.ts` |
| `/private` (a private turn; how notes and sends meet it is Q9) and `/btw` (never enters the thread; a decision call over `journalHistory`) | `TurnService.accept`; ACP `COMMANDS` (`packages/acp/src/agent.ts:92`) and the viewer's |

## Reverses three 10-19 rulings (flagged for Aron, Q0)

1. Own Codex can be a member, not only a subagent node (CONVERSATIONS §3.2).
2. Agent answers on a shared thread become visible once released; today only `send_to_member` leaves (§4.5).
3. Non-owner members can read the whole thread, minus private entries; today the whole-thread view is owner-only (§5.3, Kingdom `validateThreadsGrant.ts:30`).

## Open questions (for Aron, planning doc §11)

- **Q1.** Is the trust boundary the machine, so a teammate on another machine gets a Signet?
- **Q2.** Does D7 mean Foundry consumes Kingdom's existing transport and builds none of its own?
- **Q3.** Should there be both `/btw` and `/private`, with `/btw` offered first?
- **Q4.** Should the whole-thread view be the conversation preset's default, with outbound staying `review` until the check is measured?
- **Q8.** Is the other party's thread a second voice, or a read-only replica?
- **Q9.** How private turns meet notes, sends and depth (planning doc §4.5).

## Definition of done

- The planning doc's §10 tests pass (1–20). They are built together with BOARD-002, because several of them need both ends.
- CONVERSATIONS.md is revised to match, and its tests still pass.

## Related

- Planning doc: Oracle `docs/foundry/ATTENTION-BOARD.md` §4.
- Kingdom lane: lift the owner-only whole-thread rule for conversation grants (filed in Kingdom after Q4).
- BOARD-002 (the sidecar on the joining side).
