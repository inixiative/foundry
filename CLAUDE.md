# Foundry

Agent orchestration framework (the harness) that wraps an Artificer (a native Claude Code session, or Codex as a setting) with persistent memory, project conventions, multi-thread awareness, and correctness checking. The system gets smarter after every interaction.

## Monorepo Structure

```
packages/
  core/       @inixiative/foundry-core   — minimal engine, zero opinions
  foundry/    @inixiative/foundry         — opinionated framework (agents, tools, viewer, jobs)
  acp/        @inixiative/foundry-acp     — ACP agent: lets hosts (Paseo, T3 Code, Zed) drive Foundry threads
```

As an ACP agent, foundry-acp imports only `@inixiative/foundry/client` (the daemon client) and never runs a turn itself; its `setup` and `repeats` commands use `@inixiative/foundry/daemon` and `/repeats`. Spec: [FOUNDRY-ACP.md](docs/reference/FOUNDRY-ACP.md).

**Core vs Foundry boundary is strict.** Core contains primitives (ContextLayer, ContextStack, Thread, Harness, SignalBus, BaseAgent, Middleware, Trace, Hooks, TokenTracker) and the model registry (`model-registry.ts`: the capability vocabulary, the provider/model table and its lookups) — data and pure functions, so Oracle can reason about model fitness on a core-only dependency. No behavioral opinions, no specific agent implementations, no external service deps. Every provider (`providers/openai.ts`, `openai-compatible.ts`, `anthropic.ts`, `gemini.ts`, and the native-session providers over `@inixiative/agent-session`: `session-adapter.ts`, `native-text-provider.ts`, `primed-decisions.ts`) stays in foundry, because providers do HTTP and process handling. If it makes a decision about *how* to use the primitives, it belongs in foundry.

Oracle (eval/scoring) lives in its own repo (`../oracle`) and depends on the published `@inixiative/foundry-core`. Its worker and delegation path still import runtime-job exports that `@inixiative/foundry/runtime` no longer has, so they are broken until Oracle is reworked ([the system map](docs/SYSTEM-MAP.md), Oracle). The Prospector's correction detection now lives in core (`packages/core/src/feedback/correction.ts`); Foundry's feedback lifecycle (`packages/foundry/src/feedback/`) runs it on every accepted turn, and `foundry repeats` runs it over past Claude Code and Codex sessions. See the system map for how the five apps divide responsibility.

## Running

```bash
bun run start          # Production start (reads .foundry/settings.json)
bun run dev            # Watch mode
bun run test           # Core + foundry tests (cassette replays, no network)
bun run test:browser   # Viewer browser suite (needs `bunx playwright install chromium`)
bun run test:live      # Same tests live against this machine's subscriptions; re-records cassettes
bun run test:live:daemon  # Live smoke inside a throwaway LaunchAgent with the daemon's environment
bun run typecheck      # core, foundry, acp, scripts, browser (5 targets)
bun run test:acp       # foundry-acp tests
bun run check          # typecheck + lint + test (the full check)
bun run acp            # Run the ACP agent on stdio
bun run viewer         # Dashboard only
```

Tests that touch the agent CLIs or Kingdom replay real recordings (`packages/foundry/src/vcr`). Live runs are the truth: run `test:live` whenever a CLI, `@inixiative/agent-session` or a transport changes, and treat its drift findings as bugs to review. See [live-first testing](docs/live-testing.md).

## The Five FLOW.md Roles

Read `docs/FLOW.md` for the full architecture. These are the named agents:

| Role | Agent | What it does |
|------|-------|-------------|
| Context routing | **Cartographer** | Reads the topology map, routes context slices. Sees everything, modifies nothing. |
| Domain advising | **Wardens** (formerly called Domain Librarians) | Each maintains a warm cache for its domain (docs, convention, security, architecture, memory). Advise mode: "what context does this message need?" |
| Domain advising (cross-thread) | **Herald** | Designed to watch all threads for convergence, divergence, resource conflicts. **Not wired**: `agents/herald.ts` exists but no runtime constructs it. |
| Execution | **Artificer** (the native session under the harness) | The real work. Full tool access, capable model. |
| Correctness checking | **Wardens** (guard mode) | Same agents as advising, different mode. "Did this action violate anything in my domain?" |
| Signal reconciliation | **Librarian** | Sole writer to thread-state. Classifies signals, reconciles, feeds writeback. |

**These are separate named agents, NOT modes of a single class.** The (singular) Librarian and a Warden are different things.

## Key Mental Models

### Context layers are independent token caches

