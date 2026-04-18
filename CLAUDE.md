# Foundry

Agent orchestration framework that wraps Claude Code sessions with persistent memory, project conventions, multi-thread awareness, and correctness checking. The system gets smarter after every interaction.

## Monorepo Structure

```
packages/
  core/       @inixiative/foundry-core   — minimal engine, zero opinions
  foundry/    @inixiative/foundry         — opinionated framework (agents, tools, viewer, jobs)
```

**Core vs Foundry boundary is strict.** Core contains primitives (ContextLayer, ContextStack, Thread, Harness, SignalBus, BaseAgent, Middleware, Trace, Hooks, TokenTracker). No behavioral opinions, no specific agent implementations, no external service deps. If it makes a decision about *how* to use the primitives, it belongs in foundry.

Oracle (eval/scoring) is a planned third package. It depends on core only, not foundry.

## Running

```bash
bun run start          # Production start (reads .foundry/settings.json)
bun run dev            # Watch mode
bun run test           # Core + foundry tests
bun run typecheck      # Both packages
bun run viewer         # Dashboard only
bun run research       # Auto-research CLI for config sweeps
```

## The Five FLOW.md Roles

Read `docs/FLOW.md` for the full architecture. These are the named agents:

| Role | Agent | What it does |
|------|-------|-------------|
| Context routing | **Cartographer** | Reads the topology map, routes context slices. Sees everything, modifies nothing. |
| Domain advising | **Domain Librarians** | Each maintains a warm cache for its domain (docs, convention, security, architecture, memory). Advise mode: "what context does this message need?" |
| Domain advising (cross-thread) | **Herald** | Watches all threads. Detects convergence, divergence, resource conflicts. |
| Execution | **Claude Code session** | The real work. Full tool access, capable model. |
| Correctness checking | **Domain Librarians** (guard mode) | Same agents as advising, different mode. "Did this action violate anything in my domain?" |
| Signal reconciliation | **Librarian** | Sole writer to thread-state. Classifies signals, reconciles, feeds writeback. |

**These are separate named agents, NOT modes of a single class.** The Librarian and a Domain Librarian are different things.

## Key Mental Models

### Context layers are independent token caches

Each layer is its own small token budget + connection to a full data source. They are NOT parts of one shared context window. A layer with `maxTokens: 2000` is a 2000-token cache that gets warmed from its source, injected into a session when needed, and evicted independently.

### Domain librarians are config-driven

Domain librarians (docs, convention, security, architecture, memory) are instantiated from `.foundry/settings.json`, not hardcoded classes. The `DomainLibrarian` class is a shared pattern; each instance gets its domain, prompt, warm cache config, and layer ownership from settings.

### Trust is a quality score

Trust on layers is a score of how users reacted to a thread in response to the layer's responsibilities. It is NOT a compaction priority. There is no compaction system.

### The FlowOrchestrator wires everything together

`FlowOrchestrator` is the production entry point that connects Cartographer, Domain Librarians, Librarian, and Herald into the pre-message and post-action flows. It runs in `start.ts`, not just tests.

### Delta-aware hydration

The FlowOrchestrator tracks what context a session already has via the Librarian's injection ledger. On each message, it diffs against the ledger and only injects new or changed layers. Same-hash layers are skipped.

## Four Communication Channels

1. **Pre-message** (Foundry -> Session): `.foundry-context.md` injection before each message
2. **Mid-session** (Session -> Foundry): MCP tool calls when the agent discovers a gap
3. **Post-action** (Session -> Foundry): PostToolUse hooks observe every tool call
4. **Feedback** (Foundry -> Session): MCP push when guards flag something critical

## Model Routing

**Cheap models for decisions, capable models for work.** Classifiers, routers, domain librarians (advise + guard), and the Cartographer all run on Gemini Flash or similar fast/cheap models. Claude is too expensive for lightweight agents. Only the executor session uses a capable model.

## Design Principles

1. **Don't reinvent Claude Code.** Wrap it, don't replace it.
2. **Pull over push.** Inject predicted context, let the session pull the rest via MCP.
3. **Progressive depth.** Basic layers every message, deeper layers only on domain shift / low confidence / cross-cutting signals. Most steady-state messages reuse cached middleware output.
4. **One writer, many readers.** The Librarian is the sole writer to thread-state. Domain librarians, guards, and Herald all emit signals; the Librarian reconciles.
5. **No backwards-compat cruft.** Remove unused systems entirely. No optional fallbacks, no re-exporting removed types, no `_unused` vars.
6. **Every execution is a training step.** Trust adjustments, map rebuilds, memory entries, convention proposals all happen after each interaction.

## Common Mistakes (for AI assistants)

- Don't treat layers as parts of a shared context window. Each is independent.
- Don't create hardcoded domain librarian subclasses. They're config-driven from settings.
- Don't put behavioral opinions in core. Core is the engine.
- Don't use Claude/Sonnet for classifiers or routers. Use Gemini Flash.
- Don't add compaction or compression logic. It was removed intentionally.
- Don't add backwards-compat shims for removed features.
- Don't confuse the Librarian (signal reconciliation, sole thread-state writer) with Domain Librarians (domain-specific advise + guard).

## Config

Runtime config lives in `.foundry/settings.json`. It defines:
- Default provider/model
- Agent definitions (id, kind, domain, prompt, provider, model, temperature, visible/owned layers)
- Layer definitions (id, maxTokens, trust, sources)
- Data sources
- Project settings

The viewer dashboard reads and writes this config. `ConfigStore` handles persistence with JSON patch semantics.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict)
- **Testing**: `bun test` (bun's built-in test runner)
- **Jobs**: BullMQ (Redis-backed background jobs)
- **Database**: PostgreSQL (via postgres.js) for persistent memory/traces
- **Providers**: Anthropic, OpenAI, Gemini, Claude Code CLI, Voyage (embeddings)
- **MCP**: Model Context Protocol server for mid-session bridge
