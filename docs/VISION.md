# Foundry — Unified Vision Document

*Internal strategy document. March 2026.*

---

## 1. The Problem

Every time an AI agent starts a task, it re-learns what you already taught it. Your conventions, your architecture decisions, your taste — none of it persists reliably. You correct the same mistake on Tuesday that you corrected on Monday. This is the re-alignment tax: the continuous cost of steering AI agents back to what "good" means in your specific context. The tax scales with team size, codebase complexity, and agent autonomy. Today, teams pay it through hand-maintained CLAUDE.md files, scattered system prompts, and vibes. There's no measurement, no feedback loop, and no way to know if your documentation is helping or actively degrading output. Research confirms the problem is real: instruction-following success decays exponentially with rule count (GPT-4o follows 10 simultaneous instructions just 15% of the time), and adding full conversation history drops accuracy by 30% compared to focused context windows. Stale rules don't fail loudly — they quietly degrade everything around them.

---

## 2. The Three Layers

There are three layers to AI-assisted work:

**Model** — The frozen weights. Claude, GPT, Gemini. Labs spend billions here. Gains are plateauing. The delta from GPT-4 to GPT-5 is incremental compared to GPT-3 to GPT-4. You can't change these weights. They're someone else's parameter space.

**Harness** — The tool that wields the model. Claude Code, Cursor, Windsurf. Real progress happening here — better agents, better orchestration, better UX. But harnesses are general-purpose. They don't know your org's conventions, your team's taste, or the lessons from last sprint.

**Corpus** — The context that shapes output. System prompts, docs, skills, conventions, interaction history. This is where the actual leverage is, and it's a mess. No standardized primitives. No capture infrastructure. No way to measure whether a corpus change helped or hurt. Everyone hand-rolls their documentation and hopes for the best.

**Where Foundry sits:** Corpus is the only layer where individual teams have direct control AND where improvements compound across every agent session. Foundry treats corpus as the parameters to optimize — and provides the infrastructure to do it systematically. The analogy is gradient descent: you can't do gradient descent on the model (those weights are frozen), but you can do gradient descent on your documentation if you have a loss function (fixtures + scoring) and an update mechanism (the improvement engine).

---

## 3. The Full Loop

The core value proposition is a unified pipeline. Six stages, each connected to the next:

### Capture
Every interaction between a human and an AI agent generates signals. A correction ("no, we use snake_case for database columns"), a redirect ("that's the wrong abstraction"), a question the agent should have known the answer to. Today these signals evaporate when the session ends. Capture means recording them — structured, attributed, timestamped.

### Classify
Raw signals are noisy. Classification sorts them into actionable categories: **correction** (the agent did something wrong), **convention** (this is how we do things here), **taste** (subjective preference), **CI rule** (this should be enforced automatically), **ADR** (architectural decision record), **security** (this matters for safety). Classification is something models are already good at. It doesn't require human intervention for every signal.

### Route
Classified signals need to go somewhere durable. A convention goes into the conventions doc. A security finding goes to the Security Guard. An ADR gets formalized. A taste preference goes into the personal layer. Routing ensures signals don't just get classified — they reach the right destination in the right form.

### Verify
Before a corpus change goes live, you need to know it works. Verification means running the change against a fixture suite — does the new convention actually produce better output? Does it break anything that was working? This is the step that separates Foundry from "just write better docs."

### Improve
Verified changes get applied to the corpus. A new convention entry. An updated skill. A refined system prompt section. The improvement is attributed (which signal triggered it, which fixture validated it) so you can trace any corpus entry back to the real-world interaction that motivated it.

### Prevent Regression
The fixture that validated the improvement becomes a permanent regression test. Next time someone proposes a corpus change, the full suite runs — including fixtures generated from previous improvements. This is how the system accumulates knowledge without accumulating fragility.

**Why the unified pipeline matters:** Everyone does a part of this. Mem0 does memory. Karpathy's autoresearch does self-improvement on a single metric. cognee-skills does skill improvement. OpenAI Frontier organizes docs. Nobody connects them. The value is in the pieces being connected — one signal, the full pipeline. Same structural argument as json-rules: everyone does one target. The value is all targets from one definition.

