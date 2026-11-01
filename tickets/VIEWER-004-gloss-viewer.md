# VIEWER-004: Gloss viewer

**Status**: 🆕 Not Started
**Assignee**: TBD
**Priority**: Low (after VIEWER-002)
**Created**: 2026-11-01
**Updated**: 2026-11-01

---

## Overview

Gloss (`@inixiative/gloss`, symbol-level explanations kept beside the code) gets its home in the code viewer: open a file, see its glosses in the margin, review and edit them there. The top-bar Gloss button was removed on 2026-11-01 and returns with this viewer.

## Why (Aron, 2026-11-01)

"Until we have the viewer, the gloss doesn't need to be there. At some point, that's where the gloss viewer should be." Part of the code viewer / diffs / gloss set (VIEWER-002, which overrides the "no runner features" rule for these).

## What it shows

- In the code viewer: a gloss marker on each glossed symbol; the gloss text in a margin or popover; stale glosses flagged.
- A project-wide review list (what today's overlay does), reached from the code viewer rather than the top bar.

## Existing primitives to build on

- Today's review overlay: `GlossReview` / `GlossButton`, `glossProject` (`packages/foundry/src/viewer/ui/gloss.js`, `ui/gloss.css`). The button is no longer rendered; the overlay code stays for this ticket.
- The gloss package: `@inixiative/gloss` (Foundry dependency, `packages/foundry/package.json`).
- The code viewer (VIEWER-002).

## Open questions

- Margin vs inline popover for gloss text?
- Edit glosses in Foundry, or only review and jump to the file?
