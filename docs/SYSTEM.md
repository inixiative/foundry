# Foundry System Documentation

> Agent infrastructure primitives for AI context management, evaluation, and improvement.

---

## Architecture Overview

Foundry is a **context management and orchestration layer** for AI agents. It manages what agents know, how they're composed, how they're evaluated, and how the system improves over time.

```
┌─────────────────────────────────────────────────────────────────────┐
│                            FOUNDRY                                    │
│                                                                       │
│  ┌───────────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Agents        │  │ Providers│  │ Adapters │  │ Eval / Improve│  │
│  │               │  │          │  │          │  │               │  │
│  │ Context Stack │  │ Anthropic│  │ File     │  │ PR Fixtures   │  │
│  │ Thread        │  │ OpenAI   │  │ SQLite   │  │ Diff Scoring  │  │
│  │ Harness       │  │ Gemini   │  │ Postgres │  │ LLM Scoring   │  │
│  │ Planner       │  │          │  │ Redis    │  │ Regression    │  │
│  │ Herald        │  │ Runtime  │  │ HTTP     │  │ Trends        │  │
│  │ ActiveMemory  │  │ Adapters │  │ Markdown │  │               │  │
│  │ CorpusCompiler│  │          │  │          │  │               │  │
│  │ TokenTracker  │  │ Streaming│  │          │  │               │  │
│  │ Trace/Session │  │          │  │          │  │               │  │
│  └───────────────┘  └──────────┘  └──────────┘  └───────────────┘  │
│                                                                       │
│  ┌───────────────────────────────────────────────────────────────┐    │
│  │                    Viewer / Control Surface                    │    │
│  │  Thread Tree │ Conversation + Layer Bands │ Detail Drawer     │    │
│  │  Settings │ Analytics │ AI Assist │ Hotkeys │ Command Palette │    │
│  └───────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

### Module Dependency Graph (Three-System Split)

```
┌── System 1: Core Agent Infrastructure ──┐
│  agents/ (core, zero deps)               │
│    ↓                                     │
│  providers/ (LLM + runtime adapters)     │
│    ↓                                     │
│  adapters/ (memory backends)             │
└──────────────────────────────────────────┘
          ↓
┌── System 2: Evaluation ─────────────────┐
│  eval/ (fixtures, scoring, improvement)  │
└──────────────────────────────────────────┘
          ↓
┌── System 3: Control Surface ────────────┐
│  viewer/ (UI, analytics, settings,       │
│           AI assist)                     │
└──────────────────────────────────────────┘
```

**No circular dependencies.** Each module only imports from modules above it.

---

## 1. Agents (`src/agents/`)

### Context Layer

The fundamental unit. A layer is an independently managed context cache.

```ts
const layer = new ContextLayer({
  id: "conventions",
  trust: 8,            // higher = compressed last
  staleness: 60_000,   // ms before stale
  maxTokens: 4000,     // budget hint
  prompt: "Follow these project conventions strictly.",
  sources: [mySource],
});
```

**States:** `cold` → `warming` → `warm` → `stale` → `compressing`

Each layer carries:
- **Content** — the actual context text
- **Trust score** — determines compression priority (higher = kept longer)
- **Staleness** — automatic expiry timer
- **Prompt** — instruction explaining how this layer should be used
- **Sources** — `ContextSource[]` loaded in order on `warm()`

### Context Stack

Composes layers with token-budget assembly.

```ts
const stack = new ContextStack();
stack.addLayer(conventionsLayer);
stack.addLayer(memoryLayer);

