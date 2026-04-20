# Foundry Architecture

> Implementation details for the [Foundry vision](./PROPOSAL.md).

---

## How It Works: Oracle Eval Team + Isolated Artificer

```mermaid
graph LR
    subgraph "ORCHESTRATOR"
        O["Orchestrator<br/><i>Coordinates the run</i>"]
    end

    subgraph "FIXTURE"
        F["Task + Golden Diff + Review Q&A<br/><i>The fixture itself carries<br/>domain knowledge — no separate<br/>Subject agent needed</i>"]
    end

    subgraph "ARTIFICER UNDER TEST — Isolated Worktree"
        A["Artificer<br/><i>The user's own harness agent,<br/>run against the fixture</i>"]
        AC["System prompt + docs + skills<br/><i>The corpus being tested</i>"]
        A --- AC
    end

    subgraph "ORACLE EVAL TEAM"
        ST["Steward<br/><i>Bodyguard — enforces isolation<br/>via git worktrees/branches,<br/>brokers fixture access</i>"]
        OR["Oracle<br/><i>Judge — sees golden + rubrics,<br/>scores output, diagnoses root causes</i>"]
        OC["Golden implementation<br/>+ assertions + rubrics"]
        OR --- OC
    end

    O -->|"terse prompt"| A
    F -->|"task + review Q&A<br/>(brokered by Steward)"| A
    ST -->|"enforces isolation"| A
    A -->|"produces output"| OR
    OR -->|"scores + diagnosis"| O

    style F fill:#8b6914,stroke:#c49a1a,color:#fff
    style A fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style ST fill:#3a1a5c,stroke:#6e2ea6,color:#fff
    style OR fill:#5c1a3a,stroke:#a62e5c,color:#fff
    style O fill:#333,stroke:#666,color:#fff
```

| Agent | Role | Sees | Key Signal |
|-------|------|------|------------|
| **Artificer (under test)** | The user's own harness agent, running in an isolated worktree | Clean codebase + the corpus being evaluated | Produces the work output |
| **Steward** | Bodyguard / integrity-enforcer for the Oracle team | Fixture metadata + isolation topology | Prevents the Artificer from peeking at the golden; enforces chain-of-custody |
| **Oracle** | Judge | Golden implementation + rubrics | Scores output, diagnoses root causes |

The agent-under-test is the user's own **Artificer** — the Oracle team doesn't own one; it just spins one up against the fixture.

**Physical isolation via git worktrees/branches** — the Steward enforces that each agent sees only its branch. No credential tricks, no instruction-based scoping. The Artificer can't peek at the golden answer.

---

## The Five Scoring Rubrics

```mermaid
graph TD
    subgraph "COMPOSITE SCORE"
        PE["Prompt Efficiency<br/><b>Meta: scores the docs</b><br/><i>quality ÷ tokens</i>"]
        CO["Completion<br/><b>How far did it get?</b><br/><i>subtasks completed</i>"]
        DE["Demerits<br/><b>What rules did it break?</b><br/><i>driving-test style</i>"]
        CR["Craft<br/><b>How good is the code?</b><br/><i>pattern adherence</i>"]
        QU["Questioning<br/><b>Did it ask the right things?</b><br/><i>requirements gathering</i>"]
    end

    PE --> SCORE["Ceiling-Reduction<br/>Composite Score"]
    CO --> SCORE
    DE --> SCORE
    CR --> SCORE
    QU --> SCORE

    style PE fill:#2d5016,stroke:#4a8c28,color:#fff
    style CO fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style DE fill:#5c1a1a,stroke:#a62e2e,color:#fff
    style CR fill:#3a1a5c,stroke:#6e2ea6,color:#fff
    style QU fill:#1a5c4a,stroke:#2ea686,color:#fff
    style SCORE fill:#333,stroke:#666,color:#fff
```

**Prompt Efficiency is the meta-score** — it measures the docs, not the agent. If two doc variants produce the same quality output but one uses 3x fewer tokens, the shorter one scores 3x better. This creates constant pressure to make docs concise and modular.

---

## The Corpus Architecture: Three Layers

```mermaid
graph TB
    subgraph "EFFECTIVE CORPUS (per run)"
        direction TB
        G["Global Layer<br/><i>Foundry-managed baseline</i><br/><i>Shared across all projects</i>"]
        P["Project Layer<br/><i>Repo-specific corpus</i><br/><i>Evolves per project</i>"]
        L["Personal Layer<br/><i>Individual preferences</i><br/><i>Gitignored, local only</i>"]

        G --> MERGE["Merge + Compile"]
        P --> MERGE
        L --> MERGE
        MERGE --> SNAP["Immutable Snapshot<br/><i>Hash stored per run</i><br/><i>Full reproducibility</i>"]
    end

    style G fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style P fill:#2d5016,stroke:#4a8c28,color:#fff
    style L fill:#5c4a1a,stroke:#a6862e,color:#fff
    style SNAP fill:#333,stroke:#666,color:#fff
    style MERGE fill:#444,stroke:#777,color:#fff
```

Each layer contains: **system prompt + docs + rules + skills**

Every run compiles these into an immutable snapshot with a content hash — so you can reproduce any run exactly and attribute score changes to specific corpus modifications.

---

## The Factory Director Metaphor