---

## 4. The Agents

### The Cartographer
Read-everything-do-nothing routing agent. Loads the full documentation corpus, understands the topology of what exists, and carves precise context slices for execution agents. The Cartographer never modifies anything — it reads, understands structure, and routes. When an execution agent needs context, the Cartographer provides exactly the relevant slice, not the whole corpus. This is how you avoid the "full context kills accuracy" problem — the Cartographer absorbs the full picture so individual agents don't have to.

### The Librarian
Classification and routing engine. When signals come in — corrections, conventions, taste calls, security findings — the Librarian classifies them by type and routes them to durable forms. A correction becomes a fixture candidate. A convention gets proposed for the conventions doc. A taste preference goes to the personal layer. The Librarian also manages the batching UX: signals accumulate and get presented for human review in batches, not one at a time.

Signal types the Librarian handles:
- **Correction** — agent did X, human said do Y
- **Convention** — "we always do it this way"
- **Taste** — subjective preference, not a rule
- **CI Rule** — should be enforced automatically
- **ADR** — architectural decision with rationale
- **Security** — safety-relevant finding

### Guardian Skills
Adversarial agents that validate instead of build. They exist to catch problems that execution agents miss:
- **Convention Guard** — validates output against documented conventions
- **Security Guard** — scans for security-relevant patterns
- **API Contract Guard** — checks API changes against contracts
- **Migration Guard** — validates database migration safety

Guardians are RACI-accountable: they're Responsible for validation in their domain, Consulted by execution agents, and Accountable for catching regressions in their area.

### Domain Executors
The agents that actually do the work — write code, draft content, analyze data. They receive precisely scoped context from the Cartographer, follow conventions enforced by Guardians, and generate the signals that the Librarian classifies. They see only what they need to see, which is the whole point of the routing architecture.

---

## 5. The Four-Tier Memory Model

Memory is layered with explicit promotion flow:

### Personal Private
Individual preferences, working style, shortcuts, opinions. Gitignored, visible only to the individual. Your agent knows you prefer tabs over spaces, that you hate verbose error messages, and that you always want tests written first. Nobody else sees this.

### Personal Public
Role, expertise areas, conventions you maintain, decisions you've made that others can reference. Visible to the team. This is what makes personal agents queryable — another agent can check "what would Aron think about this API design?" against Aron's public layer before interrupting the real Aron.

### Team
Shared context for a working group. Conventions, architecture decisions, patterns, current priorities. Promoted from personal public when something applies to the whole team.

### Org
Institutional knowledge. Cross-team conventions, org-wide security policies, brand guidelines. Promoted from team when something applies everywhere.

**Promotion flow:** Personal Private → Personal Public → Team → Org. Each promotion is explicit — a human decision, not an automatic propagation. The system can suggest promotions ("this convention exists in 4 of 5 team members' personal layers — promote to team?") but never promotes without approval. Demotion flows the other direction when things become irrelevant or are superseded.

**The queryable proxy pattern:** Each person's public layer functions as a queryable agent. Before interrupting a human, the system queries their agent. Over time, as it captures corrections and redirects, the agent handles more decisions autonomously — reducing interruptions while preserving taste and judgment. This is the personal agent concept from the proposal: not a chatbot, but a proxy that carries your context into autonomous work.

---

## 6. The Open/Service Split

This is the business model's structural decision.

### What's Open (skill files + setup scripts)
- **The Cartographer** — the routing agent that reads everything and carves context slices
- **The Librarian** — the classification and routing engine for signals
- **Logging and capture tools** — infrastructure for recording interactions, corrections, and redirects
- **BYOI infrastructure setup** — bring-your-own-infrastructure scaffolding to get the capture layer running

### What's the Service (behind API key)
- **The improvement engine** — takes classified signals, generates fixtures from real corrections, runs regressions, pushes verified improvements back into the corpus
- **The Oracle evaluation loop** — the three-agent architecture (Subject, Implementer, Oracle) that scores output against golden references
- **Fixture generation from real corrections** — automated creation of test cases from captured signals
- **Regression testing** — running the full fixture suite against proposed corpus changes

