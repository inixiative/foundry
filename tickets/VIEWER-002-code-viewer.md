# VIEWER-002: Code viewer and editor

**Status**: 🆕 Not Started
**Assignee**: TBD
**Priority**: Low (after the rest of the redesign is in use)
**Created**: 2026-11-01
**Updated**: 2026-11-01

---

## Overview

Read a thread's or project's files inside Foundry, then edit them. It is the base that the diff viewer (VIEWER-003) and the Gloss viewer (VIEWER-004) sit on. It is **not a VS Code fork**: a viewer with light editing inside Foundry's own UI.

## Why (Aron, 2026-11-01)

"We should have our tickets section for that type of stuff: code viewer/editor, diffs, gloss. I think that's a good place to spend work when all the rest is [done]."

**This overrides a standing rule, on purpose.** The workspace CLAUDE.md says the viewer doesn't grow runner features (worktrees, diffs, checkpoints) that host apps already have. Aron's 11-01 ask is the explicit acknowledgement that overrides it for VIEWER-002..004. Until these land, Work › Compare links out to GitHub (#129).

## What it shows

- A file tree for the thread's worktree (or the project root when no thread is selected), and a read-only file view with syntax highlighting and line numbers.
- Paths in the stream, in Work and in the inspector (tool rows, artifacts, references) open the file at the line.
- Later: edit and save, with the save recorded on the thread (who changed what, when) so the agent is told on its next turn.

## Existing primitives to build on

- File read and write: `GET/PUT /api/files` (`packages/foundry/src/viewer/routes/control.ts:623,652`), today used by the Sources editor (`SourceEditor`, `ui/settings.js`). Its access checks (`tests/viewer-file-access.test.ts`) stay the gate.
- Thread place: `threadPlace(meta)` (`ui/thread-labels.js`), `meta.context.worktree` / `meta.cwd`.
- Vendored libraries: `ui/vendor/manifest.json` + `licenses.json` (offline-first, no CDN), so a highlighter or editor component is vendored the same way.

## Open questions

- Which editor component (a vendored CodeMirror 6 build vs a highlighter only for v1)?
- Where it lives in the layout: a centre tab (beside Work) or its own view like the Board?
- Edits while an agent is mid-turn on the same file: block, warn, or tell the agent?
