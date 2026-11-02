# AGENT-001: Herald Cross-Thread Coordination

**Status**: 🆕 Not Started
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-04-09
**Updated**: 2026-10-31

---

**2026-11-02:** `agents/herald.ts`, `agents/workstream-detector.ts` and `SessionManager` (`agents/session.ts`), deleted unwired on 11-01 (#202), are restored as the placeholder this ticket builds on (Aron, 2026-11-02: features we intend to build are not cut because they're unwired). Build the Herald on `@inixiative/foundry/classify` with region `role: herald` and the live thread directory (`viewer/thread-directory.ts`), adopting or rewriting these.


## Revision 2026-10-31 (attention board): read this first

The body below dates from April and is stale in three ways:
- It names Gemini Flash. All decision roles are Claude Haiku 5.5 now (2026-10-11).
- It says `SessionManager` "exists". Production never constructs one.
- It wires the Herald into the pre-message flow. The chorus is region Wardens only.

Aron (2026-10-31, D1) put thread matching, past work and team overlap on **Heralds**: "Chorus needs to point at rules and docs. Other things would go through heralds… Thread matching is a herald issue." Heralds carry live data; Wardens carry static knowledge (2026-10-17).

**The first Herald is local thread matching**, because inbound needs it (BOARD-003). A new item asks "does this belong to an open thread?", and on yes it becomes a goal there ("This looks familiar: add it to that thread?"). Past-work chips ("Google Pay, added Aug 12") come next, from Archive and the harvest's work links (Oracle `docs/PROSPECTOR-HARVEST.md`). Team overlap ("both changing checkout/payment.ts") crosses machines, so it goes through Kingdom with a Signet and comes last.

Decide whether to adopt `agents/herald.ts`'s detectors or replace them. Whatever is chosen runs through `@inixiative/foundry/classify`, the one classification primitive, with region `role: herald` as its socket. Planning doc: Oracle `docs/foundry/ATTENTION-BOARD.md` §8.

## Overview

The Herald watches all active threads and detects convergence, divergence, and resource conflicts. It emits signals when sibling threads are editing the same files, working on related tasks, or making conflicting decisions.

FLOW.md designates the Herald as a domain advisor with cross-thread scope. It runs on a fast LLM, reads thread summaries from warm caches, and produces signals consumed by the Librarian.

## Key Components

- **Herald agent class** (`packages/foundry/src/agents/herald.ts` — exists, needs instantiation)
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
