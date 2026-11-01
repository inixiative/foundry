# VIEWER-005: Heralds view

**Status**: 🆕 Not Started
**Assignee**: TBD
**Priority**: Medium (after AGENT-001)
**Created**: 2026-11-01
**Updated**: 2026-11-01

---

## Overview

A top-level workspace view, like the Board, showing how threads are represented to the Heralds across every project: overlaps between threads (yours and teammates'), related threads, past work they echo, and who else is watching or touching the same area. The per-thread Heralds tab in the right panel stays; this view is the cross-thread picture.

## Why (Aron, 2026-11-01)

"The heralds might be another view, kind of like board view, realistically." Heralds carry live data about what others are doing, Wardens carry static knowledge (workspace CLAUDE.md, 2026-10-17).

## What it shows

- Groups of threads the Heralds link (same files or area, same ticket, "this looks familiar"), each with why they're linked.
- Team overlap ("both changing checkout/payment.ts"), with the teammate and their thread.
- Past work a thread echoes ("Google Pay, added Aug 12").
- Filters as on the Board: Everything · each project · each Foundry.
- Workspace only, like the Board (not on Settings or Analytics).

## Existing primitives to build on

- The Herald: `packages/foundry/src/agents/herald.ts` (five detectors; not wired) and AGENT-001 (wiring; the first Herald is local thread matching for BOARD-003).
- The Board's shell and filters: `ui/board.js`, `boardOpen` / `toggleBoard` (`ui/store.js`), the `threads:all` stream.
- The per-thread Heralds tab (`ui/right-panel.js`).

## Dependencies

AGENT-001 (Herald wiring); team overlap crosses machines, so it also needs Kingdom + Signets (BOARD-004).

## Open questions

- A separate view or a Board mode ("group by Herald link")?
