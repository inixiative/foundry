# Foundry Bootstrap Strategy

> **Not the default.** This is a strategy for building a wrapped stack by hand. A fresh install is one
> executor and nothing else: the thread is unwrapped, and the user's message reaches the native session
> as typed (`defaultAgents` in `packages/foundry/src/viewer/config.ts`). Every layer and source below
> is an opt-in setting.

A practical plan for setting up a default Foundry instance with self-improvement
loops that compound over time. Start minimal, let the system learn.

---

## Philosophy

Don't over-configure upfront. Start with a thin stack, let the signal system
and writeback pipeline figure out what matters. Your job is to seed the right
*structure* — the system fills in the *content*.

---

## Phase 1: Layer Architecture

### Layer Stack

| Layer | Staleness | Max Tokens | Purpose |
|---|---|---|---|
| `system` | never | 2,000 | Identity + hard constraints. Never stale. |
| `project-context` | 5min | 6,000 | Hydrated from project files (README, package.json, tsconfig, key dirs). Per-thread. |
| `conventions` | 60s | 4,000 | Coding standards, naming, patterns. Starts seeded, grows via correction signals. |
| `domain` | 5min | 6,000 | Domain knowledge — business rules, API contracts, schema shapes. Hydrated from docs/sources. |
| `learnings` | 30s | 8,000 | Accumulated from signals. |
| `memory` | 15s | 8,000 | Working memory — recent context, decisions, thread-local state. High churn. |
| `scratch` | 10s | 4,000 | Ephemeral. Mid-run observations, hypotheses. |

**Why this shape:**
- Slow-moving layers (system, conventions) are low-staleness
- Learning surface layers (learnings, domain) absorb signals via the writeback pipeline
- Working memory layers (memory, scratch) turn over quickly per thread

### Layer Activation Modes

A layer is `always` (in every assembly) or `on-demand` (only when a Warden's contribution or other
middleware asks for it on that turn).

| Layer | Activation |
|---|---|
| `system` | always |
| `project-context` | always |
| `conventions` | always |
| `domain` | on-demand |
| `learnings` | always |
| `memory` | always |
| `scratch` | on-demand |

---

## Phase 2: Agents

A Foundry thread runs one executor: the native session (Claude Code, Codex or Muse Code) on the
thread's worker and model. An executor adds no instructions of its own; a main thread's come from its
thread role's role files (`.foundry/roles/thread/<role>/instructions.md`). Middleware around it comes
from a project's region Wardens, turned on per project (`"chorus": { "enabled": true }`), which run on
the cheap decision model.

---

## Phase 3: Self-Improvement

Feedback given in Foundry (`/feedback`, `/correction`, or detection when `feedback.capture` is on) is
captured into the feedback lifecycle and, once applied, written to a role file the composition view
reads on the next turn (docs/FEEDBACK-LOOP.md).

---

## Phase 4: Hydration Strategy

### Project Hydration (thread creation time)

When a thread is created for a project, hydrate these layers:

| Layer | Hydration Source | Method |
|---|---|---|
| `project-context` | README.md, package.json, key config files | FileMemory or inline |
| `domain` | docs/ directory, API specs, schema files | FileMemory or HTTP |
| `conventions` | .foundry/memory (conventions kind) | FileMemory |

### Thread Hydration (per-dispatch)

Each dispatch through the harness:

1. **ContextStack.warmAll()** — refresh any stale layers from sources
2. **Activation** — on-demand layers join only when requested for this turn
3. **ContextStack.assemble()** builds the prompt blocks

### Source Types to Configure

```
system-prompt     → inline (static text, your core identity)
conventions-src   → file (.foundry/memory, kind=convention)
domain-src        → file (project docs) OR markdown (a docs directory)
memory-src        → file (.foundry/memory, kind=*)
project-src       → file (README, package.json, tsconfig — per project)
```

---

## Phase 5: Token Budget

**Token budget:** Set based on your model's context window. Leave headroom for the actual
conversation (at least 50% of the context window).

Progressive hydration keeps cost low: on-demand layers join only when a turn asks for them, and MCP
lets the session pull additional context on demand.

---

## Phase 6: Budget & Safety

```typescript
const tracker = new TokenTracker({
  budget: {
    maxCost: 10.00,      // $10/day hard limit
    warnAt: 0.7,         // warn at $7
    haltAt: 1.0,         // halt at $10
  },
});

```

---

## Bootstrapping Sequence

Run this in order:

1. `bun run setup` — pick provider, model, port
2. Edit `.foundry/settings.json` with the layer/agent config above
3. Seed `.foundry/memory/` with initial conventions:
   - Your coding standards
   - Known patterns / anti-patterns
   - Domain glossary (if any)
4. `bun run start` — system comes up with thin layers
5. Send test messages through the viewer — watch the Wardens' advice and the execution
6. Give `/feedback` on what goes wrong — applied rules reach the role they name
7. After ~20 interactions, check the learnings layer — it should be accumulating

---

## What "Good" Looks Like

After a few hundred interactions:

- **Conventions layer** has grown from seed → 20+ entries, all from real corrections
- **Fewer operator corrections over time** — the same feedback stops recurring
- **Token budget respected** — progressive hydration keeps context under control
- **Trace history shows improvement** — earlier traces have more corrections, later ones fewer

The goal is not a perfect system on day 1. It's a system that's measurably better
on day 30 than day 1, and better on day 90 than day 30. The self-improvement loops
are the whole point.
