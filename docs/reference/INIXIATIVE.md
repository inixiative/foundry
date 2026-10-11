# inixiative agentic stack: feature inventory

This is the same row-by-row inventory used for the Paseo and T3 Code dissections, applied to inixiative's own stack.

**Snapshot.** Read-only, from `origin/main` on 2026-10-11:

| Repo | Commit |
|---|---|
| agent-session | `08f5081` |
| Foundry + foundry-core | `d51564b` |
| Kingdom | `4f46cf5c` |
| Oracle | `6656362` |
| Archive | `b40602f` |
| signet | `6aa5937` |

**Path conventions.**
- `pf/` = `foundry/packages/foundry/src`
- `pc/` = `foundry/packages/core/src`
- `as/` = `agent-session/src`
- `k/` = `kingdom/`
- Other repos carry their name as a prefix.

**Maturity scale.**
- **solid:** wired and tested.
- **partial:** works, with gaps.
- **stub:** code exists but isn't wired, or it throws.
- **doc-only:** described in docs, absent from code.

> **`docs/SYSTEM-MAP.md` (dated 2026-09-30) is stale in many places.** Each drift is flagged where it applies, and they are all listed again in §5.

---

## 1. Identity

| Repo | Role | License | Stack | Packaging |
|---|---|---|---|---|
| **agent-session** | Runs native agent sessions (Claude CLI, Claude Agent SDK, Codex MCP/app-server). Also provides primed decision sessions, subscription pools, routing and limit probes. | MIT | Bun 1.4.2, TS 6.0.3, ESM, ~9.5k LOC src. Depends on `@inixiative/json-rules`, so README's "zero dependencies" claim is wrong. | npm `@inixiative/agent-session` **0.5.2** (SYSTEM-MAP says 0.3.0). Ships raw TS. Exports `.` and `./routing`. Agentic release lane. |
| **foundry-core** (`foundry/packages/core`) | Engine primitives: Thread, Harness, MiddlewareChain, ContextLayer/Stack, SignalBus, Executor, Trace, TokenTracker, model registry, memory adapters. | MIT | Bun, TS | npm `@inixiative/foundry-core` **0.4.0**. Exports `.` and `./delivery-evidence`. |
| **Foundry** (`foundry/packages/foundry`) | Local workspace: viewer + daemon, decision roles (Cartographer, Wardens, Librarian), MCP bridge into the worker, Kingdom Installation client, Archive capture. | BSL 1.1. Root `LICENSE:26` still has a "Foundry Oracle — Proprietary" section. | Bun + Hono + `Bun.serve` WS. SQLite primary store. Optional Prisma/Postgres, Redis/BullMQ, MuninnDB. Preact + htm UI, vendored, no build step. | npm `@inixiative/foundry` **0.4.0** (SYSTEM-MAP says 0.2.0). Exports `. ./providers ./adapters ./viewer ./jobs ./tools ./runtime ./kingdom`. Runs locally as a launchd daemon (`foundry/scripts/daemon/*`). |
| **Kingdom** | Hosted connector: identity, five owner classes, Integrations + Credentials, Signets, Installation pairing, hosted-Archive provisioning, inference gateway. | private, no LICENSE file | Bun/turbo. `apps/api` is Hono + zod-openapi, Prisma/Postgres, Redis, BullMQ, Bun WS. `apps/{web,admin,superadmin}` are React + TanStack Router. | Deployed app: API on Railway (`apps/api/Dockerfile`), web on Vercel. Not published. |
| **signet** | Shared wire contracts: DPoP proofs, Installation pairing, installation socket, renewing client. | MIT | Bun, TS | npm `@inixiative/signet` 0.3.0 |
| **Oracle** | Evaluation: fixtures from merged PRs and mined sessions, scoring, compare (CI-gateable), experiments, hosted summary viewer. | private, no LICENSE file | Bun, TS, Dockerfile. **No CI** (no `.github/`). | `@inixiative/oracle` 0.1.0, private. Depends on foundry-core ^0.4.0 and peer-depends on `@inixiative/foundry`. |
| **Archive** | Captures, stores and searches sessions (Claude Code, Codex, ChatGPT export, Foundry threads). Standalone authenticated server; sync to destinations. | MIT | Bun, Postgres + pgvector + pg_trgm (`archive/prisma/schema.prisma:6-10`). SYSTEM-MAP's "SQLite revisions" is stale. | npm `@inixiative/archive` 0.12.1 with CI. Docker / Compose / Railway / Render. |

---

## 2. Architecture map

```
 ┌──────────────────────────── your machine ────────────────────────────────────────────────┐
 │                                                                                           │
 │  launchd com.inixiative.foundry  (scripts/daemon/supervisor.ts:28-70)                     │
 │   └─ stages .foundry/releases/<sha>, imports start.ts                                     │
 │                                                                                           │
 │  ┌─────────────── Foundry process (pf/start.ts) ───────────────────────────┐              │
 │  │ Viewer HTTP+WS  127.0.0.1:${VIEWER_PORT||4500}  (start.ts:729,          │◀── browser   │
 │  │   viewer/server.ts:456-470,541-547; WS /ws open/snapshot/append/close)  │   (Preact)   │
 │  │ Harness → Thread.dispatch → MiddlewareChain → Executor                  │              │
 │  │ ThreadRuntime: Cartographer + Wardens + Librarian + FlowOrchestrator    │              │
 │  │ SQLite .foundry/sessions.sqlite   FileMemory .foundry/memory            │              │
 │  │ optional: Postgres :5932  Redis :6879  Muninn :8975/8976 (compose)      │              │
 │  └───┬─────────────────────┬────────────────────┬───────────────┬──────────┘              │
 │      │ npm import          │ npm import         │ HTTP          │ loopback MCP            │
 │      ▼                     ▼                    ▼               │ (mcp/transport.ts,      │
 │  agent-session         agent-session        Local Archive       │  proxy.ts launch file)  │
 │  HarnessSession        Claude/CodexPrimed   (Compose, :4700)    │                         │
 │  (executor, per        Sessions (decision   /api/v1/archive/*   │                         │
 │   thread)              roles, warm)         archive/src/        │                         │
 │      │ spawn+stdio            │ spawn        server.ts:71-218   │                         │
 │      │ stream-json /          │ text-only                       │                         │
 │      │ JSON-RPC               ▼                                  │                         │
 │      ▼                 claude --fork-session / codex app-server │                         │
 │  claude --input-format stream-json  |  codex app-server ◀───────┘ foundry_* MCP tools     │
 │                                                                                           │
 └───────┬──────────────────────────────────────────────────┬────────────────────────────────┘
         │ HTTPS + DPoP: /api/v1/access/*                   │ HTTPS tunnel (localtunnel /
         │ Installation WS (signet installationSocket.ts:   │  cloudflared, pf/viewer/tunnel.ts)
         │  authenticateInstallation, ping 20s, snapshots)  │  + handoff code (pf/viewer/handoff.ts)
         ▼                                                  │
 ┌──────────── Kingdom (hosted) ──────────────────────────┐ │
 │ apps/api  POST /api/v1/<module>/<action>                │◀┘ "Open Foundry"
 │   (apps/api/src/lib/routeTemplates/action.ts)           │
 │ WS upgrade apps/api/src/index.ts:36-42 (pub/sub,        │──── forwards /api/v1/archive/* ──▶ Hosted Archive
 │   data streams, installation sockets, Redis fan-out)    │      (archiveClientFor)            (Railway/Render,
 │ inference gateway access/gateway/:bindingId/v1/messages │                                    provisioned by Kingdom)
 │   (streamInference.ts:20-148, owner API keys)           │
 └──────────────▲──────────────────────────────────────────┘
                │ HTTP verifyAuthority via SignetClient (oracle/src/authority/kingdom.ts)
 ┌──────────────┴────────── Oracle ───────────────────────┐
 │ CLI oracle mine|run|score|compare|trends (src/cli.ts)   │  imports foundry-core (npm)
 │ hosted summaries /api/cycles,/api/batches               │  runs on paid API keys only (src/providers.ts)
 │   (src/hosted/server.ts:115-210)                        │  oracle-worker BROKEN (src/delegation/bootstrap.ts:57-66)
 └─────────────────────────────────────────────────────────┘
```

**Key entry files**

