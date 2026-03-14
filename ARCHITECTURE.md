# Foundry Architecture

> Implementation details for the [Foundry vision](./PROPOSAL.md).

---

## How It Works: Three Agents, Three Perspectives

```mermaid
graph LR
    subgraph "ORCHESTRATOR"
        O["Orchestrator<br/><i>Coordinates the run</i>"]
    end

    subgraph "SUBJECT — The Vague PM"
        S["Subject Agent"]
        SC["subject-context.md<br/><i>Q&A pairs — only reveals<br/>answers when asked</i>"]
        S --- SC
    end

    subgraph "IMPLEMENTER — Agent Under Test"
        I["Implementer Agent"]
        IC["System prompt + docs + skills<br/><i>The corpus being tested</i>"]
        I --- IC
    end

    subgraph "ORACLE — The Judge"
        OR["Oracle Agent"]
        OC["Golden implementation<br/>+ assertions + task map"]
        OR --- OC
    end

    O -->|"terse prompt"| I
    I <-->|"asks questions"| S
    I -->|"produces output"| OR
    OR -->|"scores + diagnosis"| O

    style S fill:#8b6914,stroke:#c49a1a,color:#fff
    style I fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style OR fill:#5c1a3a,stroke:#a62e5c,color:#fff
    style O fill:#333,stroke:#666,color:#fff
```

| Agent | Role | Sees | Key Signal |
|-------|------|------|------------|
| **Subject** | Vague PM | Domain knowledge (Q&A pairs) | Doesn't volunteer info — only answers when asked |
| **Implementer** | Agent under test | Clean codebase + the corpus being evaluated | Produces the work output |
| **Oracle** | Judge | Golden implementation + rubrics | Scores output, diagnoses root causes |

**Physical isolation via git branches** — each agent sees only its branch. No credential tricks, no instruction-based scoping. The Implementer can't peek at the golden answer.

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
        WORK["Run Worker<br/><i>Coordinated mode:<br/>Implementer + Subject + Oracle</i>"]
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