// Token-budgeted assembly with prompt-layer pairing
const assembled = stack.assemble("You are a senior engineer.", layerFilter);
// Returns: { text, tokens, blocks: [{ role, id, content }] }
```

**Key feature: Prompt-Layer Pairing.** Each layer's prompt is included as a separate block, so the LLM knows *why* each piece of context exists.

### BaseAgent + AgentLLMConfig

Agents carry per-agent LLM configuration:

```ts
interface AgentLLMConfig {
  provider?: string;       // "anthropic", "openai", "gemini"
  model?: string;          // "claude-haiku-4-5-20251001"
  temperature?: number;    // 0 = deterministic
  maxTokens?: number;
  sources?: string[];      // layer IDs this agent can see
  maxDepth?: number;       // prevent infinite delegation
}
```

**Agent types:**
- `Executor` — takes context + payload, does work, returns full result
- `Decider` — returns only a slim decision (context stays behind)
- `Classifier` — Decider subclass for classification
- `Router` — Decider subclass for routing to destinations

### Thread

The orchestrator. Owns the stack, manages agents, runs dispatch through middleware.

```ts
const thread = new Thread("main", stack, {
  description: "Primary agent thread",
  tags: ["production"],
});
thread.register(classifier);
thread.register(executor);
await thread.dispatch("executor", payload);
```

**Features:** middleware chain (always/conditional tiers), signal bus, dispatch log, fan-out (`thread.fan()`), metadata (description, tags, status).

### Harness

Entry point for external callers. Every message gets a full Trace.

```ts
const harness = new Harness(thread);
harness.setClassifier("classifier");
harness.setRouter("router");
harness.setDefaultExecutor("executor");

const result = await harness.send({ id: "msg-1", payload: "build auth" });
// result.trace contains the full span tree
```

### Session Manager

Manages a tree of threads with lazy creation via blueprints.

```ts
const session = new SessionManager();
session.add(mainThread);
session.addBlueprint({
  match: /^feature-/,
  create: (id, parent) => {
    const stack = SessionManager.inheritLayers(parent, { copyAll: true });
    return new Thread(id, stack);
  },
});
// "feature-auth" thread created on first dispatch
await session.dispatch("feature-auth", payload, { sourceThread: mainThread });
```

### Trace

Full span tree of a message's journey. Each span records: kind, status, duration, input/output, error, annotations, context hash, layer visibility.

**Span kinds:** `ingress`, `classify`, `route`, `dispatch`, `execute`, `decide`, `middleware`, `writeback`, `egress`, `fan`

### Signal Bus

Typed pub/sub for side-channel information.

```ts
thread.signals.on("correction", async (signal) => {
  await memory.write(signal);
});
thread.signals.emit({ kind: "correction", content: "Use try/catch", source: "reviewer" });
```

### Planner

A new agent type that generates structured execution plans with topological step execution.

```ts
const planner = new Planner("planner", {
  provider: "anthropic",
  model: "claude-haiku-4-5-20251001",
});
thread.register(planner);
const plan = await thread.dispatch("planner", { goal: "implement auth" });
// Returns a DAG of steps executed in topological order
```

Steps are executed respecting dependency order, enabling parallel execution of independent steps and sequential execution where dependencies exist.

### Herald

Cross-agent observation layer. Herald monitors agent interactions and detects emergent patterns across the system.

**5 Pattern Detectors:**

| Detector | What it catches |
|----------|----------------|
| Duplication | Multiple agents producing overlapping work |
| Contradiction | Agents emitting conflicting outputs or recommendations |
| Convergence | Independent agents arriving at the same conclusion |
| Cross-pollination | Useful context from one agent applicable to another |
| Resource imbalance | Uneven load or token usage across agents |

### Active Memory

Levin-inspired trust competition system for context management.

- **Trust competition** — memory entries compete for attention based on trust scores; low-trust entries are displaced by high-trust ones
- **Dissolution** — entries that remain unused or repeatedly fail to contribute are dissolved (removed)
- **Access tracking** — every read/write is tracked to inform trust adjustments over time

### Corpus Compiler

Three-stage pipeline for converting raw context into optimized compiled form.

```
fluid → formal → compiled
```

- **Fluid** — raw, unstructured context (notes, signals, corrections)
- **Formal** — validated and structured (typed entries with metadata)
- **Compiled** — optimized for token efficiency (deduplicated, compressed, indexed)

### Token Tracker

Per-provider, per-model, per-agent cost accounting with budget enforcement.

- Tracks token usage (input/output) for every LLM call
- Aggregates costs by provider, model, and agent
- Enforces budget limits — agents are blocked when budget is exhausted
- Exposes data for the Analytics tab in the Viewer

### Compaction Strategies

4 strategies for reducing context size when token budgets are exceeded:

| Strategy | Approach |
|----------|----------|
| Trust-based | Evict lowest-trust layers first |
| LRU | Evict least-recently-used layers |
| Summarize | Replace verbose layers with LLM-generated summaries |
| Hybrid | Combines trust-based eviction with summarization for mid-trust layers |

### Lifecycle Hooks

16 hook points across the agent lifecycle, enabling fine-grained control over agent behavior.

- Hooks fire at key points: pre/post dispatch, pre/post execution, layer warm/stale transitions, compaction, session events, etc.
- **Plan-mode auto-shunt** — when a Planner is active, hooks automatically shunt dispatch into plan-mode execution
- **Budget guards** — hooks that intercept dispatch when token budgets are near exhaustion

### Other Primitives

- **CacheLifecycle** — rule-based lifecycle management with event queuing
- **HydrationRegistry** — ref-based context hydration (deferred loading)
- **MiddlewareChain** — composable pre/post dispatch hooks
- **InterventionLog** — manual operator overrides with correction signals
- **EventStream** — unified event bus (5K event history, push/pull)

---

## 2. Providers (`src/providers/`)

### LLM Providers

Zero SDK dependencies. Raw `fetch` to provider APIs.

```ts
interface LLMProvider {
  readonly id: string;
  complete(messages: LLMMessage[], opts?: CompletionOpts): Promise<CompletionResult>;
}
```

**Implementations:**
- `AnthropicProvider` — Anthropic Messages API (API key in header, system message extracted)
- `OpenAIProvider` — OpenAI Chat Completions (configurable baseUrl for Cursor, Ollama, Azure)
- `GeminiProvider` — Google Gemini (API key in `x-goog-api-key` header, not URL)

**Streaming:** All three providers support streaming via `AsyncGenerator<LLMStreamEvent>`, enabling token-by-token output for real-time UIs and progressive rendering.

**Embedding Providers:** `VoyageEmbeddingProvider`, `OpenAIEmbeddingProvider`, `GeminiEmbeddingProvider`

**Convenience factories:** `createCursorProvider()`, `createOllamaProvider()`

### Bridge Functions

```ts
// Convert assembled context to LLM messages
const messages = assembledToMessages(assembled, "What should I build?");

