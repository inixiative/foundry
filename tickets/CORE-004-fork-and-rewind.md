# CORE-004: Fork and rewind on the native primitives, with Foundry's state kept in step

**Status**: 📝 Proposed (not built). Shape agreed with Aron 2026-11-01. Rolling back files is his "we might also try", pending the recommendation below.
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-11-01
**Updated**: 2026-11-01

---

## Overview

The live fork and revert routes return 501 (`packages/foundry/src/viewer/routes/runtime.ts`, with `localStore` the default). agent-session already has the native pieces:
- **Claude fork:** `HarnessSession.fork()` (`--fork-session`).
- **Claude conversation rewind:** `rewind_conversation`, used today only for decision side sessions (`src/claude-subagents.ts:812`).
- **Claude file rewind:** the CLI has a `rewind_files` control and SDK file checkpointing (`enableFileCheckpointing` / `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, found in the 2.1.316 binary). agent-session doesn't use it yet.
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
| **Warden thread knowledge** (`session_knowledge`, per revision) | copied at the revision current at N | reset to the revision at N |
| **Delivered-pointer ledger** (proposed, FEAT-004) | copied at N | cut to N |
| **Journal** | new thread with provenance (`parentThreadId`, forked-at turn); the source is untouched | a rewind marker row; rows after N stay, marked superseded, never deleted |
| **Queued turns** | not copied | kept, re-sent on top of N |
| **Archive** | the fork is its own top-level thread with provenance (FEAT-004) | the marker rides in the snapshot |

## Files

**Recommendation: roll back files natively on Claude, and say what wasn't restored.**
- Claude's file checkpointing records edits made through its own file tools (Write, Edit). It does not see changes made by shell commands (`rm`, `mv`, `sed`, codegen, `bun install`), by other processes, or by another thread in the same worktree. After a rewind, Foundry lists the files the turns after N touched through the shell, from the journal's tool calls, as "not restored".
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
| Thread knowledge | `session_knowledge` (keyed by thread, per revision) |
| ACP | `session/fork` (UNSTABLE in the SDK); the host's rewind UI where offered |

## Acceptance

- [ ] Forking a Claude thread at turn N creates a top-level thread with provenance whose native session is a native fork. Its injection ledger and Warden thread knowledge match the source at N.
- [ ] Rewinding to N: the next turn re-sends every layer delivered after N. A test fails if the ledger isn't cut.
- [ ] Rewinding with file checkpointing on restores Write/Edit changes, and lists shell-touched files as not restored.
- [ ] On Codex, fork uses the portable form, and rewind is refused with the reason.
- [ ] Journal rows after N are kept and marked superseded.

## Related

Oracle `docs/foundry/reference/COMPARISON.md` §0.3 Q1 (answered 2026-11-01); agent-session (move rewind onto `HarnessSession`, add `rewind_files`); FEAT-004.
