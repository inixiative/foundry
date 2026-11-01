# VIEWER-003: Diff viewer

**Status**: 🆕 Not Started
**Assignee**: TBD
**Priority**: Low (after VIEWER-002)
**Created**: 2026-11-01
**Updated**: 2026-11-01

---

## Overview

Per-file diffs for a thread's work, and a branch-vs-base Compare, inside Foundry. Today Work › Compare is a GitHub link-out (redesign S4, #129); that stays the interim until this lands.

## Why (Aron, 2026-11-01)

"We do want, eventually, a good diff viewer. I think GitHub is probably good for now." Part of the same ask as VIEWER-002, which overrides the "viewer doesn't grow diffs" rule for these tickets (see VIEWER-002, Why).

## What it shows

- **Per turn:** the files a turn changed and their diffs, from the turn's edit tools.
- **Per thread:** everything the thread changed (Work › File changes).
- **Compare:** this branch against its base: commits ahead/behind, changed files, unified or side-by-side diff per file; "Open in GitHub ↗" stays.
- Read-only. Merging, rebasing and checkpoints stay in git and the host apps.

## Existing primitives to build on

- Turn records: `slimTurn` in `packages/foundry/src/viewer/turn-flow.ts` (no file list today; add `files: [{ path, tool }]` from the turn's native Edit/Write tool inputs, `LocalSessionStore.nativeTools`).
- Thread place: `meta.context.repository`, `branch`, `worktree` (`packages/foundry/src/archives/thread-context.ts`).
- The code viewer (VIEWER-002) renders the file side.
- The current link-out: Work › Compare (`ui/work.js`).

## Open questions

- Diff source: run `git diff` in the worktree on request (server side), or reconstruct per-turn diffs from tool inputs?
- Large diffs: cap and page, or link out past a size?