| What | File |
|---|---|
| Foundry boot | `pf/start.ts` (provider setup :211-330, ThreadRuntimeManager :461, ThreadFactory :486, Harness :565-578, port :729, shutdown :779-787) |
| Viewer server | `pf/viewer/server.ts` (Kingdom lock :178-195, WS :456-470, bind :541-547) |
| WS protocol | `pf/ws/types.ts`, `pf/ws/streams.ts`, `pf/viewer/data-streams.ts` |
| Flow middleware | `pf/agents/thread-runtime.ts:905-1270` |
| Executor | `pc/executor.ts:69` |
| Native session adapters | `pf/providers/session-adapter.ts:255` (interface), `:516` (Claude), `:831` (Codex) |
| Decision host | `pf/providers/primed-decisions.ts:122`, `pf/providers/subscription-decisions.ts` |
| MCP server | `pf/mcp/server.ts:306-627` |
| HarnessSession contract | `as/harness-session.ts:242-313` |
| Transports | `as/transport.ts:16-204`, `as/transports.ts:47-97` |
| Kingdom pairing (client) | `pf/providers/kingdom-pairing.ts:80-153` |
| Installation socket (client) | `pf/providers/kingdom-installation-connection.ts` |
| Kingdom pairing (server) | `k/apps/api/src/modules/access/services/installations/*` |
| Kingdom WS | `k/apps/api/src/ws/*` |
| Archive server | `archive/src/server.ts` |
| Oracle CLI | `oracle/src/cli.ts` |

---

## 3. Feature inventory

### A. Agent runtime and providers

| Feature | What / where | Mechanism | Maturity |
|---|---|---|---|
| Claude Code driver | `as/claude-code-session.ts:231` `ClaudeCodeSession` | One persistent `claude --print --input-format stream-json --output-format stream-json` process. Native resume and fork (`--resume <id> --fork-session`). Interrupt via the stdio control channel. | solid, verified live |
| Codex driver (app-server) | `as/codex-session.ts:1099` `CodexAppServerSession` | JSON-RPC: thread/start, thread/resume, turn/start. `turn/interrupt`. `push()` → `turn/steer`. Every server request gets -32601. `fork()` throws (`:1267-1271`). | solid (no fork) |
| Codex driver (mcp-server) | `as/codex-session.ts:830` | `codex mcp-server`. Still the default `CodexSession` export (`as/index.ts:30`). Foundry says Codex 0.155 dropped it (`pf/start.ts:299`) and defaults to app-server; agent-session AS-004 says it was verified on 0.155.1. **The repos disagree.** | solid / disputed |
| Claude Agent SDK driver | `as/claude-agent-sdk-session.ts:271` | Caller supplies the SDK `query`. Has `canUseTool` per-call approval (`:37-47`). Not used by Foundry. | solid, unused |
| ACP (Gemini CLI), API transports | `as/transports.ts:47-69` | Throw `TransportUnavailableError` | stub |
| Transport capability descriptors | `as/transport.ts:26-48` `TRANSPORTS` | Each transport declares resume, fork, rollback, interrupt, push, approvals, usage, limits, primed and billing, so callers can branch on capabilities | solid |
| Foundry executor binding | `pf/providers/session-adapter.ts:516,831` + `pf/providers/session-backed.ts:98` `SessionBackedProvider` | Wraps a HarnessSession per (thread, cwd) behind foundry-core `LLMProvider.complete()`. The thread→native-id map lives in `.foundry/sessions.json`. Foundry still `Bun.spawn`s through spawn hooks to wrap argv with its MCP bridge and an allowlisted env. | solid |
| Subscription auth | `pf/providers/subscription-policy.ts:26-42`, `subscription-authentication.ts`, `native-authentication.ts`; `as/claude-code-session.ts:415-423` | Default `~/.claude` / `~/.codex` logins. API keys stripped from the child env. `claude auth status --json` re-checked every 5 min. Codex must be a ChatGPT login and runs on a private `CODEX_HOME`. Shared-holder lock files. `apiTokens: true` is the only path to paid APIs. | solid |
| Model registry | `pc/model-registry.ts` (19 providers; `MAIN_THREAD_LABS` = anthropic, openai, google, meta, xai), `pf/models/registry.ts:53` (only `claude-code`/`codex` native) | Main threads: Anthropic and OpenAI on subscription; Google/Meta/xAI only with `apiTokens`. Decision default `claude-haiku-5-5` (Codex: `gpt-6-luna`); a substituted model is refused. | solid |
| Account pools / routing / limits | `as/pool.ts:204` `SubscriptionPool`, `as/routing.ts` (5 strategies), `as/limits-probe.ts` | Lease, cooldown, quartile-balanced ranking, cross-account `continueOn`. **Foundry uses none of it.** Its own account selection is in `pf/providers/provider-accounts.ts`, `native-authentication.ts` and `default-profiles.ts`. | solid lib / unused |
| Kingdom inference gateway | `k/apps/api/src/modules/access/services/streamInference.ts:20-148`; Foundry side `pf/providers/kingdom-client.ts:73-123`, `native-authentication.ts:285-310` | Native Claude launched with `ANTHROPIC_BASE_URL` = Kingdom and a RunBinding token. Kingdom decrypts the owner's API-key Credential and streams. Paid API capacity, not subscription. | partial (purpose undecided) |
| Legacy direct spawners | `pf/providers/claude-code.ts:148,228` `ClaudeCodeProvider` (imported in `start.ts:42`, never constructed); `pf/providers/native-text-provider.ts:249` | `claude -p` one-shots | dead code |

### B. Session and thread lifecycle

| Feature | What / where | Mechanism | Maturity |
|---|---|---|---|
| Thread object | `pc/thread.ts:187` | Status `idle/active/waiting/archived`. `dispatch` is the single boundary (`:322`). Dispose is terminal for the object (`docs/HARNESS_LIFECYCLE.md:101`). | solid |
| Create / send | `POST /api/threads` (`pf/viewer/routes/runtime.ts:902`), `POST /api/messages`, `/api/messages/send` (`:405,:646`) | Turn written to SQLite first. Duplicate → 409, failed write → 503. | solid |
| Native resume across restarts | `.foundry/sessions.json` + `--resume`; `as/claude-code-session.ts:486-488` auto-restarts a dead process when an external id exists | Restart marks in-flight turns `interrupted` and restores threads from SQLite (`pf/viewer/server.ts:228-229`). | solid |
| Admission/ownership evidence | `as/harness-session.ts:46-66,229-251` (`onAdmission`, `SessionAttempt`, `interruptNative`) | Registration before the native write. A send is refused while any attempt is `attempted/unknown`. | solid |
| Interrupt / stop a turn | `HarnessSession.interrupt()` releases only the local waiter; `interruptNative` exists | **No HTTP route or WS frame stops a running turn.** Operator `pause` only pauses cache lifecycle (`pf/viewer/actions.ts:98-127`). | stub (UI) |
| Archive / delete | operator `archive` action | Archive only; no delete | partial |
| Message tree, branch-pinned session ids, LRU warm pool, idle auto-archive | `docs/HARNESS_LIFECYCLE.md:45-56,193-205,275-296` | Target architecture. The doc cites `providers/harness-session.ts` and `providers/claude-code-session.ts`, which no longer exist in Foundry; they moved to agent-session. | doc-only |
| Thread naming | `pf/agents/thread-namer.ts` | Debounced decision call, 3–6 words | solid |

### C. Streaming and wire protocol

| Feature | What / where | Mechanism | Maturity |
|---|---|---|---|
| Data-stream WS | `/ws?client=<tabId>`; `pf/ws/types.ts:15-18`, `pf/ws/streams.ts:98`, `pf/ws/handler.ts` | Client sends `open`, `close`, `ping`. Server sends `connected`, `opened`, `{category:'data', action:'snapshot'}`, `{category:'data', action:'append'}`, `closed`, `openRejected`, `pong`, `error`. Snapshot and subscribe happen in one synchronous step, so appends follow the snapshot. **No sequence numbers, no replay**: reconnect means re-open and a fresh snapshot. Limits: 300 frames/10 s, 32 pending, 60 s stale sweep. | solid |
| Streams | `pf/viewer/data-streams.ts:14-27` | `thread:<id>` (turn, delta, activity, event appends; `done`/`error` only to the sending tab), `threads[:<projectId>]`, `prompts`, `events[:<threadId>]`, `flow:<threadId>`. Turn buffer shape in `pf/viewer/stream-buffer.ts:14-33`. | solid |
| Client | `pf/viewer/ui/data-stream-socket.js` | Re-opens on reconnect; 30 s heartbeat | solid |
| Kingdom gate on streams | `pf/viewer/server.ts:104-111,206-224,423-453` | Every open calls `kingdom.check()`. Losing authorization closes all sockets with 1008. 15 s re-check. | solid |
| Normalized native event stream | `as/harness-session.ts:82-177` | `text_delta, native_status, session_start/end, session_compact, text, tool_use, tool_result, thinking, usage, rate_limit, result, error`, with call/turn/item ids. In-process callbacks only. | solid |
| Kingdom-side mirror | `k/apps/api/src/ws/dataStreams.ts:16-38` | The same open → opened + snapshot + appends → close shape, fanned out over Redis | solid |
| HTTP surface | `pf/viewer/routes/{runtime,control,access,kingdom,devices,gloss}.ts`, `pf/archives/routes.ts` | `/api/events` is a JSON list, not SSE | solid |

