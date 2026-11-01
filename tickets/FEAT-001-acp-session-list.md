# FEAT-001: ACP `session/list`

**Status**: 📝 Proposed (not built)
**Assignee**: TBD
**Priority**: Low
**Created**: 2026-10-31
**Updated**: 2026-10-31

---

## Overview

Foundry's ACP agent advertises `sessionCapabilities` resume and close only (`packages/acp/src/agent.ts:758`). A host can reopen a Foundry thread only if it already holds the id.

Implement `session/list` over the thread directory: id, title and last activity, scoped to the cwd or project. Advertise it.

## Why

Hosts (Zed, Paseo, T3 Code) list an agent's past sessions so a user can pick one up. Without the list, a Foundry thread started in one host can't be found from another.

## Existing machinery to use

| Concern | Primitive |
|---|---|
| Thread list and titles | `ViewerThreadDirectory` (`packages/foundry/src/viewer/thread-directory.ts`) and `ThreadNamer` |
| Reopen | ACP `session/load` / `session/resume` (`agent.ts:786,811`) |

## Acceptance

- [ ] `session/list` returns the project's threads, newest first, with titles.
- [ ] Each one opens with `session/load` from a host that never saw it.
- [ ] Archived threads are excluded.
- [ ] An ACP conformance test covers it.

## Not in scope

Advertising the native harness's slash commands and skills is Q4 in the source doc, for Aron.

## Related

Oracle `docs/foundry/reference/COMPARISON.md` §0 (parity refresh, 2026-10-31); `docs/reference/FOUNDRY-ACP.md`.