// Separate system message for Anthropic/Gemini
const { system, turns } = splitSystemMessage(messages);
```

### Runtime Adapters

Wrap agent runtimes (Claude Code, Codex, Cursor) with inject/teardown lifecycle.

```ts
interface RuntimeAdapter {
  prepareInjection(assembled: AssembledContext): ContextInjection;
  inject(injection: ContextInjection): Promise<() => Promise<void>>;
  onEvent(handler: RuntimeEventHandler): () => void;
}
```

**Implementations:**
- `ClaudeCodeRuntime` — injects via `.foundry-context.md`, generates hook scripts
- `CodexRuntime` — injects via `.foundry-instructions.md`
- `CursorRuntime` — injects via `.cursorrules`

All extend `BaseRuntime` which handles shared event emission, path safety (`safePath()`), and inject/teardown.

---

## 3. Adapters (`src/adapters/`)

Memory backends implementing `ContextSource` and `HydrationAdapter`.

| Adapter | Dependencies | Storage |
|---------|-------------|---------|
| `FileMemory` | None (built-in) | JSON files on disk |
| `SqliteMemory` | None (Bun built-in) | SQLite database |
| `MarkdownDocs` | None | Markdown file parsing |
| `HttpMemory` | None | Remote HTTP API |
| `RedisMemory` | redis (peer dep) | Redis key-value |
| `PostgresMemory` | prisma (peer dep) | PostgreSQL + pgvector |

Each adapter provides:
- `.asSource(id)` — returns a `ContextSource` for use in layers
- `.asAdapter()` — returns a `HydrationAdapter` for ref-based hydration
- `.signalWriter()` — returns a handler for auto-persisting signals

---

## 4. Eval (`src/eval/`)

PR-based evaluation system for self-improvement.

### Concept

Every merged PR is a complete training example:
- **Ticket** = input (what was requested)
- **Base commit** = context (what the repo looked like)
- **Squash diff** = golden output (what a human produced)

### PRFixture

```ts
interface PRFixture {
  id: string;
  pr: { owner, repo, number, title, url, mergedAt, mergeCommitSha };
  ticket: { number, title, body, labels, url } | null;
  baseSha: string;
  goldenDiff: string;
  files: PRFileChange[];
  meta: { filesChanged, additions, deletions, labels, complexity };
}
```

### Scorers

**DiffScorer** — heuristic, no LLM required:
- File overlap (did the agent touch the right files?)
- Volume match (additions/deletions ratio)
- Craft signals (debug artifacts, TODO/FIXME, hardcoded values)

**LLMScorer** — LLM-as-judge:
- Sends golden diff + agent output to LLM
- Returns structured rubric scores via JSON parsing

### Five Rubrics (0-100 each)

| Rubric | Measures |
|--------|----------|
| Completion | Did the agent address the full ticket? |
| Correctness | Does the output match the golden diff structurally? |
| Craft | Code quality, pattern adherence, naming |
| Efficiency | Quality ÷ tokens (same output, fewer tokens = higher) |
| Precision | Minimal diff, no drive-by refactors, no scope creep |

### FixtureRunner

```ts
const runner = new FixtureRunner({ provider, stack, scorer });
const result = await runner.run(fixture);        // single
const batch = await runner.runBatch(fixtures);    // batch with summary
const comparison = await runner.compare(fixtures, altStack);  // A/B test
```

### EvalStore (Persistence)

```ts
const store = new EvalStore(".foundry/eval");
const batchId = await store.save(batchResult, "baseline", "abc123");

