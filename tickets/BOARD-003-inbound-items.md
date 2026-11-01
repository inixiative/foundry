# BOARD-003: Inbound items (Slack, Linear, GitHub) arrive as threads already investigating

**Status**: 🆕 Not Started (Kingdom INTEG-002 and INTEG-003 first)
**Assignee**: TBD
**Priority**: High
**Created**: 2026-10-31
**Updated**: 2026-11-01

---

## Overview

When Aron is **tagged or messaged directly** in Slack, Linear or GitHub, the item arrives as a thread that is already investigating. The agent has looked into it, matched it to open work and drafted a reply before he sees it. The reply goes back where the item came from, as a held draft.

Aron:
- 2026-10-31: "Let's just say you get tagged or a direct message." And: "messages in Slack, whatever, and we'll respond in Slack."
- 10-24 guide: "Things arrive already in session."

## Split (D7: Foundry builds nothing that goes through Kingdom)

**Kingdom lane:**
- **INTEG-002**: signed receivers on Tribe's `whatsappWebhook.ts` pattern. The trigger filter runs in Kingdom. Delivery is durable, as `inboundItem` Inquiries on the Installation snapshot.
- **INTEG-003**: the write operations, Slack message, Linear comment and GitHub comment, all as Signet operations.

**Foundry lane (this ticket).** Prerequisites:
- G1 (BOARD-005);
- the first Herald (AGENT-001);
- a per-source limit on investigating threads open at once. It is new: `subscription-decisions.ts` bounds decision calls, not turns. Items over the limit wait as pending Inquiries.

On each item:
1. **Match first.** Ask the Herald whether the item belongs to an open thread. If it does, it becomes a goal there.
2. **Otherwise open a thread, idempotently.** The thread id is derived from the item id (`POST /api/threads` takes `id`, `pf/viewer/routes/runtime.ts:715`). It goes in the mapped project or the global scope, created with its opening prompt in one internal call. Today that takes two calls; the second is `/api/messages/send`.
3. **Read the body** through `access/execute` with the Signet (`pf/tools/kingdom-access.ts`), using the new read operations (Kingdom INTEG-003: Slack DMs, GitHub issues and PRs, Linear comments), labelled untrusted.
4. **Mark it for attention** (`meta.attention`) in the "Just in" lane.
5. **Acknowledge it** by resolving the Inquiry, only after the thread exists, so a crash gives one thread.
6. **Noise and duplicates.** A rule may file an item as noise with a one-line reason, one tap away. Duplicates join their thread.
7. **The reply is a held draft.** A Foundry MCP tool runs the Kingdom write operation on the held-outbound pattern (`ActionQueue`). The card offers "Post to Slack" or "Post to Linear and close". Nothing posts unseen. Whether that is what "our MCP" means is Q-E.

## Open questions

- **Q-D.** Is Slack first, then GitHub (by polling notifications) and Linear?
- **Q-E.** "Our MCP": Foundry's tool backed by a Signet (recommended), or the harness's Slack MCP?
- **Q-F.** Linear webhooks in a work workspace need its admin.
- Mapping an item to a project: by integration resource (repo, Linear team), or by asking?

## Related

- Planning doc §6; VIEWER-001; AGENT-001; BOARD-005; Kingdom INTEG-002, INTEG-003.
