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

## What Kingdom needs (Aron, 2026-11-02)

Your other devices reach Foundry through **the Signet Foundry holds from Kingdom**. Each of your other machines is a `foundry` Integration. Foundry's Signet carries an entitlement anchored at your user, with operations such as *read online* and *read tunnel* over those integrations. Kingdom already has the liveness, as integration presence (`readIntegrationPresence`, `apps/api/src/modules/me/services/readIntegrationPresence.ts`). The Kingdom lane building this (with inixiative-bf's grant cutover) gives the exact operation and response.

Also wanted with it: a short presence summary each Foundry reports (open top-level threads, registered checkouts, tunnel on/off), stored beside `lastSeenAt` and read under the same entitlement.

## Foundry side (built)

- `ui/device-page.js` (`DevicePage`, `otherMachines`, `threadsOnMachine`); `openDevicePage`, `openMachineBoard`, `openMachineWatchtower`, `watchtowerFilter` in `ui/store.js`.
- The footer's "Your other devices" (`ui/nav-footer.js`).
- Removable filter chips (`ui/filter-chips.js`).

To do once Kingdom serves the call: switch `otherMachines()` (`ui/device-page.js`), the one function every surface reads, to the Signet call through the existing Kingdom client, merged with the machines known from threads; it fills `online`, `checkouts` and `tunnel`, and the "Coming soon" notes give way on their own. Report the summary with presence.
