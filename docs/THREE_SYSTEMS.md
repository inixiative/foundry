# Foundry Three-System Architecture

## The Split

Three composable systems. Each can exist independently. Higher layers depend on lower ones.

```
┌─────────────────────────────────────────────────┐
│  3. Foundry Oracle (closed service)             │
│     Eval engine, fixtures, improvement proposals │
│     BYOI: uses YOUR keys, YOUR repos            │
├─────────────────────────────────────────────────┤
│  2. Foundry (open, opinionated)                 │
│     Active Memory, Corpus Compiler, Herald,      │
│     Viewer/Analytics, Settings, AI Assist        │
├─────────────────────────────────────────────────┤
│  1. @foundry/primitives (open, MIT/Apache 2.0)  │
│     Context, Agents, Middleware, Signals, Traces, │
│     Providers, Adapters, Hooks, TokenTracker     │
└─────────────────────────────────────────────────┘
```

---

## System 1: @foundry/primitives

**What:** The generic agent orchestration framework. No opinions about how you
use it. Like Express is to web frameworks — you wire it yourself.

**License:** Apache 2.0 (max adoption)

**Files (from current repo):**

```
src/agents/
  base-agent.ts          115 lines   # BaseAgent, ExecutionResult, AgentLLMConfig
  executor.ts             39 lines   # Executor
  decider.ts              50 lines   # Decider, Decision
  classifier.ts           36 lines   # Classifier, Classification
  router.ts               34 lines   # Router, Route
  planner.ts             272 lines   # Planner, Plan, PlanStep
  context-layer.ts       216 lines   # ContextLayer, LayerState
  context-stack.ts       231 lines   # ContextStack, AssembledContext
  cache-lifecycle.ts     187 lines   # CacheLifecycle, LifecycleRule
  middleware.ts          107 lines   # MiddlewareChain, DispatchContext
  signal.ts              118 lines   # SignalBus, Signal, SignalKind
  thread.ts              229 lines   # Thread, Dispatch, FanResult
  session.ts             321 lines   # SessionManager, ThreadBlueprint
  harness.ts             227 lines   # Harness, Message, HarnessResult
  trace.ts               259 lines   # Trace, Span, TraceSummary
  event-stream.ts         89 lines   # EventStream, StreamEvent
  intervention.ts        133 lines   # InterventionLog, Intervention
  hydrator.ts            148 lines   # HydrationRegistry, RefSource
  hooks.ts               360 lines   # HookRegistry, 16 HookPoints
  token-tracker.ts       459 lines   # TokenTracker, BudgetConfig, cost tables
  compaction.ts          410 lines   # 4 strategies (trust, LRU, summarize, hybrid)

src/providers/
  types.ts               143 lines   # LLMProvider, CompletionResult, streaming
  anthropic.ts           269 lines   # AnthropicProvider + streaming
  openai.ts              309 lines   # OpenAIProvider + streaming
  gemini.ts              310 lines   # GeminiProvider + streaming
  runtime.ts             384 lines   # RuntimeAdapter, ClaudeCode/Codex/Cursor

src/adapters/
  file-memory.ts         197 lines   # FileMemory
  sqlite-memory.ts       188 lines   # SqliteMemory
  redis-memory.ts        196 lines   # RedisMemory
  postgres-memory.ts     307 lines   # PostgresMemory
  http-memory.ts         139 lines   # HttpMemory
  markdown-docs.ts       133 lines   # MarkdownDocs
```

**Total: ~6,400 lines production code**

**What it gives you:**
- Build any agent composition (classify → route → dispatch)
- Any LLM provider with streaming and cost tracking
- Context management with compaction and budget enforcement
- Middleware, signals, tracing, sessions
- Zero opinions about what agents do or how context is organized

---

## System 2: Foundry

**What:** Opinionated composition of primitives for the specific Foundry vision.
This is where the Cartographer, Librarian, Guardians, Herald, Active Memory,
and Corpus Compiler live. Also the operator UI.

**License:** Source-available or open (your call — this is the product layer)

**Files (from current repo):**

```
src/agents/
  herald.ts              769 lines   # Herald, 5 PatternDetectors
  active-memory.ts       367 lines   # ActiveMemory (Levin-inspired)
  corpus-compiler.ts     467 lines   # CorpusCompiler, 3-stage pipeline

src/viewer/
  server.ts              354 lines   # Hono REST/WS server
  actions.ts             250 lines   # ActionHandler (operator commands)
  config.ts              277 lines   # ConfigStore (settings persistence)
  ai-assist.ts           268 lines   # AIAssist (LLM-powered config help)
  analytics.ts           367 lines   # AnalyticsStore (cost tracking)

src/viewer/ui/
  *.js                 2,127 lines   # Preact UI (12 components)
  styles.css           1,428 lines   # Dark monospace theme
  index.html              13 lines   # HTML shell
```

**Total: ~6,700 lines production code**