Each layer is its own small token budget + connection to a full data source. They are NOT parts of one shared context window. A layer with `maxTokens: 2000` is a 2000-token cache that gets warmed from its source, injected into a session when needed, and evicted independently.

### Wardens are config-driven

Wardens (docs, convention, security, architecture, memory) are instantiated from `.foundry/settings.json`, not hardcoded classes. The `DomainLibrarian` class in code is the shared implementation pattern; each instance gets its domain, prompt, warm cache config, and layer ownership from settings.

### The FlowOrchestrator wires everything together

`FlowOrchestrator` is the production entry point that connects the Cartographer, Wardens and Librarian into the pre-message and post-action flows (the Herald is not wired). It runs in `start.ts`, not just tests.

### Delta-aware hydration

The FlowOrchestrator tracks what context a session already has via the Librarian's injection ledger. On each message, it diffs against the ledger and only injects new or changed layers. Same-hash layers are skipped. What a native session actually receives is decided in `providers/session-delivery.ts` ([FLOW.md, Delivery](docs/FLOW.md#delivery-what-a-native-session-receives-each-turn)).

## Communication Channels

1. **Pre-message** (Foundry -> Session): standing context in the system prompt at session start (`--append-system-prompt-file`, a private file agent-session removes when the session ends), then changed layers and Warden notes with each user message (`providers/session-delivery.ts`)
2. **Mid-session** (Session -> Foundry): the `foundry` MCP server's seven tools when the agent discovers a gap
3. **Post-action** (Session -> Foundry): tool calls observed on the native event stream; the structural tool gate (`turns/tool-gate.ts`) answers permission requests before a call runs
4. **Feedback** (Foundry -> Session): guard findings become signals and reach the session on a later turn at best. No push path is built.

There is no `.foundry-context.md` and no Claude Code hook: middleware runs in Foundry's own harness, never in vendor hooks.

## Model Routing

**Cheap models for decisions, capable models for work.** Classifiers, routers, the Cartographer, the Librarian and Wardens (advise, guard and review) run on Claude Haiku 5.5 (`claude-haiku-5-5`). Heavier reasoning roles use Claude Opus 5.5 (`claude-opus-5-5`) or Fable 5.1 (`claude-fable-5-1`). Only the Artificer uses a capable model by default.

Foundry is subscription-only by default and all Claude for now (2026-10-11): the Artificer runs on the Claude Code login (`~/.claude`) (Codex, with `defaults.provider: "codex"`, is a setting), and every decision role runs Claude Haiku 5.5 on primed Claude Code sessions through the same Claude login, with no API provider constructed and no paid fallback. The decision runtime and model are settings (`subscriptionOnly.decisionRuntime`, `subscriptionOnly.model` / `defaults.classifierModel`), so Codex or another lab can run decisions again without code changes. API-key providers require `apiTokens: true`; their decision default is Anthropic Haiku 5.5. Main threads run on Anthropic, OpenAI, Google, Meta and xAI models only. See [subscription decisions](docs/subscription-decisions.md) for settings, bounds and ownership.

## Design Principles

1. **Don't reinvent Claude Code.** Wrap it, don't replace it.
2. **Pull over push.** Inject predicted context, let the session pull the rest via MCP.
3. **Progressive depth.** Basic layers every message, deeper layers only on domain shift / low confidence / cross-cutting signals. Most steady-state messages reuse cached middleware output.
4. **One writer, many readers.** The Librarian is the sole writer to thread-state. Wardens and guards emit signals; the Librarian reconciles.
5. **No backwards-compat cruft.** Remove unused systems entirely. No optional fallbacks, no re-exporting removed types, no `_unused` vars.
6. **Every execution is a training step.** Map rebuilds, memory entries, convention proposals, signal ingestion all happen after each interaction.

## Common Mistakes (for AI assistants)

- Don't treat layers as parts of a shared context window. Each is independent.
- Don't create hardcoded Warden subclasses. They're config-driven from settings.
- Don't put behavioral opinions in core. Core is the engine.
- Don't put a capable model (Opus, Fable, Sonnet) on classifiers, routers or Wardens. Decisions use Haiku 5.5 unless settings say otherwise.
- Use Claude Code's native auto-compaction policy (`providers/claude-context-budget.ts`). Don't implement a separate summarizer or compression loop; Foundry layer caches remain independent.
- Don't add backwards-compat shims for removed features.
- Don't confuse the singular Librarian (signal reconciliation, sole thread-state writer) with the Wardens (domain-specific advise + guard).

## Config

