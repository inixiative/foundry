# CORE-002: Release idle and disposed main-thread native sessions

**Status**: 📝 Proposed (not built)
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-10-31
**Updated**: 2026-10-31

---

## Overview

A main thread's native Claude or Codex process lives until Foundry shuts down. It is released only in three cases:
- a settings relaunch (`SessionBackedProvider._relaunch`, `packages/foundry/src/providers/session-backed.ts:864`);
- a cwd move (`_retireElsewhere`, `:935`);
- shutdown (`releaseAll`).

`ThreadRuntime.dispose` releases only the Warden providers (`packages/foundry/src/agents/thread-runtime.ts:3573`). With many open threads, this is the memory problem CLAUDE.md (2026-10-12) warns about.

Extend the **existing** guarded release, `_releaseIdle(opts, owned = true)` (`session-backed.ts:243`), which goes through the adapter's `releaseIdleSession` and keeps the resume binding:

1. Call it after a settable idle time.
2. Call it on `ThreadRuntime.dispose`.
3. Add vetoes: a pending prompt or held answer, a queued turn, an active observed child (thread tree), or an unsettled call (already checked).

The next prompt resumes the session natively, through the stored binding.

## Why

Paseo shipped the same thing (#7782): it releases an idle runtime after an hour, with daemon and provider vetoes. It is cheap because the binding survives. Ours has every piece except the triggers.

## Existing machinery to use

| Concern | Primitive |
|---|---|
| Release | `_releaseIdle` / `releaseIdleSession`; the `releaseIdle` lifecycle (`packages/core/src/types.ts:211`) |
| Resume | The stored native binding (session-backed resume path) |
| Timers | Foundry's existing job layer if a periodic sweep is needed (`packages/foundry/src/jobs/`). **Not** `Session.evict`, which archives Thread objects |

No second release path.

## Acceptance

- [ ] An idle thread's native process exits after the configured time, and the next message resumes the same native session.
- [ ] Each veto keeps the process alive.
- [ ] Disposing a thread releases its process.
- [ ] The setting has a default, and off disables it.

## Related

Oracle `docs/foundry/reference/COMPARISON.md` §0 (parity refresh, 2026-10-31).