### D. Workspaces and git

| Feature | What / where | Mechanism | Maturity |
|---|---|---|---|
| Worktree per thread | `pf/git/worktree.ts:4-9` | **Foundry does not create or destroy worktrees**; it lists existing ones. A thread's cwd is a worktree you pass in or the project path (`runtime.ts:925`). Picker in `pf/viewer/ui/detail-drawer.js:1257-1330`. | partial |
| Diffs | `diffStat` in `pf/git/worktree.ts`, never called | No diff UI | stub |
| Revert / fork | `POST /api/threads/:id/revert` and `/fork` (`pf/viewer/routes/runtime.ts:1024-1029,1063-1067`) | **501 whenever the local SQLite store exists (the default).** Without it, they only delete or copy Postgres message rows; files and native sessions are untouched. The native fork capability exists in agent-session and is unused. | stub |
| Checkpoints | `pf/persistence/checkpoint-import.ts` | Imports idle trace checkpoints as historical evidence. Not file or git snapshots. | n/a |
| Git context for Archive | `pf/archives/capture.ts` | Repo/branch references attached to snapshots | solid |

### E. Multi-agent orchestration

| Feature | What / where | Mechanism | Maturity |
|---|---|---|---|
| Pipeline roles | `pc/harness.ts:408-520`, `pf/viewer/config.ts:280-288` | Agent kinds: executor, classifier, router, cartographer, decider, domain-librarian. Classify + route run concurrently, then the executor. | solid |
| Decision roles in parallel | see F | Cartographer + N Wardens per message, on warm primed sessions | solid |
| Sub-agents / multiple executors per thread | — | **One executor per thread.** `parentThreadId` is metadata (tree in UI). | absent |
| Cross-thread awareness | `foundry_threads` MCP tool (`pf/mcp/server.ts:572-600`) | Read-only summaries of live threads in the project. No messaging. | partial |
| Herald, Planner, SessionManager | `pf/agents/herald.ts` (1002 LOC), `planner.ts`, `session.ts` | Exported and tested, never instantiated. `herald` and `librarian` are refused as agent kinds (commit `a2e81fa`). | stub |
| Human approval prompts | `pc/action-prompt.ts` `ActionQueue`, created at `pf/start.ts:382`, shown via `prompts` stream | Nothing calls `actionQueue.prompt()` | stub |
| Development team generator | `pf/development-team.ts`, `bun run team` | Generates domain-expert settings | solid (config tool) |
| Primed-session concurrency substrate | `as/primed.ts:140-284` (Slots, KeyedQueue), `as/claude-primed.ts`, `as/codex-primed.ts` | Parallel isolated decision calls with hedging | solid |

### F. Middleware / interception (the core)

Bare paths like `agents/x.ts` or `providers/x.ts` are under `pf/`.

#### F1. The primitive: Koa-style dispatch middleware — **solid**
- `pc/middleware.ts:4-31` — `DispatchContext { agentId, payload, timestamp, annotations, stack?: ContextStackView, threadId?, projectId?, messageId?, dispatchId? }`; `Middleware = (ctx, next) => Promise<ExecutionResult>`.
- `MiddlewareChain.use(id, fn)` / `useWhen(id, predicate, fn)` (`middleware.ts:63-70`): two tiers, `always` and `conditional`; composed in registration order in, reverse out (`:80-98`).
- One chain per `Thread` (`thread.middleware`); `Thread.dispatch` is the single boundary every entry point passes through (`pc/thread.ts:322-413`). It mints `dispatchId`, builds `ctx`, and wraps `agent.run(...)` in `this.middleware.execute(ctx, …)` (`thread.ts:413`).
- The only carrier from middleware to the executor is `ctx.annotations` (mutable bag). The executor reads `annotations.decoration` and `annotations.injectionPlan` (`pc/executor.ts:77-80`).

Middleware registered on every thread today (in order):
1. `factory:configured-sources` — lazy `stack.warmAll()` on first dispatch (`pf/agents/thread-factory.ts:465-471`).
2. `reactive` — post-dispatch reaction rules; only `lowConfidenceRule(0.5)` is installed, which emits an `info` signal (`agents/thread-runtime.ts:845-847`, `agents/reactive.ts:167-185`).
3. `flow-pre-message` — the FLOW.md pipeline (`agents/thread-runtime.ts:360,905-1087`).

Present in core but **not wired anywhere** (exported only): `HookRegistry` with 16 hook points incl. `pre:dispatch`, `pre:compact`, `plan:enter` (`pc/hooks.ts:5-133`); `permissionMiddleware` over `CapabilityGate` (`pc/permission-middleware.ts:38`). FLOW.md:803-805 lists the permission middleware as "already exists … integrates CapabilityGate into dispatch pipeline": the code exists, nothing installs it. **doc-only in effect.**

#### F2. The pipeline stages (Harness) — **solid**
- `pc/harness.ts:408-470` resolves stages: classify (always) → route (always) → conditional/on-demand `enrich` agents → `execute` (routed or default executor). `start.ts:565-578` auto-detects classifier/router/executor from settings agent kinds.
- Classify and route run **concurrently on the frozen message** (`harness.ts:497-520`); the router no longer waits for classification (`thread-factory.ts:554-558`). Each is an ordinary `thread.dispatch`, so each passes through the middleware chain.
- Classifier/router fall back to keyword classification/routing on any model failure (`thread-factory.ts:539-545, 607-617`).

#### F3. `flow-pre-message`: preMessage → hydrateDelta → executor → commitDelivery — **solid**
`agents/thread-runtime.ts:862-1087`, `agents/flow-orchestrator.ts`.
1. **Early start.** On the message's first decision dispatch (classifier or router, with a `messageId`), the middleware kicks off `prepare(message)` and parks the promise in `early` keyed by messageId (`thread-runtime.ts:908-915`); stale entries are pruned after 10 min (`:893-896`). So Cartographer + every Warden run in parallel with classify/route, not after.
2. **prepare()** awaits a non-blocking snapshot of pending learning (`_awaitPendingLearning`), warms any project-expert cache that is not warm, then calls `flow.preMessage(message, identity)` (`:862-887`).
3. **FlowOrchestrator.preMessage** (`flow-orchestrator.ts:441-526`):
   - *Freeze*: captures `threadState` (Librarian's `__thread-state` layer), and per domain its cache content/hash/staleness and its own thread-knowledge revision, before any await (`:484-504`).
   - *Assess*: `runBounded(domains, maxAdviseParallel)` → `DomainLibrarian.advise(...)` per Warden, concurrently with `Cartographer.route(...)` (`:517-522`). Per-call deadlines `adviseTimeoutMs`/`routingTimeoutMs` default 10 s; optional `planTimeoutMs`; a timeout is recorded as `timeout`, never cancelled — tracked in `_outstanding` (`:725-757`).
   - *Compose*: configured domain order, `contributionBudget` (chars) → `omitted`; a domain that contributes while the router selected other domains is a `routing-excluded` **conflict**, recorded not resolved (`:765-824`). Plan is deep-frozen (`sealedAt`).
   - `ContributionDecision = contribute | abstain | error | timeout | excluded | omitted` (`:76-82`); every contribution carries `segments {instructions, domainKnowledge, threadKnowledge}`, hash provenance and the exact `ParticipantRequest` sent (`:84-125`).
4. **hydrateDelta(plan)** (`:846-923`): sets focus on every layer to the frozen message (`layer.setFocus`), warms plan layers and focusable layers, diffs against the Librarian's injection ledger into `injected | skipped | reinjected`, and builds a `MessageDecoration` (`composeDecoration`, `:1191-1260`): one `decoration:routing` block (router selection + every domain's decision + conflicts) and one `## <domain> advice` block per contributing domain.
5. Middleware writes `ctx.annotations.injectionPlan` and `ctx.annotations.decoration` (`thread-runtime.ts:944-945`), journals the sealed `route` and `advice` phase records **before** the executor call (`:946-988`), then calls `next()`.
6. **Executor** (`pc/executor.ts:69-220`) assembles **every warm layer of the stack** (`assembleContext`) and appends the decoration blocks (`:77-84`). Refuses before any provider call if memory selection belongs to another message or a pinned record is blocked (`:138-175`). Records an `InjectionArtifact` with provider messages.
7. **commitDelivery** runs only if the executor produced `meta.injection.providerMessages` (evidence of delivery), emitting `context_loaded` per layer so the Librarian ledger reflects what was delivered (`thread-runtime.ts:1016-1074`, `flow-orchestrator.ts:930-943`). Assessed-vs-delivered revision drift is recorded per layer (`relation: assessed | advanced | inconsistent | unknown`).

