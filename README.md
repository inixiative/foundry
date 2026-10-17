# Foundry

Agent orchestration framework and harness. It wraps native Claude Code (and, as a setting, Codex) sessions with context layers, middleware (Wardens), a structural tool gate, multi-thread pipelines and a real-time operator dashboard. Host apps (Paseo, T3 Code, Zed) can drive it over ACP.

```
bun install
bun run setup
bun run start
```

Open http://localhost:4500, or point an ACP host at `foundry-acp` ([setup](docs/reference/FOUNDRY-ACP.md)).

For source-bound Claude Code and Codex credentials, see [native runtime authentication](docs/native-authentication.md).

Foundry runs on your machine. It reaches Kingdom for identity, integrations and Signets, captures sessions into the local Archive, and runs native sessions through agent-session ([session archives](docs/session-archives.md), [Kingdom access](docs/kingdom-access.md), [subscription-only setup](docs/subscription-decisions.md)).

## What this is

Foundry is a framework for building agent systems where you control the context, permissions, and routing — not just the prompt.

- **Context layers** — stackable context slices with staleness and caching. Agents see what you decide they should see.
- **Classify → Route → Execute pipeline** — incoming messages are classified, routed to the right executor with the right context slice, and traced end-to-end.
- **Tool gate** — structural tool rules decide each native tool request (allow, ask or deny); asks surface in the viewer, or go to the ACP host, for approval. Core's capability gate is the underlying primitive.
- **Multi-thread hierarchy** — spawn child threads with inherited or isolated context.
- **Viewer dashboard** — three-panel operator UI. Thread tree with prompt badges, live event stream, trace inspector, layer bands, intervention corrections. Not a log viewer — a control surface.

## Structure

```
packages/
  core/     @inixiative/foundry-core   — engine primitives, zero external deps
  foundry/  @inixiative/foundry        — framework, providers, viewer, adapters
  acp/      @inixiative/foundry-acp    — ACP agent for host apps (Paseo, T3 Code, Zed)
```

Core is usable standalone. It includes context layers, agents, middleware, signals, thread, harness, tracing, hooks, and lightweight adapters (file, sqlite, http, markdown).

Foundry adds opinions: native Claude Code and Codex sessions via `@inixiative/agent-session`, API providers behind `apiTokens` (Anthropic, OpenAI, Gemini), the viewer, heavy-infra adapters (Postgres, Redis), and higher-order agents (Cartographer, Wardens, Librarian).

## Setup