### Why this split exists
They *have to have* the capture layer or the service doesn't work. The open tools are the funnel — teams adopt the Cartographer and Librarian because they're immediately useful (better context routing, classified interaction history). Even without the recursion loop, capture has standalone value: agents can look up "what did we decide about this" from classified history instead of asking the human again.

We do the hard part — verification, fixture generation, regression testing, measured improvement — as SaaS. This is the part that requires infrastructure, compute, and the evaluation engine. The open layer creates adoption and data flow. The service layer creates revenue and defensibility.

---

## 7. The Corpus Compilation Pipeline

Three stages of increasing structure:

### MuninnDB (Fluid Memory)
Raw interaction logs, corrections, signals, questions, redirects. Temporal, unstructured, high-volume. This is where the Librarian works — classifying and routing signals as they flow in. Think of this as the "working memory" — everything gets recorded, most of it gets processed, some of it gets promoted.

### Formal Docs (Structured)
Conventions documents, ADRs, skill definitions, system prompts, API contracts. Structured, versioned, attributed. This is where routed signals land after classification — a convention gets added to the conventions doc, an ADR gets formalized, a skill gets updated. Each entry traces back to the signal that created it.

### Compiled Corpus (Optimized)
The effective context that an agent actually receives. Compiled from Global + Project + Personal layers, merged, deduplicated, and optimized for token efficiency. Every compilation produces an immutable snapshot with a content hash — so any run can be reproduced exactly and score changes can be attributed to specific corpus modifications.

### Document Lifecycle States
Every document moves through explicit states:
- **Draft** — proposed, not yet reviewed
- **Development** — under active iteration
- **Active** — in use, included in compiled corpus
- **Deprecated** — superseded but still available for reference
- **Archived** — removed from active corpus, retained for history

The pipeline flows one direction under normal operation: fluid signals get classified, routed to structured docs, and compiled into optimized corpus. The compilation step is where Foundry's prompt efficiency scoring matters most — it creates constant pressure to make docs concise and modular, because the meta-score measures quality per token.

---

## 8. The Batched UX

Developers don't want to be prompted for every signal. The interaction model is batched, not real-time.

**How it works:** During normal work, the capture layer records signals silently. The Librarian classifies them in the background. Signals accumulate. At natural breakpoints — hourly, on context compaction, or on-demand — the developer gets a batched review:

> *"Since your last review: 3 convention signals, 1 ADR candidate, 2 taste preferences detected. Here's what I'd propose:"*

The developer approves, modifies, or dismisses each. Approved signals route to their destinations. This is manageable — a few minutes per batch, not constant interruption.

**Why batching works:** Classification is something models are already good at. The Librarian doesn't need human input to classify "that's a correction" vs. "that's a convention" — it needs human input to decide whether the proposed *action* is right. Batching reduces the frequency of that decision-making while maintaining human oversight on what actually changes.

**Progressive autonomy:** Over time, as the system's classification accuracy proves out against the developer's corrections, the batching threshold can rise. More gets auto-classified, less requires review. The developer always has veto power, but exercises it less frequently as trust builds.

---

## 9. Competitive Position

### What Exists

**Mem0** — Memory layer for AI applications. Stores and retrieves context across sessions. Does memory. Doesn't do improvement, verification, or regression testing. A component, not a system.

**Karpathy's autoresearch** — Self-improving research agent. Optimizes on a single metric. No regression testing across a fixture suite. One metric goes up, but you don't know what else moved. Too narrow.

**cognee-skills** — Skill improvement for AI agents. Focuses on individual skill refinement. Doesn't connect to capture, classification, or the broader corpus. Another component.

**OpenAI Frontier** — "Let us organize your docs." Shallow. Document organization is the easy part. The hard part is knowing whether your docs are helping or hurting, and improving them when they're not.

**Lab memory systems** — Every major lab has tried built-in memory. They're all bad. That's why third-party memory systems (Mem0, etc.) exist. Self-improvement from labs is similarly weak — that's why Karpathy built autoresearch externally.

### What Nobody Does

