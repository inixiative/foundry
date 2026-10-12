# Foundry

Agent orchestration framework that wraps an Artificer (a Claude Code session) with persistent memory, project conventions, multi-thread awareness, and correctness checking. The system gets smarter after every interaction.

## Monorepo Structure

```
packages/
  core/       @inixiative/foundry-core   — minimal engine, zero opinions
  foundry/    @inixiative/foundry         — opinionated framework (agents, tools, viewer, jobs)
```

**Core vs Foundry boundary is strict.** Core contains primitives (ContextLayer, ContextStack, Thread, Harness, SignalBus, BaseAgent, Middleware, Trace, Hooks, TokenTracker) and the model registry (`model-registry.ts`: the capability vocabulary, the provider/model table and its lookups) and the correction detector (`feedback/correction.ts`: the Prospector's patterns, secret scrubber and classify contract, shared by Oracle, live feedback capture and `foundry repeats`) — data and pure functions, so Oracle can use them on a core-only dependency. No behavioral opinions, no specific agent implementations, no external service deps. Every adapter (`openai.ts`, `openai-compatible.ts`, `anthropic.ts`, `gemini.ts`, `claude-code.ts`, `codex.ts`) stays in foundry, because adapters do HTTP and process handling. If it makes a decision about *how* to use the primitives, it belongs in foundry.

Oracle (eval/scoring) lives in its own repo (`../oracle`) and consumes the published `@inixiative/foundry-core` and `@inixiative/foundry/runtime` packages. See [the system map](docs/SYSTEM-MAP.md) for how the five apps divide responsibility. Its roles: **Oracle** (scores), **Steward** (chain of custody), **Prospector** (mines session transcripts + merged PRs into fixtures and correction signal — see `oracle mine`).

## Running

```bash
bun run start          # Production start (reads .foundry/settings.json)
bun run dev            # Watch mode
bun run test           # Core + foundry tests (cassette replays, no network)
bun run test:browser   # Viewer browser suite (needs `bunx playwright install chromium`)
bun run test:live      # Same tests live against this machine's subscriptions; re-records cassettes
bun run test:live:daemon  # Live smoke inside a throwaway LaunchAgent with the daemon's environment
bun run typecheck      # Both packages
bun run viewer         # Dashboard only
```

Tests that touch the agent CLIs or Kingdom replay real recordings (`packages/foundry/src/vcr`). Live runs are the truth: run `test:live` whenever a CLI, `@inixiative/agent-session` or a transport changes, and treat its drift findings as bugs to review. See [live-first testing](docs/live-testing.md).

## The Five FLOW.md Roles

Read `docs/FLOW.md` for the full architecture. These are the named agents:

| Role | Agent | What it does |
|------|-------|-------------|
| Context routing | **Cartographer** | Reads the topology map, routes context slices. Sees everything, modifies nothing. |
| Domain advising | **Wardens** (formerly called Domain Librarians) | Each maintains a warm cache for its domain (docs, convention, security, architecture, memory). Advise mode: "what context does this message need?" |
| Domain advising (cross-thread) | **Herald** | Watches all threads. Detects convergence, divergence, resource conflicts. |
| Execution | **Artificer** (the Claude Code session under the harness) | The real work. Full tool access, capable model. |
| Correctness checking | **Wardens** (guard mode) | Same agents as advising, different mode. "Did this action violate anything in my domain?" |
| Signal reconciliation | **Librarian** | Sole writer to thread-state. Classifies signals, reconciles, feeds writeback. |

**These are separate named agents, NOT modes of a single class.** The (singular) Librarian and a Warden are different things.

## Key Mental Models

### Context layers are independent token caches

Each layer is its own small token budget + connection to a full data source. They are NOT parts of one shared context window. A layer with `maxTokens: 2000` is a 2000-token cache that gets warmed from its source, injected into a session when needed, and evicted independently.

### Wardens are config-driven

Wardens (docs, convention, security, architecture, memory) are instantiated from `.foundry/settings.json`, not hardcoded classes. The `DomainLibrarian` class in code is the shared implementation pattern; each instance gets its domain, prompt, warm cache config, and layer ownership from settings.

### The FlowOrchestrator wires everything together

`FlowOrchestrator` is the production entry point that connects Cartographer, Wardens, Librarian, and Herald into the pre-message and post-action flows. It runs in `start.ts`, not just tests.

### Delta-aware hydration

The FlowOrchestrator tracks what context a session already has via the Librarian's injection ledger. On each message, it diffs against the ledger and only injects new or changed layers. Same-hash layers are skipped.

## Four Communication Channels

1. **Pre-message** (Foundry -> Session): `.foundry-context.md` injection before each message
2. **Mid-session** (Session -> Foundry): MCP tool calls when the agent discovers a gap
3. **Post-action** (Session -> Foundry): PostToolUse hooks observe every tool call
4. **Feedback** (Foundry -> Session): MCP push when guards flag something critical

## Model Routing

**Cheap models for decisions, capable models for work.** Classifiers, routers, the Cartographer, the Librarian and Wardens (advise, guard and review) run on Claude Haiku 5.5 (`claude-haiku-5-5`). Heavier reasoning roles use Claude Opus 5.5 (`claude-opus-5-5`) or Fable 5.1 (`claude-fable-5-1`). Only the Artificer uses a capable model by default.

Foundry is subscription-only by default: the Artificer runs on the Claude Code login (`~/.claude`) or, with `defaults.provider: "codex"`, on the Codex login, and every decision role runs Claude Haiku 5.5 on primed Claude Code sessions through the same Claude login, with no API provider constructed and no paid fallback. The decision runtime and model are settings (`subscriptionOnly.decisionRuntime`, `subscriptionOnly.model` / `defaults.classifierModel`), so Codex or another lab can run decisions again without code changes. API-key providers require `apiTokens: true`; their decision default is Anthropic Haiku 5.5. Main threads run on Anthropic, OpenAI, Google, Meta and xAI models only. See [subscription decisions](docs/subscription-decisions.md) for settings, bounds and ownership.

## Design Principles

1. **Don't reinvent Claude Code.** Wrap it, don't replace it.
2. **Pull over push.** Inject predicted context, let the session pull the rest via MCP.
3. **Progressive depth.** Basic layers every message, deeper layers only on domain shift / low confidence / cross-cutting signals. Most steady-state messages reuse cached middleware output.
4. **One writer, many readers.** The Librarian is the sole writer to thread-state. Wardens, guards, and Herald all emit signals; the Librarian reconciles.
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
- Agent definitions (id, kind, domain, prompt, provider, model, temperature, visible/owned layers)
- Layer definitions (id, maxTokens, sources)
- Data sources
- Project settings

The viewer dashboard reads and writes this config. `ConfigStore` handles persistence with JSON patch semantics.

A Warden is three parts: **instructions** (the agent's `prompt`), **domain knowledge** (the content of the one layer it owns) and **thread knowledge** (generated per thread by its post-work review). Each phase (advise, guard, review) appends its own response protocol, so a Warden prompt never states a JSON shape.

A project agent (`projects[id].agents`) is **standalone** (a full definition) or **`extends: <global agent id>`**. An extension appends its `prompt` and its `domainKnowledge` (source ids for the parent's layer) to the parent's, global first, under a heading per chunk; `override: ["instructions" | "domainKnowledge"]` replaces that chunk instead. No entry means the global agent applies unchanged. `GET /api/projects/:id/resolved/agents` shows where each chunk came from.

Settings edits apply live: every committed change is appended to `.foundry/settings-history.jsonl` (before/after per definition, `GET /api/settings/history`), and running threads take edited layers, agents and Cartographer/Warden instructions on their next turn. Adding or removing a Warden, and provider changes, apply to new threads.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict)
- **Testing**: `bun test` (bun's built-in test runner)
- **Jobs**: BullMQ (Redis-backed background jobs)
- **Database**: PostgreSQL (via postgres.js) for persistent memory/traces
- **Providers**: Anthropic, OpenAI, Gemini, Claude Code CLI, Codex CLI, Voyage (embeddings), plus the OpenAI-compatible family (xAI, DeepSeek, Qwen, Kimi, GLM, Meta, Mistral, OpenRouter, Groq, Together, Fireworks, Ollama, vLLM) through one adapter and the registry's `apiRoot`
- **MCP**: Model Context Protocol server for mid-session bridge