Important mechanism facts:
- **The ledger does not reduce tokens.** The header comment says so explicitly: "The executor assembles every warm layer on every turn … `skipped` is informational for stateless providers" (`flow-orchestrator.ts:19-25`). The router's layer selection influences warming/focus and the decoration text, not which layers reach the worker.
- **How context reaches a native worker.** The executor sends `[system: <assembled context + agent prompt>, user: <payload>]` (`thread-factory.ts:635-644`). For Claude Code / Codex, `SessionBackedProvider` flattens that into one text turn `# System Context … # User Message …` (`providers/session-backed.ts:885-899`) and `send()`s it into the persistent native session **every turn**. So the full context is re-sent as user-turn text each message; it is not `--append-system-prompt`.
- Pre-message failure is non-fatal: the turn proceeds with no decoration (`thread-runtime.ts:993-995`).

#### F4. Decision roles: Cartographer, Wardens, Librarian — **solid (Cartographer, Wardens advise/guard/review), partial (Librarian)**
- **Cartographer** (context routing): builds a topology map from the stack, optionally loads an Atlas concept graph (`.atlas` or `MAP.md`) (`agents/cartographer.ts:235-314`); `route()` sends map+atlas as a `stablePrefix` (`:377-429`); model failure → `keyword-fallback` (`:445-447`). Instructions come from settings (`setRoutePrompt`, wired by commit `a2e81fa`).
- **Wardens** = `DomainLibrarian` (class name not renamed; FLOW.md:818 admits it). One per domain whose layer exists on the thread. Built-in defaults `docs | conventions | security | architecture | memory` with guard triggers (`thread-runtime.ts:169-179`); configured experts (`flowRole: "domain-advising"`, kind `decider|domain-librarian`, exactly one owned domain layer, no tools/peers/permissions) replace defaults (`agents/configured-experts.ts:24-120`).
  - `advise(message, threadState, {cache, threadKnowledge})` → `{layers, snippets, confidence, abstain?, reason?}` validated against `ADVICE_RESPONSE_PROTOCOL` (`domain-librarian.ts:1105-1166, 1332-1337`).
  - `guard(observation, threadState, …)` → `GuardResult {findings[{severity: critical|advisory, description, location?, suggestion?}], status: completed|skipped|cold-cache|provider-error|invalid-response|not-admitted}` (`:1176-1296, 567-601`). Only `completed` certifies an all-clear.
  - `review(...)` post-work learning → `{decision: learn|abstain, knowledge, facts, reason}` (`:884-1035, 1355-1363`).
  - Response protocols are appended by each phase, never by the configured instructions; validation now refuses instructions that restate a response format (commit `d51564b`).
- **Librarian** (`agents/librarian.ts`): programmatic reducer and sole writer of `__thread-state` (domain, recentActivity, flags, ledger). `security_concern` → flag `security-concern-active`; `guard_finding`/`correction` → activity lines (`librarian.ts:186-260`). Runs on a projected bus that strips `domain_learning` payloads to metadata (`thread-runtime.ts:732-750`).
  - **Bug:** `_handleClassification` overwrites `state.domain` before calling `domainShifted(category)`, so the "clear transient flags on domain shift" branch can never fire (`librarian.ts:236-258`).
  - As a settings agent kind, `librarian` (and `herald`) are now **refused** at build ("programmatic / unwired", commit `a2e81fa`).
- **Herald** (cross-thread): 1002 lines in `agents/herald.ts`, exported, never instantiated by `start.ts`; refused as an agent kind. **stub/unwired.** FLOW.md lists it as a live domain-advising role.

#### F5. Post-action guards — **partial**
- Every `tool_observation` signal on the thread bus (not from the orchestrator itself) triggers `flow.postAction(...)` (`thread-runtime.ts:1089-1270`). Trigger-gating is `DomainLibrarian.shouldGuard(tool)` = the configured `guardTriggers` set (`domain-librarian.ts:816-820`); guards run in parallel; each request and outcome is journalled (`guard-request`, `guard-outcome` phase rows).
- Native tool observations come from the worker's event stream after the fact: `createNativeToolProjector` maps native tool evidence to `meta.observeTool` (`thread-factory.ts:646-678`), which `Thread.dispatch` re-emits as `tool_observation` with the dispatch id (`pc/thread.ts:368-388`). There is **no pre-tool gate**: the Claude worker runs `bypassPermissions` (`agent-session/src/claude-code-session.ts:320`), Codex `approval_policy="never"`.
- **Critical findings are not pushed into the session.** `postAction` returns `critical[]`; the runtime only `warn()`s them to the log (`thread-runtime.ts:1239-1243`). The Warden also emits a `security_concern` signal (`domain-librarian.ts:1308`), which the Librarian turns into a `security-concern-active` flag in `__thread-state`, so the worker sees it on the **next** turn. FLOW.md's channel ④ "push immediately via MCP" (`FLOW.md:351,608-611`) and HARNESS_LIFECYCLE's mid-turn `push()` (`HARNESS_LIFECYCLE.md:215-223`) do not exist.
- **Memory "programmatic guard" is not programmatic.** The default `memory` domain has `programmaticGuard: true` but no `guardFn` is ever passed (`thread-runtime.ts:178,820`; only `configured-experts.ts:235` forwards the flag). `shouldGuard` returns true for every tool when `programmaticGuard` is set, and with no `guardFn` the guard falls through to the LLM path (`domain-librarian.ts:816-820, 1191-1245`). Net: when a `memory` layer exists, every tool call fires an LLM guard — the opposite of FLOW.md's "programmatic, ~0ms, free" (`FLOW.md:123,227,615-621`).
- `ProcessingStrategy` / `RuleCompiler` (compile-to-programmatic rules, `domain-librarian.ts:613-674`) is declared; `recompileOn` is never read. **stub.**

#### F6. Warm dedicated middleware sessions — **solid**
- Each role has its own auxiliary native session id `<thread>:aux:<role>` — `cartographer`, `domain:<d>`, `review:<generation>:domain:<d>`, `agent:<classifier|router>` (`thread-runtime.ts:52-60, 752-834`), wrapped by `scopedProvider` (`:72-139`). Auxiliary compaction is re-emitted as `auxiliary_*` so it never clears the central ledger (`:1293-1310`).
- In subscription mode (default) every decision role runs on `subscription-decisions` → `createPrimedDecisionHost` (`providers/primed-decisions.ts:122-573`) over agent-session's `ClaudePrimedSessions` (default since `facc556`, model `claude-haiku-5-5`) or `CodexPrimedSessions` (`decisionRuntime: "codex"`, `gpt-6-luna`).
  - `primedRequest` (`:80-114`): prime key = aux session id + hash(instructions); the `stablePrefix` (domain cache, or topology map + atlas) is primed once; each decision forks the primed session and sends only the per-cycle tail (thread state, message/observation, response protocol).
  - Bounds: tools off, `--setting-sources ""`, model substitution refused (`:491-493`), 100 kB input cap (`:406`), `maxCalls`, single turn; receipts in `decisions.jsonl` without prompt text (`:354-365`). 16 primed Claude roles max (`:36`).
  - Process-wide scheduler with priorities (pre-message > guard > review/naming), per-thread fairness, shedding, rate-limit backoff (`providers/subscription-decisions.ts`, `providers/decision-priority.ts`; documented in `docs/subscription-decisions.md:95-103`).
- So SYSTEM-MAP's "Draft #41 moves decisions onto agent-session primed sessions" (`SYSTEM-MAP.md:180-184`) is **done**; SYSTEM-MAP is stale on this point.
- Measured (doc, 2026-10-11): warm Haiku decision 1.1–4.3 s, median ~1.7 s; cold role 5–7 s (`docs/subscription-decisions.md:122`). FLOW.md's "~400 ms steady-state overhead" (`FLOW.md:363,747-752`) is not what the code achieves.

