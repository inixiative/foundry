# VIEWER-007: Your other machines, from Kingdom

**Status**: 🆕 Not Started (the viewer side is built; the data waits on Kingdom)
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-11-02
**Updated**: 2026-11-02

---

## Overview

The rail footer lists **your other devices** under this machine, each with its status and its open-thread count and no meters. Clicking one opens its **machine page**: its open threads, checkouts and tunnel, a note that subscriptions are shared, and links to its threads on the Board and in the Watchtower, each filtered to that machine with a removable chip. Today Foundry knows another machine only through threads listed here that carry its `meta.machine`. Its status, checkouts and tunnel, and every machine with no such thread, read "Coming soon" with this ticket.

## Why (Aron, 2026-11-02)

Quota belongs to a subscription login and is shared across devices, so it is never shown per machine. The footer reads: this Mac, then Kingdoms and Archives, then "Your other devices" (listed with status and open-thread count), then Subscriptions. Intended features stay visible as placeholders.

## What Kingdom needs

Kingdom already knows each paired Foundry. It is a `foundry` Integration on its owner, and its liveness is integration presence (`readIntegrationPresence`, `apps/api/src/modules/me/services/readIntegrationPresence.ts`, Redis `lastSeenAt` within `PRESENCE_TTL_SECONDS`). But only a person reads it, through `GET /me/overview`. A paired Foundry presents its Signet enrollment on the installation socket and has no way to ask.

1. **An installation operation `installations.siblings`** on the installation socket (or `access/…`): the other enabled `foundry` integrations of the same owner, plus those of the owner's personal owners (the User and their OrganizationUsers). It returns each integration's id, name (the Foundry's `installationName` from pairing) and presence (`online` / `lastSeenAt`). Permission: the caller's own owner, or its personal owner. It reuses `readIntegrationPresence`, with no second presence store.
2. **A short presence summary** carried with the presence a Foundry already reports: open top-level thread count, registered checkouts (project ids and labels), and tunnel on/off. Kingdom stores it beside `lastSeenAt` (Redis, same TTL), so `installations.siblings` returns it.

## Foundry side (built)

- `ui/device-page.js` (`DevicePage`, `knownOtherMachines`, `threadsOnMachine`); `openDevicePage`, `openMachineBoard`, `openMachineWatchtower`, `watchtowerFilter` in `ui/store.js`.
- The footer's "Your other devices" (`ui/nav-footer.js`).
- Removable filter chips (`ui/filter-chips.js`).

To do once Kingdom serves the two items above:
- Read `installations.siblings` through the existing Kingdom client, and merge it with the machines known from threads.
- Report the summary with presence.
- Replace the three "Coming soon" notes.
