# Foundry

> **Gradient descent on documentation** — because you can't do gradient descent on the model.

---

## The Topology of Modern AI Work

There are three layers to AI-assisted work. Two are getting massive investment. One is not.

```mermaid
graph TB
    subgraph "THE THREE LAYERS"
        direction TB
        M["Model<br/><i>The frozen weights —<br/>Claude, GPT, Gemini</i>"]
        H["Harness<br/><i>The tool that wields the model —<br/>Claude Code, Cursor, Windsurf</i>"]
        C["Corpus<br/><i>The context that shapes output —<br/>system prompts, docs, skills, conventions</i>"]

        M --> H --> C
    end

    subgraph "WHO'S IMPROVING EACH"
        M_WHO["Labs (Anthropic, OpenAI, Google)<br/><i>Billions invested, gains plateauing —<br/>each generation brings less delta</i>"]
        H_WHO["Tool companies<br/><i>Real progress — better agents,<br/>better orchestration, better UX</i>"]
        C_WHO["???<br/><i>Tons of heat, not much light</i>"]
    end

    M --- M_WHO
    H --- H_WHO
    C --- C_WHO

    style M fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style H fill:#2d5016,stroke:#4a8c28,color:#fff
    style C fill:#5c1a3a,stroke:#a62e5c,color:#fff
    style M_WHO fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style H_WHO fill:#2d5016,stroke:#4a8c28,color:#fff
    style C_WHO fill:#5c1a3a,stroke:#a62e5c,color:#fff
```

**Model improvements are plateauing.** Labs are spending billions and each generation brings diminishing returns. The step change from GPT-3 to GPT-4 was transformative. The step change from GPT-4 to GPT-5 is incremental.

**Harness improvements are real but generic.** Claude Code, Cursor, Windsurf — these tools are getting dramatically better at wielding models. But they're general-purpose. They don't know your org's conventions, your team's taste, or the lessons you learned last sprint.

**Corpus is where the actual leverage is — and it's a mess.** People are seeing real gains from better prompts, better docs, better skills. But it's artisanal. No standardized skill libraries to start from. No infrastructure for capturing what happens during real work and feeding it back. No way to measure whether a corpus change actually made things better or just felt like it did. Everyone's hand-rolling their CLAUDE.md and hoping for the best.

**In fact, there's growing evidence that most corpus is doing more harm than good.** Research on LLM attention (Liu et al., 2023) shows 30%+ performance degradation when relevant information gets buried in long context. Bloated rules files create exactly this problem. Stale instructions written for older workflows don't fail loudly — they quietly degrade output. Teams pile on rules and see quality drop, not rise. One study found AI-assisted productivity gains averaging just 10–15%, far below the 50% touted — with time saved on boilerplate wiped out reviewing and fixing degraded output. Without measurement, you can't tell if your corpus is helping or hurting. Most people can't. And most people's isn't.

**Foundry is the infrastructure layer for corpus.** Three things that don't exist yet:

1. **Standardized primitives** — a base set of skills, docs, and conventions that work out of the box, so you're not starting from zero
2. **Event capture** — infrastructure for recording, tagging, and classifying everything that happens during normal work — every correction, every question, every redirect
3. **The recursion loop** — a system that turns those captured signals into corpus improvements automatically, measures whether they worked, and rolls them back if they didn't

**Foundry treats corpus as the parameters to optimize — and provides the infrastructure to do it systematically.**

---

## The Vision: A Recursive Improvement Engine

```mermaid
graph TB
    subgraph "THE RECURSION LOOP"
        direction TB
        A["🎯 Define What Good Looks Like<br/><i>Fixtures from real work</i>"] --> B["🤖 Run Agent Against Fixture<br/><i>Controlled simulation</i>"]
        B --> C["⚖️ Oracle Scores the Output<br/><i>5 rubrics, composite score</i>"]
        C --> D["📋 Diagnose What Went Wrong<br/><i>Attribution to specific docs</i>"]
        D --> E["✏️ Update the Corpus<br/><i>System prompt, docs, skills</i>"]
        E --> A
    end

    style A fill:#2d5016,stroke:#4a8c28,color:#fff
    style B fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style C fill:#5c1a3a,stroke:#a62e5c,color:#fff
    style D fill:#5c4a1a,stroke:#a6862e,color:#fff
    style E fill:#1a5c4a,stroke:#2ea686,color:#fff
```

**Each loop makes the system smarter.** Not just the current output — the entire corpus that every future agent session draws from.

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

## Where This Goes: The Unified Workspace

### The Fragmentation Problem

