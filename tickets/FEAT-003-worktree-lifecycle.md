# FEAT-003: Worktree lifecycle for agent threads: template or classic mode, released on merge

**Status**: 🚧 Partly built: the per-thread checkout record (`meta.context.checkout`: mode, path, root, slot, merged, live / released / recreating), recreate (`POST /api/threads/:id/worktree/recreate`), merge detection by tree equality against the local `origin/HEAD` (`squashMergedInto`, no fetch), and on merge the `threadOnMerge` setting (Aron, 2026-11-01): `done` (default, the thread can take another task) or `auto-archive` (archive + `releaseWorktree`, never `--force`). Not built: create on agent-thread start, the unpushed-branch check, pinning the pool login on recreate, PR state through GitHub (the GitHub Signet operations read commits, trees and blobs only).
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-11-01
**Updated**: 2026-11-01

---

## Overview

When an agent launches a thread that works on code (FEAT-004), the thread gets its own worktree, and Foundry owns that worktree from setup to cleanup.

A worktree mode is a set of lifecycle actions, and the project's mode says what runs each one:

| Action | Template mode | Classic mode |
|---|---|---|
| create (+ set up) | `bun run worktree:create <base> <branch>`, or `worktree:create <branch>` to attach an existing branch | `git worktree add -b <branch> <path> <base>` |
| destroy (+ tear down) | `bun run worktree:destroy <name>` (never `--force`) | `git worktree remove <path>` (never `--force`) |

- **The mode is a committed project setting** in `.foundry/` with a detected default: `template` when the repo's `package.json` has `worktree:create`, else `classic`. A project may override any single action with its own command. Paseo's `paseo.json` `worktree.setup`/`worktree.teardown` has the same shape.
- **Only threads with an agent running get a Foundry-made worktree.** Threads you start in a host keep the host's handling.
- **Released on merge (Aron, 2026-11-01: "Approved automatically on merge, ideally").** When the thread's branch merges, Foundry archives the thread and runs destroy. The thread then shows a **released** badge. This is a badge, not a status colour, because archived already has its own.
- **Never lose work.** Both destroy commands already refuse dirty or untracked work without `--force`. Template `destroy.sh` checks `status --porcelain --untracked-files=all` and keeps the branch (`scripts/worktree/destroy.sh:77-85`). Foundry adds only the check that the branch is merged or pushed, and never passes `--force`. A refusal flags the thread "worktree not released: unsaved work" and it waits for you. No automatic stash (CLAUDE.md: never bare `git stash` in worktrees).
- **What destroy discards** even when clean: the slot's databases and buckets (template), and gitignored files such as `.env.local` and build output. Those aren't work, but the thread's Context tab says so on release.
- **Starting again is "recreate", not "reopen".** The branch survives. A released thread offers one action, recreate, which runs create on the existing branch with a fresh slot and setup. It keeps the same worktree name, so the path is the same. Claude files sessions by directory path, and under the login's `CLAUDE_CONFIG_DIR`. So a resume needs the same path **and the same login**. Under a Kingdom pool, recreate pins the thread's original subscription, or the session starts fresh from the journal (`turns/journal-history.ts`).

Aron, 2026-11-01: "Template mode is just a thing that maps to cleaning up things and setting up things… Classic mode should just take those actions." "I think you have to clean up work trees, or else you end up copying way too much code into your computer… If you'd like to start work on it again… you'll have to set up a new work tree."
- **Sharing a worktree is a setting of the split (Aron, 2026-11-01).** When work branches, forks or splits into another thread (FEAT-004 delegation, CORE-004 fork), the split chooses whether the new thread works in the same worktree, with many agents in it, or gets its own. Sharing is also how work is grouped: threads in one worktree are one piece of work, so the board and Archive can show them together. Aron: "to split work across a work tree with many agents working in it is a setting… It's part of how you group work as well." A shared worktree is released only when its last thread is done, and CORE-004's shared-worktree hazard (a rewind in one thread changing files under another) applies.

## Why

- **Template's `create.sh` does more than `git worktree add`.** It allocates a slot (database, ports, buckets) in a registry, and `destroy.sh` releases it. T3 and Paseo create worktrees themselves and then run a setup hook. A host-made worktree in a template project gets no slot, so its ports and database collide with other worktrees. So in template mode Foundry runs `worktree:create` and then launches the host thread *into* that worktree (T3 `workspaceStrategy: 'existing_worktree'`, Paseo `cwd`).
- **Cleanup is not optional.** Each worktree is a full copy of the code plus a slot's databases.
- **Merge is the natural end.** Work merged is work done. Archiving then needs no one to remember it.

## Existing machinery to use

| Concern | Primitive |
|---|---|
| Finding worktrees, the main checkout, the containing worktree | `packages/foundry/src/git/worktree.ts` (`listWorktrees`, `findByPath`, `findByBranch`, `containingPath`) |
| A thread's worktree, branch and linked PRs | `ThreadContextTracker` (`packages/foundry/src/archives/thread-context.ts`); thread worktree reassignment (`viewer/routes/runtime.ts:801`) |
| Thread creation with a worktree | `POST /api/threads` `worktreePath` (`viewer/routes/runtime.ts:734-751`) |
| Template worktrees and slots | template `scripts/worktree/{create,destroy}.sh` (`bun run worktree:*`) |
| "Merged", first | `git merge-tree --write-tree origin/main <branch>` against `origin/main^{tree}` after a fetch (CLAUDE.md § Merging: patch counts lie after squash). Works today |
| PR merged state, later | GitHub read operations through the Kingdom Signet (`pf/tools/kingdom-access.ts`). **Blocked:** Kingdom INTEG-003 isn't built (`tickets/BOARD-003-inbound-items.md`), and Foundry tracks no PR state today (`thread-context.ts` builds URLs only) |
| Settings | Foundry settings, personal over repo `.foundry/` |

No new worktree store: the thread already records its worktree path and branch.

## Open

- **CLAUDE.md, 10-11:** "the viewer doesn't grow runner features (worktrees…)". This ticket adds no worktree UI: Foundry runs the project's own commands, and the viewer shows a badge and one recreate action. Aron's 11-01 decision is recorded beside the 10-11 rule.

- **Template "adopt an existing worktree" mode** (template PR, Aron reviews). It would let `create.sh` set up a worktree a host created, run as Paseo's `worktree.setup` or T3's setup script. Then threads you start straight from a host also get a slot. Not needed for this ticket.
- **T3 and Paseo cleanup on their own archive.** T3 leaves an `existing_worktree` alone. Paseo's archive may remove its worktrees, so check what it does to a worktree it didn't create before relying on it.

## Acceptance

- [ ] In a template project, a launched thread's worktree is made by `worktree:create`, with a slot in the registry. On merge the thread is archived, `worktree:destroy` runs and the slot is free.
- [ ] In a classic project, the same flow uses `git worktree add`/`remove`.
- [ ] A dirty worktree, or one with an unpushed branch, is never destroyed. The thread shows the "unsaved work" flag.
- [ ] Recreate on a released thread restores the same path on the same branch, and the native session resumes, including under a Kingdom pool (same login pinned).
- [ ] A squash-merged branch with no PR is detected as merged by tree equality.

## Related

FEAT-004 (agent-launched threads); Oracle `docs/foundry/reference/SUBAGENTS.md` §0; template `scripts/worktree/`.
