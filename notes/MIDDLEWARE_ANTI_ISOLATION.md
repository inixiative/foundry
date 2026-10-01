# Middleware Layer: Anti-Isolation Architecture

*Draft notes. March 2026.*

---

## The Problem with Isolation

Everyone in multi-agent is building for isolation — sandboxed contexts, clean boundaries, no cross-contamination. This is correct for preventing hallucination bleed and context confusion. But isolation creates its own failure mode: **cross-blindness**.

Isolated agents:
- Duplicate work they can't see each other doing
- Reach contradictory conclusions with no arbiter
- Converge on the same sub-problem without anyone noticing
- Lose emergent insights that only appear at the intersection of multiple agents' findings

Isolation solves contamination. It creates blindness. We need both.

---

## The Middleware Harness

A new harness type, distinct from the agent harness, purpose-built for **cross-cutting observation**.

```
Agent A ──┐                              ┌── Channel/Thread A
Agent B ──┼── Snapshot ──→ Middleware ──→ ┼── Channel/Thread B
Agent C ──┘   (frozen)     Harness        └── Channel/Thread C
                           (stateless)
```

### Properties

- **Read-many, write-none** on agent state. The middleware sees snapshots of all agents' contexts but never mutates live state directly.
- **Stateless per invocation.** Each evaluation runs against a frozen snapshot. This makes it interruptible, restartable, and safe.
- **Pre-commit gate.** Decisions pass through the middleware *before* landing in a thread or channel. This is where interruption happens.
- **Anti-isolation by design.** Its entire job is to hold the cross-cutting view that no isolated agent can have.

### What it enables

| Capability | Example |
|------------|---------|
| **Deduplication** | "Agent B, stop — Agent A already answered this 40 seconds ago" |
| **Contradiction detection** | "Agent C's conclusion contradicts Agent A's finding — escalate before committing" |
| **Convergence detection** | "Three agents are converging on the same sub-problem — merge them" |
| **Resource arbitrage** | "Agent A is idle, Agent B is overloaded — rebalance" |
| **Cross-pollination** | "Agent A found something relevant to Agent B's task — inject it" |

### Harness differences

| | Agent Harness | Middleware Harness |
|---|---|---|
| **Optimized for** | Depth — stay on task, manage your context | Breadth — shallow understanding of many things simultaneously |
| **State** | Stateful, accumulates context | Stateless, runs against snapshots |
| **Evaluation** | "Did you answer correctly?" | "Did you catch the redundancy/contradiction/convergence?" |
| **Isolation** | Enforced — can't see other agents | Violated — must see all agents |
| **Interruption** | Should not be interrupted mid-task | Can be interrupted and restarted at any point |

---

## The Role: Herald / Spymaster / Spider

The middleware needs a persona. Working names:

| Name | Connotation | Fit |
|------|-------------|-----|
| **Herald** | One who announces, carries messages between parties | Clean, clear, medieval/craft flavor that fits Foundry |
| **Spider** | Sits at center of web, feels every vibration | Accurate but sinister; good internal shorthand |
| **Spymaster** | Runs a network of informants, synthesizes intelligence | Captures the information-dealing aspect |
| **Whispermonger** | Trades in secrets and rumors | Fun but possibly too playful |
| **Chronicler** | Records and connects everything | Emphasizes the memory/history function |
| **Nexus** | Connection point, hub | Generic but accurate |
| **Loom** | Weaves threads together | Fits Foundry's craft metaphor (foundry → forge → loom) |

### What the role does

The Herald (working name) is the **information broker of the hivemind**. It:

1. **Observes** — maintains a read-only view of all active agents' state via snapshots
2. **Correlates** — identifies patterns across agents that no single agent can see (duplication, contradiction, convergence, relevance)
3. **Intercepts** — sits in the pre-commit path so decisions can be enriched, redirected, or blocked before landing
4. **Synthesizes** — when asked "what does the collective know?", produces a coherent summary from fragmented agent knowledge
5. **Arbitrates** — when agents disagree, provides the cross-cutting context needed to resolve the conflict

### What it is NOT