Today, an AI-assisted business operates across a dozen disconnected tools:

```mermaid
graph TB
    subgraph "TODAY: Fragmented"
        direction TB
        LIN["Linear<br/><i>Tasks & sprints</i>"]
        GH["GitHub<br/><i>Code & PRs</i>"]
        NOT["Notion<br/><i>Docs & wikis</i>"]
        SL["Slack<br/><i>Conversations</i>"]
        SF["Salesforce<br/><i>Customer data</i>"]
        HOST["Render / Vercel<br/><i>Infrastructure</i>"]

        LIN ~~~ GH
        GH ~~~ NOT
        NOT ~~~ SL
        SL ~~~ SF
        SF ~~~ HOST
    end

    H["Human"] -->|"context-switches<br/>between apps"| LIN
    H --> GH
    H --> NOT
    AI["AI Agent"] -->|"limited to<br/>one tool at a time"| GH

    style H fill:#2d5016,stroke:#4a8c28,color:#fff
    style AI fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style LIN fill:#444,stroke:#777,color:#fff
    style GH fill:#444,stroke:#777,color:#fff
    style NOT fill:#444,stroke:#777,color:#fff
    style SL fill:#444,stroke:#777,color:#fff
    style SF fill:#444,stroke:#777,color:#fff
    style HOST fill:#444,stroke:#777,color:#fff
```

Decisions live in Slack. Tasks live in Linear. Context lives in Notion. Code lives in GitHub. Customer intent lives in Salesforce. **No single actor — human or AI — can see the full picture.** The AI agent working on a feature can't see the customer conversation that motivated it. The PM approving a spec can't see the technical constraints the agent discovered. The CX team can't see what's shipping next week.

### The Modern AI Business Lifecycle

What does a modern lifecycle actually look like when AI is a full participant?

```mermaid
graph TB
    subgraph "THE LIFECYCLE"
        direction TB
        INTENT["Intent Capture<br/><i>Human expresses what<br/>they want — rough,<br/>unstructured, messy</i>"]
        STRUCT["Structuring<br/><i>AI organizes intent into<br/>actionable form — specs,<br/>tasks, criteria</i>"]
        EXEC["Execution<br/><i>AI does the work —<br/>code, content, analysis,<br/>outreach</i>"]
        REVIEW["Review & Decision<br/><i>Human applies taste<br/>and judgment —<br/>approve, redirect, refine</i>"]
        RECORD["Record & Learn<br/><i>Decisions, outcomes, and<br/>rationale captured in<br/>shared log</i>"]

        INTENT --> STRUCT --> EXEC --> REVIEW --> RECORD
        RECORD -->|"feeds back into<br/>future intent"| INTENT
    end

    style INTENT fill:#2d5016,stroke:#4a8c28,color:#fff
    style STRUCT fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style EXEC fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style REVIEW fill:#2d5016,stroke:#4a8c28,color:#fff
    style RECORD fill:#3a1a5c,stroke:#6e2ea6,color:#fff
```

This lifecycle applies to **every function** — engineering, sales, CX, marketing, research. The content changes but the loop is the same. And critically: **both humans and AI are actors at every stage.** Humans provide intent and taste. AI provides structure and throughput. Both read and write to the same record.

### The Unified Workspace Vision

