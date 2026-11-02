# Foundry

> Part of [inixiative](https://www.inixiative.com), technology for cooperation. See [all the projects](https://github.com/inixiative).

**Stop repeating yourself to Claude.**

Every agent session starts half-amnesiac, so you pay a re-alignment tax: you re-explain your conventions, your decisions and your taste. The model and the harness are outside your control. Your docs, rules and `CLAUDE.md` are the one layer you do control, and Foundry is the workspace around your agent that puts that layer to work.

The agent does what you want when it is told the right thing. Our bet is that your corrections compile into docs that tell it automatically. In early runs, when the corrections reached the agent before it planned, its plans came out right.

## What you get

1. **Stop repeating yourself to Claude.** What you've already decided reaches every session. Wardens notice what your request touches and point at what your codebase already has and where it's written down. They never block; your agent decides. (The chorus is off on a fresh install; turn it on per project.)
2. **Every agent you pay for, in one place.** Claude Code, Codex and Muse on your own subscriptions, a worker per thread, and every session captured. ACP apps such as Paseo and T3 Code can drive Foundry too.
3. **Stop being a meat proxy.** Your agent, their agent and the people in one thread, hashing out the work. *(Host side built; joiner view in progress.)*
4. **Stop checking a dozen apps.** Work comes to you, already understood. *(In progress: Kingdom streams GitHub, Slack and Linear events; the Foundry inbox is not wired yet.)*
5. **Set up your repo.** Foundry reads your repo and builds the docs and Wardens. *(In progress.)*

The voice of the codebase.

## How it works

1. **You work with your own agent.** Threads run Claude Code, Codex or Muse on the logins already on your machine, from Foundry's viewer or an ACP app. No API key needed.
2. **Wardens point.** Your docs are split into regions, one Warden per region. Each turn, every Warden asks "does this touch my region?" and, if so, names the existing thing and where it's written. The pointer goes to your agent, which decides what to do with it.
3. **Corrections are captured.** `/feedback` records a correction with its context so it can go into your docs, where every later session sees it.
4. **Every session is kept.** Sessions land in your local [Archive](https://github.com/inixiative/archive), and `foundry repeats` shows the corrections you keep giving, so you can see whether one stuck.

## Install

Requires macOS (the daemon is a launchd agent), [Bun](https://bun.sh) 1.4.4 or later, and Claude Code logged in (`claude`). For a Codex worker, also `codex login`. The local Archive runs on Docker.

```bash
bunx @inixiative/foundry-acp setup
```

This installs Foundry and `foundry-acp` globally, runs the daemon from `~/.foundry/home`, prints the settings for Paseo and T3 Code, and ends with `foundry repeats`. Then open http://localhost:4500. Details: [pointing a host at Foundry](docs/reference/FOUNDRY-ACP.md#10-pointing-a-host-at-foundry).

From source:

```bash
git clone https://github.com/inixiative/foundry.git
cd foundry
bun install
bun run setup
bun run start
```

## License

The core engine (`@inixiative/foundry-core`) and the ACP adapter (`@inixiative/foundry-acp`) are [MIT](./LICENSE-MIT). The Foundry app (`@inixiative/foundry`) is source-available under [BSL 1.1](./LICENSE-BSL): free to use, including inside your organization; not to sell or offer as a commercial service. It becomes MIT on 2030-04-06. See [LICENSE](./LICENSE).

---

## Under the hood

Foundry runs on your machine. It reaches Kingdom for identity, integrations and Signets, captures sessions into the local Archive, and runs native sessions through agent-session ([anatomy](docs/ANATOMY.md), [session archives](docs/session-archives.md), [Kingdom access](docs/kingdom-access.md), [subscription-only setup](docs/subscription-decisions.md), [native runtime authentication](docs/native-authentication.md)).

Underneath, Foundry is a framework for agent systems where you control the context, permissions and routing, not just the prompt.

- **Context layers:** stackable context slices with staleness and caching. Agents see what you decide they should see.
- **Wardens (the chorus):** one small, fresh model call per region of your docs. Layer 1 (Haiku) asks every region "is this mine?"; Layer 2 (Sonnet) confirms each yes and picks the primitive. A Warden answers with a pointer or `NO_COMMENT`; a timeout leaves the turn to proceed without it.
- **Tool gate:** structural tool rules decide each native tool request (allow, ask or deny). Asks surface in the viewer, or go to the ACP host, for approval. Core's capability gate is the underlying primitive.
- **Thread tree:** subagents are their own threads tied to their parent, stitched into Archive as one artifact.
- **Viewer:** the operator surface, in Kingdom's look. Not a log viewer.

## Structure

```
packages/
  core/     @inixiative/foundry-core   — engine primitives, zero external deps
  foundry/  @inixiative/foundry        — framework, providers, viewer, adapters
  acp/      @inixiative/foundry-acp    — ACP agent for host apps (Paseo, T3 Code, Zed)
```

Core is usable standalone. It includes context layers, agents, middleware, signals, thread, harness, tracing, hooks, and lightweight adapters (file, sqlite, http, markdown).

Foundry adds opinions: native Claude Code, Codex and Muse sessions via `@inixiative/agent-session`, API providers behind `apiTokens` (Anthropic, OpenAI, Gemini), the viewer, heavy-infra adapters (Postgres, Redis), and the middleware roles (Wardens, routing, thread state).

## Setup

Requires [Bun](https://bun.sh) 1.4.4 (the version in `packageManager`).

Setup (`bun run setup`) is interactive — picks your worker and model and creates `.foundry/settings.json` with one executor and nothing else. A fresh install's thread is **unwrapped**: your message goes to the native session (Claude Code or Codex) as typed, with no Foundry layers, classifier, router or thread state composed into it. Layers, sources and decision roles are opt-in settings; Wardens come from a project's regions (`.foundry/regions`) once its chorus is enabled (`"chorus": { "enabled": true }` in its `.foundry/project.json`). The default worker is the Claude Code subscription, which needs no key; only an API-key provider (with `apiTokens`) writes its key to `.env.local`.

An install set up before this default carries the old starter stack (system / conventions / memory layers, classifier → router → three prompt-only executors). `bun run doctor` flags it (`legacy-starter-defaults`), and `bun run setup --remove-legacy-defaults` (or the **Legacy defaults** item in `bun run setup`) removes whatever is still exactly as seeded; edited items are kept.

Provider choices come from the shared registry. The default worker is Claude Code through the subscription; Codex, Muse and API-key providers are settings, and each thread can run on any worker you have a login for.

Foundry is subscription-only by default: the Claude Code (or Codex) worker and Claude Haiku 5.5 decisions (through the same Claude login) use the logins already on the machine, so no API key is needed. Log in with `claude` first (and `codex login` for a Codex worker or Codex decisions). API-key providers require `"apiTokens": true` in `.foundry/settings.json`; see [subscription decisions](docs/subscription-decisions.md).

### Environment variables

```bash
# Only with "apiTokens": true — pick one provider
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AI...

# Optional
DATABASE_URL=postgresql://...   # Postgres memory tool (optional)
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

`bun run daemon:install` runs Foundry as a LaunchAgent. Before boot it starts the docker-compose services your `DATABASE_URL` and `MUNINN_URL` point at on this machine.

The daemon runs a release, not your working checkout: an exported commit with its own install under `.foundry/releases/<sha>`. With `"daemon": { "autoUpdate": "apply" }` in settings, it builds `origin/main` as a candidate (at startup and every `updateCheckSeconds`, default 300) and restarts onto it once no turn is queued or running (it waits up to `drainTimeoutSeconds`, default 3600, then restarts anyway). A turn a restart cuts off is settled on the next boot from the native session's own record (the Claude Code transcript or Codex rollout); one that record can't settle shows Continue and Retry on the thread. A candidate that boots becomes stable; one that fails to boot is marked failed, never retried, and the daemon relaunches on stable. `"check"` only logs that `origin/main` moved. Release state is in `.foundry/releases/state.json`.

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

Every part of Foundry, its name, where it lives and whether it is on: [the anatomy sheet](docs/ANATOMY.md).

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

### Harness (foundry-core)

Core's `Harness` dispatches a message through the agents you register. The classifier/router/executor setters are its simplest form; Foundry's own threads are unwrapped by default and add Wardens and layers by setting.

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

The viewer is a Preact dashboard served by Hono, with no build step (vanilla JS with htm tagged templates). It uses Kingdom's tokens and type.

- **Left rail:** Active threads (yours and shared), then Projects and the selected scope's threads.
- **Centre:** the thread's header band and tabs (Thread · Brief · Work · Loop), with the message box and pending approval cards.
- **Right panel:** Context · Participants · Permissions · Heralds · Pointers · Feedback; the inspector takes it over.
- **Board** (`b`): every thread by status, with filters. Status is colour, then shape: green working, orange needs you, red can't proceed.

Press `?` for every shortcut, or hold ⌥ while typing. `⌘K` opens the command palette.

## Acknowledgements

Big thanks to **[T3 Code](https://github.com/pingdotgg/t3code)** (Theo and the Ping team) and **[Paseo](https://github.com/getpaseo/paseo)**, open-source agent runners that helped shape the language Foundry uses and gave us a reference to check our work against. Thank you for working in the open.

Thanks to **UserEvidence** for supporting open-source software.

## Session archives

Foundry captures its durable sessions into this machine's local Archive (`bun run archive setup` starts it), which publishes onward to hosted Archives reached through Kingdom. See [setup and retrieval](docs/session-archives.md).

## Usage telemetry and context budgets

Claude cache reads/writes and original usage tags flow through sessions, providers,
traces, token tracking, and persisted analytics. Foundry defaults Claude Code to a
200k native compaction window with an 80% trigger (roughly 160k).
See [usage telemetry and native context budgets](docs/usage-and-context.md) for
configuration, counter semantics, and the limits of native compaction.