Requires [Bun](https://bun.sh) 1.4.2 (the version in `packageManager`).

```bash
git clone https://github.com/inixiative/foundry.git
cd foundry
bun install
bun run setup
```

Setup is interactive — picks your worker and model and creates `.foundry/settings.json` with one executor and nothing else. A fresh install's thread is **unwrapped**: your message goes to the native session (Claude Code or Codex) as typed, with no Foundry layers, classifier, router, Cartographer or thread-state composed into it. Layers, sources, decision roles and Wardens are opt-in settings. The default worker is the Claude Code subscription, which needs no key; only an API-key provider (with `apiTokens`) writes its key to `.env.local`.

An install set up before this default carries the old starter stack (system / conventions / memory layers, classifier → router → three prompt-only executors). `bun run doctor` flags it (`legacy-starter-defaults`), and `bun run setup --remove-legacy-defaults` (or the **Legacy defaults** item in `bun run setup`) removes whatever is still exactly as seeded; edited items are kept.

Provider choices come from the shared registry. All Claude for now (Claude Code through the subscription); Codex and API-key providers are settings.

Foundry is subscription-only by default: the Claude Code (or Codex) worker and Claude Haiku 5.5 decisions (through the same Claude login) use the logins already on the machine, so no API key is needed. Log in with `claude` first (and `codex login` for a Codex worker or Codex decisions). API-key providers require `"apiTokens": true` in `.foundry/settings.json`; see [subscription decisions](docs/subscription-decisions.md).

### Environment variables

```bash
# Only with "apiTokens": true — pick one provider
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AI...

# Optional
DATABASE_URL=postgresql://...   # Postgres persistence
REDIS_URL=redis://...           # Redis adapter
VIEWER_PORT=4500                # Dashboard port (default: 4500)
```

Local ports come from the `@inixiative/config` port registry (Foundry is block 5: viewer 4500, Postgres 5932, Redis 6879, MuninnDB 8975/8976; `bunx @inixiative/config ports foundry`).

## Running

```bash
bun run doctor       # Inspect existing setup without starting agents or making provider calls
bun run start        # Production — loads config, starts viewer + harness
bun run setup        # Reconfigure (additive — edit agents, layers, sources, projects)
bun run acp          # ACP agent on stdio (what hosts launch)
```

Send messages through the viewer chat or the API:

```bash
curl -X POST http://localhost:4500/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"message": "What is the project structure?"}'
```

### Daemon

`bun run daemon:install` runs Foundry as a LaunchAgent. Before boot it starts the docker-compose services your `DATABASE_URL`, `REDIS_URL` and `MUNINN_URL` point at on this machine.

The daemon runs a release, not your working checkout: an exported commit with its own install under `.foundry/releases/<sha>`. With `"daemon": { "autoUpdate": "apply" }` in settings, it builds `origin/main` as a candidate (at startup and every `updateCheckSeconds`, default 300) and restarts onto it once no job is running. A candidate that boots becomes stable; one that fails to boot is marked failed, never retried, and the daemon relaunches on stable. `"check"` only logs that `origin/main` moved. Release state is in `.foundry/releases/state.json`.

A boot of stable that fails on changed settings sets them aside as `.foundry/settings.rejected-<ts>.json` and restores the last settings that booted.

## Testing

```bash
bun run check          # The full check: typecheck (5 targets) + lint + test
bun run test           # Core + Foundry tests
bun run test:core      # Core engine tests
bun run test:foundry   # Framework tests
bun run test:acp       # foundry-acp tests
bun run test:browser   # Viewer browser suite (needs `bunx playwright install chromium`)
bun run test:db        # Postgres tests (localhost:5932, the compose Postgres)
```

## Key concepts

### Context layers

```typescript
import { ContextLayer, ContextStack } from "@inixiative/foundry-core";

const system = new ContextLayer({ id: "system" });
await system.load(mySource);

const stack = new ContextStack();
stack.add(system);

const context = stack.assemble({ maxTokens: 8000 });
```

### Capability gate

```typescript
import { ActionQueue, CapabilityGate } from "@inixiative/foundry-core";

const queue = new ActionQueue();
const gate = new CapabilityGate({ defaults: "prompt", capabilities: { "file:read": "allow" } }, queue);

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

- **Header**: Workspace / Settings / Analytics, and the selected project's name, centered
- **Left column**: navigation. Pinned Global and Forge Master, the projects, and below them the threads of the selected scope (with prompt badges); the two lists scroll independently
- **Center panel**: conversation chat, pending prompt cards with approve/reject buttons
- **Right panel**: trace inspector, span details, layer detail, intervention corrections
- **Settings**: besides configuration, the Layers, Agents and Activity (runtime events) of the selected thread

Keyboard shortcuts: `1-3` switch panels, `?` help, `s` settings, `a` analytics.

## License

- `packages/core/` — [MIT](./LICENSE-MIT)
- `packages/acp/` — [MIT](./LICENSE-MIT)
- `packages/foundry/` — [BSL 1.1](./LICENSE-BSL) (converts to MIT on 2030-04-06)

See [LICENSE](./LICENSE) for details.

## Session archives

Foundry captures its durable sessions into this machine's local Archive (`bun run archive setup` starts it), which publishes onward to hosted Archives reached through Kingdom. See [setup and retrieval](docs/session-archives.md).

## Usage telemetry and context budgets

Claude cache reads/writes and original usage tags flow through sessions, providers,
traces, token tracking, and persisted analytics. Foundry defaults Claude Code to a
200k native compaction window with an 80% trigger (roughly 160k).
See [usage telemetry and native context budgets](docs/usage-and-context.md) for
configuration, counter semantics, and the limits of native compaction.