**What it gives you (on top of primitives):**
- Herald cross-agent coordination
- Active memory with trust competition and dissolution
- Three-stage corpus pipeline (fluid → formal → compiled)
- Full operator UI with analytics, settings, hotkeys
- The "Foundry way" of composing agents

**Instantiations (config, not code — these are just wiring):**
- **Cartographer** = Router with full context visibility
- **Librarian** = Classifier(correction|convention|taste|...) → Router
- **Guardians** = Decider<boolean> per concern (conventions, security, API contracts)
- **Domain Executors** = Executor with LayerFilter per context slice

---

## System 3: Foundry Oracle

**What:** The evaluation and improvement engine. This is the service.

**License:** Proprietary / hosted

**Files (from current repo):**

```
src/eval/
  types.ts               226 lines   # PRFixture, EvalRun, rubrics
  runner.ts              321 lines   # FixtureRunner, batch comparison
  scorer.ts              352 lines   # DiffScorer, LLMScorer
  diagnoser.ts           449 lines   # HeuristicDiagnoser, LLMDiagnoser
  store.ts               452 lines   # EvalStore, regression tracking
  github-fixtures.ts     245 lines   # GitHubFixtureSource
```

**Total: ~2,100 lines production code**

---

## The BYOI Model (Bring Your Own Infrastructure)

The Oracle does NOT host your agents, your LLMs, or your corpus.

```
┌─────────────────────────────────────────────────┐
│ YOUR INFRASTRUCTURE                              │
│                                                  │
│  Your Repo ←──── Oracle writes PRs/proposals     │
│    ├── .foundry/                                 │
│    │   ├── fixtures/        (test cases)         │
│    │   ├── corpus/          (compiled context)   │
│    │   ├── settings.json    (agent configs)      │
│    │   └── analytics/       (usage data)         │
│    ├── CLAUDE.md            (system prompt)       │
│    └── docs/                (conventions, ADRs)   │
│                                                  │
│  Your LLM Keys ──→ Oracle uses them for evals    │
│  Your Claude Code / Cursor ──→ runs agents       │
│                                                  │
├──────────────────────────────────────────────────┤
│ ORACLE SERVICE (what we host)                    │
│                                                  │
│  1. Fixture Generation                           │
│     - Reads merged PRs from your repo            │
│     - Extracts golden diffs + ticket context     │
│     - Writes fixtures to .foundry/fixtures/      │
│                                                  │
│  2. Evaluation Runs                              │
│     - Reads your corpus + fixtures               │
│     - Runs Implementer against fixtures           │
│     - Scores with DiffScorer + LLMScorer         │
│     - Diagnoses with HeuristicDiagnoser          │
│     - Uses YOUR LLM keys (BYOI)                  │
│                                                  │
│  3. Improvement Proposals                        │
│     - Identifies context gaps                    │
│     - Suggests corpus additions                  │
│     - Proposes config changes                    │
│     - Opens PRs into YOUR repo                   │
│                                                  │
│  4. Regression Tracking                          │
│     - Stores eval history (our DB)               │
│     - Compares runs over time                    │
│     - Alerts on regressions                      │
│     - Trend analysis (are you improving?)        │
│                                                  │
└──────────────────────────────────────────────────┘
```

### What the Oracle Hosts (Minimal)

| Component | Why We Host It |
|-----------|---------------|
| **Eval history DB** | Cross-run comparisons, trend analysis, regression alerts |
| **Fixture index** | Deduplication across repos, complexity classification |
| **Webhook receiver** | Triggered by merged PRs to generate new fixtures |
| **Job runner** | Orchestrates eval runs (but LLM calls use user's keys) |
| **Dashboard** | Shows eval trends, regressions, gaps across runs |

### What Lives in the User's Repo

Everything that matters:

```
.foundry/
  settings.json           # Agent configs, provider keys, model selection
  corpus/
    compiled.json         # Latest compiled corpus snapshot (immutable, hashed)
    formal/               # Formal docs (conventions, ADRs, skills)
    fluid/                # Raw signals awaiting promotion
  fixtures/
    batch_001.json        # Test cases generated from merged PRs
    batch_002.json
    index.json            # Fixture metadata and regression baselines
  analytics/
    calls.jsonl           # Token usage history
```

### How the Oracle Interacts

```
1. PR merges on user's repo
   ↓
2. Webhook fires to Oracle
   ↓
3. Oracle reads PR → generates fixture
   ↓
4. Oracle writes fixture to .foundry/fixtures/ (via PR or direct push)
   ↓
5. Oracle runs eval: reads corpus + fixture, calls LLM (user's keys)
   ↓
6. Oracle scores and diagnoses
   ↓
7. If context gap found:
   Oracle proposes corpus change as PR into user's repo
   ↓
8. User reviews/merges corpus improvement
   ↓
9. Next eval run: scores should improve (regression tracked)
```

### The Key Insight: Repo as Source of Truth

The user's `.foundry/` directory IS the state. Not our database. Our database
just tracks eval history for trend analysis. If the user stops paying, they
keep everything — their corpus, fixtures, configs, analytics. They just lose
the automated eval loop.

This is important for trust: "We don't hold your data hostage."

---

## Pricing Model

| Tier | What | $/mo |
|------|------|------|
| **Open Source** | Primitives + Foundry (self-serve) | Free |
| **Starter** | Oracle: 100 eval runs/mo, 5 fixtures/PR, basic regression alerts | $49/mo |
| **Growth** | Oracle: 1000 eval runs/mo, unlimited fixtures, trend analysis, gap suggestions | $149/mo |
| **Team** | Multi-repo, team corpus promotion, Herald coordination across repos | $499/mo |

**Cost structure for us:**
- We DON'T pay for LLM calls (user's keys)
- We DO pay for: eval history DB, webhook infrastructure, job runner compute
- Main cost driver: job runner compute during eval runs (CPU, not GPU)
- Estimated cost per eval run: ~$0.001-0.01 (our infrastructure only)