```mermaid
graph TB
    subgraph "UNIFIED WORKSPACE"
        direction TB

        subgraph "Canonical Record"
            TASKS["Tasks & Decisions<br/><i>What needs doing,<br/>what was decided</i>"]
            CORPUS["Knowledge Corpus<br/><i>How we do things —<br/>patterns, docs, skills</i>"]
            ASSETS["Work Artifacts<br/><i>Code, content, analysis,<br/>proposals — the output</i>"]
        end

        subgraph "Interaction Log"
            HUMAN_LOG["Human Actions<br/><i>Decisions, approvals,<br/>redirects, taste calls</i>"]
            AI_LOG["AI Actions<br/><i>Questions asked, work done,<br/>patterns followed/missed</i>"]
            CROSS["Cross-Reference<br/><i>Every action traces to<br/>intent and outcome</i>"]
        end

        subgraph "Spaces"
            PERSONAL["Personal Space<br/><i>Private scratchpad,<br/>drafts, experiments</i>"]
            TEAM["Team Space<br/><i>Shared context,<br/>visible to the group</i>"]
            CROSS_TEAM["Cross-Team Space<br/><i>Org-wide visibility,<br/>institutional knowledge</i>"]
        end

        TASKS <--> HUMAN_LOG
        TASKS <--> AI_LOG
        CORPUS <--> AI_LOG
        ASSETS <--> HUMAN_LOG
        HUMAN_LOG <--> CROSS
        AI_LOG <--> CROSS

        PERSONAL -->|"promote"| TEAM
        TEAM -->|"promote"| CROSS_TEAM
    end

    BOTH["Humans & AI<br/><i>First-class actors —<br/>same data, same actions,<br/>same record</i>"]
    BOTH --> TASKS
    BOTH --> CORPUS
    BOTH --> ASSETS

    FOUNDRY_ENGINE["Foundry Recursion Engine<br/><i>Watches outcomes,<br/>generates fixtures from<br/>real interactions,<br/>improves the corpus</i>"]

    CROSS --> FOUNDRY_ENGINE
    FOUNDRY_ENGINE --> CORPUS

    style TASKS fill:#2d5016,stroke:#4a8c28,color:#fff
    style CORPUS fill:#2d5016,stroke:#4a8c28,color:#fff
    style ASSETS fill:#2d5016,stroke:#4a8c28,color:#fff
    style HUMAN_LOG fill:#5c4a1a,stroke:#a6862e,color:#fff
    style AI_LOG fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style CROSS fill:#3a1a5c,stroke:#6e2ea6,color:#fff
    style PERSONAL fill:#444,stroke:#777,color:#fff
    style TEAM fill:#444,stroke:#777,color:#fff
    style CROSS_TEAM fill:#444,stroke:#777,color:#fff
    style BOTH fill:#2d5016,stroke:#4a8c28,color:#fff
    style FOUNDRY_ENGINE fill:#5c1a3a,stroke:#a62e5c,color:#fff
```

### What Makes This Different From "Just Another Platform"

The unified workspace isn't Notion + Linear + GitHub bolted together. The key differences:

**1. Humans and AI are co-equal actors.** Both can read the data, take actions, and record decisions — in the same interface, in the same log. Not "AI does things in the background and humans see a dashboard." Both operate on the same canonical record.

**2. The interaction log is the institutional memory.** Every decision, every question an AI asked, every redirect a human made — all captured, cross-referenced, and queryable. When someone new joins the team, they don't read stale wiki pages — they see the living log of how decisions were actually made.

**3. Personal and shared spaces with promotion.** You can draft something in your personal space and promote it to team-visible when it's ready. The boundary between private exploration and shared knowledge is fluid, not a wall. This mirrors how real work happens — you noodle on something privately before sharing it.

**4. Personal agents as queryable proxies.** The personal layer isn't just a config file — it's a **queryable agent** for each person and team.

```mermaid
graph LR
    subgraph "BEFORE INTERRUPTING ARON"
        Q["Agent needs<br/>a decision"] --> PA["Aron's Agent<br/><i>Public: role, expertise,<br/>conventions maintained</i><br/><i>Private: preferences,<br/>style, past decisions</i>"]
        PA -->|"confident"| ANS["Answer on<br/>Aron's behalf"]
        PA -->|"uncertain"| ESC["Escalate to<br/>the real Aron"]
    end

    style Q fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style PA fill:#5c4a1a,stroke:#a6862e,color:#fff
    style ANS fill:#2d5016,stroke:#4a8c28,color:#fff
    style ESC fill:#5c1a3a,stroke:#a62e5c,color:#fff
```

Each personal agent maintains two layers of context:

- **Public** — role, expertise areas, conventions they maintain, decisions they've made that others can reference. Visible to the team.
- **Private** — personal preferences, working style, shortcuts, opinions. Visible only to the individual. Gitignored.

The system queries your agent before querying you. Over time, as it captures your corrections and redirects, it handles more decisions autonomously — reducing interruptions while preserving your taste and judgment. Eventually, your agent doesn't just answer questions on your behalf — it acts on your behalf, carrying your taste and context into autonomous work. Privacy is built in: you control what's public and what stays private.

**5. The recursion engine sits underneath.** This is where Foundry comes in. The interaction log is a continuous stream of potential fixtures:

```mermaid
graph LR
    subgraph "FIXTURE GENERATION"
        INT["Real Interaction<br/><i>AI built a feature,<br/>human corrected it</i>"]
        DETECT["Pattern Detection<br/><i>This correction maps to<br/>a missing corpus entry</i>"]
        FIX["Auto-Generated Fixture<br/><i>Task + corpus state +<br/>what good looks like</i>"]
        TEST["Regression Test<br/><i>Does the corpus update<br/>actually fix it?</i>"]

        INT --> DETECT --> FIX --> TEST
        TEST -->|"validated"| PROMOTE["Promoted to<br/>Fixture Suite"]
        TEST -->|"failed"| DETECT
    end

    style INT fill:#5c4a1a,stroke:#a6862e,color:#fff
    style DETECT fill:#1a3a5c,stroke:#2e6ba6,color:#fff
    style FIX fill:#2d5016,stroke:#4a8c28,color:#fff
    style TEST fill:#3a1a5c,stroke:#6e2ea6,color:#fff
    style PROMOTE fill:#2d5016,stroke:#4a8c28,color:#fff
```