// Regression tracking
const report = await store.compare(baselineId, candidateId);
// → { verdict: "improved", delta: { composite: +5 }, improved: [...], regressed: [...] }

// Trend analysis
const trends = await store.trends();
// → [{ rubric: "composite", direction: "improving", slope: 2.3, points: [...] }]

// Gap aggregation across batches
const gaps = await store.aggregateGaps();
const suggestions = await store.aggregateSuggestions();
```

---

## 5. Viewer (`src/viewer/`)

### Architecture

Preact + HTM + Signals UI (~5KB runtime, no build step).

**Three-panel layout:**
- **Left:** Thread tree (file-tree style), layers (colored dots), agents, live events
- **Center:** Conversation timeline with colored layer bands between spans
- **Right:** Detail drawer — span detail, layer detail, corrections

### Layer Bands

Thin colored strips between agent calls. Each layer gets a persistent color (hashed from ID). Hover shows name, click opens detail in right drawer. Visual density indicator for "how much context was in play."

### Hotkeys

| Key | Action |
|-----|--------|
| `1` `2` `3` | Focus tree / conversation / detail |
| `j` / `k` | Next / previous item |
| `Enter` | Expand / select |
| `Escape` | Close overlay / deselect |
| `Ctrl+K` | Command palette |
| `?` | Hotkey help overlay |
| `p` | Pause / resume thread |
| `i` | Inspect thread state |
| `s` | Open settings |
| `r` | Refresh all data |
| `a` | Open analytics tab |

### Settings Panel

Full configuration UI with five tabs:

- **Agents** — prompt, provider, model, temperature, maxTokens, visible layers, peers
- **Layers** — prompt, trust, staleness, maxTokens, source IDs
- **Providers** — enabled/disabled, base URL, model catalog with tier badges
- **Sources** — type, URI, enabled
- **Defaults** — global provider, model, temperature, maxTokens

**AI Assist:** Each section has an "AI Analyze" button. Each prompt editor has "AI improve." Suggestions appear as purple cards with one-click Apply.

### Analytics Tab

First-class cost tracking and usage analytics panel:

- **Stat cards** — total cost, total tokens, average cost per call, active providers
- **Budget gauge** — visual budget utilization with warning thresholds
- **Ranked models** — models sorted by cost/usage with per-model breakdowns
- **Ranked agents** — agents sorted by cost/usage with per-agent breakdowns
- **Thread costs** — cost attribution per thread
- **Call log** — full history of LLM calls with cost, tokens, latency, provider, model

### Server API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/traces` | GET | Paginated trace summaries |
| `/api/traces/:id` | GET | Full trace with span tree |
| `/api/interventions` | GET/POST | Intervention history / submit |
| `/api/threads` | GET | Thread state, agents, layers |
| `/api/events` | GET | Event stream (filterable) |
| `/api/actions` | POST | Operator commands (pause, inspect, etc.) |
| `/api/settings` | GET/PUT | Full config read/write |
| `/api/settings/:section` | PATCH | Partial config update |
| `/api/settings/:section/:id` | DELETE | Remove config item |
| `/api/assist` | POST | AI config analysis |
| `/api/assist/prompt` | POST | AI prompt improvement |
| `/api/assist/agent-config` | POST | AI model suggestion |
| `/api/analytics` | GET | Aggregated cost/usage analytics |
| `/api/analytics/calls` | GET | Paginated LLM call log |
| `/api/analytics/budget` | GET | Budget status and utilization |
| `/ws` | WebSocket | Live event stream |

