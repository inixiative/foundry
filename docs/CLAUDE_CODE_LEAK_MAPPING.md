# How the Claude Code Leak Informs Foundry

> Analysis of the March 31, 2026 Claude Code source leak and what it validates, challenges, and reveals for Foundry's architecture.

---

## Background

On March 31, 2026, Anthropic accidentally shipped the full source code of Claude Code (~512,000 lines of TypeScript) inside a public npm package. A source map file in version 2.1.88 of `@anthropic-ai/claude-code` pointed to a publicly accessible zip on Anthropic's Cloudflare R2 bucket. Within hours, the codebase was mirrored across GitHub and analyzed by thousands of developers.

The leak exposed Claude Code's internal architecture: LLM orchestration, multi-agent coordination, permission logic, memory systems, 44 hidden feature flags, and unreleased capabilities. This document maps those internals to Foundry's thesis and architecture.

---

## 1. Three-Layer Memory Architecture → Foundry's Corpus Layering

### What Claude Code Does

The leak reveals a three-layer memory system centered on `MEMORY.md` — a lightweight index of pointers (~150 characters per line) that is perpetually loaded into context. This is a "self-healing memory" design: compact, always-present, pointer-based rather than content-heavy.

### What Foundry Designed

Foundry's corpus architecture has three layers: **Global** (Foundry-managed baseline, shared across projects), **Project** (repo-specific, evolves per project), and **Personal** (individual preferences, gitignored, local only). Each run compiles these into an immutable snapshot with a content hash for reproducibility.

### The Mapping

| Claude Code (leaked) | Foundry |
|---|---|
| MEMORY.md as always-loaded index | Effective corpus compiled per run |
| ~150 char pointers, not full content | Prompt Efficiency rubric (quality ÷ tokens) |
| Self-healing consolidation | Librarian skill that classifies and routes |
| Three memory layers | Three corpus layers (Global/Project/Personal) |

### What This Validates

**Foundry's core thesis is confirmed by Anthropic's own engineering.** Claude Code doesn't dump everything into context — it uses a compact pointer layer and retrieves selectively. This is exactly the problem Foundry's Prompt Efficiency rubric measures: context bloat degrades performance, and the solution is lean, precise context slices rather than broad dumps.

**The pressure toward compaction is real.** Claude Code's ~150 character limit per memory line mirrors Foundry's design pressure: the Prompt Efficiency rubric rewards docs that achieve the same quality with fewer tokens. Anthropic arrived at the same conclusion independently — less is more, if the less is the *right* less.

### What This Challenges

Foundry's four-tier memory model (Personal Private → Personal Public → Team → Org) is more granular than what Claude Code implements. The leak shows Anthropic solved this with a simpler scheme. **Question for Foundry:** Is the four-tier promotion flow worth the complexity, or does a simpler layering with aggressive compaction achieve 80% of the value?

---

## 2. KAIROS (Always-On Agent) + autoDream → Foundry's Recursion Engine

### What Claude Code Does

**KAIROS** is an unreleased always-on background daemon. While the user is idle, it runs `autoDream` — a process that performs "memory consolidation": merging disparate observations, removing logical contradictions, and converting vague insights into absolute facts. This is memory optimization happening *between* sessions, not during them.

### What Foundry Designed

Foundry's recursion engine watches outcomes from real interactions, generates fixtures from corrections, and improves the corpus automatically. The loop: Capture → Classify → Route → Verify → Improve → Prevent Regression. The Librarian classifies signals, the engine tests proposed improvements, and validated changes are promoted.

### The Mapping

| Claude Code KAIROS | Foundry Recursion Engine |
|---|---|
| autoDream consolidation during idle | Capture + Classify + Route pipeline |
| Merges disparate observations | Librarian consolidates scattered notes |
| Removes contradictions | Fixture regression testing catches conflicts |
| Converts vague insights → facts | Promotion flow: scratch → validated → standard |
| Runs between sessions | Runs after interactions (continuous) |

### What This Validates

