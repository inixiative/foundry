# AGENT-002: Writeback Pipeline (Loop 4)

**Status**: 🆕 Not Started
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-04-09
**Updated**: 2026-04-09

---

## Overview

FLOW.md Loop 4 defines a writeback pipeline that feeds learnings from completed threads back into the persistent context layers. This is the basic self-improvement loop — robust eval/scoring lives in Oracle.

After a thread completes, the writeback pipeline:
1. Reviews accumulated signals and thread-state
2. Adjusts trust scores on layers that provided good/bad context
3. Updates the Cartographer's doc map with new file observations
4. Proposes new memory entries or convention updates

## Key Gap

CorpusCompiler has a working three-stage pipeline (fluid → formal → corpus) that converts raw signals into structured documents (conventions, ADRs, skills, etc). But nothing feeds it — the Librarian reconciles signals into thread-state but doesn't push them to CorpusCompiler. The wiring is: `Librarian signals → CorpusCompiler.ingest() → formal docs → layer source updates`.

## Key Components

- **CorpusCompiler feed**: Librarian → CorpusCompiler.ingest() on each reconciled signal
- **Writeback agent**: post-thread cleanup agent (fast LLM)
- **Trust adjustment**: bump/decay trust scores based on signal quality
- **Map rebuild trigger**: tell Cartographer to re-index changed files
- **Memory proposals**: extract durable learnings from thread-state via CorpusCompiler formal docs
- **Convention proposals**: CorpusCompiler already produces `convention` typed FormalDocs — surface for review

## Architecture

```
Thread completes
       │
       ▼
 Writeback Agent (fast LLM)
       │
       ├─→ Trust adjustments (layer trust +=/-= delta)
       ├─→ Map rebuild (Cartographer.rebuildMap())
       ├─→ Memory entries (append to memory layer source)
       └─→ Convention proposals (append to convention layer source)
```

## Tasks

### Gap: Librarian → CorpusCompiler feed
- [ ] Subscribe CorpusCompiler to Librarian's reconciled signals (after thread-state write)
- [ ] Call `CorpusCompiler.ingest()` with each reconciled signal as a FluidEntry
- [ ] Wire CorpusCompiler's FormalDoc output to layer source updates (conventions, memory)

### Writeback agent
- [ ] Define `WritebackResult` type (trust deltas, memory entries, convention proposals)
- [ ] Create writeback agent that reads thread-state layer + CorpusCompiler formal docs
- [ ] Implement trust adjustment (update LayerSettingsConfig trust via ConfigStore)
- [ ] Wire Cartographer map rebuild on relevant file observations
- [ ] Surface CorpusCompiler convention/ADR proposals for human review (not auto-applied)
- [ ] Trigger writeback on thread archive/complete

## Definition of Done

- [ ] Thread completion triggers writeback agent
- [ ] Trust scores update based on signal quality
- [ ] New memory entries appear in memory layer on next thread
- [ ] Convention proposals flagged for human review (not auto-applied)

## Related

- **Depends on**: Librarian (thread-state layer) — done
- **Depends on**: Cartographer (map rebuild) — done
- **Blocks**: None (enhancement)
- **Reference**: `docs/FLOW.md` Loop 4
- **Note**: Robust eval/scoring/improvement lives in Oracle, not here

---

_Post-MVP. Basic self-improvement loop. Oracle handles systematic evaluation._
