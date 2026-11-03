# CORE-004: Fork and rewind on the native primitives, with Foundry's state kept in step

**Status**: 🟡 Portable fork built (2026-11-01, inixiative-da: `forkedFrom` provenance, the journal seed, the viewer route and `fork_thread`; CONVERSATIONS.md §4.11). Native fork, rewind, the ledger cut and file rollback not built. Shape agreed with Aron 2026-11-01. Rolling back files is his "we might also try", pending the recommendation below. **2026-11-02:** the journal seed is also the mid-thread worker switch's (`turns/journal-history.ts`: the `worker-switch` marker, the thread's plan, a budget per worker's context window). `SessionBackedProvider.retireThread` ends and forgets a thread's session on a worker, through `_forget`.
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-11-01
**Updated**: 2026-11-02

---

## Overview

The live fork and revert routes return 501 (`packages/foundry/src/viewer/routes/runtime.ts:851,891` at main `467c8d5`, with `localStore` the default). agent-session already has the native pieces:
- **Claude fork:** `HarnessSession.fork()` (`--fork-session`).
- **Claude conversation rewind:** `rewind_conversation`, used today only for decision side sessions (`src/claude-subagents.ts:812`).
- **Claude file rewind:** the CLI's `rewind_files` control request (2.1.316 binary): `{subtype: 'rewind_files', user_message_id, dry_run?}`, returning `canRewind`, `filesChanged`, `insertions`, `deletions`. It fails with "File rewinding is not enabled." unless the session was launched with `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` (what the SDK's `enableFileCheckpointing` sets). It fails with "No file checkpoint found for this message." for a message with no checkpoint. It is rejected in cloud-hosted sessions, and the SDK forbids it with `sessionStore`. agent-session doesn't use it yet.
- **Codex:** fork is wired only in primed sessions (`thread/fork`, `src/codex-primed.ts`); 0.155 refuses `thread/rollback`.

**Decided (Aron, 2026-11-01): agreed with the proposal.**
- Fork and rewind run on the native primitives where they exist.
- Each is wrapped in a Foundry hook that cuts or copies Foundry's own per-thread state at the same turn.
- Where the native one is missing, the portable form is used: a fresh session seeded from Foundry's journal (`turns/journal-history.ts`).

Aron: "even if we do mostly on the native version, we still need some level of hooks on our side. We have a running sense of what's in the thread, and that might need to change or get rebuilt."

**How T3 does it** (checked in its code): fork is native when the provider can, with a stricter check to fork from a specific turn (`t3:apps/server/src/orchestration-v2/CommandPolicy.ts:287`). Otherwise it is a portable fork that replays T3's stored history into a fresh native session within a token budget (`ContextHandoffDelivery.ts`). Rewind is native only, and the provider must return a snapshot (`CommandPolicy.ts:313-333`) so T3 can rebuild its own record to match. Files roll back through T3's own git checkpoints.

## What Foundry must keep in step

| State | On fork (the new thread, cut at turn N) | On rewind (to turn N) |
|---|---|---|
| **Injection ledger**: what the native session has been given (`providers/session-delivery.ts`, the Librarian's ledger) | copied as it stood at N | cut back to N. **Without this, Foundry won't resend context that the rewind removed** |
| **Warden thread knowledge** (`session_knowledge`) | rebuilt at N | rebuilt at N |
| **Delivered-pointer ledger** (proposed, FEAT-004) | copied at N | cut to N |
| **Journal** (append-only, ANATOMY.md) | new thread with provenance (`parentThreadId`; the forked-at turn is `parentTurnId`); the source is untouched | an appended rewind marker; rows after N are *read* as superseded from the marker, never updated or deleted |
| **Queued turns** | not copied | kept, re-sent on top of N |
| **Archive** | capture sends Archive's existing `lineage.kind: 'fork'` (`archive/src/index.ts:50`), not `subagent` (`archives/capture.ts:71-95` today maps every `parentThreadId` to `subagent`) | the marker rides in the snapshot |

**Thread knowledge has no history to roll back to.** `session_knowledge` is one upserted snapshot per thread (`local-session-store.ts:651`, `ON CONFLICT(thread_id) DO UPDATE`), and the store refuses a revision that moves backwards (`:632-637`). So "rebuilt at N" means one of two things. Either replay the thread's `session_learning` rows up to N (`:375`), or keep per-revision snapshots. Either way the backwards-revision invariant changes for a rewind: a rewind starts a new revision line rather than lowering the number. **Aron (11-01): "idk if we're doing those for oracle anyway."** Per-domain thread knowledge may not survive. The thread-context proposal (one shared running summary per thread, plus a ledger of pointers delivered) would replace it. So build the injection-ledger cut and the journal marker first, and treat thread knowledge as whatever per-thread Warden state exists when this is built.

## Files

**Recommendation: roll back files natively on Claude, and say what wasn't restored.**
- **Foundry must record each turn's CLI user-message uuid**, because `rewind_files` takes it. Before rewinding, a `dry_run` shows the files that will change, and the thread shows that list.
- Per the Claude Code checkpointing docs (not verified in the binary), checkpoints record edits made through Claude's own file tools (Write, Edit). They don't see changes made by shell commands (`rm`, `mv`, `sed`, codegen, `bun install`), by other processes, or by another thread in the same worktree. **Hazard:** in a shared worktree, a file rewind can also overwrite another thread's later edits to the same file, not just miss them. Refuse a file rewind when another live thread shares the worktree, or show the overlap first. After a rewind, Foundry lists the files the turns after N touched through the shell, from the journal's tool calls, as "not restored".
- Checkpointing must be on at launch, so a thread launched without it can't rewind files.
- **On Codex,** there's no native file rollback: conversation only, and the thread says so.
- **No Foundry-built git checkpoints.** File checkpoints are the host's (the 10-11 decision), and T3 already has them.

## Existing machinery to use

| Concern | Primitive |
|---|---|
| Native fork | `HarnessSession.fork()` (agent-session `src/harness-session.ts`) |
| Native rewind | the `rewind_conversation` control (agent-session `src/claude-subagents.ts:812`); move it onto `HarnessSession` |
| File rewind | the Claude `rewind_files` control + file checkpointing; add to agent-session next to rewind |
| Portable fallback | `turns/journal-history.ts` (seeding a fresh session from the journal) |
| Injection ledger | `providers/session-delivery.ts` |
| Thread knowledge | `session_knowledge` (one snapshot per thread) and `session_learning` (its rows), `local-session-store.ts` |
| Archive fork lineage | Archive `lineage.kind: 'fork'`; `archives/capture.ts` `lineageOf` |
| ACP | `session/fork` (UNSTABLE in the SDK); the host's rewind UI where offered |

## Acceptance

- [ ] Forking a Claude thread at turn N creates a top-level thread with provenance whose native session is a native fork. Its injection ledger and Warden thread knowledge match the source at N.
- [ ] Rewinding to N: the next turn re-sends every layer delivered after N. A test fails if the ledger isn't cut.
- [ ] Rewinding with file checkpointing on restores Write/Edit changes, and lists shell-touched files as not restored.
- [ ] On Codex, fork uses the portable form, and rewind is refused with the reason.
- [ ] Journal rows after N are kept, and readers treat them as superseded because of the appended marker.
- [ ] A fork archives with `lineage.kind: 'fork'`.

## Related

Oracle `docs/foundry/reference/COMPARISON.md` §0.3 Q1 (answered 2026-11-01); agent-session (move rewind onto `HarnessSession`, add `rewind_files`); FEAT-004.