**Anthropic built the same feedback loop Foundry is designed to measure.** KAIROS/autoDream is essentially an internal, unmeasured version of what Foundry exposes as an observable, testable pipeline. The key difference: Claude Code's dream consolidation is a black box — there's no way for a team to see what changed, why, or whether it helped. Foundry's architecture makes this explicit, measurable, and attributable.

### What This Reveals (Opportunity)

**Foundry could benchmark KAIROS-style consolidation.** If Foundry can measure corpus quality before and after a consolidation pass, it becomes the tool that validates whether "dreaming" actually works — or whether it introduces regressions. This is a direct product opportunity: "Your AI agent is rewriting its own memory overnight. Foundry tells you if that made things better or worse."

---

## 3. 44 Feature Flags + Compile-Time Elimination → Foundry's Doc Lifecycle States

### What Claude Code Does

The leak exposed 44 feature flags covering unreleased functionality. These compile to `false` in external builds, meaning the code exists but is gated. This is standard feature flagging — but applied to an AI agent's capabilities, not just a web app's UI.

### What Foundry Designed

Foundry's AI Skills Strategy proposes **lifecycle states for documentation**: `draft`, `development`, `active`, `deprecated`, `archived`. Agents treat each state differently — ignoring drafts, following active docs as policy, warning on deprecated references. This is described as "feature flags for documentation."

### The Mapping

| Claude Code Feature Flags | Foundry Doc Lifecycle |
|---|---|
| `flag === true` → feature active | `status: active` → agent follows as policy |
| `flag === false` → compiled out | `status: draft` → agents ignore |
| Unreleased but built | `status: development` → agents follow but flag as experimental |
| Deprecated flags | `status: deprecated` → agents warn, suggest replacement |

### What This Validates

**The feature-flag pattern transfers directly to corpus.** Anthropic gates *code capabilities* behind flags; Foundry gates *documentation and conventions* behind lifecycle states. Both solve the same problem: you need things to exist in the system without being active, and you need controlled rollout. The leaked architecture confirms this is a real need, not a theoretical one.

---

## 4. Anti-Distillation + Fake Tools → Foundry's Corpus Integrity Problem

### What Claude Code Does

When enabled, Claude Code sends `anti_distillation: ['fake_tools']` in API requests, which tells the server to inject decoy tool definitions into the system prompt. If someone records API traffic to train a competing model, the fake tools pollute that training data.

### What This Means for Foundry

Foundry's entire value proposition rests on corpus being the differentiator. If corpus is valuable enough to measure and optimize, it's valuable enough to steal. The anti-distillation pattern reveals that **Anthropic considers its own system prompts and tool definitions as proprietary corpus worth protecting.**

### Implications

1. **Corpus is IP.** The leak confirms what Foundry's thesis asserts: the context that shapes AI output is a strategic asset, not just configuration files. Anthropic went so far as to build active countermeasures against corpus theft.

2. **Foundry needs a corpus protection story.** If Foundry helps teams build optimized corpus, those teams will want assurance that their corpus (skills, docs, conventions) can't be trivially extracted by recording API traffic. This could be a Scale-tier feature: corpus obfuscation, watermarking, or monitoring for extraction patterns.

3. **The fake-tools pattern is a corpus evaluation fixture.** If you inject fake tools and an agent *uses* them, that's a signal about instruction-following quality. Foundry could use a similar technique: inject decoy instructions into corpus and score whether agents correctly ignore them (a form of the Demerits rubric).

---

## 5. Undercover Mode → The Corpus Leakage Problem

### What Claude Code Does

`undercover.ts` strips all traces of Anthropic internals when Claude Code is used in non-internal repos. It instructs the model to never mention internal codenames, Slack channels, repo names, or "Claude Code" itself. This is corpus containment — preventing context from one environment from bleeding into another.

### What Foundry Designed

Foundry's corpus layering explicitly addresses this: **Personal** layer is gitignored and local-only, **Project** layer is repo-specific, **Global** layer is shared. The promotion flow ensures "knowledge doesn't leak upward by accident." Each tier increase requires explicit human approval.

### What This Validates

