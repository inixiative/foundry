# BOARD-003: Inbound items arrive as threads already investigating

**Status**: 🆕 Not Started (Kingdom lane first; first source is Aron's Q5)
**Assignee**: TBD
**Priority**: High
**Created**: 2026-10-31
**Updated**: 2026-10-31

---

## Overview

A Slack message, an email or a Linear issue arrives as a thread that is already investigating. The agent has looked into it, matched it to open work, and drafted a response before Aron sees it. Aron (2026-10-31): "Before you even see them, before they pop up on your board, they get contextualized." And: "We need to get integrations and signets to be able to power hooks and inbound items."

## Split (Aron's D7: Foundry builds nothing that goes through Kingdom)

**Kingdom lane** (Kingdom tickets, filed once Aron picks the first source):
- **Provider receivers.** Kingdom has none today: its provider operations are read-only and on demand. Each receiver follows the Tribe precedent, `apps/api/src/routes/whatsappWebhook.ts`:
  - a signed route checked with `isValidWebhookSignature`;
  - the verify handshake;
  - a body limit;
  - a schema-checked payload;
  - an unknown shape is ignored and logged.

  Each receiver is bound to the owner's integration.
- **Durable delivery to the paired Foundry.** Use a list on the Installation snapshot, like `hostedSignetRequests`, re-sent by the existing refresh hook. Do not use a bare frame: `sendToInstallationLocal` is fire-and-forget, so an offline Foundry would lose the item. Each item is a pointer only, gated by a Signet the Foundry integration holds on that integration's resources.
- **A write operation for the round trip.** "Post to Linear and close" needs `issues.comment` / `issues.update`; every catalog operation is read-only today.

**Foundry lane (this ticket).** Prerequisites: G1 (BOARD-005), the first Herald (AGENT-001), and a per-source bound on items per hour plus a capacity check, because each item starts a headless turn on content nobody typed.
- **Open the thread.** On an event, create a thread in the mapped project, or a global thread, with an opening prompt: investigate, match to open work, draft. Today this takes two calls, `POST /api/threads` (`pf/viewer/routes/runtime.ts:713`) then `/api/messages/send`. Fold them into one internal call that both creates and sends.
- **Born private.** The thread starts in the private zone in state New.
- **Matching.** It asks the first Herald (AGENT-001) whether it belongs to an open thread ("This looks familiar: add it to that thread?"). If it does, it becomes a goal on that thread.
- **Reading the body.** The item's body is read through the existing `access/execute` with the Signet (`pf/tools/kingdom-access.ts`). It is labelled untrusted (BOARD-005).

## Open questions

- **Q5.** Which source comes first? The recommendation is Linear: its webhook is signed, it maps to a project, and its round trip is the video's.
- Mapping an item to a project: by integration resource (repo or Linear team), or by asking?

## Related

- Planning doc §6; VIEWER-001; AGENT-001; BOARD-005 (G1).