```mermaid
graph TB
    subgraph "TRADITIONAL"
        ENG1["Engineer"] -->|"writes code"| CODE1["Code"]
        CODE1 -->|"manual review"| QUAL1["Quality?<br/><i>¯\\_(ツ)_/¯</i>"]
    end

    subgraph "WITH FOUNDRY"
        DIR["Factory Director<br/><i>(Engineer)</i>"]
        DIR -->|"defines what good<br/>looks like"| FIXTURE["Fixtures"]
        DIR -->|"tunes the<br/>production line"| CORPUS["Corpus<br/><i>prompts, docs, skills</i>"]

        FIXTURE --> ENGINE["Foundry Engine"]
        CORPUS --> ENGINE
        ENGINE -->|"runs agents,<br/>scores output"| METRICS["Measurable Quality<br/><i>Composite scores,<br/>attribution, trends</i>"]
        METRICS -->|"diagnosis feeds<br/>back into corpus"| CORPUS
    end

    style DIR fill:#2d5016,stroke:#4a8c28,color:#fff
    style ENGINE fill:#5c1a3a,stroke:#a62e5c,color:#fff
    style METRICS fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style FIXTURE fill:#5c4a1a,stroke:#a6862e,color:#fff
    style CORPUS fill:#3a1a5c,stroke:#6e2ea6,color:#fff
```

**The engineer's job shifts** from writing code to defining quality standards and tuning the system that produces code. Each improvement compounds — one person's better skill or doc benefits every future agent session across the entire team.

---

## What's Built Today

```mermaid
graph LR
    subgraph "IMPLEMENTED ✓"
        API["API + Dashboard<br/><i>Projects, fixtures,<br/>feedback, oracle</i>"]
        DB["SQLite Schema<br/><i>Full data model</i>"]
        CLI["CLI Commands<br/><i>init-project, start-round</i>"]
        WORK["Run Worker<br/><i>Coordinated mode:<br/>Artificer (isolated) + Steward + Oracle</i>"]
        HIV["Per-Run Hivemind<br/><i>Role-scoped auth,<br/>channel ACLs</i>"]
        GIT["Git Isolation<br/><i>Role-isolated workspaces,<br/>per-role branches</i>"]
    end

    subgraph "IN PROGRESS"
        FIX["Canonical Smoke Fixture"]
        INJ["System Prompt Injector"]
        SKL["Internal Skill Stubs"]
        FB["Auto Feedback Ingestion"]
        CRP["Corpus Layering"]
    end

    subgraph "NEXT"
        ECC["Effective Corpus Compiler"]
        OBS["Compaction Metrics"]
        PROM["Promotion Workflow"]
        CLD["Cloud Deploy"]
    end

    API --> FIX
    WORK --> FIX
    FIX --> ECC
    INJ --> ECC

    style API fill:#2d5016,stroke:#4a8c28,color:#fff
    style DB fill:#2d5016,stroke:#4a8c28,color:#fff
    style CLI fill:#2d5016,stroke:#4a8c28,color:#fff
    style WORK fill:#2d5016,stroke:#4a8c28,color:#fff
    style HIV fill:#2d5016,stroke:#4a8c28,color:#fff
    style GIT fill:#2d5016,stroke:#4a8c28,color:#fff
    style FIX fill:#5c4a1a,stroke:#a6862e,color:#fff
    style INJ fill:#5c4a1a,stroke:#a6862e,color:#fff
    style SKL fill:#5c4a1a,stroke:#a6862e,color:#fff
    style FB fill:#5c4a1a,stroke:#a6862e,color:#fff
    style CRP fill:#5c4a1a,stroke:#a6862e,color:#fff
    style ECC fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style OBS fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style PROM fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style CLD fill:#1a3a5c,stroke:#2e6ba6,color:#fff
```

---

## Primitive Coverage for Agent Roles

| Defined Role | Primitive | Status |
|-------------|-----------|--------|
| Artificer (executor / agent under test) | Executor — takes context + payload, produces output | Ready |
| Oracle (judge) | LLMScorer + HeuristicDiagnoser + LLMDiagnoser | Ready |
| Steward (isolation / fixture broker for Oracle evals) | Worktree/branch isolation + fixture chain-of-custody | Planned |
| The Cartographer | Router with full context visibility + contextSlice | Ready |
| The Librarian (signal reconciliation) | Classifier → Router pipeline (Harness classify→route) | Ready |
| Wardens (advise + guard per domain) | Decider<boolean> per concern (conventions, security, etc.) | Primitive ready, config-driven instances live |
| Herald (cross-agent observation) | Herald class with 5 PatternDetectors | Ready |
| Artificer execution layer (per-domain context slicing) | Executor with LayerFilter per context slice | Ready |
| Planner (plan mode) | Planner agent + planModeHook auto-shunt | Ready |

---

## New Primitives (Since Initial Architecture)

- **Herald** — cross-agent observation with snapshot-based coordination. 5 detectors: duplication, contradiction, convergence, cross-pollination, resource imbalance. Operates on frozen ThreadSnapshots, stateless, read-many write-none.
- **Corpus Compiler** — Three-stage pipeline: fluid entries (raw signals) → formal docs (conventions, ADRs, skills with lifecycle states) → compiled corpus (immutable, hashed, token-optimized). Supports tier promotion: personal → team → org.
- **Token Tracker** — Per-provider/model/agent cost accounting with budget enforcement and analytics.
- **Lifecycle Hooks** — 16 hook points (pre/post dispatch, classify, route, session events, budget events, plan mode). Built-in hooks: planModeHook, budgetGuardHook.
- **Streaming** — AsyncGenerator<LLMStreamEvent> for Anthropic, OpenAI, Gemini providers.
- **Analytics** — First-class cost tracking with time-series rollups, thread costs, model rankings.
- **Planner Agent** — Generates execution plans with dependency-ordered steps, dispatches to agents, tracks results.

---

## Three-System Split

- The codebase is designed for eventual split into: @foundry/primitives (open), Foundry (opinionated), Foundry Oracle (service)
- See docs/THREE_SYSTEMS.md for full details
- Dependencies are already unidirectional: primitives ← foundry ← oracle