### ActionHandler

Operator commands executed via `/api/actions`:
- `thread:pause` / `thread:resume` / `thread:archive`
- `thread:inspect` — returns full thread state
- `layer:warm` / `layer:invalidate`
- `agent:dispatch` — manually trigger an agent
- `runtime:command` — passthrough to runtime adapters
- `system:snapshot` — full system state dump

---

## 6. Database Schema (`prisma/schema.prisma`)

PostgreSQL with pgvector extension.

| Model | Purpose |
|-------|---------|
| `Entry` | Knowledge units (conventions, corrections, ADRs) with vector embeddings |
| `Trace` | Full span tree as JSONB |
| `Span` | Flattened spans for cross-trace queries |
| `Signal` | Typed side-channel information |
| `Intervention` | Manual operator overrides |
| `ThreadState` | Persisted thread metadata |
| `Message` | Conversation within threads |

---

## 7. Project Stats

| Metric | Value |
|--------|-------|
| Production code | ~16,300 lines (69 source files) |
| Test code | ~8,000+ lines (29 test files) |
| Tests passing | 472+ |
| Agent primitives | 25+ (including Planner, Herald, ActiveMemory, CorpusCompiler) |
| Compaction strategies | 4 |
| Lifecycle hooks | 16 hook points |
| Pattern detectors | 5 |
| Memory adapters | 6 |
| LLM providers | 3 |
| Runtime adapters | 3 |
| Eval rubrics | 5 |
| UI components | 13 |
| Circular dependencies | 0 |
| External runtime deps | 2 (hono, prisma) |

---

## 8. Running

```bash
# Install
bun install

# Tests
bun test tests/*.test.ts          # Unit tests (472+ tests)
bun test tests/db/                 # Database integration tests

# Demo
bun run src/demo.ts                # Run the agent demo
bun run src/eval-demo.ts           # Run the eval demo

# Viewer
bun run src/viewer/server.ts       # Open http://localhost:4400

# Typecheck
bun run --bun tsc --noEmit

# Database
docker compose up -d               # Start PostgreSQL
bun run db:push                    # Push schema
```
