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

## The Kingdom contract (Kingdom #206, `docs/DEVICE-INVENTORY.md`; builds after Kingdom #202)

Your other devices reach Foundry through **the Signets Foundry holds from Kingdom**, starting with its pairing Signet (Aron, 2026-11-02). Each of your other machines is a `foundry` Integration, granted as a `device` resource under an entitlement anchored at your user.

1. For each Signet: `POST /api/v1/access/describe {signetId}` (DPoP Signet access token and proof). The `operations[]` entries keyed `online.read` and `tunnel.read` list `resources[]`. Each resource of kind `device` is one device: its `integrationId` and its resource `id`.
2. For each device and granted operation: `POST /api/v1/access/execute {signetId, integrationId, operation, requestId, input: {resourceId}}`.
   - `online.read` returns `{name, status: online | restarting | offline, lastSeenAt, openThreads}`.
   - `tunnel.read` returns `{publicAddress, openUrl}`. `openUrl` is a Kingdom page that opens that Foundry; it never returns the viewer address or tunnel token.
3. Read on page open, on focus, and at most once a minute: every call is metered.
4. A 403 means the device is no longer granted, or is paused: drop it from the list.
5. Kingdom has no per-device projects or quota. A device page shows no checkouts for another machine, and quota stays per login.

## Foundry side (built)

- `ui/device-page.js` (`DevicePage`, `otherMachines`, `threadsOnMachine`); `openDevicePage`, `openMachineBoard`, `openMachineWatchtower`, `watchtowerFilter` in `ui/store.js`.
- The footer's "Your other devices" (`ui/nav-footer.js`).
- Removable filter chips (`ui/filter-chips.js`).

To do once Kingdom ships it: switch `otherMachines()` (`ui/device-page.js`), the one function every surface reads, to the describe and execute calls above, through the existing Kingdom client and merged with the machines known from threads. That fills `online` (from `status`), `open` (from `openThreads`) and `tunnel` (`openUrl` as its link), and the "Coming soon" notes give way on their own. Drop the Checkouts box for other machines: Kingdom has none.
