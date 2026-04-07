# Foundry Bootstrap Strategy

A practical plan for setting up a default Foundry instance with self-improvement
loops that compound over time. Start minimal, let the system learn.

---

## Philosophy

Don't over-configure upfront. Foundry's strength is that layers gain and lose
trust based on actual usage. Start with a thin stack, let the signal system
and active memory figure out what matters. Your job is to seed the right
*structure* — the system fills in the *content*.

---

## Phase 1: Layer Architecture

### Layer Stack (ordered by trust, highest first)

| Layer | Trust | Staleness | Max Tokens | Purpose |
|---|---|---|---|---|
| `system` | 1.0 | never | 2,000 | Identity + hard constraints. Never stale. |
| `project-context` | 0.9 | 5min | 6,000 | Hydrated from project files (README, package.json, tsconfig, key dirs). Per-thread. |
| `conventions` | 0.8 | 60s | 4,000 | Coding standards, naming, patterns. Starts seeded, grows via correction signals. |
| `domain` | 0.7 | 5min | 6,000 | Domain knowledge — business rules, API contracts, schema shapes. Hydrated from docs/sources. |
| `learnings` | 0.5 | 30s | 8,000 | Auto-accumulated from signals. Corpus compiler promotes fluid entries here. |
| `memory` | 0.3 | 15s | 8,000 | Working memory — recent context, decisions, thread-local state. High churn. |
| `scratch` | 0.1 | 10s | 4,000 | Ephemeral. Mid-run observations, hypotheses. Dissolved aggressively by active memory. |

**Why this ordering:**
- High-trust layers are slow-moving, low-staleness (system, conventions)
- Mid-trust layers are the learning surface (learnings, domain)
- Low-trust layers are fast-moving working memory (memory, scratch)
- Active memory will naturally adjust trust based on actual use/override/ignore patterns

### Layer Activation Modes

| Layer | Activation | Condition |
|---|---|---|
| `system` | always | — |
| `project-context` | always | — |
| `conventions` | always | — |
| `domain` | conditional | categories: bug, feature, refactor |
| `learnings` | always | — |
| `memory` | always | — |
| `scratch` | conditional | Only during executor dispatch |

---

## Phase 2: Agent Pipeline

### Model Strategy

Use **tiered models** — don't burn Opus tokens on classification:

| Agent | Model | Temperature | Max Tokens | Reasoning |
|---|---|---|---|---|
| `classifier` | haiku | 0 | 256 | Fast, cheap. Classification is pattern matching. |
| `router` | haiku | 0 | 256 | Routing is a lookup, not reasoning. |
| `planner` | sonnet | 0.2 | 2,048 | Needs to reason about decomposition. |
| `executor-fix` | sonnet | 0 | 8,192 | Bug fixing needs precision. |
| `executor-build` | sonnet | 0.3 | 8,192 | Feature work benefits from slight creativity. |
| `executor-answer` | sonnet | 0.1 | 4,096 | Explanations should be clear, not creative. |
| `reviewer` | sonnet | 0 | 4,096 | Self-review needs to be strict. |
| `distiller` | haiku | 0 | 1,024 | Extracting signals from traces is mechanical. |

**Thinking levels:** For providers that support extended thinking (Claude), use it
on the planner and executor-fix agents. These are the agents where step-by-step
reasoning actually improves output quality. Don't use thinking on classifier/router —
it's wasted latency.

### Agent Definitions