---

## Migration Path from Current Monorepo

### Phase 1: Logical Split (now)
Keep one repo but organize with clear boundaries:
```
packages/
  primitives/     # System 1
  foundry/        # System 2
  oracle/         # System 3
```

### Phase 2: Package Split
Publish `@foundry/primitives` as npm package.
Foundry imports from `@foundry/primitives`.
Oracle imports from both.

### Phase 3: Repo Split
Three repos:
- `inixiative/foundry-primitives` (open)
- `inixiative/foundry` (open/source-available)
- `inixiative/foundry-oracle` (private)

### What Needs to Change for Split
1. **Primitives** have zero imports from Foundry or Oracle ✓ (already true)
2. **Foundry** imports only from Primitives ✓ (already true — herald, active-memory, corpus-compiler only import from agents/)
3. **Oracle** imports from Primitives (eval types, providers) ✓ (already true)
4. Need to extract viewer → Foundry package
5. Need to extract eval → Oracle package
6. Adapters could go in either Primitives or Foundry (they're generic enough for Primitives)

---

## Hivemind V2 Integration Point

When Hivemind V2 is ready, it becomes an **optional backend** for:
- Herald snapshot storage (currently in-memory)
- Cross-repo Herald coordination (Team tier)
- Corpus promotion across team members
- Signal persistence across sessions

The Herald interface is already designed for this — swap the snapshot
capture and injection mechanism without changing the pattern detectors.

---

## API Key Security

**We never store user LLM keys.** Keys are passed per-run and used only for
that execution. Two implementation options:

1. **CLI / GitHub Action** — keys come from environment variables or CI secrets.
   Oracle reads them at runtime, uses them for LLM calls, discards.
2. **OAuth delegation** — if providers ever support scoped OAuth tokens for
   third-party eval runs. Not available today, but the interface is ready.

The trust pitch: "Your keys are never stored. They exist in memory for the
duration of one eval run, then they're gone."

---

## Feedback Channels

Running agents and users feed pain directly to the Oracle through the
existing capture system. No separate infrastructure needed.

### Agent Feedback

```typescript
// Agent hits missing context → emits escalation signal
signals.emit({
  kind: "escalation",
  source: agentId,
  content: {
    type: "missing_context",
    description: "No convention for error handling in auth module",
    attempted: "looked in docs/conventions/errors.md",
    impact: "guessed at pattern, low confidence",
  },
  confidence: 0.3,
});
```

### User Feedback

The viewer has an intervention system — click any span, submit a correction.
These become high-priority fluid entries in the corpus compiler.

### How It Flows to Oracle

```
During session:
  Agent overrides convention → SignalBus emits "correction"
  User intervenes → InterventionLog records correction
  Both auto-ingested → .foundry/corpus/fluid/*.json (CorpusCompiler)

Between sessions:
  Oracle reads .foundry/corpus/fluid/
  Aggregates: "convention X overridden 47 times across 12 sessions"
  Proposes: "deprecate convention X" or "rewrite convention X" as PR
```

The capture system IS the feedback channel. The Oracle just reads the repo.

---

## What's Defensible

The code is NOT the moat. Anyone can rebuild 2,100 lines of TypeScript.

**What IS defensible:**

| Asset | Why It's Hard to Copy |
|-------|----------------------|
| **Scoring calibration** | Cross-customer data: "across 500 repos, when completion drops below X, the gap is Y" |
| **Diagnosis → proposal mappings** | Feedback loop: which proposals actually improved scores after merge? |
| **Fixture cross-pollination** | Anonymized patterns across customers: "companies in your industry fail on X" |
| **Proposal effectiveness tracking** | The Oracle improves its own suggestions based on measured outcomes |
| **Ecosystem gravity** | @foundry/primitives adoption → Oracle is the natural paid layer |

**Moat timeline:**
- Month 0-6: Code is defensible enough (nobody's copying yet)
- Month 6-12: Calibration data is defensible (hundreds of runs, they have zero)
- Month 12+: Network effects are defensible (cross-customer patterns, ecosystem)