#### F7. Layering and configuration — **solid**
- Layers/sources/agents/projects live in `.foundry/settings.json` (`viewer/config.ts`); a project view is resolved by `resolveProjectView` (`viewer/config-resolve.ts`). Project agents are standalone or `extends` a global agent; instructions and domain knowledge concatenate under a heading per chunk (`composeChunks`, `config-resolve.ts:369`) or `override` (`:419-461`).
- Layer = `ContextLayer` with sources, staleness, warm/stale lifecycle, focus-driven selection (`pc/context-layer.ts`), assembled by `ContextStack` (`pc/context-stack.ts`). Each thread gets clones of the project template stack bound to its ownership scope (`thread-factory.ts:436-481`).
- Live settings: `configStore.onChange` → `factory.reconfigure` swaps sources/prompt/staleness on live threads, rebuilds agents, and pushes Cartographer/Warden instructions for the next turn; adding/removing/remapping a Warden waits for a new thread (`start.ts` configStore watcher; `thread-factory.ts:352-428`; `thread-runtime.ts:595-626, 2554-2570`). A versioned `settings-history.jsonl` records before/after (`viewer/config.ts:972-1315`).
- Example team: `examples/domain-team.settings.json` (classifier, router, `artificer` executor with `permissions: "bypass"`, four `expert-*` deciders each owning a `domain-*` layer).
- Gap (SYSTEM-MAP goal 7): no `layer test` / dry-run against recorded cases.

#### F8. How feedback becomes middleware — **partial (thread-private learning) / doc-only (cross-thread feedback loop)**
What actually runs:
- **Per-thread learning.** After each executor dispatch (`dispatch` signal) and each tool observation, every Warden reviews the completed work on its own review session and may `learn`, replacing its **thread-private** `thread-knowledge:<domain>` layer (`thread-runtime.ts:1272-1291, 1737+, 2407`; `domain-librarian.ts:278-530`). That layer is fed back into the same Warden's next advise/guard and assembled into the worker's context. Persisted per thread through `persistence/knowledge-persistence.ts`. It never leaves the thread; there is no promotion to project/global.
- **Corrections.** Viewer "Correction" → `POST /api/threads/:threadId/interventions` (`viewer/routes/runtime.ts:772`) → `correction` signal on that thread's bus (`pc/intervention.ts`). Since `a2e81fa` `correction` and `guard_finding` are **audit-only** memory kinds (`pc/adapters/file-memory.ts:54-75`): captured, never injected.
- **Pinned memory** kinds injected every turn: `instruction | pin | pinned | convention | decision | requirement` (`file-memory.ts:56-63`). A memory record of one of these kinds written via `foundry_memory`/`MemoryToolAdapter` is the only path by which feedback changes later behavior today, and it is manual.
What does not run:
- FEEDBACK-LOOP.md's `FeedbackCapture`, `feedback_item|event|resolution`, resolution queue, `foundry feedback import/export` — **none exist** (doc itself says "hypotheses, not a settled design", `docs/FEEDBACK-LOOP.md:3`).
- FEEDBACK-LOOP.md says "A pinned memory record of kind `rule` would be injected on every turn" (`FEEDBACK-LOOP.md:158`); `rule` is **not** in `pinnedKinds` (`file-memory.ts:56-63`). Doc and code disagree.
- `CorpusCompiler.ingestFromSignalBus` (`agents/corpus-compiler.ts:139`) and `RuleCompiler.recompileOn` have no callers. `FileMemory.publish` (thread→project/global) has no caller.
- DISTILLATION.md is self-declared "target architecture. No part of this pipeline is implemented today" (`docs/DISTILLATION.md:3`).

---


### G. Permissions and auth

| Feature | What / where | Mechanism | Maturity |
|---|---|---|---|
| Native tool permissions | `as/claude-code-session.ts:320,1115` (`bypassPermissions` default); `as/codex-session.ts:837-877,1438` (`approval_policy="never"`, `danger-full-access`) | The worker runs with permissions bypassed. Foundry overrides this only for tool-less or fixture sessions (`pf/providers/session-adapter.ts:659`, `dontAsk`). The example executor sets `"permissions": "bypass"` (`examples/domain-team.settings.json`). Claude `--permission-prompt-tool stdio` exists natively but is not wired (`as/transport.ts:87`). | **no gate** |
| CapabilityGate / permission middleware | `pc/capability.ts`, `pc/permission-middleware.ts:38` | allow / prompt / deny per capability with ActionQueue. Exported; used only in `pf/decisions/catalog-cli.ts:81` and typesafe. **Not in the dispatch chain.** | stub |
| MCP tool authority | `pf/mcp/authority.ts` | Pins MCP tool scope to one live thread. `foundry_signal` is refused on the default read-only native grant. | solid |
| Foundry ↔ Kingdom pairing (Installation) | Client `pf/providers/kingdom-pairing.ts:80-153` (signet `pairInstallation`, `kind:'foundry'`); server `k/.../installations/registerInstallation.ts:15-50`, `requestRegistration.ts:12-40` (12-hex review code, 10 min), `k/.../owner/controllers/ownerClaimRegistration.ts:20-96` → Inquiry `registerIntegration` (`k/.../inquiry/handlers/registerIntegration/index.ts:25-74`, auto-approves when the approver can manage the owner) → `preparePairedIntegration.ts:29-84` + `issuePairingSignet.ts:13-40` | DPoP key = identity. The owner approves through an Inquiry. Kingdom creates a `foundry` Integration and a Signet held by that Integration. Many-to-many through `kingdomIntegrations[]`. Key rotation and revoke exist. The runtime key (`kingdom_runtime_`, `RuntimeInstallation`) is gone. | solid |
| Pairing Signet scope | `k/packages/access/src/catalog.ts:228-234` | The `foundry` catalog entry has `operations: []`, so the pairing Signet is presence and identity only. `oracle` has no catalog entry. | partial |
| Signets | `k/.../schema/signet.prisma`; issue `issueSignet.ts:23-84`, revise `saveSignetRevision.ts:20-82`, revoke `ownerRevokeSignet.ts:14-32` | Recipient is User or Integration. Grants are `SignetRevision → SignetResourceGrant{operations, lens}`. Limits: `maxRequests`, `maxConcurrent`, expiry < 1 yr. Lens works only on `archiveLibrary` (`resolveArchiveSelection.ts:12-25`). Revoke sets `revokedAt`; tokens and enrollments are hard-deleted on soft delete (`hardDeleteOnTombstone.ts:11-22`). Audit-enabled. A legacy `access` JSON path remains (`ownerSchemas.ts:105`). | solid / partial (lens) |
| Enrollment + access tokens | `enrollSignet.ts:50-112`, `signetCredentials.ts:45-81`, nonces `signetNonce.ts` (Redis, 60 s) | Renewal secret up to 1 yr. 5-min DPoP-bound `kingdom_…` tokens, stored in **Postgres** `AccessToken` (CLAUDE.md says ephemeral auth goes in Redis). Static bearer tokens only for `proofRequired=false` Signets. | solid |
| Execution + usage | `executeAccess.ts:25-157`, `reserveAccess.ts:41-125` | Idempotent `requestId`, 429 on `maxRequests`/`maxConcurrent`, 60 s lease, `AccessExecution` + `UsageEvent` (not the audit log, matching CLAUDE.md). Real provider adapters: slack, teams, linear, notion, jira, drive, confluence, github, gmail, discord. | solid |
| Foundry agent use of grants | `pf/providers/kingdom-access-client.ts` (only `*.read`), `pf/tools/kingdom-access.ts:143`, `foundry_access` MCP tool, `pf/viewer/routes/access.ts:20-121` | Configured per grant through `kingdomAccess[]` and a credential file. `docs/kingdom-access.md` tells users to hand-issue static tokens. **Not through the paired Signet.** `foundry_access` still uses the dead "connections" term (`pf/mcp/server.ts:537`). | partial |
| Kingdom Token (own API) | `k/.../schema/token.prisma` | Role + entitlements, separate from Signets | solid |
| Dead terms still present | `k/packages/db/src/lib/encryption/registry.ts:16` `CONNECTION_SECRETS`; `renewConnections` job (`k/apps/api/src/jobs/handlers/index.ts:12,25,59`); Foundry `connectionId` (`pf/providers/session-backed.ts:52`, `native-authentication.ts:24`) | — | cleanup owed |

### H. Remote and multi-device

