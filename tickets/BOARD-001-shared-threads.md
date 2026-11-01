# BOARD-001: Shared threads: one member path, one log with private sides

**Status**: 📐 Spec revision 4 (Aron answered Q0–Q9 on 10-31; §4 goes to him before CONVERSATIONS.md is revised)
**Assignee**: TBD
**Priority**: High
**Created**: 2026-10-31
**Updated**: 2026-11-01 (participation design, planning doc §4.9)

---

## Overview

A shared thread is one conversation, and every party is distinct, "just like a chat room". Each party holds its own thread on its own machine, and Foundry bridges them.

Who can be a member: any second agent, Aron's own Codex included, through **one member path**. Only the transport differs:
- in-process on one machine;
- Kingdom and a Signet between machines.

What crosses is everything except tool calls: typed messages, agent answers and member posts. What stays home: each party's own context, memory and `/btw`. Nothing private is said in the shared thread (`/btw` is the only private channel), so the shared journal *is* the record of what was shared. That holds structurally, not by the agent's memory.

This revises the 2026-10-19 rulings in `docs/reference/CONVERSATIONS.md` §3.2, §4.5 and §5.3. Aron approved the reversal (Q0). The doc changes once he says yes to the planning doc's §4.

## Why (Aron, 2026-10-31)

- "Any second agent can be joined as a member, right? They'll get a thread, and we'll build this bridge between threads."
- "I think everything should be visible. Maybe you don't put tool calls, though… You kind of do input/output at the end of the boundary."
- "by the way be inherently private, and we don't need a second thing, but… it needs to work on all agents."

## Pieces (planning doc §4, after review round 3)

There is no new link record, private mark or held-answer state.

| Piece | Extends (path) |
|---|---|
| `ConversationMember.kind` gains `local`, and `local-herald` folds into it | `@inixiative/signet` `src/threads.ts:115` |
| Every `signetId`-keyed site takes a member key: `admit` (frame fields), `pump` (`subscriptions()`), `visibleTo`, `members()` (so local members show before their first post), `outbound()`, `seen`/`accepted`, note ids, the dedupe key. Local terms come from settings (CONVERSATIONS §4.1) or the conversation record | `pf/conversations/service.ts:184-235,358-379,718-745,998-1050`; `view.ts:46,69-79` |
| Members of a shared thread read the whole thread. Tool I/O, subagent runs and Warden rows are already never entries | `threadEntryOf` / `visibleTo` (`view.ts:23-79`); Kingdom AUTH-014 |
| **Audience at the clamp.** The per-thread audience feeds `roleComposition`, so the Wardens narrow with main. The narrowest member wins. Outsiders at `org` (Q-A) | `pf/prompts/instruction-settings.ts:441-452`; `composeRoleView` (`instruction-stack.ts:365-400`); `VISIBLE_TO` (`corpus-compiler.ts:90-95`) |
| **A private home for a shared thread's sessions**, the host and every local member, so the harness loads no user CLAUDE.md, AGENTS.md, hooks, skills or MCP connectors. With no private home, the invite is refused | `NativeAuthentication` per-thread source and `privateHome` (`pf/providers/native-authentication.ts:258-282`). `harnessLoading` can't do it, because it is process-wide (`instruction-stack.ts:678-684`) |
| **A fresh session on the first member.** End the native session and clear its binding; the next turn is seeded by `journalHistory` | `_forget` → `adapter.clearSession` (`pf/providers/session-backed.ts:910-929`) |
| The roster says what isn't shared (tool reads, context, `/btw`) and words local members | Extend `memberLines` / `conversationRoster` (`pf/conversations/roster.ts:15-18,53-56`); no new layer |
| `/btw` on every runtime: the decision call with no tools, over `journalHistory` plus the composed context (so it sees no tool I/O). Stored in its own store beside the thread, never as a journal or phase row; its own Archive unit, routed personal | `textOnly` → `tools: false` (`session-backed.ts:1117`, `pf/providers/decision-host.ts`); ACP `COMMANDS` (`packages/acp/src/agent.ts:92`) |