- Not the Orchestrator (doesn't assign tasks or manage lifecycle)
- Not the Cartographer (doesn't map the corpus — maps the *agents*)
- Not the Librarian (doesn't classify signals — classifies *agent state*)
- Not a supervisor (doesn't evaluate quality — detects *patterns*)

The Cartographer maps the territory (corpus, knowledge). The Herald maps the *expedition* (who's doing what, who found what, who's stuck, who's redundant).

---

## Relationship to Existing Roles

```
                    Orchestrator
                    (assigns work)
                         │
                         ▼
    ┌──────────┬─────────┬──────────┐
    │          │         │          │
Agent A    Agent B   Agent C    Agent D
    │          │         │          │
    └──────────┴─────────┴──────────┘
                    │
              ──── Herald ────
              (sees all, owns none)
                    │
                    ▼
              Hivemind State
              (coordination layer)
```

The Herald reads from Hivemind (where agents emit events) and can write back recommendations, warnings, or blocks. It's the nervous system overlaid on top of the organ-level isolation.

---

## Snapshot Architecture

The key architectural insight: **the middleware operates on snapshots, not live state**.

```
Time T₁: Snapshot captured
  → Agent A: working on auth module, 60% complete, asked 2 questions
  → Agent B: working on API routes, 40% complete, found a blocker
  → Agent C: working on tests, 80% complete, no issues

Time T₁: Herald evaluates snapshot
  → Detects: Agent B's blocker relates to Agent A's auth module
  → Action: Surface Agent A's progress to Agent B before Agent B goes down a dead end

Time T₂: New snapshot captured
  → Herald evaluates again, stateless, no memory of T₁ evaluation
```

This makes the Herald:
- **Safe** — can't corrupt agent state because it only reads snapshots
- **Interruptible** — any evaluation can be killed and restarted
- **Parallelizable** — multiple Herald instances can evaluate different aspects of the same snapshot
- **Auditable** — every snapshot + decision is a reproducible artifact

---

## Push Architecture: Event-Driven, Not Poll-Based

Most agent architectures are request/response — pull-based. The agent asks for what it needs, or it doesn't get it. The Herald *can't* work that way. Its whole purpose is knowing things agents didn't think to ask about. It needs to be **notified**, not polled. That's push architecture.

The primitives already exist. Hivemind v2 is event-based. The harness has hooks. WebSocket is just the transport for making events real-time instead of batched.

### The Event Flow

```
Agent emits event → Hivemind → WebSocket → Herald receives
                                          → Herald evaluates
                                          → Herald pushes back (inject/block/enrich)
```

No polling. No "check every N seconds." The Herald's tickrate becomes **event-driven** — it fires when something happens, not on a timer. This is both cheaper and more responsive than periodic snapshots.

### Herald as Hook Subscriber

The hook system is the natural integration point. Hooks are already "when X happens, do Y" — the same pattern. The Herald is a hook subscriber that:

1. **Subscribes** to cross-agent events on the Hivemind event bus
2. **Evaluates** each event against the current cross-agent snapshot
3. **Emits** its own events back (block, enrich, passthrough, redirect)

The harness infrastructure already supports this shape. The Herald doesn't need a new communication paradigm — it plugs into the one that exists.

### Why This Matters

The reason agent architectures aren't designed this way is that most agents are single-shot or conversational. They don't have a coordination layer to hook into. Foundry does. Hivemind is already an event bus. Making the Herald a subscriber rather than a poller is the natural architecture.

### The Event Contract

The hard part isn't the transport. It's the **contract** — what the Herald subscribes to, the schema of events, and the response types. This is the API design work:

| Event Type | Herald Response Options |
|------------|------------------------|
| Agent action (pre-commit) | **Block** — prevent the action, return reason |
| Agent action (pre-commit) | **Enrich** — allow but inject additional context |
| Agent action (pre-commit) | **Passthrough** — allow without modification |
| Agent finding (post-action) | **Redirect** — route the finding to another agent |
| Agent state change | **Rebalance** — suggest work redistribution |
| Agent question | **Short-circuit** — answer from another agent's prior work |

The WebSocket/hook plumbing is the easy part given what's already built. The event contract is where the design work lives.

### Snapshot Frequency: Resolved

Open question #1 from below is resolved: **event-driven, not periodic**. Snapshots are captured on every relevant event emission, not on a timer. The Herald evaluates when something happens. If nothing happens, the Herald is idle — zero cost. If three agents emit simultaneously, the Herald processes three events — proportional cost.

Periodic polling is the wrong model because:
- It wastes cycles when agents are idle
- It misses events between polling intervals
- It introduces latency equal to half the polling period on average
- It doesn't scale — doubling agents doubles the work per poll regardless of actual activity

Event-driven eliminates all four problems.

---

## Open Questions

1. ~~**Snapshot frequency** — How often should snapshots be captured? Event-driven (on every agent emission) vs. periodic (every N seconds)?~~ **Resolved: event-driven. See Push Architecture section above.**
2. **Decision authority** — Can the Herald block an agent's action, or only recommend? Who breaks ties?
3. **Herald-to-agent communication** — Does the Herald inject into agent context directly, or go through Hivemind channels?
4. **Multiple Heralds** — Should there be specialized Heralds (one for deduplication, one for contradiction detection) or one generalist?
5. **Relationship to Cartographer** — The Cartographer maps knowledge, the Herald maps agent state. Do they share infrastructure? Is the Herald a Cartographer specialization?
6. **Cost** — Running a cross-cutting observer adds overhead. When is it worth spinning up vs. letting agents run blind?
7. **Event contract schema** — What is the full taxonomy of events the Herald subscribes to? What metadata must each event carry for the Herald to evaluate without needing to fetch additional state?
8. **Backpressure** — When agents emit faster than the Herald can evaluate, what's the degradation strategy? Drop, queue, sample?

---

*The core thesis: isolation is necessary but insufficient. You need a layer that deliberately violates isolation — but does so safely, statelessly, on frozen snapshots. The Herald is that layer.*