| Feature | What / where | Mechanism | Maturity |
|---|---|---|---|
| Viewer reachability | `pf/viewer/server.ts:541-547` | Loopback only | — |
| Tunnel | `pf/viewer/tunnel.ts`, `pf/viewer/request-auth.ts` | localtunnel (default) or cloudflared. Bearer token in `.foundry/tunnel-token`; 24 h HMAC cookie; origin checks. | partial |
| "Open Foundry" from Kingdom | `k/.../ownerOpenFoundry.ts:17-56`, `storeInstallationCredential.ts:14-44`; `pf/viewer/handoff.ts:7-47` | Kingdom stores the tunnel token as a Credential and reads presence `viewerUrl`. Foundry mints a single-use 120 s HMAC code and sets a SameSite=None cookie. CSP `frame-ancestors` lets paired Kingdoms embed the viewer (`server.ts:147-163`). | solid |
| Liveness / presence | signet `installationSocket.ts:105-185` (ping 20 s, HTTP poll fallback); `k/.../authenticateInstallationSocket.ts:30-56`, `installationSnapshot.ts`, DB hook `hooks/installationRefresh/hook.ts:14-60` → Redis → `refreshInstallationSocket.ts:16-37`; presence in Redis (`k/packages/db/src/redis/integrationPresence.ts:22-32`) | Snapshot = pending review, inquiries, held Signets; re-sent on change. Rotation closes 4409; revoke sends `installationRevoked` and closes 4401. Presence = online/restarting, `viewerUrl`, `sessionCount`. | solid |
| Viewer lock | `pf/providers/kingdom-installation-connection.ts:173-300,362`; `pf/viewer/server.ts:178-195` | A Signet counts as held while the socket is up or the snapshot is ≤150 s old. When unpaired-and-locked, everything except `/api/health`, `/kingdom`, `/api/kingdom/*`, `/ui/*` returns 503. | solid |
| Devices | `pf/devices/local-inventory.ts`, `/api/devices`, `foundry_device` MCP tool | `~/.foundry/device.json` identity. Local only, no sync. | partial |
| Mobile / multi-client | — | Any browser through the tunnel; no native app | — |

### I. Automation

| Feature | What / where | Mechanism | Maturity |
|---|---|---|---|
| Daemon + self-update | `scripts/daemon/{plist,supervisor,update,last-good,watch}.ts` | launchd KeepAlive. Releases staged per sha with a trial boot, stable/previous/failed state; a failed candidate is never retried. `autoUpdate` off/check/apply (default off). `settings.last-good.json` rollback. | solid |
| Background jobs | `pf/jobs/*` | BullMQ only when Redis **and** Postgres are configured. Handlers: persistTrace, persistMessage, persistSignal, warmLayers, cleanStaleTraces. `cron` types are declared; no recurring job is registered. | partial |
| Runtime jobs from Kingdom | — | **Removed on both sides.** `@inixiative/foundry/runtime` now exports only `SignetClient`, `SignetHttpError`, `KingdomInstallationConnection` (`pf/runtime/index.ts:1-9`). Kingdom has no runtime-job / Oracle-cycle models left. SYSTEM-MAP §2/§3 still describes them. | gone |
| oracle-worker | `oracle/src/delegation/bootstrap.ts:57-66` | Imports `RuntimeJobWorker`, `RuntimeJobRegistry`, `KingdomRuntimeConnection` from `@inixiative/foundry/runtime` and throws. **Cannot boot.** `oracle/src/runtime/handler.ts` is orphaned. | broken |
| Archive collectors | `archive/src/agents.ts`, `archive/src/collector.ts:10` | launchd/systemd agents capture Claude Code and Codex history continuously | solid |
| Hosted Archive provisioning | `k/.../schema/archiveHosting.prisma`, `ownerSetupArchive`, `ownerConnectHosting`, `advanceArchiveHosting` job; `k/packages/hosting/src/{railway,render}` | State machine deploying Archive to Railway or Render. SYSTEM-MAP goal 5 ("missing") is stale. | partial |
| Readiness / doctor / self-test | `pf/readiness.ts`, `pf/doctor.ts`, `pf/startup-self-test.ts` | Daemon boot gate | solid |
| VCR live-test cassettes | `pf/vcr/*`, `scripts/vcr/*` | Record and replay native stdio / JSON-RPC / WS / HTTP | solid |
| Scheduled agents, webhooks, triggers | — | none | absent |

### J. Extensibility

| Feature | What / where | Mechanism | Maturity |
|---|---|---|---|
| MCP tools into the worker | `pf/mcp/server.ts`: `foundry_device` :306, `foundry_query` :346, `foundry_conventions` :392, `foundry_memory` :453, `foundry_access` :531, `foundry_threads` :573, `foundry_signal` :605; live bridge `pf/mcp/transport.ts` + `proxy.ts` + `pf/providers/native-launch.ts:62` `withNativeBridge` | Loopback MCP server per native session. Capability in a 0600 launch file. Thread-pinned authority. The `pf/mcp/cli.ts` header says 5 tools; there are 7. | solid |
| Fixture bridge | `pf/mcp/fixture-bridge.ts` (`fixture_read/write/command`), `withIsolatedFixture` | Eval infrastructure (SYSTEM-MAP asks whether Oracle should own it) | partial |
| Settings-driven agents/layers/sources | `pf/viewer/config.ts:67-131`, `pf/viewer/config-resolve.ts` | Global templates plus per-project override/extend. Live reconfigure. Versioned `settings-history.jsonl`. | solid |
| Layer source types | `pc/adapters/{file-memory,markdown-docs,sqlite-memory,http-memory}.ts`, `pf/adapters/{postgres,muninn,redis,supermemory}-memory.ts`, Archive source `pf/archives/context-source.ts:13-56` | `ContextLayer` sources. Postgres and Muninn wired when env is set. Redis and Supermemory exported, unwired. Scope-aware only for FileMemory (`docs/HARNESS_LIFECYCLE.md:269`). | solid / partial |
| Tool registry (API tool loop) | `pc/tools.ts`, `pf/tools/*`, `pf/agents/tool-loop.ts` | Wired at boot: file memory, bash (rtk filter), Bun script, Kingdom access. `PlaywrightBrowser`, `HttpApi`, `JustBashShell` exported, unwired. **Only API providers use it**; native workers use their own tools. | partial |
| Execution environments | `pf/viewer/config.ts:235-249,333`; `docs/EXECUTION_ENVIRONMENTS.md` | `bash / just-bash / typescript / browser / hybrid` setting is **never read** | doc-only |
| RuntimeAdapter (file injection for Claude/Codex/Cursor) | `pf/providers/runtime.ts:10-78,184-360` | `.foundry-context.md` + event subscription. Never registered (`Project.setRuntime`, `registerRuntime` uncalled). | stub |
| Prompt files | `pf/prompts/composer.ts`, `pf/start.ts:190-206` | Writes CLAUDE.md, .cursorrules etc. into project dirs at boot | partial |
| TypeSafe / Jev | `pf/providers/typesafe*.ts`, `docs/typesafe-jev.md`, `scripts/jev-catalog.ts` | Shadow decisions; `createTypeSafeMiddleware` unwired | partial |
| Plugins / user hooks | — | User Claude settings, hooks and plugins are deliberately disabled for both worker and decisions (`--setting-sources ""`) | absent by design |

### K. Storage

| Store | Where | Contents | Maturity |
|---|---|---|---|
| Foundry SQLite | `.foundry/sessions.sqlite`, `pf/persistence/local-session-store.ts:224-269` | `session_threads, session_turns, session_messages, session_traces, session_knowledge, session_learning, session_phase, session_native, session_native_tools, checkpoint_traces` | solid (primary) |
| Foundry files | `.foundry/` | `settings.json` (+ last-good, history), `sessions.json`, `memory/` (FileMemory JSONL), `analytics/`, `layers/`, `agents/`, `prompts/`, `runtime-profiles/`, `kingdom/`, `decision-receipts/`, `tunnel-token`, `releases/`. Per user: `~/.foundry/device.json`. | solid |
| Foundry Postgres mirror | `foundry/prisma/schema.prisma` | Entry, Trace, Span, Signal, Intervention, ThreadState, Message. Optional; `db push`. | partial |
| agent-session | — | In-memory only. Native history lives in the CLIs' homes. Primed transcripts are deleted on evict. | by design |
| Kingdom | Postgres (Prisma) + Redis | Signets, Installations, Integrations, Credentials (encrypted), AccessExecution, UsageEvent, RunBinding, Capacity…; Redis for presence, nonces, pub/sub | solid |
| Archive | Postgres + pgvector + pg_trgm | Sessions, revisions, TagEdit/TagDefinition, Outbox/Receipts. `vector(1536)` column reserved, never written. Retention prune hourly. | solid |
| Oracle | `.oracle/` files | fixtures, `corrections.jsonl`, artifacts, store | partial |