## Participation (planning doc §4.9, Aron 2026-11-01; review round 4 fixes)

**Supersedes the "everything visible" pieces above.** Agents never post straight into the log; a person elects each draft.

| Piece | Changes |
|---|---|
| The log is people's posts and released sends. The host agent's own messages reach only a member whose grant includes `prompt.resolve` (the owner) | `visibleTo` (`view.ts`), not `threadEntryOf` |
| `sharedFromSeq`: reads start at the share, unless the owner shares the history | `ConversationRecord`; `read`/`subscribe` (`service.ts:312-345`) |
| The suppressor: notes ride **every** turn of the agent | `deliverNotes` drops the `lastOwnerSeq` gate (`service.ts:706`) |
| A shared thread holds every draft for `review`, except a report against an open commission whose caller chose `post` | `send()` / `hold()` |
| Commission sends: `commission: {report: 'post'\|'notify', expiresAt}` (default 24 h, `conversations.commissionHours`). Only they invite outside `speak-when-spoken-to`. They survive `setFloor`, the switch to conch and restarts. The entry is marked (signet release) | `invite()`, `setFloor` (`:583-585`), `takeFloor`, `raisePending`-style startup |
| `agents: 'silent' \| 'drafting'`: under silent, posts are admitted as `note`, and `send()` is refused (commissions excepted) | `conversations` settings; `admit`, `send` |
| `floor.mayTake` lens term (signet release); a local member's term on its invite record | `threadsLensSchema`, `floor()` |
| `aside` entry kind: sender and addressee people only; skipped by notes, mirror, `journalHistory` and the agent's context | `view.ts`, viewer |
| §4.4's private-home, fresh-session and audience pieces are **not built in v1** | — |

## Local members, voices, plain-text control (planning doc §4.11; built 2026-11-01)

- Built: the owner's own threads join as local members (same project, no cycles), hear the log through `shared-entry` mirror rows, are woken only while speaking and the floor would admit them, and speak with `post_to_conversation` (no hold). Voices per agent (`host`, `local:<id>`), `set_voice` / `set_floor` / `give_conch` gated on the owner's own message, else a Needs-you confirmation. `TurnService.onSettled` re-checks waits. CONVERSATIONS.md §4.11.
- Not yet: fork with context (§4.11 point 3, next PR); a Signet member's voice (needs a signet release); Codex as a member needs a second subscription worker (subscription-only mode runs every main thread on one worker); Grok waits on Q-I (API key); Muse's API is unverified.
- Open for Aron: may his own local agents read the main agent's answers? Built per the spec: no, the log is what was posted.

## The floor (planning doc §4.8)

- **A shared thread defaults to `conch`** (Aron, 2026-11-01): outside agents are present, so one speaker at a time, with the host as leader. Unshared threads keep `talk`. It is applied when a thread gains its first member; a thread override still wins.
- **`floor()` takes the member key** (`service.ts:387` hard-codes `{kind:'signet'}`), so a local Codex takes turns like Sam.
- **A raised hand** (`thread.floor {request}`, today only in `record.requests` and the summary, `service.ts:791`) also raises an `ActionQueue` prompt in Needs you. Answering it uses the owner's existing pass.
- **`/btw` is outside the floor.**

## First check

Does a private home carry nothing personal: no user hooks (SessionStart `additionalContext`), no personal skills, no user MCP connectors? This is planning doc test 3.

## Not in v1

- **Per-answer review.** If it is wanted later, a release writes an `answer-released` row, because `subscribe` advances cursors past every row (`service.ts:370-378`). That is planning doc revision 3, `a18c62b`.
- **A "what was decided and what data was considered" line.** This is Aron's open question (Q-B).

## Definition of done

- The planning doc's §10 tests 1, 6–12, 21–34 pass (2–5 are history). Experiment 35 is pre-registered. They are built together with BOARD-002, because tests 8–10 need both ends.
- CONVERSATIONS.md is revised to match, and its tests still pass.

## Related

- Planning doc: Oracle `docs/foundry/ATTENTION-BOARD.md` §4.
- Kingdom AUTH-014; BOARD-002.