Every time a human corrects an AI, that's a signal. The system asks: "What context was missing that caused this? Can I turn this into a fixture so I catch it next time?" Over time, the fixture suite grows organically from real work — not from engineers manually authoring test cases.

### Beyond Software Engineering

The core abstraction — **task + corpus + definition of good** — is domain-agnostic:

| Domain | Task | Corpus | "Good" (Fixture) |
|--------|------|--------|-------------------|
| **Engineering** | "Add a projects endpoint" | CLAUDE.md, API docs, conventions | Golden implementation + assertions |
| **Sales** | "Draft proposal for Acme Corp" | Playbooks, case studies, pricing | Closed-won proposal that converted |
| **Customer Success** | "Respond to billing escalation" | KB articles, tone guide, policies | Response that resolved the ticket |
| **Content** | "Write launch blog post" | Brand guide, style docs, audience profiles | Published post that hit metrics |
| **Research** | "Analyze competitor pricing" | Market data, frameworks, prior analyses | Analysis that drove a decision |

In each case: the AI does the work, the human applies taste and judgment, the system records what happened, and the recursion engine asks "what would have made this better?" **The substrate doesn't matter** — git for code, a CRM for sales, a help desk for CX. Foundry provides the recursion pattern; adapters connect it to wherever the work actually lives.

### The Convergence

```mermaid
graph TB
    subgraph "THE CONVERGENCE"
        direction LR
        TODAY["Today:<br/>Foundry for code"]
        NEXT["Next:<br/>Foundry for any<br/>knowledge work"]
        END["End state:<br/>Unified workspace<br/>with embedded recursion"]

        TODAY -->|"prove the pattern<br/>in software"| NEXT
        NEXT -->|"generalize the<br/>substrate"| END
    end

    subgraph "What Each Stage Proves"
        P1["Software fixtures work,<br/>corpus improvement is<br/>measurable"]
        P2["The pattern transfers —<br/>any task + corpus +<br/>definition of good"]
        P3["Humans and AI as<br/>co-equal actors in a<br/>single system that<br/>gets smarter over time"]
    end

    TODAY --- P1
    NEXT --- P2
    END --- P3

    style TODAY fill:#2d5016,stroke:#4a8c28,color:#fff
    style NEXT fill:#5c4a1a,stroke:#a6862e,color:#fff
    style END fill:#5c1a3a,stroke:#a62e5c,color:#fff
    style P1 fill:#2d5016,stroke:#4a8c28,color:#fff
    style P2 fill:#5c4a1a,stroke:#a6862e,color:#fff
    style P3 fill:#5c1a3a,stroke:#a62e5c,color:#fff
```

**Foundry starts as the recursion engine for code.** But the architecture is designed so that the same core — fixture-based evaluation, corpus optimization, interaction logging — can wrap around any AI-assisted workflow. The unified workspace is where it all converges: one place where humans guide taste and intent, AI does the work, both record their actions, and the system continuously improves from every interaction.

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

---

## The Factory Director Metaphor

```mermaid
graph TB
    subgraph "TRADITIONAL"
        ENG1["Engineer"] -->|"writes code"| CODE1["Code"]
        CODE1 -->|"manual review"| QUAL1["Quality?<br/><i>¯\\_(ツ)_/¯</i>"]
    end

    subgraph "WITH DELPHI"
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

## Summary

| What | Why |
|------|-----|
| **Recursion harness** | Systematic improvement instead of vibes-based tweaking |
| **Three-agent isolation** | Honest evaluation — no information leakage |
| **Five scoring rubrics** | Multi-dimensional quality measurement with attribution |
| **Corpus layering** | Global + project + personal, with immutable snapshots |
| **Hivemind integration** | Every decision point logged for diagnosis |
| **Beyond software** | The pattern works for any task + corpus + quality definition |
| **Unified platform** | GitHub + ticketing + knowledge base + interaction log, with Foundry as the improvement engine |

> **The thesis:** The teams that systematically improve their AI context — treating prompts and docs as optimizable parameters with measurable outcomes — will dramatically outperform teams that rely on intuition. Foundry is the engine that makes that systematic improvement possible.
