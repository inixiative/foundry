# Foundry

Agent orchestration framework. Context layers, capability gating, multi-thread pipelines, real-time operator dashboard.

```
bun install
bun run setup
bun run start
```

Open http://localhost:4400.

## What this is

Foundry is a framework for building agent systems where you control the context, permissions, and routing — not just the prompt.

- **Context layers** — stackable, trust-weighted context with staleness, caching, and compaction. Agents see what you decide they should see.
- **Classify → Route → Execute pipeline** — incoming messages are classified, routed to the right executor with the right context slice, and traced end-to-end.
- **Capability gate** — agents request permission before dangerous operations. Three preset policies (unattended, supervised, restricted). Prompts surface in the viewer for human approval.
- **Multi-thread hierarchy** — spawn child threads with inherited or isolated context. Herald observes across threads and detects duplication, contradiction, convergence.
- **Viewer dashboard** — three-panel operator UI. Thread tree with prompt badges, live event stream, trace inspector, layer bands, intervention corrections. Not a log viewer — a control surface.

## Structure

```
packages/
  core/     @inixiative/foundry-core   — engine primitives, zero external deps
  foundry/  @inixiative/foundry        — framework, providers, viewer, adapters
```

Core is usable standalone. It includes context layers, agents, middleware, signals, thread, harness, tracing, hooks, and lightweight adapters (file, sqlite, http, markdown).

Foundry adds opinions: compaction strategies, session management, LLM providers (Anthropic, OpenAI, Gemini, Claude Code), the viewer, heavy-infra adapters (Postgres, Redis), and higher-order agents (Planner, Herald, Active Memory, Corpus Compiler).

## Setup

Requires [Bun](https://bun.sh) (v1.0+).

```bash
git clone https://github.com/inixiative/foundry.git
cd foundry
bun install
bun run setup
```

Setup is interactive — picks your LLM provider and model, creates `.foundry/settings.json`, writes `.env.local` with your API key, and scaffolds a starter config (3 context layers, classifier → router → executor pipeline, file-based memory).

Supported providers: Anthropic, OpenAI, Google Gemini, Claude Code CLI.

### Environment variables

```bash
# Pick one provider
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AI...

# Optional
DATABASE_URL=postgresql://...   # Postgres persistence
REDIS_URL=redis://...           # Redis adapter
VIEWER_PORT=4400                # Dashboard port (default: 4400)
FOUNDRY_MODE=supervised         # supervised (default) or unattended
```

## Running

```bash
bun run start        # Production — loads config, starts viewer + harness
bun run setup        # Reconfigure (additive — edit agents, layers, sources, projects)
bun run demo         # Demo mode with sample data
```

Send messages through the viewer chat or the API:

```bash
curl -X POST http://localhost:4400/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"message": "What is the project structure?"}'
```

## Testing

```bash
bun run test           # All tests (511 across core + foundry)
bun run test:core      # Core engine tests only (223)
bun run test:foundry   # Framework tests only (288)
bun run test:db        # Postgres tests (requires DATABASE_URL)
```

## Key concepts

### Context layers

```typescript
import { ContextLayer, ContextStack } from "@inixiative/foundry-core";

const system = new ContextLayer({ id: "system", trust: 1.0 });
await system.load(mySource);

const stack = new ContextStack();
stack.add(system);

const context = stack.assemble({ maxTokens: 8000 });
// Higher-trust layers win when budget is tight
```

### Capability gate

```typescript
import { ActionQueue, CapabilityGate, SUPERVISED_POLICY } from "@inixiative/foundry-core";

const queue = new ActionQueue();
const gate = new CapabilityGate(queue, SUPERVISED_POLICY);

// This blocks until a human approves in the viewer
await gate.require("file:write", {
  agentId: "code-writer",
  threadId: "main",
  detail: "Writing to /src/index.ts",
});
```

### Pipeline

```typescript
import { Harness, Thread } from "@inixiative/foundry-core";

const thread = new Thread({ id: "main" });
thread.agents.set("classifier", myClassifier);
thread.agents.set("router", myRouter);
thread.agents.set("executor", myExecutor);

const harness = new Harness(thread);
harness.setClassifier("classifier");
harness.setRouter("router");
harness.setDefaultExecutor("executor");

const result = await harness.dispatch("Fix the login bug");
// result.trace — full execution trace with timing
// result.output — agent response
```

## Viewer

The viewer is a Preact-based dashboard served by Hono. No build step — vanilla JS with htm tagged templates.

- **Left panel**: thread tree (with prompt badges), layers (color-coded by trust), agents, live event stream
- **Center panel**: conversation chat, pending prompt cards with approve/reject buttons
- **Right panel**: trace inspector, span details, layer detail, intervention corrections

Keyboard shortcuts: `1-3` switch panels, `?` help, `s` settings, `a` analytics.

## License

- `packages/core/` — [MIT](./LICENSE-MIT)
- `packages/foundry/` — [BSL 1.1](./LICENSE-BSL) (converts to MIT on 2030-04-06)

See [LICENSE](./LICENSE) for details.