### L. Observability and usage

| Feature | What / where | Mechanism | Maturity |
|---|---|---|---|
| Traces | `pc/trace.ts`, SQLite `session_traces`, UI `detail-drawer.js`, `inspector-data.js` | Span tree with `layerIds`, `contextHash` | solid |
| Phase journal (middleware audit) | `pf/agents/thread-runtime.ts:327-336,946-988,1137-1227` → `session_phase` | Exact route, advice and guard-request inputs plus guard-outcome rows, journalled at the call boundary | solid |
| Injection / delivery evidence | `pc/messages.ts` `InjectionArtifact`, `pc/delivery-evidence.ts`, `pc/native-evidence.ts` | Per-turn record of provider messages, layers included, assessed vs delivered hashes | solid |
| Token / cost analytics | `pc/token-tracker.ts`, `pf/viewer/analytics.ts`, `/analytics` page | JSONL rollups by provider, model, agent, thread, with budget. Cost estimates ignore subscription quota. | partial |
| Subscription limits | `as/limits.ts`, `as/limits-probe.ts` (unused by Foundry); Foundry shows decision-pressure events and flow-snapshot `limits` | No account quota view | partial |
| Decision receipts | `.foundry/decision-receipts/primed-*/decisions.jsonl` (`pf/providers/primed-decisions.ts:354-365`) | Ownership, model, prime and settlement; never prompt text | solid |
| Kingdom usage | `UsageEvent`, `AccessExecution`, `requestsUsed` | Per-Signet metering | solid |
| Logging / telemetry | consola (default), pino optional (`pf/logger/*`) | No OpenTelemetry anywhere | partial |

### M. UI/UX

| Feature | Where | Maturity |
|---|---|---|
| Stack | Preact + htm + signals, vendored modules, no build (`pf/viewer/ui/vendor/*`) | solid |
| Routes | `pf/viewer/ui/route.js`: workspace `/`; global settings (models, providers, kingdom, integrations, archive, tunnel, devices); per-project settings (integrations, archive, sources, gloss, overrides); `/analytics`; `/kingdom` | solid |
| Workspace | thread tree (`thread-tree.js`), project sidebar, conversation (reconciles interrupted/unconfirmed turns, `conversation.js`, `conversation-state.js`), `store.js` | solid |
| Middleware visibility | `flow-graph.js` (per-turn flow + learning loop), `graph-view.js`, `layer-band.js`, `detail-drawer.js` (traces, corrections form, worktree picker), `inspector-data.js` | solid |
| Setup | `wizard.js` first-run, `settings.js`, `kingdom-settings.js`, `access-settings.js`, `archive-settings.js` | solid |
| Utilities | command palette + hotkeys, self-chat (chat about configuring Foundry, `pf/viewer/foundry-self-chat.ts`), AI assist (`pf/viewer/ai-assist.ts`), voice dictation/TTS (`voice.js`), Gloss margin notes (`gloss.js`) | solid |
| Missing | stop button, diff view, terminal pane, approval prompts with a producer, file tree / editor beyond read/write routes | — |

## 4. The middleware seam

### 4.1 What middleware runs against today
Three layers, from most to least portable:

| Layer | Interface (file) | Depends on |
|---|---|---|
| Decision logic | `FlowOrchestrator` — `preMessage(message, identity?) → InjectionPlan`, `hydrateDelta(plan) → HydrationResult {content, decoration, injected, skipped, reinjected, pending, revisions}`, `commitDelivery({layers})`, `postAction(ToolObservation, hooks?) → GuardReport`, `onInvalidation()` (`pf/agents/flow-orchestrator.ts:163-284, 441, 846, 930, 953`) | foundry-core only: `ContextStack`, `SignalBus`, `LLMProvider` (via Cartographer / `DomainLibrarian` / `Librarian`). No agent-session, no runner. |
| Dispatch binding | `Middleware(ctx: DispatchContext, next)` + `ctx.annotations.{injectionPlan, decoration}` consumed by `Executor.run` (`pc/middleware.ts:4-31`, `pc/executor.ts:69-84`); installed by `ThreadRuntimeImpl` (`pf/agents/thread-runtime.ts:905-1087`) | Foundry's `Thread` / `Harness` / `Executor` — Foundry's own turn loop. |
| Runner I/O | `LLMProvider.complete(messages, opts)` (`pc/types.ts`), `SessionBackedProvider` over `HarnessSession` from `@inixiative/agent-session` (`pf/providers/session-backed.ts:98`), `SessionAdapter.createSession / bindSignals` (`pf/providers/session-adapter.ts:255-295`), native tool evidence → `observeTool` (`thread-factory.ts:646-678`) | agent-session transports; Foundry's MCP bridge injected into the worker (`providers/native-launch.ts:62`, `mcp/native-bridge.ts`). |

Signals the middleware listens to on the thread `SignalBus`: `tool_observation` (guards + learning), `dispatch` (learning review), `session_compacted` (clears the injection ledger, invalidates the plan; `flow-orchestrator.ts:1114-1126`), `context_loaded` / `context_evicted` (plan invalidation).

### 4.2 Coupling verdict
- The **decision core is decoupled**: `FlowOrchestrator` + Cartographer + Wardens + Librarian need only a `ContextStack`, a `SignalBus` and an `LLMProvider` for decisions. None of them imports agent-session or knows what runs the worker. Decisions themselves already run on a separate warm host (primed sessions) that is independent of whichever runner serves the main thread.
- The **binding is coupled to Foundry's own turn loop**: the middleware is a `Thread.middleware` entry that only fires for `kind === 'executor'` dispatches with a string payload (`thread-runtime.ts:906-916`), hands its output through `ctx.annotations` to Foundry's `Executor`, and gets delivery evidence back from `result.meta.injection` (`:1016-1018`). Tool evidence must arrive as `tool_observation` signals carrying a live `dispatchId` (`:1109-1117`) or it is recorded as uncorrelated and guards still run but outcomes cannot attach to a turn.
- An older, simpler adapter surface already exists and is unused: `RuntimeAdapter { prepareInjection(assembled), inject(injection) → teardown, onEvent(handler) }` with event kinds `session_start | session_end | tool_call | tool_result | completion | error | user_input | context_inject` (`pf/providers/runtime.ts:10-78`), implemented as file-based `.foundry-context.md` injectors for Claude Code, Codex and Cursor (`:184-360`). HARNESS_LIFECYCLE.md step 4 asks to reconcile it with `HarnessSession` (`docs/HARNESS_LIFECYCLE.md:288`); nothing calls it.

- The runner-side hooks Foundry would need already exist one layer down and go unused: agent-session's `HarnessSession.onBeforeSend(hook)` (pre-send transform, composes in registration order; `agent-session/src/harness-session.ts:242-313`, `claude-code-session.ts:495-501`) and `push({kind,text})` (real steer only on `codex-app-server` via `turn/steer`; Claude emits `push_ignored`). Foundry calls neither; `harness-session.ts:223-225` claims FlowOrchestrator uses `onBeforeSend`, which is false. HARNESS_LIFECYCLE.md:223 says these hooks are "not yet first-class on the interface" — they are on agent-session's interface; Foundry just doesn't use them.

So: yes, Foundry middleware can be put in front of a different runner (Paseo's daemon, T3 Code's server) as an adapter, by driving `FlowOrchestrator` directly (or a thin `Thread` + custom `Executor` whose handler forwards to the foreign runner) instead of agent-session. It does not require Foundry's runner; it requires Foundry's `Thread`/stack/bus to exist as the state holder for that conversation.

### 4.3 Adapter contract the foreign runner must offer
Mapped to what Foundry consumes today:

| Need | What Foundry does today | What the foreign runner must expose |
|---|---|---|
| **Pre-turn context injection** (required) | Re-sends the whole assembled context + decoration as `# System Context` text inside the user turn (`session-backed.ts:885-899`) | A hook that runs **before** a user turn is sent, can await ~2–7 s, and can prepend text (or set per-turn system/developer instructions). Must carry a stable turn id (`messageId`) so plan, delivery and tool evidence correlate. |
| **Delivery acknowledgment** | `result.meta.injection.providerMessages` gates `commitDelivery` (`thread-runtime.ts:1018`) | A confirmation that the turn was actually submitted with the injected text (else the ledger stays uncommitted, which is safe). |
| **Turn observation** (required for guards + learning) | Native tool events → `tool_observation {tool, input, output?, filesAffected?, dispatchId, callId}`; turn completion → `dispatch` signal with output | A per-turn event stream: tool call + tool result (name, input, output, files touched), assistant final text, turn completed/failed — each tagged with the turn id. PostToolUse-level is enough; streaming deltas optional. |
| **Session reset / compaction** | `session_compacted` signal clears the injection ledger (`flow-orchestrator.ts:1114-1126`) | An event when the runner compacts, clears, forks or replaces the underlying session, so the next turn re-delivers everything. |
| **Tool gating** (optional; Foundry has none today) | No pre-tool gate: worker in bypass mode; guards are post-hoc; critical findings only flag `__thread-state` for the next turn | A pre-tool approval callback (allow / deny / ask) if blocking guards are wanted. Foundry would have to add it (wire `permissionMiddleware`/`CapabilityGate`, or make `guard()` blocking for critical triggers). In agent-session the only per-call gate today is the Agent SDK transport's `canUseTool` (`agent-session/src/claude-agent-sdk-session.ts:37-47`); Claude CLI `--permission-prompt-tool stdio` exists natively but is unwired (`agent-session/src/transport.ts:87`). |
| **Mid-turn push** (optional; absent in Foundry) | Not implemented (`HARNESS_LIFECYCLE.md:223`) | Ability to inject a message into an in-flight turn, if critical findings should land before the turn ends. |
| **Working directory / identity** | `thread.meta.cwd`, worktree path passed as `cwd` to every decision (`thread-runtime.ts:72-79`) | The cwd/worktree of the session, so Wardens and the Cartographer's atlas see the same tree. |

Not needed from the foreign runner: model choice for decisions, auth for decisions, or tools for decisions — Foundry's primed decision host supplies those separately from the main runner.

---

## 5. Weaknesses, gaps and stubs

### Middleware (the product's core)
1. **No blocking interception.**
   - The worker runs with permissions bypassed (Claude `bypassPermissions`; Codex `approval_policy=never`, `danger-full-access`).
   - Guards run after the tool has already executed.
   - Critical findings are only logged (`pf/agents/thread-runtime.ts:1239-1243`), plus a `security-concern-active` flag for the next turn.
   - Neither FLOW.md's "push immediately via MCP" nor HARNESS_LIFECYCLE's mid-turn push exists.
   - `permissionMiddleware`, `CapabilityGate`, `HookRegistry` and `ActionQueue` are present but not wired.
2. **The "free" memory guard is an LLM call on every tool.** It sets `programmaticGuard: true` but has no `guardFn` (`thread-runtime.ts:178,820`; `domain-librarian.ts:816-820,1191-1245`).
3. **Full context is re-sent every turn as user-turn text** (`pf/providers/session-backed.ts:885-899`).
   - The injection ledger's `skipped` is informational only (`flow-orchestrator.ts:19-25`).
   - The router's layer choice does not reduce what the worker receives.
   - agent-session's `onBeforeSend` / `baseContext` (`--append-system-prompt`) are unused.
4. **Pre-message latency.** Warm Haiku decisions take a median of ~1.7 s and up to 4.3 s; a cold role takes 5–7 s (`docs/subscription-decisions.md:122`). FLOW.md promises ~400 ms.
   - The FLOW.md progressive-depth tiers ("only on domain shift", "reuse last middleware output") are **not implemented**: every Warden assesses every message.
   - The Librarian's domain-shift flag clearing is dead code (`pf/agents/librarian.ts:236-258`).
5. **Feedback → middleware is not closed.**
   - Learning is thread-private (`thread-knowledge:<domain>`) and never promoted to project or global.
   - Corrections are captured as audit-only and never resolved.
   - `FileMemory.publish`, `CorpusCompiler.ingestFromSignalBus` and `RuleCompiler.recompileOn` have no callers.
   - FEEDBACK-LOOP.md's capture/resolution design is unbuilt, and its claim that a `rule` record is pinned is false (`pc/adapters/file-memory.ts:56-63`).
   - Oracle's `corrections.jsonl` has no reader.
6. **No `layer test` / dry-run** for a configured Warden against recorded cases (SYSTEM-MAP goal 7).
7. **Herald (cross-thread) is unwired**, and it is refused as an agent kind. FLOW.md still lists it as a live role.

### Runtime and lifecycle
8. **No UI stop or interrupt for a running turn.** `interruptNative` exists in agent-session and is never reached from the viewer.
9. **No worktree per thread.** Revert and fork return 501 by default (`pf/viewer/routes/runtime.ts:1024-1029,1063-1067`). There is no diff view, and the native fork capability is unused.
10. **One executor per thread**; no sub-agent orchestration.
11. **No subscription harness for Google, Meta or xAI.** ACP and API transports are stubs (`as/transports.ts:47-69`).
12. **Foundry ignores agent-session's `SubscriptionPool`, routing and limit probes** and keeps its own account handling. Kingdom-supplied subscription accounts are wired nowhere.
13. **Dead code.** `ClaudeCodeProvider` (`pf/providers/claude-code.ts`) and `RuntimeAdapter` implementations (`pf/providers/runtime.ts`).
14. **The repos disagree on Codex mcp-server.** agent-session still defaults to it (`as/index.ts:30`); Foundry says Codex 0.155 dropped it (`pf/start.ts:299`).

### Kingdom, Oracle, Archive
15. **The Foundry pairing Signet grants no operations** (`k/packages/access/src/catalog.ts:228-234`). Agent integration access goes through hand-issued static tokens in files (`docs/kingdom-access.md`), not "everything through the paired Signet".
16. **Ephemeral auth tokens live in Postgres** (`AccessToken`), not Redis as CLAUDE.md asks.
17. **Inference gateway.** It runs on paid API keys (`streamInference.ts`); its role under subscription-only is undecided.
18. **oracle-worker cannot boot** against Foundry 0.4.0's `./runtime` exports (`oracle/src/delegation/bootstrap.ts:57-66`).
19. **Oracle's remaining gaps:**
   - It runs on paid APIs only (`oracle/src/providers.ts:30-174`) and refuses native execution (`oracle/src/runtime/handler.ts:83-98`).
   - It has no CI.
   - Scripts still import Kingdom source (`KINGDOM_TEST_SOURCE`).
   - The hosted UI links to Kingdom `/dashboard?oracle=1`, which no longer exists.
   - `layer-cycle.ts` leans on `any`.
20. **Archive gaps.**
   - Tags are heuristic, with no feedback/correction tag.
   - The embedding column is never written.
   - Imported sessions have no `turnId`.
21. **Dead "Connection" term remains:** Kingdom `CONNECTION_SECRETS` and `renewConnections`; Foundry `connectionId`; `foundry_access` "connections".

### Docs that disagree with code
- **`docs/SYSTEM-MAP.md`:**
  - versions (0.2.0 / 0.3.0) are stale;
  - "#41 pending" is stale: decisions already run on `ClaudePrimedSessions`;
  - it cites `codex-text-provider.ts` and `connection-check-job.ts`, which are gone;
  - its claims about Kingdom Oracle/runtime-job models, the `./runtime` job worker, `ARCHIVE_REMOTE_BINDINGS`, "no hosting integration" and Archive-on-SQLite are all out of date.
- **`docs/HARNESS_LIFECYCLE.md`:**
  - cites `providers/harness-session.ts` and `claude-code-session.ts`, which now live in agent-session;
  - says pre-send and push hooks are "not on the interface", but they are on agent-session's interface (Foundry just doesn't use them);
  - its message tree, LRU and archive store are unbuilt.
- **`docs/FLOW.md`:**
  - lists the permission middleware as wired; it is not;
  - describes the memory guard as programmatic; it is an LLM call;
  - promises an MCP push for critical findings; it is absent;
  - presents Herald as live; it is unwired;
  - claims ~400 ms overhead; measured warm decisions are ~1.7 s median.
- **`as/harness-session.ts:223-225`** says FlowOrchestrator uses `onBeforeSend`. It does not.
- **`docs/EXECUTION_ENVIRONMENTS.md`:** the setting it documents is never read.
- **`docs/DISTILLATION.md`:** self-declared not implemented.
- **`docs/FEEDBACK-LOOP.md`:** its claim that a `rule` record is pinned is false.
- **`pf/mcp/cli.ts`** says 5 tools; there are 7.
- **agent-session README** claims "zero dependencies"; it depends on json-rules.
- **Lab/QA leftovers** still in product repos: agent-session `docs/S1-*.md`, `scripts/s0/*`, `fixtures/s0/2026-09-07*`; Oracle `.oracle/qa/*-20260910/`, `docs/MACHINE-HANDOFF-2026-09-10.md`; Foundry `LICENSE:26` Oracle section.