The full loop: capture → classify → route → verify → improve → prevent regression. Everyone does a piece. Nobody connects them into a pipeline where one signal flows through the entire system. The value isn't in any individual step — it's in the steps being connected. One correction from a developer automatically flows through classification, generates a fixture, validates the improvement, and becomes a permanent regression test. No manual authoring of test cases. No hoping the doc change helped.

### Why Acquisition, Not Native Implementation

Big labs don't build this. Their core competency is models and harnesses. Corpus infrastructure is adjacent but not core. When a lab decides they need corpus optimization, they acquire it — same as they acquire memory systems, tool use frameworks, and evaluation infrastructure. This is the realistic outcome for Foundry, and it's a good one. Acquisition by Anthropic, OpenAI, or Google is an exit, not a threat. The alternative — labs building it natively — is unlikely because it's not what labs are good at, and the problem is deep enough that "let's add a docs feature" doesn't solve it.

---

## 10. Three-System Architecture

Foundry is now structured as three composable systems with distinct licensing and deployment models:

- **@foundry/primitives** (open, Apache 2.0) — The base layer. Corpus schemas, skill file format, scoring rubrics, fixture format, and the CorpusCompiler. These are the building blocks anyone can use, embed, or build on. Open by design so the ecosystem can standardize on shared formats.

- **Foundry** (open / source-available) — The evaluation harness. The three-agent evaluation loop (Subject, Implementer, Oracle), the CLI, git isolation, run orchestration, and the viewer. Source-available so teams can inspect, self-host, and contribute — but with a license that prevents repackaging as a competing service.

- **Foundry Oracle** (closed service) — The calibrated judgment layer. Cross-customer scoring calibration, fixture cross-pollination, diagnosis-to-proposal mappings, and proposal effectiveness tracking. This is what turns raw evaluation into compounding insight. Closed because the value is in the accumulated data and calibration, not the code.

See [THREE_SYSTEMS.md](./THREE_SYSTEMS.md) for the full breakdown of what lives where, licensing details, and the interface boundaries between systems.

---

## 11. The Oracle as BYOI Service

The Oracle operates on a Bring Your Own Infrastructure model. It uses the user's LLM API keys, runs against the user's repos, and delivers results as PRs with corpus improvements. The user's `.foundry/` directory is the source of truth — not our database. We never become a data custodian for your corpus.

**Feedback channel:** The existing signal capture infrastructure (SignalBus to CorpusCompiler fluid entries) serves as the feedback mechanism. There is no separate feedback system to build. Escalation signals from running agents — missing context, failed conventions, ambiguous instructions — feed directly into the Oracle's next eval cycle as prioritized inputs.

**API key model:** Keys are passed per-run, never stored. The Oracle orchestrates LLM calls using the user's credentials for the duration of a job, then discards them. No key vault, no persistence, no liability.

**Metering:** Pricing is based on concrete, countable units — eval runs, fixtures, repos. Not on nebulous "complexity" tiers. Users can predict their bill before they run anything.

---

## 12. What We Host (Minimal)

The Oracle service requires minimal infrastructure on our side:

- **Eval history DB** — Cross-run comparisons and trend analysis. The only data we persist long-term.
- **Fixture index** — Deduplication across repos. When two customers hit the same class of problem, the fixture exists once.
- **Webhook receiver** — Triggered by PR merge events. Kicks off the next eval cycle when corpus changes land.
- **Job runner** — Orchestrates eval runs. All LLM calls use the user's API keys, not ours.
- **Dashboard** — Trends, regressions, coverage gaps. The view layer over eval history.

**Estimated cost:** A single VPS + Postgres handles the first 50 customers at approximately $27/month. The architecture is deliberately boring — no Kubernetes, no microservices, no distributed systems until the numbers demand it.

---

## 13. What Exists Today

