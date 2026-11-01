# BOARD-004: Outside requests on the board, granted with a Signet

**Status**: 🆕 Not Started
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-10-31
**Updated**: 2026-10-31

---

## Overview

An outside party asks for something: to join a thread, or to read two items until Friday. The request shows on the board as a card ("From outside"). Nothing happens until Aron says yes, and the grant is a Signet with a narrow lens, a request limit and an expiry.

## What exists

The flow is already in Kingdom:
- **The request.** `requestSignet` creates a `signetRequest` Inquiry (Kingdom `modules/access/services/signets/requestUserSignet.ts`, handler `modules/inquiry/handlers/signetRequest/index.ts`).
- **Approval.** Approving may only narrow the request, then calls `issueSignet` (`maxRequests`, `expiresAt`, and a lens that names the items).
- **Reaching Foundry.** Pending requests already reach the Foundry in `hostedSignetRequests` on every Installation snapshot.

## Gaps

- **Kingdom lane: Aron is never told.** The handler declares no `appEvents`. Kingdom's app-events system (Kingdom `tickets/FEAT-012-notifications.md`) is the path for that. Add `appEvents.sent`; build no new notifier.
- **Foundry lane (this ticket):**
  - Render `hostedSignetRequests` as attention cards.
  - Screen the request text first (BOARD-005, G1).
  - "Grant" deep-links to Kingdom's approve flow, on the F1 invite-link precedent (`<Kingdom web>/dashboard?…`). No approval UI is rebuilt in Foundry.

## Related

- Planning doc §7; VIEWER-001; BOARD-005.
