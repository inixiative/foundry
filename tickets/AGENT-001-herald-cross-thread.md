# AGENT-001: Herald Cross-Thread Coordination

**Status**: 🆕 Not Started
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-04-09
**Updated**: 2026-04-09

---

## Overview

The Herald watches all active threads and detects convergence, divergence, and resource conflicts. It emits signals when sibling threads are editing the same files, working on related tasks, or making conflicting decisions.

FLOW.md designates the Herald as a domain advisor with cross-thread scope. It runs on a fast LLM, reads thread summaries from warm caches, and produces signals consumed by the Librarian.

## Key Components

- **Herald agent class** (`packages/core/src/herald.ts` — exists, needs instantiation)
- **Thread summary cache**: warm cache of sibling thread status/descriptions
- **Signal emission**: convergence, divergence, resource conflict signals
- **FlowOrchestrator integration**: Herald runs during pre-message flow at "on cross-cutting signals" tier (~5% of messages)
- **start.ts wiring**: register Herald with thread, subscribe to session manager

## Architecture

```
SessionManager.threads ──→ Herald warm cache
                             │
                             ▼
             Fast LLM: "Is any sibling thread
              relevant or conflicting?"
                             │
                             ▼
              Signal: thread_convergence / thread_conflict
                             │
                             ▼
              Librarian reconciles → thread-state layer
```

## Tasks

- [ ] Instantiate Herald in `start.ts` with session manager reference
- [ ] Build thread summary warm cache (refresh on thread create/archive events)
- [ ] Wire Herald into FlowOrchestrator pre-message at cross-cutting tier
- [ ] Define signal kinds: `thread_convergence`, `thread_divergence`, `resource_conflict`
- [ ] Add Herald to thread cleanup (SIGINT handler)

## Definition of Done

- [ ] Herald detects when two threads edit the same file
- [ ] Herald emits signal that Librarian reconciles into thread-state
- [ ] Herald skips analysis when only one active thread
- [ ] Fast LLM (Gemini Flash) used, not the executor model

## Related

- **Depends on**: Librarian (signal reconciliation) — done
- **Depends on**: SessionManager — exists
- **Blocks**: None (enhancement)
- **Reference**: `docs/FLOW.md` lines 104, 256-264, 777

---

_Post-MVP enhancement. Herald class exists in core but isn't instantiated in the runtime._