Runtime config lives in `.foundry/settings.json`. It defines:
- Default provider/model
- Agent definitions (id, kind, domain, prompt, provider, model, temperature, visible/owned layers, a Warden's `domainKnowledge` sources)
- The composition view (`composition`): the instruction ladder and what each role picks from it
- Layer definitions (id, maxTokens, sources)
- Data sources
- Project settings

The viewer dashboard reads and writes this config. `ConfigStore` handles persistence with JSON patch semantics.

A Warden is three parts: **instructions** and **domain knowledge**, both composed by the composition view, and **thread knowledge**, generated per thread by its post-work review. The composition view is one ladder that composes every slot for every role, main thread included ([usage-and-context.md](docs/usage-and-context.md), "Composition view"). Instructions are the agent's `prompt` plus the ladder's files for its role. Domain knowledge is its `domainKnowledge` sources plus the role's files and the general files (CLAUDE.md and the like) of the nodes its `general` names. Both live in private layers, never on the thread's stack, and a Warden owns no configured layer. Each phase (advise, guard, review) appends its own response protocol, so a Warden prompt never states a JSON shape. Every Warden runs under the fixed Warden charter (`agents/warden-charter.ts`, composed above its instructions, never settings) and is asked at every trigger point that reaches it (`user-message`, `agent-action`) unless the pre-filter (`prefilter`, on by default; a local decision model, failing open) is confident the moment is outside its domain; `NO_COMMENT` is the expected answer and adds nothing to the thread ([FLOW.md](docs/FLOW.md#when-a-warden-weighs-in-the-charter-trigger-points-and-no_comment)). A Warden's advice is appended to the user's message as "The <domain> Warden chimed in:".

A project agent (`projects[id].agents`) is **standalone** (a full definition) or **`extends: <global agent id>`**. An extension appends its `prompt` (under a heading per chunk) and its `domainKnowledge` (source ids, each under its label) to the parent's, global first; `override: ["instructions" | "domainKnowledge"]` replaces that chunk instead. No entry means the global agent applies unchanged. `GET /api/projects/:id/resolved/agents` shows where each chunk came from.

Settings edits apply live: every committed change is a row in Foundry's audit log, `.foundry/audit.jsonl` (before/after per definition, `GET /api/settings/history`), and running threads take edited layers, agents and Cartographer/Warden instructions on their next turn. Adding or removing a Warden, and provider changes, apply to new threads.

Every Warden call records what its instructions and domain knowledge were composed from, as version ids, not text (`audit/`, docs/THREAD-TREE.md spec B). The audit log holds a **source version** for every change to a source: a settings definition, a ladder file (`file:<path>`), a settings prompt (`prompt:agent:<id>`), a configured source's text (`source-content:<id>`), a feedback-written line, or the charter. Each row records the actor and the cause. The journal's `composition_version` lists a slot's parts in order (glue, source version plus the text it contributed, per-message text), so `CompositionAuditor.recompose` returns the exact text. Advice, guard and review requests carry `versions: {charter, instructions, domainKnowledge, retrieved?}`; text chosen per message is stored raw with the call.

A thread is a tree (docs/THREAD-TREE.md spec A).
- **Subagents.** The executor's native subagents (Claude Agent/Task, Codex sub-agents) are recorded as observed child threads (`turns/subagents.ts`), tied to their real parent by `handoff` / `handoff-return` rows.
- **Compaction.** When a turn closes, each middleware call gets a `middleware-reduced` row: its state (versions) and its result, never its input.
- **Retention.** Raw middleware rows age out after `journal.rawMiddlewareDays` (default 30).
- **Archive.** It gets reduced entries and per-node snapshots with `lineage`. Capture claims the native sessions it records, with a lease, so the Archive collector skips them unless Foundry dies before fulfilling.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict)
- **Testing**: `bun test` (bun's built-in test runner)
- **Jobs**: BullMQ (Redis-backed background jobs)
- **Database**: PostgreSQL via Prisma (`prisma/schema.prisma`) for persistent memory/traces; SQLite for the local session store
- **Providers**: native Claude Code and Codex sessions via `@inixiative/agent-session` (subscription, the default); with `apiTokens: true`, Anthropic, OpenAI, Gemini, Voyage (embeddings), plus the OpenAI-compatible family (xAI, DeepSeek, Qwen, Kimi, GLM, Meta, Mistral, OpenRouter, Groq, Together, Fireworks, Ollama, vLLM) through one adapter and the registry's `apiRoot`
- **MCP**: Model Context Protocol server for the mid-session bridge
- **ACP**: foundry-acp, the Agent Client Protocol agent hosts talk to