### Built ✓
- **API + Dashboard** — project management, fixture management, feedback, oracle interface
- **SQLite schema** — full data model for projects, fixtures, runs, scores
- **CLI commands** — `init-project`, `start-round` for running evaluations
- **Run Worker** — coordinated mode with Implementer + Subject + Oracle agents running in isolation
- **Per-run Hivemind** — role-scoped auth, channel ACLs for agent communication (built on inixiative's existing hivemind library)
- **Git isolation** — role-isolated workspaces, per-role branches ensuring honest evaluation

### In Progress
- Canonical smoke fixture (first end-to-end test case)
- System prompt injector (how corpus gets loaded into agent context)
- Internal skill stubs (baseline skills that ship with Foundry)
- Auto feedback ingestion (structured capture from real interactions)
- Corpus layering (Global + Project + Personal merge logic)

### Designed but Not Built
- The Cartographer agent (routing architecture is specified, not implemented)
- The Librarian agent (classification taxonomy defined, agent not built)
- Guardian Skills (adversarial validation pattern designed, individual guards not implemented)
- Four-tier memory model (architecture specified, promotion workflows not built)
- Batched UX (interaction model designed, UI/workflow not implemented)
- Fixture generation from real corrections (the automatic pipeline from signal → fixture)
- Regression testing across fixture suites

### Speculative / Vision
- Unified workspace where humans and AI are co-equal actors
- Personal agents as queryable proxies
- Beyond-software generalization (sales, CX, content, research)
- Domain-agnostic "task + corpus + definition of good" pattern applied to non-engineering functions
- MuninnDB or equivalent fluid memory store (the right storage layer for corpus probably doesn't exist yet — see `HIVEMIND_V2.md` for storage research)

### Existing Infrastructure from inixiative
Foundry builds on a real stack, not from zero:
- **json-rules** — type-safe rules engine, 38 operators, compiles to runtime validation, Prisma queries, AND PostgreSQL WHERE clauses. Same AST, three targets.
- **hivemind** — multi-agent coordination with role-scoped messaging. Already used for Foundry's per-run agent isolation.
- **SaaS template** — auth, permissions, multi-tenancy, background jobs. The platform scaffold.

---

## 14. What's Next

**Immediate (weeks):**
- Complete the canonical smoke fixture — first end-to-end evaluation run with all three agents
- System prompt injector working — corpus loaded into Implementer context automatically
- Ship internal skill stubs — baseline conventions and patterns that work out of the box

**Near-term (1-3 months):**
- Effective corpus compiler — merge Global + Project + Personal into immutable snapshots with content hashing
- Auto feedback ingestion — structured capture pipeline from real coding sessions
- Corpus layering with promotion workflow — explicit promote/demote between tiers
- Cloud deployment — move from local-only to hosted service

**Medium-term (3-6 months):**
- Build the Cartographer and Librarian as working agents
- Implement Guardian Skills (Convention Guard first, then Security Guard)
- Fixture generation from real corrections — automatic pipeline from captured signal to test case
- Regression testing across full fixture suites
- Batched UX — developer-facing review interface for accumulated signals
- Open/service split — open-source the capture layer, gate the improvement engine behind API keys

**Longer-term (6-12 months):**
- Four-tier memory with promotion flow
- Personal agents as queryable proxies
- Cross-team corpus promotion
- Beyond-engineering vertical proof (sales or CX as first non-code domain)

---

## Team

**Aron Greenspan** — Founder. Full-stack engineer (TypeScript, Bun, Hono, PostgreSQL, Prisma, React). Built inixiative's open-source stack: json-rules, hivemind, SaaS template. Previously Senior Software Engineer at UserEvidence. Founded Carde.io and Dscnd. Experience across fintech (PrimeTrust, Spinwheel, Neat Capital), consumer (HelloTech), and CDN infrastructure (Edgecast).

**Hernán Massad** — Co-founder. Entrepreneur and engineer based in Punta del Este, Uruguay. 10+ years in software, 3 startups founded and scaled. Built a workflow automation SaaS to 10,000+ users and $2M ARR. Co-founded DataViz Pro (acquired for $5M). Led development of a fintech mobile banking app (1M+ downloads, 4.8 App Store rating). Currently CTO at MCGDS.

**inixiative** — Based in Uruguay. Building technology for cooperation — identity, governance, and investment infrastructure. Foundry is the second product from the inixiative ecosystem, built on the same open-source foundation that powers the platform.

---

*This document synthesizes the Foundry proposal, architecture spec, AI skills strategy, and founder insights as of March 2026. It's a living document — update it as things get built and assumptions get tested.*