```
classifier
  kind: classifier
  prompt: |
    Classify the message into exactly one category.
    Categories: bug, feature, refactor, question, architecture, convention, devops, general
    Consider the project context and recent thread history.
    Respond with JSON: {"category": "...", "confidence": 0-1, "tags": [...], "reasoning": "..."}
  visibleLayers: [system, project-context]
  invocation: always

router
  kind: router
  prompt: |
    Route to the best executor for this task. Consider:
    - Classification category and confidence
    - Which context layers are relevant (include by ID)
    - Whether this needs planning (complexity > medium)
    Available executors: executor-fix, executor-build, executor-answer
    Available meta-agents: planner, reviewer
    Respond with JSON: {"destination": "...", "contextSlice": [...], "priority": 1-10, "needsPlanning": bool, "reasoning": "..."}
  visibleLayers: [system, project-context, conventions]
  invocation: always

planner
  kind: executor
  prompt: |
    Break down this task into concrete steps. Each step should be:
    - Specific enough to execute without ambiguity
    - Assigned to an executor agent
    - Ordered by dependency
    Consider token budget and whether steps can parallelize.
    Respond with a structured plan.
  visibleLayers: [system, project-context, conventions, domain]
  invocation: conditional
  condition: { routes: ["planner"] }

executor-fix
  kind: executor
  prompt: |
    You are a bug-fixing specialist.
    1. Reproduce the issue mentally from the description
    2. Identify root cause using project context and conventions
    3. Propose a minimal fix that doesn't break existing behavior
    4. Note any conventions or patterns you relied on
    If you override or disagree with a convention, emit a signal explaining why.
  visibleLayers: []  (all layers)
  invocation: conditional
  condition: { categories: ["bug"], routes: ["executor-fix"] }

executor-build
  kind: executor
  prompt: |
    You are a feature implementation specialist.
    1. Understand the requirement in context of the existing architecture
    2. Design the minimal change that fulfills the requirement
    3. Follow project conventions strictly
    4. If you discover a new pattern worth codifying, note it
  visibleLayers: []
  invocation: conditional
  condition: { categories: ["feature", "refactor", "architecture"], routes: ["executor-build"] }

executor-answer
  kind: executor
  prompt: |
    You are a technical Q&A specialist.
    Answer clearly and concisely using project context.
    Reference specific files, functions, or conventions when relevant.
    If you don't know, say so — don't fabricate.
  visibleLayers: []
  invocation: conditional
  condition: { categories: ["question", "general"], routes: ["executor-answer"] }

reviewer
  kind: executor
  prompt: |
    Review the previous executor's output for:
    1. Correctness — does it actually solve the problem?
    2. Convention compliance — does it follow project standards?
    3. Completeness — are there edge cases or missing pieces?
    4. Signal extraction — what should the system learn from this?
    Emit correction signals for any issues found.
    Emit convention signals for any new patterns worth codifying.
  visibleLayers: []
  invocation: on-demand

distiller
  kind: executor
  prompt: |
    Extract learnings from completed traces. For each trace:
    1. What worked well? (convention signal)
    2. What was corrected? (already captured as correction signal)
    3. Any new patterns? (convention signal)
    4. Any domain knowledge discovered? (emit as domain signal)
    Be concise. Each signal should be one clear statement.
  visibleLayers: [system, conventions, learnings]
  invocation: on-demand
```

---

## Phase 3: Self-Improvement Loops

These are the feedback mechanisms that make Foundry get better over time.

### Loop 1: Correction → Convention (immediate)

```
Operator corrects a classification/route/output
  → InterventionLog emits correction signal (confidence: 1.0)
  → ActiveMemory adjusts layer trust (override penalty on overridden layer)
  → CorpusCompiler ingests as fluid entry
  → After N corrections on same topic → auto-promote to formal doc
  → Formal doc compiles into conventions/learnings layer
```

**Setup:** This is automatic. InterventionLog already emits correction signals,
ActiveMemory already tracks outcomes, CorpusCompiler already ingests from SignalBus.
Just wire them at startup:

```typescript
activeMemory.connectSignals(signals);
activeMemory.connectLifecycle();
corpus.ingestFromSignalBus(signals);
```

### Loop 2: Review → Refinement (per-dispatch)

```
Executor produces output
  → Reviewer agent evaluates output (on-demand, triggered by hook)
  → Reviewer emits convention/correction signals
  → Signals flow into layer trust + corpus
```

**Setup:** Add a post:dispatch hook that conditionally invokes the reviewer:

```typescript
hooks.register({
  id: "auto-review",
  hookPoint: "post:dispatch",
  priority: 200,
  handler: async (ctx) => {
    // Only review executor outputs, not classifier/router
    if (ctx.agentId?.startsWith("executor-")) {
      // Dispatch to reviewer with the output as payload
      return { action: "continue", annotations: { needsReview: true } };
    }
    return { action: "continue" };
  },
});
```

### Loop 3: Distillation → Knowledge (periodic)

```
Every N traces (or on schedule):
  → Distiller agent reviews recent traces
  → Extracts patterns, conventions, domain knowledge as signals
  → Corpus compiler clusters related signals
  → Auto-promotes clusters with enough evidence to formal docs
  → Compiled corpus refreshes learnings layer
```

**Setup:** Run distillation on a timer or trace count threshold:

```typescript
let traceCount = 0;
harness.onTrace((trace) => {
  traceCount++;
  if (traceCount % 10 === 0) {
    // Every 10 traces, run distillation
    distiller.run(recentTraceSummaries(10));
  }
});
```

### Loop 4: Herald → Cross-Thread Learning (continuous)

```
Herald snapshots all threads every 5s
  → Detects duplication, contradiction, convergence
  → Injects recommendations as signals into target threads
  → Cross-pollination: learnings from thread A appear in thread B
```

**Setup:** Herald is already built. Start it:

```typescript
const herald = new Herald(threadRegistry, signals);
herald.start(); // 5s default interval
```

### Loop 5: Active Memory → Layer Evolution (continuous)

```
Every layer access is tracked:
  - "used" → trust boost (+1)
  - "overridden" → trust penalty (-3)
  - "ignored" → mild penalty (-0.5)

Layers compete: overlapping content → higher-access layer wins
Layers dissolve: trust drops below threshold → removed from stack
```

**Setup:** Already built into ActiveMemory. Configure thresholds:

```typescript
const activeMemory = new ActiveMemory(lifecycle, {
  useBoost: 1,
  overridePenalty: 3,
  ignorePenalty: 0.5,
  dissolutionThreshold: 5,
  enableCompetition: true,
});
```

### Loop 6: Corpus Tier Promotion (manual + automatic)

```
Fluid entries cluster → formal docs (draft)
  → docs gain trust from usage/signals
  → personal_private (trust ≥ 0) → personal_public (trust ≥ 30)
  → personal_public → team (trust ≥ 50, sources ≥ 5)
  → team → org (trust ≥ 70, sources ≥ 10)
```

This is the path from "one agent learned something" to "the whole org knows it."

---

## Phase 4: Hydration Strategy

### Project Hydration (thread creation time)

When a thread is created for a project, hydrate these layers:

| Layer | Hydration Source | Method |
|---|---|---|
| `project-context` | README.md, package.json, key config files | FileMemory or inline |
| `domain` | docs/ directory, API specs, schema files | FileMemory or HTTP |
| `conventions` | .foundry/memory (conventions kind) | FileMemory |
| `learnings` | Compiled corpus (active formal docs) | CorpusCompiler.loadIntoStack() |

### Thread Hydration (per-dispatch)

Each dispatch through the harness:

1. **ContextStack.warmAll()** — refresh any stale layers from sources
2. **RunContext layer** gets payload + classification + route info
3. **Visible layers filtered** per agent config
4. **ContextStack.assemble()** builds the prompt blocks

### Source Types to Configure

```
system-prompt     → inline (static text, your core identity)
conventions-src   → file (.foundry/memory, kind=convention)
domain-src        → file (project docs) OR http (API specs) OR supermemory
memory-src        → file (.foundry/memory, kind=*)
learnings-src     → inline (dynamically compiled from corpus)
project-src       → file (README, package.json, tsconfig — per project)
```

---

## Phase 5: Compaction Strategy

As context grows, you need intelligent compression. Use the **HybridStrategy**:

| Trust Range | Strategy | Behavior |
|---|---|---|
| < 0.3 | TrustBased | Evict stale, truncate low-trust layers to 50% |
| 0.3 – 0.7 | LRU | Score by recency (70%) + frequency (30%), compact mid-priority |
| ≥ 0.7 | Summarize | LLM-powered compression to 25% of original, preserve key terms |

**Token budget:** Set based on your model's context window.
- Haiku agents (classifier/router): 4K budget (they only see system + project-context)
- Sonnet agents (executors): 32K budget (they see everything)
- Leave headroom for the actual conversation (at least 50% of context window)

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

// Wire the budget guard hook
hooks.register(budgetGuardHook(tracker));

// Wire the auto-compact hook (compress before dispatching if over budget)
hooks.register(autoCompactHook(hybridStrategy, 32_000));

// Wire plan mode for complex tasks
hooks.register(planModeHook({
  plannerAgentId: "planner",
  triggers: ["complexity", "newDomain"],
  complexityThreshold: 4000,
}));
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
5. Send test messages through the viewer — watch classification, routing, execution
6. **Intervene** on bad classifications/routes — corrections become signals
7. After ~20 interactions, check the learnings layer — it should be accumulating
8. After ~50 interactions, run the distiller manually — see what it extracts
9. After ~100 interactions, check corpus tier promotions — conventions should be solidifying

---

## What "Good" Looks Like

After a few hundred interactions:

- **Conventions layer** has grown from seed → 20+ entries, all from real corrections
- **Learnings layer** has auto-promoted patterns from signal clusters
- **Low-value layers dissolved** — scratch layers that never got used are gone
- **Classification accuracy** improved — fewer operator corrections over time
- **Router confidence** higher — routes are more precise as domain layer fills in
- **Cross-thread patterns detected** — Herald flagged duplications and contradictions
- **Token budget respected** — compaction keeps context under control
- **Trace history shows improvement** — earlier traces have more corrections, later ones fewer

The goal is not a perfect system on day 1. It's a system that's measurably better
on day 30 than day 1, and better on day 90 than day 30. The self-improvement loops
are the whole point.
