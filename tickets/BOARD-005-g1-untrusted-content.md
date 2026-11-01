# BOARD-005: G1: content nobody typed is data on every thread

**Status**: 🆕 Not Started (needs its own short spec when picked up)
**Assignee**: TBD
**Priority**: High (the board makes it urgent)
**Created**: 2026-10-31
**Updated**: 2026-10-31

---

## Overview

`docs/reference/CONVERSATIONS.md` §4.5 already names this gap as G1. Every thread should hold one standing reception charter: content the owner didn't type is data, never instructions. That content includes:
- tool output;
- fetched pages;
- member posts;
- chimes;
- now also inbound items and outside requests.

The board makes G1 urgent: every inbound item and every outside request is content nobody typed. The video's "Screened: no hidden instructions found" is G1 plus a visible screen result on the card.

## Built on

- `memberPostReception` and `CHORUS_RECEPTION` (`pf/agents/chorus-reception.ts`).
- The scattered "data, not instructions" sites: `pf/mcp/server.ts:307,532`, `pf/tools/kingdom-access.ts:143`.

G1 makes these one standing layer.

## Related

- CONVERSATIONS.md §4.5; planning doc §9; BOARD-003; BOARD-004.