**Context leakage is a real production problem, not a theoretical concern.** Anthropic built an entire mode to prevent it. Foundry's explicit promotion flow with human approval at each tier is the right architecture — but the leak shows that even Anthropic, with enormous engineering resources, found this hard enough to warrant a dedicated system.

### What This Challenges

Foundry's current design relies on policy (human approves promotions) rather than enforcement (the system physically prevents leakage). Claude Code's approach is more aggressive — active instruction to the model to suppress information. **Foundry may need both:** policy for intentional promotion *and* enforcement to prevent accidental context bleeding between layers.

---

## 6. Multi-Agent Coordination → Foundry's Hivemind + Three-Agent Architecture

### What Claude Code Does

The leaked source reveals sophisticated multi-agent coordination, role-scoped permissions, and orchestration logic. Agents are isolated with different permission levels and capabilities. The "three-gate trigger architecture" controls when and how agents activate.

### What Foundry Designed

Foundry uses three physically isolated agents (Subject, Implementer, Oracle) coordinated via Hivemind — a multi-agent coordination system with role-scoped auth, channel ACLs, and structured event types. Isolation is enforced via git branches, not just instructions.

### What This Validates

**Physical isolation beats instruction-based scoping.** Foundry's design of isolating agents via git branches (the Implementer literally can't see the Oracle's golden implementation) is a stronger guarantee than what the Claude Code leak shows. Claude Code uses permission logic and role scoping — Foundry uses actual workspace isolation. This is a genuine architectural advantage.

### What This Reveals

Claude Code's multi-agent system is focused on *task execution* (getting work done). Foundry's three-agent system is focused on *evaluation* (measuring how well work gets done). These are complementary, not competing. **Foundry wraps around tools like Claude Code** — it doesn't replace them. Claude Code is the harness; Foundry measures the corpus that makes the harness effective.

---

## 7. The Cartographer Pattern → Claude Code's Context Routing

### What Claude Code Does

The leaked architecture shows that Claude Code performs context management — deciding what information to load, when to retrieve from memory, and how to scope context for sub-agents. The system is designed to be selective rather than exhaustive.

### What Foundry Designed

The Cartographer is a "read everything, do nothing" agent. It loads the full template docs, receives user intent, and carves out precisely which docs, patterns, and reference files execution agents need. It pays the context cost once at a routing layer to prevent execution agents from being wasteful.

### What This Validates

**The routing pattern is convergent design.** Anthropic's engineering team and Foundry's architecture independently arrived at the same solution: one expensive context-aware agent that routes precise slices to focused executors. This isn't coincidence — it's the natural architecture when context windows are finite and context bloat is measurable.

---

## Summary: What the Leak Means for Foundry

| Leaked Feature | Foundry Mapping | Signal |
|---|---|---|
| Three-layer memory + MEMORY.md | Corpus layering + Prompt Efficiency rubric | **Validates** compaction-first approach |
| KAIROS autoDream | Recursion engine | **Validates** continuous improvement loop; **creates opportunity** to benchmark it |
| 44 feature flags | Doc lifecycle states | **Validates** feature-flags-for-documentation concept |
| Anti-distillation / fake tools | Corpus as IP | **Reveals** need for corpus protection features |
| Undercover mode | Promotion flow + layer isolation | **Validates** leak prevention; **challenges** policy-only approach |
| Multi-agent coordination | Hivemind + three-agent eval | **Validates** physical isolation; **clarifies** Foundry wraps harnesses, doesn't replace them |
| Context routing | The Cartographer | **Validates** routing pattern as convergent design |
| Buddy (Tamagotchi pet) | — | Irrelevant but delightful |

### The Core Takeaway

**Anthropic built internally what Foundry proposes to make external and measurable.** Claude Code has memory consolidation, context routing, feature-gated capabilities, and multi-agent coordination — but all of it is opaque to the teams using it. Foundry's value proposition is making these dynamics visible, testable, and improvable by the people who actually need the AI to work well: the teams writing the corpus.

The leak doesn't invalidate Foundry — it validates the problem space while confirming that the solutions are currently locked inside proprietary tools. Foundry is the instrument panel for a system that Anthropic proved needs one.
