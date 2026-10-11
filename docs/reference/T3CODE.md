# T3 Code: architecture map and feature inventory

Source: `~/code/t3`, `pingdotgg/t3code` at **f23d0084b6** (2026-10-11 10:35 -0700). The clone is read-only reference; nothing was installed or run.

All paths are relative to the repo root. Claims come from reading code. Where docs and code disagree, the code wins and the mismatch is noted. **[Speculation]** marks inference not verified in code.

Compared against: inixiative Foundry, foundry-core, agent-session, Kingdom. Paseo is dissected in parallel under the same headings.

---

## 1. Identity

| | |
|---|---|
| Name | T3 Code: "an agent harness control surface" (README.md) |
| License | **MIT**, © 2026 T3 Tools Inc. (`LICENSE`) |
| Maintainers | Julius Marminge leads (1,460 commits since 2026-06; 303 of 982 since 2026-09-23). Then Theo Browne (569 / 157), "maria" (345 / 92), t3-code[bot], and a long tail. About 45 co-authors on the orchestrator PR. |
| Activity | 5,329 commits; the first is dated 2026-02-07. **982 commits between 2026-09-23 and 2026-10-11**, peaking at 124/day on 10/10. Release cadence: nightly every ≥6 h when there are new commits; stable promotes a nightly (`docs/operations/release.md`). Server and desktop are at version 0.0.45. |
| Contribution stance | "Mostly not accepting contributions… Big features will not be" (README.md). |
| Language and runtime | TypeScript end to end, on **Effect** (effect-smol / Effect 4 style: `Context.Service`, `Layer`, `Schema`, `effect/unstable/rpc`). Node ≥24.13 with built-in `node:sqlite`. pnpm 11 plus **Vite+** (`vp`). Rust for `native/resource-monitor` and C/Zig for the libghostty-vt WASM build. |
| Size | About 880k lines of non-test TS/TSX under `apps/` and `packages/`. Single files are enormous: `orchestration-v2/Orchestrator.ts` is 11,573 lines (431 KB), `ProjectionStore.ts` 278 KB, `ClaudeAdapterV2.ts` 9,269 lines, `ChatView.tsx` 12,177 lines. |
| Packaging | (1) **`t3` CLI/server**: npm `t3` launcher plus per-platform Node SEA binaries (`scripts/build-cli-archive.ts`), `curl \| sh` installers, `npx t3@latest`, and `t3 service install` (systemd/launchd). (2) **Desktop**: Electron 44 bundling the same server as a child process (dmg, AppImage, nsis, .deb, AUR, winget, scoop, brew). (3) **Hosted web client** at app.t3.codes (Vercel), a pure client of your own server. (4) **Mobile**: Expo 58 / RN 0.88 on iOS and Android (App Store and Play listed in README). (5) **Hosted relay "T3 Connect"**: a Cloudflare Worker (`infra/relay`). |
| Providers | Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity, Pi, Muse Code, and any ACP agent (registry or local command). |

---

## 2. Architecture map

```
                         ┌──────────────── hosted by T3 ────────────────┐
                         │ infra/relay  (Cloudflare Worker + Queues +   │
                         │  Durable Objects, PlanetScale PG, Clerk)     │
                         │  • env linking, DPoP creds, CF Tunnel mgmt   │
                         │  • APNs/FCM push, Live Activities            │
                         │  • webhook forwarder /v1/hooks/...           │
                         └───────▲──────────────────────▲───────────────┘
              HTTPS (relay API,  │                      │ signed publish (agent activity),
              Clerk + DPoP)      │                      │ mint-credential JWT, held-hook wake
 ┌───────────────────────┐       │        ┌─────────────┴──────────────────────────────────────┐
 │ CLIENTS               │       │        │ ENVIRONMENT = one `t3` server process (apps/server)│
 │ apps/web  (React 19,  │───────┘        │                                                    │
 │  TanStack Router)     │                │  HTTP (Effect HttpApi)   WS /ws (Effect RPC, JSON)  │
 │ apps/desktop (Electron│  direct LAN /  │  /.well-known/t3/...     WsRpcGroup  ~300 methods   │
 │  renderer = web build)│  Tailscale /   │  /api/auth/*, /oauth/*   RpcScopeAuthorization mw   │
 │ apps/mobile (Expo/RN) │  SSH -L /      │  /api/orchestration/*    subscribeThread/Shell      │
 │                       │  CF Tunnel     │  /api/hooks/:id/:token   dispatchCommand            │
 │ all share             │═══════════════▶│  /mcp  (MCP HTTP, OAuth) ◀── outside agents         │
 │ packages/client-runtime│ HTTP + WS     │                                                    │
 │ + packages/contracts  │                │  ┌──── orchestration-v2 (event-sourced core) ────┐ │
 └───────────────────────┘                │  │ ThreadMessageIntake / ThreadManagementService │ │
                                          │  │        │                                      │ │
 Outside agents (Claude Code, Codex,      │  │  OrchestratorV2.dispatch (decider, per-thread  │ │
 ChatGPT…) ── MCP over HTTP + OAuth ─────▶│  │   KeyedLock, receipts)                          │ │
                                          │  │        │ events + effects                       │ │
                                          │  │  EventSink ── one SQLite txn: events →          │ │
                                          │  │   projections → receipt → effect outbox         │ │
                                          │  │        │ PubSub (post-commit, ordered)          │ │
                                          │  │  EffectWorker (4 workers, leases, retries)      │ │
                                          │  │  Reactors: Settlement, PRSync, PRWatch,         │ │
                                          │  │   AgentAwarenessRelay, StorageCleanup, ...      │ │
                                          │  └────────┬───────────────────────────────────────┘ │
                                          │  ProviderSessionManager.decorateRuntime            │
                                          │  ProviderAdapterV2 (packages/provider-core)        │
                                          │  SQLite (node:sqlite, WAL) · node-pty terminals    │
                                          │  git worktrees + hidden-ref checkpoints            │
                                          │  Playwright headless browser · device hub          │
                                          │  native/resource-monitor (Rust child, JSONL)       │
                                          └──┬─────────┬─────────┬─────────┬─────────┬─────────┘
                                             │         │         │         │         │
           codex app-server        Claude Agent SDK   ACP JSON-RPC   HTTP/SSE    in-process
           JSON-RPC/stdio          query() → claude   over stdio     opencode    @cursor/sdk
           (effect-codex-          CLI (stream-json   (effect-acp):  serve       (Cursor);
            app-server)            control channel)   Grok, Antigrav., (OpenCode) pi --mode rpc
                                                      registry/local             (JSONL stdio);
                                                      ACP agents                 @muse-code/sdk
   each provider session also gets the `t3-code` MCP server injected (HTTP + per-session bearer)
```

### Apps

| App | Responsibility | Key entry files | Depends on |
|---|---|---|---|
| `apps/server` (npm `t3`) | **Everything that executes.** Provider processes, orchestration, SQLite, git, terminals, preview browser, MCP server, auth, scheduler, relay link. | `src/bin.ts:1-27` (fast path for `acp-mcp-bridge`/`acp-mcp-call`, else `binCli.ts`); `src/binCli.ts:57-90` (CLI tree); `src/server.ts` (Layer composition: `:262`, `:434`, `:550-656`; reactors wired `:510-579`; `/mcp` `:722-725`); `src/ws.ts:3157-3230` (`/ws` upgrade, RPC server); `src/http.ts`; `src/serverRuntimeStartup.ts:384-414, 507-538` (startup recovery order) | all `packages/*`, `@anthropic-ai/claude-agent-sdk`, `node-pty`, Effect platform-node |
| `apps/web` | Main UI: chat, sidebar, diff panel, terminal, preview, settings, PR review. Used by the hosted web app and the desktop renderer. | `src/main.tsx`, `src/router.ts`, `src/routes/*` (TanStack file routes), `src/components/ChatView.tsx`, `src/state/*` (Effect atoms) | client-runtime, contracts, provider client packages, `@pierre/diffs`, Tiptap, `@legendapp/list`, libghostty WASM |
| `apps/desktop` | Electron shell. Spawns the bundled server as a child (Node mode, bootstrap JSON on fd3), serves the renderer over the `t3code://` scheme, SSH/WSL backends, snap-shot capture, auto-update. | `src/main.ts`, `src/boot.ts`, `src/backend/DesktopBackendManager.ts:449-510`, `src/backend/DesktopBackendPool.ts`, `src/electron/ElectronProtocol.ts:16-17`, `src/updates/DesktopUpdates.ts` | client-runtime, contracts, ssh, tailscale, electron-updater, Clerk |
| `apps/mobile` | iOS/Android client with native modules for terminal (Ghostty), diff, markdown, composer, notifications and widgets. | `index.ts`, `src/App.tsx`, `src/Stack.tsx`, `modules/t3-*` | client-runtime, contracts, Expo SDK 58 |
| `apps/marketing` | Astro site; also serves `install.sh` / `install.ps1`. | `scripts/stage-install-scripts.mjs` | shared |
| `infra/relay` | Hosted T3 Connect control plane. Not in the data path. | `src/worker.ts`, `src/http/Api.ts`, `alchemy.run.ts`, `src/persistence/schema.ts` | contracts (`relay.ts`) |

### Packages

| Package | Responsibility | Key files |
|---|---|---|
| `contracts` | **The wire boundary.** Effect `Schema` for every RPC, command, event, setting and HTTP route. | `src/rpc.ts` (`WsRpcGroup` `:1878`, middleware `:1868-1876`), `src/orchestrationV2.ts` (entities `:364-1668`, events `:1736-1873`, commands `:2705-3221`, WS methods `:3238-3254`), `src/environmentHttp.ts:450-759`, `src/auth.ts:82-99`, `src/relay.ts` |
| `client-runtime` | Shared connection and domain state for web and mobile: multi-route connection supervisor, RPC session, thread/shell stores with sequence cursors, relay client. Private (not published). | `src/connection/{supervisor,routes,registry,driver}.ts`, `src/rpc/{session,protocol}.ts`, `src/state/{threads,shell}.ts`, `src/operations/commands.ts` |
| `provider-core` | **Provider SPI**: `ProviderDriver`, `ProviderInstance`, `ProviderAdapterV2`, `ProviderHost`, text generation, auth controller, handoff budget, IdAllocator, runtime/orchestration instructions. | `src/server/driver.ts:52-216`, `src/server/ProviderAdapter.ts:78-662`, `src/server/ProviderHost.ts:48-76`, `src/server/orchestrationInstructions.ts`, `src/server/runtimeInstructions.ts`, `src/server/handoffBudget.ts` |
| `provider-{cursor,grok,opencode,pi,muse,acp,acp-registry}` | Extracted provider drivers, each exporting `./client`, `./settings`, `./server`, and (except pi) `./testing`. | e.g. `provider-acp/src/server/{AcpSessionRuntime,adapter}.ts`, `provider-pi/src/server/{rpc,mcpExtensionSource}.ts` |
| `provider-testing` | Fake CLI, replay transcripts, `TestProviderHost`. | `src/{fakeCli,replayTranscript,replayGate}.ts` |
| `effect-codex-app-server` | Typed JSON-RPC client for `codex app-server`, with a 57k-line schema generated from `openai/codex`. | `src/client.ts:39-79`, `src/protocol.ts`, `scripts/generate.ts:18` |
| `effect-acp` | Generated ACP schema, JSON-RPC client/agent, stdio transport. | `src/*` |
| `source-control-core` + `-github/-gitlab/-bitbucket/-azure-devops/-forgejo/-gitcafe/-testing` | `SourceControlProvider` (repo ops) and `PullRequestProviderApi` (review surface) ports plus per-host drivers. | `source-control-core/src/server/SourceControlProvider.ts:112-197`, `PullRequestProvider.ts:330-721` |
| `shared` | Utilities: `AgentScope`, `DrainableWorker`, git helpers, project scripts, composer-context projection, PTY adapter, sqlite client. | `src/AgentScope.ts`, `src/composerContextReferences.ts`, `src/git.ts`, `src/projectScripts.ts` |
| `ssh`, `tailscale` | SSH launch/tunnel of remote servers (desktop only); Tailscale CLI wrapper. | `ssh/src/tunnel.ts:862-1159`, `tailscale/src/tailscale.ts` |
| `native/resource-monitor` | Rust sysinfo sampler speaking JSONL protocol v3. | `src/main.rs` |
| `.repos/` | Vendored reference sources (`effect-smol`, `alchemy-effect`) for agents to read. They account for most of the raw diff volume. | — |

Ownership rule (`docs/internals/overview.md`): execution stays in the environment that owns the workspace. Clients never substitute their own filesystem or credentials. Shared client logic lives in `client-runtime`.

---

## 3. Feature inventory

Maturity scale: **solid** = complete, heavily tested and in use; **partial** = works with known gaps; **experimental** = new (days old), beta-labelled, or thinly tested.

### A. Agent runtime and providers

| Feature | What / where / how | Maturity |
|---|---|---|
| **Provider SPI (Driver → Instance → Adapter)** | `ProviderDriver` (`packages/provider-core/src/server/driver.ts:176-216`) is a plain record so one driver can have many instances. It has `configSchema`, `create()` and an optional `usage` reader. `ProviderInstance` (`:82-131`) carries `orchestrationAdapter`, `textGeneration`, optional `auth`, `snapshot`, and `continuationIdentity {driverKind, continuationKey}`. Provider packages may only use the `ProviderHost` service (`ProviderHost.ts:48-76`): paths, settings, credentials and attachment resolution. | solid |
| **Adapter interface** | `ProviderAdapterV2` (`ProviderAdapter.ts:646-662`): `getCapabilities`, `planSelectionTransition`, `openSession` → `ProviderAdapterV2SessionRuntime` (`:534-644`). Required runtime methods: `events: Stream`, `ensureThread`, `resumeThread`, `startTurn`, `steerTurn`, `interruptTurn`, `respondToRuntimeRequest`, `readThreadSnapshot`, `rollbackThread`, `forkThread`. Optional: `injectHistory`, `compactThread`, `stopTask`, `stopSubagent`, `unloadThread`, `mcpApps`, `uploadFeedback`, `getModelContextWindow`. Turn input (`:405-426`) is `{appThread, runId, runOrdinal, attemptId, providerThread, message{text, attachments}, modelSelection, runtimePolicy{runtimeMode, interactionMode, cwd, approvalPolicy?, sandboxPolicy?}, appContext?}`. `readThreadSnapshot` is required but has **no production caller**. | solid |
| **Normalized events** | Adapters emit graph-shaped **upserts**, not deltas: `app_thread.created`, `provider_session/thread/turn.updated`, `node.updated`, `subagent.updated`, `message.updated`, `turn_item.updated`, `runtime_request.updated`, `plan.updated`, `turn.terminal` (`ProviderAdapter.ts:78-161`). They are consumed by `orchestration-v2/ProviderEventIngestor.ts:538-687`. Errors are a 15-class tagged union (`:364-380`). | solid |
| **Capability system** | `OrchestrationV2ProviderCapabilities` (`packages/contracts/src/orchestrationV2.ts:193-337`) has 12 groups (threads, steering, checkpointing, context, identity, tools, approvals, subagents, streaming, planning, runtimePolicy, and others). About 25 flags (`streaming.*`, most `tools.*`, `approvals.*`, `planning.*`, `subagents.*`, `runtimePolicy.enforcement`) have **zero non-test reads**. The ones that drive behaviour are read in `CommandPolicy.ts` and `Orchestrator.ts`. The doc `provider-capability-system.md:250-268` still shows a stale adapter contract (`sendRun`, `streamEvents`). | partial |
| **Codex** | Spawns `codex app-server` (`Adapters/CodexAdapterV2.ts:1501-1559`; args `provider/codexLaunchArgs.ts:12-15`; `T3CODE_CODEX_LAUNCH_ARGS` override) with `CODEX_HOME`, wrapped by `AgentScope`. Newline JSON-RPC via `effect-codex-app-server`. Uses `thread/start\|resume\|read\|fork\|inject_items\|compact/start\|goal/*`, `turn/start\|steer\|interrupt`, `thread/revert`, `mcpServer/tool/call`. Handles server requests for command, fileChange and permissions approvals, `requestUserInput` and MCP elicitation. `experimentalApi: true`. Version gate ≥0.156. Every capability is strong; `enforcement: native`. | solid |
| **Claude** | `@anthropic-ai/claude-agent-sdk ^0.3.276` `query({prompt: AsyncIterable, options})` (`Adapters/ClaudeAdapterV2.ts:680-719`), which spawns the `claude` CLI through an AgentScope wrapper (`:691-714`). Mapping: steer = `query.offer(msg, {priority:"now"})` (`:8705-8737`); rollback = close and resume with `resumeSessionAt` (`:9017+`); fork = SDK `forkSession`; approvals = `canUseTool` (`:7820-8050`); MCP servers are set over the control channel with `setMcpServers`, not argv (`:686-760`). `systemPrompt` is the `claude_code` preset plus T3 runtime and orchestration instructions appended (`:1052-1058`). There is **no `hooks` option**. Version gate: CLI ≥2.1.280. | solid |
| **Cursor** | In-process `@cursor/sdk` 1.0.35 local agent (`packages/provider-cursor/src/server/CursorAgentSdk.ts`). There is no subprocess. A process-wide `unhandledRejection` guard (`CursorSdk.ts:8-83`) stops SDK crashes from taking the server down. No approvals, rollback or fork. Docs (`install.md:141`) still describe the old CLI. | partial |
| **Grok** | ACP flavor: `grok [--permission-mode …] agent stdio` (`provider-grok/src/server/acpSupport.ts:55-83`), plus an xAI ACP extension for questions and exit-plan (`xaiAcpExtension.ts`). | partial–solid |
| **OpenCode** | `opencode serve` plus HTTP/SSE SDK. Two generations routed by probed version (`provider-opencode/src/server/driver.ts:111-133`): 1.x runs one server per thread; 2.x runs one server per instance with a T3 password. External `serverUrl` supported. Native rollback and fork. | 1.x partial, 2.x solid |
| **Pi** | `pi --mode rpc`, JSONL over stdio (`provider-pi/src/server/rpc.ts`). T3 **generates a Pi extension** (`mcpExtensionSource.ts:249-455`) with input, `before_provider_request`, `tool_call` and `before_agent_start` hooks. See F. | partial |
| **Muse Code (Meta)** | `@muse-code/sdk` MSP connection that spawns `muse` (`provider-muse/src/server/sdk.ts:6-10`). Beta, off by default. | experimental |
| **Antigravity (Google)** | T3 downloads `agy-acp-server` from dl.google.com (`provider/antigravityRelease.ts:19-80`), manages installs (`AntigravityInstallation.ts`), runs its own Google OAuth (`AntigravityAuth.ts`), and drives it through a 247-line ACP flavor (`orchestration-v2/Adapters/AntigravityAdapterV2.ts`). No replay fixtures. | partial |
| **Generic ACP / ACP Registry / local ACP command** | `provider-acp/src/server/AcpSessionRuntime.ts` speaks ACP protocol v2 (`session/new\|load\|resume\|prompt\|cancel\|set_model\|set_mode\|fork`…) and **serves the client side** (fs, terminal). The registry driver fetches `cdn.agentclientprotocol.com/registry/v1/latest/registry.json` and launches agents by binary, `npx` or `uvx` with pinned versions (`provider-acp-registry/src/server/AcpRegistrySupport.ts:48, 85-95`). Contains Devin, Copilot and Mistral exceptions despite a doc rule against agent-id checks. A "local ACP command" lets the user point at any ACP executable (`docs/user/providers-acp.md:26-35`). | runtime solid; registry partial |
| **Adding a provider** | The real registration point is `BUILT_IN_DRIVERS` (`apps/server/src/provider/builtInDrivers.ts:61-71`), hydrated by `ProviderInstanceRegistryHydration.ts`. Clients also register `providerDriverMeta.ts` and `makeProviderClientRegistry`. `orchestration-v2/builtInProviderAdapterDrivers.ts` is vestigial (test-only), although `adding-a-provider.md:104-129` says to register there. A replay-fixture harness covers ~89 scenario dirs with per-provider transcripts (`orchestration-v2/testkit/fixtures/`), and there are recorder scripts (`apps/server/scripts/record-*-replay-fixture.ts`). There is **no runtime plugin loading**: drivers are compiled in. The only runtime-pluggable path is a local ACP command. | solid in practice, doc stale |
| **Subscription vs API auth** | Default is the native CLI login (subscription). **Codex** has CLI mode (user's `CODEX_HOME`; multi-account via a "shadow home" auth overlay, `provider/Drivers/CodexHomeLayout.ts:8-66`, with `auth.json` private and everything else symlinked) and managed "Connect with ChatGPT" mode (T3 OAuth against auth.openai.com, T3-installed Codex, custom model provider `openai_token_sharing` with `ACCESS_TOKEN`, scrubbing `OPENAI_API_KEY`; `CodexManagedRuntime.ts:17-32, 94-103`). **Claude** uses one `CLAUDE_CONFIG_DIR` per instance (`provider/Drivers/ClaudeHome.ts:17-53`; HOME is left alone for keychain). Subscription vs API key is detected from SDK init `account.subscriptionType/apiKeySource`. API routing goes through per-instance env vars (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`). Ambient `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` are **not** scrubbed in CLI mode. | solid |
| **Credentials at rest** | `ServerSecretStore` (`apps/server/src/auth/ServerSecretStore.ts:155-317`) stores **plaintext files** in `stateDir/secrets/*.bin` (dir 0700, files 0600). There is no keychain and no encryption. `ProviderCredentialStore` keys are `provider-auth-<sha256(driver,binding)>`. | partial |
| **Model manifest** | `apps/server/src/provider/model-manifest.json` is bundled and re-fetched hourly from GitHub `main` (`ModelManifest.ts:39-43, 265-278`). It holds the full Claude catalog, Codex min-versions and per-driver CLI version compatibility ranges. `claudeModelOptions.ts` compiles a selection into `apiModelId`, effort, `promptEffort`, settings and a `queryIdentity` reuse key. | solid |
| **Provider switching mid-thread** | `ProviderSwitchService.ts:69-217` → `ProviderSessionTransitionPolicy.ts:34-96`. Outcomes: `reject`, `create_with_handoff` (different driver or `continuationKey`), `restart_and_resume`, `switch_model_in_session`, `reuse`. Accounts that share a Codex home or Claude config dir keep native continuity. | solid |
| **Context handoffs** | **Deterministic transcript selection, not LLM summaries.** `ContextHandoffService.ts:410-486` plus `provider-core/src/server/handoffBudget.ts:111-282` keep whole items prioritised last-user → last-assistant → first-user → newest. Budget is min(16k tokens, 64 KB, window headroom). Items are labelled `[Historical …]` and the footer tells the model to call `t3_thread_read`. Delivery uses native `injectHistory` (Codex `thread/inject_items` only) or a `<context>\n\nUser message:` prefix (`ProviderTurnStartService.ts:1121-1181`). The 240-char `compactText` (`ContextHandoffService.ts:96-130`) applies **only** to fork-delta summaries. `provider-switching-and-context.md` (LLM summaries) and `internals/context-handoffs.md` are inaccurate. | solid (mechanics); semantic summaries absent |
| **Text generation** | `ProviderTextGeneration` (`provider-core/src/server/textGeneration.ts:119-150`) covers commit message, PR content, branch name, thread title and PR review guide. It is routed per instance (`apps/server/src/textGeneration/TextGeneration.ts:59-96`). The default is Codex `gpt-6-luna`, low effort (`contracts/src/settings.ts:1241-1253`). Codex runs `codex exec --ephemeral -s read-only --output-schema` (`CodexTextGeneration.ts:192-230`); Claude runs `claude -p --json-schema --tools "" --strict-mcp-config` with `disableAllHooks` (`ClaudeTextGeneration.ts:172, 196-225`). | solid |

### B. Session and thread lifecycle

| Feature | What / where / how | Maturity |
|---|---|---|
| **Entity model** | AppThread (`orchestrationV2.ts:364-441`, with lineage, forkedFrom, settle/snooze/pin/archive timestamps, `createdBy`, `creationSource`), Run (`:543-588`), RunAttempt (`:601`, reason `initial\|steering_restart\|retry\|provider_recovery`), ExecutionNode (`:626`), Subagent (`:747`), ProviderSession/Thread/Turn (`:812/957/1073`), RuntimeRequest (`:1114`), ContextTransfer/Handoff, Checkpoint, and a 24-variant TurnItem (`:1463-1668`). IDs are deterministic where retries matter (`provider-core/src/server/IdAllocator.ts:260-360`). | solid |
| **States** | Run: `preparing, queued, starting, running, waiting, completed, interrupted, failed, cancelled, rolled_back` (`:455`). ProviderSession: `starting, ready, running, waiting, stopped, error`. ProviderThread: `not_loaded, idle, active, archived, closed, error`. RuntimeRequest: `pending, resolved, expired, cancelled`. Thread lifecycle is **timestamps, not an enum** (archivedAt, settledOverride/At, snoozedUntil, pinnedAt, deletedAt). | solid |
| **Turn start path** | WS `orchestration.dispatchCommand {message.dispatch}` (`ws.ts:1821-1869`) is gated by a startup command queue (`serverRuntimeStartup.ts:102-144`). Then `ThreadMessageIntake.dispatchCommand` → `Orchestrator.dispatchMessage` (`Orchestrator.ts:4513`), which emits `run.created` plus the `provider-turn.start` effect (`:5601`). `EffectWorker` claims it → `ProviderTurnStartService.start` → `RunExecutionService.startRootRun` (`RunExecutionService.ts:550`), which forks a detached fiber per run → adapter `startTurn`. A command ack means **intent committed**, not provider accepted. | solid |
| **Steering vs queueing** | Client `deliveryIntent: auto\|steer\|restart` resolves into modes `defer_start, steer_active, restart_active, queue_after_active, start_immediately` (`CommandPolicy.ts:120-164`). Under `auto`: no active run → start; preparing or starting → queue; otherwise native steer if supported, else queue, else interrupt-restart. Steering is native (`provider-turn.steer` effect) or interrupt-and-restart (new attempt `steering_restart`, `Orchestrator.ts:4351, 4495`). If the turn already finished, the worker re-dispatches the steer as a new start (`EffectWorker.ts:239-315`). | solid |
| **Queue** | A queued message **is a Run row** with `status: queued`, `queuePosition`, `queueHeld`. There is no queue table. Ordering: delegated-completion wakes first, then position, then ordinal (`QueuedRunOrder.ts:12-31`). Commands: `queued-run.reorder\|cancel\|edit`, `queued-message.promote-to-steer`, `queue.resume`. The queue drains via the terminal-run reactor (`Orchestrator.ts:11133`, `startNextQueuedRun :1275`). The UI supports drag-reorder (`apps/web/.../QueuedRunsControl.tsx`). | solid |
| **Cancellation** | `run.interrupt` (`dispatchRunInterrupt`, `Orchestrator.ts:9050`). With no provider turn yet it terminalizes locally and cancels pending start effects (`:9228-9345`); otherwise it issues `provider-turn.interrupt`. Stop with `holdQueue` also stops delegated tasks recursively (`delegated-tasks.stop`). Individual native subagents stop with `subagent.stop`. | solid |
| **Crash / restart recovery** | Startup order: legacy import → `ProviderRuntimeRecoveryService.recover` → `recoverDelegatedTasks` → EffectWorker → accept commands (`serverRuntimeStartup.ts:384-414`). Recovery **cancels rather than resumes**: queues are held, pending approvals become `expired / not_resumable`, in-flight runs, attempts, nodes and turns become `cancelled`, background work is noted for the next turn (`RestartBackgroundNote.ts`), and sessions stop (`ProviderRuntimeRecoveryService.ts:188-632`). The outbox cancels process-bound effects and requeues replay-safe ones (`EffectOutbox.ts:123-134, 490-524`). Opt-in `continueThreadsAfterServerUpdate` sends "Continue where you left off." only when the last run was running with a strong native ref (`RestartContinuation.ts`). | solid (continuation partial) |
| **Resume of provider sessions** | Sessions open lazily; persisted sessions are not resurrected (`ProviderSessionManager.ts:72-78`). Adapters `resumeThread` by native ref (Codex thread id, Claude session id, …). | solid |
| **Usage-limit auto-resume** | `UsageLimitRecoveryWorker.ts` re-arms a thread that failed with `usage_limit` once the reset passes. | partial |
| **Settlement ("inbox")** | `ThreadSettlementService.ts:251-664`: a 1-minute sweep plus event-driven checks. Settles on PR merge/close or after N idle days. The guarded `thread.auto-settle` command rejects if anything changed since its snapshot. Settling detaches idle sessions, closes idle terminals and runs `runOnSettle` project scripts. Also snooze, pin, archive (cancels queue and revokes MCP credentials, `Orchestrator.ts:3302-3460`) and delete (`ThreadDeletion.ts`). | solid |
| **Fork / merge-back / lineage** | See D. Lineage is `{parentThreadId, relationshipToParent: fork\|subagent, rootThreadId}`. | fork solid, merge-back partial |
| **`/goal`** | Native goal commands for Codex (`thread/goal/*`) and Claude, with goal state on ProviderThread (`orchestrationV2.ts:929`). Commit a172e1c4e8. | experimental |

### C. Streaming and wire protocol

| Feature | What / where / how | Maturity |
|---|---|---|
| **Transport** | A single WebSocket `GET /ws` speaking **Effect RPC with JSON serialization** (`apps/server/src/ws.ts:3157-3230`; `RpcSerialization.layerJson :3211`). It requires the protocol query param equal to `ORCHESTRATION_PROTOCOL_VERSION = 2` (`contracts/src/environment.ts:13`), otherwise HTTP 426. `disableFatalDefects` means one handler crash fails only its own request. Client: `client-runtime/src/rpc/session.ts:198-212`, ping 5 s, timeout 15 s, no RPC-level retry. | solid |
| **RPC surface** | `WsRpcGroup` (`contracts/src/rpc.ts:1878`) has roughly 300 methods across orchestration (15), projects, server/admin, ACP registry, diagnostics, provider auth and install, vcs/git (~30 `pullRequests.*`), review, terminal, preview, device, filesystem, scheduledTasks, secrets, cloud and mcpApps. Many are `stream: true` subscriptions. **Every RPC requires a declared scope** (`apps/server/src/auth/RpcAuthorization.ts:45-216`, a type-checked total map). | solid |
| **Read-only HTTP mirror** | `GET /api/orchestration/shell`, `/threads/:id`, `/threads/:id/bounded`, `/threads/:id/history` (`contracts/src/environmentHttp.ts:610-640`; `orchestration-v2/http.ts`). There is **no HTTP command endpoint**. | solid |
| **Event schema** | Effect `Schema` throughout. `OrchestrationV2DomainEvent` (`orchestrationV2.ts:1736-1873`) has 24 event types. Unions are forward-compatible (`kindUnionWithFallback :856`, unknown events decode and still advance cursors). The stored envelope adds a global `sequence` and `commandId` (`:2075`). | solid |
| **Per-thread stream** | `orchestration.subscribeThread` (`ws.ts:746-940`) yields `snapshot \| event{sequence} \| synchronized \| unknown-event`. Without a cursor: snapshot (full or bounded) then live events. With `afterSequence`: bounded replay, unless the cursor is too old, there are more than 128 events, the payload is over 1 MiB, or the range contains a create event, in which case it sends a fresh snapshot (`ThreadStream.ts:15-30, 107-124`). Wire projection truncates large fields to 32 KiB / 16 KiB (`WireProjection.ts:1-5`) with on-demand `getTurnItem`. Live tool-call updates are coalesced (`ThreadLiveEventCoalescer.ts`). | solid |
| **Shell stream** | `subscribeShell` (`ShellStream.ts`) sends a sidebar-level snapshot plus `project.*` / `thread.updated\|removed` deltas coalesced per aggregate, so a client watching one thread does not pay for every thread's history. | solid |
| **History paging** | `threadHistoryPaging.ts`: pages of 10 user turns / 75 items / 1 MiB, opaque base64 cursor (`:13-17, 114-128`). | solid |
| **Ordering and backpressure** | `EventSink.commitThenPublish` holds a single-permit publish lane so subscribers never see N+1 before N (`EventSink.ts:232-262`). `stream()` subscribes, reads the high-water mark, replays from SQL in pages of 256, then goes live (`:681-760`). `LiveStreamBudget.ts` caps buffered live items at 1000. | solid |
| **Client sync** | `client-runtime/src/state/threads.ts` drops `sequence <= lastSequence` (`:444-469`), re-subscribes with `afterSequence` (`:888`), and caches settled snapshots. The connection supervisor backs off exponentially up to 5 min and probes for better routes every 60 s (`connection/supervisor.ts:40-54, 134-145`). | solid |
| **Idempotency** | Command receipts (`CommandReceiptStore.ts`, table `orchestration_command_receipts`). A duplicate `commandId` returns the original `resultSequence`; rejected commands are remembered; effect IDs are deterministic per command (`Orchestrator.ts:10889-11094`). | solid |

### D. Workspaces and git

| Feature | What / where / how | Maturity |
|---|---|---|
| **Worktree per thread** | Launch strategies are `root \| worktree \| existing_worktree` (`orchestration-v2/ThreadLaunchService.ts:53-62`). Worktrees live in `~/.t3/worktrees/<repo-basename>/<branch-with-dashes>` (`config.ts:156`, `vcs/GitVcsDriverCore.ts:3404-3554`), created with `git worktree add -b <tmp> <path> <startRef>` under a temporary branch `t3/<8hex>` (`packages/shared/src/git.ts:14, 119-141`). Branches are later renamed by an LLM-generated name (`ThreadLaunchService.ts:339-372, 495-536`); the directory keeps its temporary name. Optional `startFromOrigin` fetch, submodule init, and base recorded in git config `branch.<b>.gh-merge-base`. Stages: fetch → checkout → setup-script → agent. A missing worktree self-heals at turn start (`ProviderTurnStartService.ts:459-495`). Agents can create one mid-thread with `t3_worktree_handoff` (`mcp/WorktreeMcpService.ts:230-300`). | solid |
| **Setup / settle scripts** | `ProjectScript {runOnWorktreeCreate, runOnSettle, async, previewUrl, …}` (`contracts/src/project.ts:33-45`). The source is project settings, environment defaults or the repo's `t3.json` (`contracts/src/t3ProjectFile.ts:28-113`). Scripts run in a T3 terminal with `T3CODE_PROJECT_ROOT` / `T3CODE_WORKTREE_PATH` and sentinel-based exit detection (`project/ProjectSetupScriptRunner.ts:378-468`). `async:false` holds the agent until setup succeeds. | solid |
| **Worktree GC** | `storageCleanup.ts:394-647` uses rules (after N days, on merge, on delete, unchanged) and keep-when-dirty. It runs eight safety guards before `git worktree remove`. All rules are off by default. | solid |
| **Checkpoints (hidden refs)** | Refs are `refs/t3/orchestration-v2/checkpoints/<b64(sha256(scopeId))>/ordinal/<n>` (`orchestration-v2/CheckpointService.ts:26, 161-172`). One scope per thread; ordinal = run ordinal; 0 is the baseline. A baseline is captured before each run if missing (`RunExecutionService.ts:864-878`). After a completed, interrupted or cancelled run, a durable `checkpoint.capture` effect writes the next one (`:686-716`; `CheckpointCaptureService.ts:63-239`). Storage uses a temp index, `add -A`, `write-tree`, `commit-tree -p HEAD`, `update-ref` with fsync (`vcs/GitVcsDriver.ts:799-1082`). The user's index and HEAD are untouched. The legacy `refs/t3/checkpoints/...` builder (`checkpointing/Utils.ts`) is dead code. **Refs are never garbage-collected**, except stale ones after a rollback. Nested scopes are advertised but `ensureScope` is a no-op. | solid (GC missing) |
| **Diffs** | Per-turn diff between checkpoint n-1 and n (`checkpointing/CheckpointDiffQuery.ts:108-255`). "Authored paths" filtering (`GitVcsDriver.ts:1237-1284`) excludes files brought in by pull, merge or rebase. Whitespace is ignored by default; the cap is 10 MB. Full-thread diff is 0 → N. Git-mode panels show working-tree and branch-range vs merge-base (`review/ReviewService.ts:125-169`; `GitVcsDriverCore.ts:2804-2962`). | solid |
| **Revert / rollback** | `checkpoint.rollback {scopeId, checkpointId, restoreFiles?}` (`orchestrationV2.ts:3075-3082`). Admission requires the provider to support conversation rollback (`CommandPolicy.ts:306-320`). File restore requires an **isolated worktree** (`CheckpointRestoreSafety.ts:14-88`); otherwise only the conversation rewinds. Order: provider `rollbackThread` first, then filesystem `git restore --source … && git clean -fd && git reset` (`CheckpointRollbackService.ts:110-354`; `GitVcsDriver.ts:1090-1164`). Rolled-back runs stay visible as `rolled_back`. Provider support: Claude, Codex, OpenCode and Pi natively; ACP and Grok only as a fresh-session reset; Cursor and Muse not at all. | solid / partial per provider |
| **Fork** | `thread.fork` (`ThreadForkService.ts:76-139`). The fork **shares the source's worktree and branch**, which blocks file restore on both. Context resolves lazily at the first run on the fork: `native_fork`, `portable_context` or `fork_delta_context` (`Orchestrator.ts:5728-6341`). `thread.merge_back` sends fork context back to the parent; queued merge-back is not implemented (`:4932`). | partial |
| **PRs** | Pipeline `commit \| push \| create_pr \| commit_push \| commit_push_pr` (`git/GitManager.ts:2860-3000`) with LLM commit and PR text. Auto-linking (`git/linkCreatedPullRequest.ts`). Agents link PRs through MCP tools (`link_pull_request`, `watch_pull_request`, …); runtime instructions tell them to. `PullRequestSyncReactor` sweeps every minute and catches `gh pr merge` run by agents by regex on command items (`:446-467`). `PullRequestWatchReactor` wakes the agent on CI, comments or conflicts (`:306-340`). Stacks are native on GitHub and GitCafe only. A full PR review UI (80 components) includes LLM "review guides" built in a disposable worktree (`pullRequest/PullRequestReviewGuideService.ts:180-345`). | solid (GitHub), partial elsewhere |
| **Source-control hosts** | `source-control-core` ports with GitHub (direct GraphQL/REST; token from settings > `GH_TOKEN` > `gh auth token`), GitLab (`glab`), Azure DevOps (`az`), Bitbucket (REST), Forgejo (`fj`/`tea`) and GitCafe. Capabilities are declared per host. | GitHub solid, rest partial |
| **VCS abstraction** | `VcsDriver` declares `git \| jj \| unknown` (`contracts/src/vcs.ts:4`); only git is registered (`vcs/VcsDriverRegistry.ts:73-118`). | git solid, jj absent |

### E. Multi-agent orchestration

| Feature | What / where / how | Maturity |
|---|---|---|
| **Provider-native subagents** | Claude Task/Agent and Codex subagents are projected as **read-only child app threads** (`provider-core/src/server/subagentProjection.ts:71`) plus `subagent` nodes and items. Dispatching into one throws `OrchestratorSubagentThreadReadOnlyError`. They can be stopped individually (`subagent.stop`). Claude "workflows" (coordinator plus phases) appear in a Lineage view (`claudeWorkflowProgress.ts`, `stopWorkflow` RPC). | solid |
| **App-owned delegation (`delegate_task`)** | Agents call `delegate_task` on the injected `t3-code` MCP server (`mcp/toolkits/orchestrator/tools.ts:53-261`, `mcp/OrchestratorMcpService.ts:2001-2051`). The decider (`Orchestrator.ts:6548+`) creates a child thread (lineage `subagent`, deterministic IDs from the commandId), an `app_owned` Subagent and a `subagent_spawn` transfer, and starts the child in the same command. The child gets **only the task prompt**, not the parent's history. Modes: `wait` (the tool call blocks, event-driven) or async. **Cross-provider**: any provider instance or model, discovered with `orchestrator_capabilities`. Results come back as `subagent_result` transfers. The parent is woken by a server-synthesized `message.dispatch` with `delegatedCompletion` (queue-jumping, or native steer). Mailbox semantics include generation-tracked cohorts and ack/dispose (`:4783-4818, 10078-10160, 10295`). | solid |
| **Thread spawning** | `t3_thread_launch` (with workspace strategy), `create_threads` (batch, sharing the checkout) and `t3_thread_send/read/wait/interrupt/fork/merge_back`. They create top-level siblings, with a `thread_created` item in the caller. | solid |
| **Limits** | `DispatchModeLimit` stops a child from running with broader runtime or interaction modes than its caller (`DispatchModeLimit.ts`; re-checked under lock at `Orchestrator.ts:10951-10962`). **No delegation depth limit exists.** | partial |
| **Recovery** | `recoverDelegatedTasks` runs at startup (`Orchestrator.ts:11197-11284`); stop cascades through `delegated-tasks.stop`. | solid |
| **Scheduled orchestration** | `schedule_task` (interval, fixed time or webhook) can return runs to the current thread, so an orchestrator agent can deduplicate and delegate (see I). | experimental |

### F. Middleware / interception (most important)

**Bottom line: T3 has no middleware, plugin or interceptor system for turns or tool calls.** Everything named middleware is transport-level: `RpcScopeAuthorization` (`contracts/src/rpc.ts:1873`), `RpcInstrumentation` (`ws.ts:543`), MCP auth (`mcp/McpHttpServer.ts:183`) and HTTP compression/readiness. Prompt injection is hard-coded string concatenation in services and adapters. The seams are listed exhaustively below, sorted by "needs a fork?".

#### F.1 What T3 itself injects (hard-coded)

| Injection | Where | Mechanism |
|---|---|---|
| Runtime info and PR-linking rules | `packages/provider-core/src/server/runtimeInstructions.ts:1-26` | `<runtime_info>` plus `<pull_request_linking>` text |
| Orchestration instructions (`delegate_task`, `t3_thread_launch`, `schedule_task`, `request_secret`, `html_render`, ACP terminal fallback) | `provider-core/src/server/orchestrationInstructions.ts:3-…` | Long markdown block, added only when the `t3-code` MCP server is attached |
| Browser instructions (`preview_*`) | same file, `T3_CODE_BROWSER_TOOL_INSTRUCTIONS` | Markdown |
| Claude | `ClaudeAdapterV2.ts:1052-1058` | `systemPrompt: {preset:"claude_code", append: runtime + orchestration}` |
| Codex | `CodexAdapterV2.ts:705-797`; `provider/CodexDeveloperInstructions.ts:191-225` | `collaborationMode.settings.developer_instructions` (plan/default prompts) plus `additionalContext` entries `t3_code_orchestration/runtime/tools` (`kind:"application"`) |
| ACP agents (no system channel) | `orchestrationInstructions.ts:72-94` | Wraps the user prompt in `<t3_code_instructions>…<user_request>` on the first send and whenever the mode or tools change |
| Cursor | `provider-cursor/src/server/adapter.ts:2133-2179` | Prepended to the first prompt |
| OpenCode | `provider-opencode/src/server/v2/adapter.ts:3416` | System prompt |
| Pi | `provider-pi/src/server/mcpExtensionSource.ts:249-455` | A **generated Pi extension**: `pi.on("input")` inlines skills, `before_provider_request` rewrites the raw payload, `tool_call` blocks or asks by mode, `before_agent_start` appends to the system prompt. This is the most complete in-harness middleware in the repo, and it is Pi-only. |
| Composer context | `packages/shared/src/composerContextReferences.ts:147-312` | Inline `t3-context://v1/<kind>/<id>` links become `[Kind: label; ref=id]` markers plus a trailing `<t3_context version="1">` JSON envelope with tag escaping. @-file mentions send only `path:`; thread refs say "read with `t3_thread_read`". |
| Attachments | `provider-core/src/server/attachmentPrompt.ts:159-218` | File paths appended. Snap-shot accessibility trees are wrapped as "untrusted JSON". |
| Skills | `provider/Drivers/ClaudeSkillDispatch.ts`; `CodexAdapterV2.ts:3152-3183` | `$skill` becomes a leading `/skill` (Claude) or Codex skill mention |
| Handoffs / restart notes | `ProviderTurnStartService.ts:950-1181` | `<context>…User message:` prefix or native `injectHistory`; restart background note |
| MCP-App model context | `RunExecutionService.ts:1401-1437`; `mcpApps/McpAppModelContext.ts` | `appContext[]` on the turn input. **Only Codex consumes it** (`additionalContext`, `kind:"untrusted"`, `CodexAdapterV2.ts:742-764`). |
| Plan capture | `ClaudeAdapterV2.ts:7949-7970` | `ExitPlanMode` is intercepted in `canUseTool`: the plan becomes a `proposed_plan` artifact and the tool is **denied** with a message. This is a veto-and-capture precedent. |
| Prompt command interception | `ProviderTurnStartService.ts:373-458`; `provider/ProviderAuthService.ts:284-296` | Slash prompts are offered to the auth service first (logout). This is the only server-side prompt interceptor. |
| AGENTS.md / CLAUDE.md | — | **Not injected.** Harnesses load them natively. T3 reads them only for commit and PR text style (`git/GitManager.ts:814-841`). |

#### F.2 External seams (no fork)

| # | Seam | Gives access to | Cannot do | Maturity |
|---|---|---|---|---|
| 1 | **Sidecar WS client** with a scoped token (`t3 auth session issue --scope orchestration:operate`, `cli/auth.ts:164`). It subscribes to `subscribeShell` / `subscribeThread` and dispatches commands. | Observe every normalized event (messages, tool items, approvals, plans, subagents, usage). Answer approvals and questions (`runtime-request.respond`; first responder wins, `Orchestrator.ts:7299-7350`). Send, steer, queue, interrupt, fork, switch provider and set modes (full command vocabulary `orchestrationV2.ts:2705-3221`). | Rewrite a prompt in flight. Hide an approval from the UI. Veto tools the provider auto-approved (Full access / acceptEdits / Codex `never`). Pre-empt the user. | solid |
| 2 | **Custom composer context kinds.** Unknown kinds decode to `UnknownContextRecord` with ≤64 KB JSON (`contracts/src/composerContext.ts:244-280`) and are emitted verbatim into the `<t3_context>` envelope (`composerContextReferences.ts:267-278`). | Attach structured context to a message sent by a sidecar client. It must be referenced by a `t3-context://` link in the text. | Inject into turns the user sends from the UI. The UI shows unresolved chips. | partial |
| 3 | **Local ACP command provider** (`docs/user/providers-acp.md:26-35`). Write an ACP agent that proxies to `claude-code-acp`, `codex-acp`, etc. | **Full** prompt rewrite, context injection, tool and permission veto, and observation, because the proxy *is* the agent. T3 still applies client-side fs/terminal policy (`provider-acp/src/server/adapter.ts:5526-5560`). | Use T3's native Claude/Codex adapters (rich rollback, steering, subagents, goals). ACP is the weakest feature tier: rollback becomes a reset and IDs are weak. | solid |
| 4 | **Claude passthrough**: launch args go to SDK `extraArgs` (`ClaudeAdapterV2.ts:975-979, 1059`), e.g. `--settings hooks.json` or `--append-system-prompt`. Others: binary-path wrapper (`pathToClaudeCodeExecutable`, `:1047`), per-instance `CLAUDE_CONFIG_DIR` whose `settings.json` hooks likely apply because the main query sets no `settingSources` (**[unverified: depends on SDK 0.3.276 defaults]**), and per-instance env such as `ANTHROPIC_BASE_URL` for an API-level proxy. | Harness-native hooks: PreToolUse veto, UserPromptSubmit context, PostToolUse observe. Request-level rewrite via a proxy. | Coordinate with T3's own state. Hooks run out of band of T3's event log. | partial |
| 5 | **Codex passthrough**: launch args to `codex app-server` (`-c k=v`), `T3CODE_CODEX_LAUNCH_ARGS`, and `CODEX_HOME/config.toml`. T3 layers only `mcp_servers.t3-code` and `update_plan` on top (`CodexAdapterV2.ts:1296-1332`). The generated schema includes PreToolUse, PostToolUse and UserPromptSubmit hooks (`effect-codex-app-server/src/_generated/schema.gen.ts:52060-52082`), but T3 never uses them. | Codex-native hooks, approval policy, extra MCP servers. | Same as 4. | partial |
| 6 | **Outside-agent MCP** at `/mcp` (OAuth 2.1 + PKCE + DCR; `auth/McpOAuth.ts`; `docs/user/outside-agents.md`). 82 tools. | Orchestrate threads within a runtime-mode ceiling: launch, send, steer, interrupt, delegate, schedule, read. Answer **questions**. | **Approve permission requests** (`t3_pending_request_respond` refuses, `mcp/toolkits/thread/tools.ts:169-176`). | solid |
| 7 | **Webhook scheduled tasks** at `/api/hooks/:hookId/:token` with optional HMAC and `{{body.x}}` templating (`scheduledTasks/webhookRoute.ts`, `webhookTemplate.ts`). | Start templated turns from outside. | Intercept anything. | experimental |
| 8 | **Project scripts** (`t3.json` `runOnWorktreeCreate` with `async:false`, `runOnSettle`). | Prepare the workspace before the first turn, e.g. write `.claude/settings.json` hooks or `AGENTS.md` into the worktree. | Act per turn. | solid |
| 9 | **Harness `AGENTS.md` / `CLAUDE.md` / skills** | Static context, loaded natively by the harness. | Act dynamically. | solid (harness) |

#### F.3 Fork points (small, central edits)

| # | Point | Access | Size |
|---|---|---|---|
| 10 | **`RunExecutionService.ts:1401-1453`**: the final `ProviderAdapterV2TurnInput` before `session.startTurn` / `compactThread` | Rewrite `message.text`, attachments, `modelSelection`, `runtimePolicy`; add `appContext` for **all providers**. The best single prompt-middleware slot. | small |
| 11 | **`ProviderSessionManager.decorateRuntime`** (`:1677-1859`) and its event pump (`:1891`). It already wraps every adapter's `startTurn`, `steerTurn`, `interruptTurn` and `respondToRuntimeRequest` for metrics. | Wrap every turn op; observe every raw adapter event before ingestion; auto-respond to runtime requests. A drop-in decorator over the stable `ProviderAdapterV2` interface. | small |
| 12 | `Orchestrator.dispatchWithReceipt` (`Orchestrator.ts:11096-11116`), the universal command choke point (MCP and workers bypass `ThreadMessageIntake`) | Veto or rewrite **any command** before it is decided. Runs under the per-thread lock, so it must be fast. | small–medium |
| 13 | `RpcScopeAuthorization` middleware (`auth/RpcAuthorization.ts:279-284`) | Per-RPC, payload-aware allow/deny for clients. Note that all orchestration commands, including approvals, share `orchestration:operate`. | small |
| 14 | `RuntimePolicy.layerWithOverride` (`orchestration-v2/RuntimePolicy.ts:138-167`), **built but unused** | Force raw `approvalPolicy` / `sandboxPolicy` / `cwd` / effort into every adapter. Claude and Codex honor them. A ready-made per-thread policy-engine slot, about one line in `runtimeLayer.ts:61`. | tiny |
| 15 | Claude `canUseToolEffect` (`ClaudeAdapterV2.ts:7820`) and adding SDK `hooks` in `makeClaudeQueryOptions` (`:1007-1060`) | Veto non-pre-approved tools. With hooks: full PreToolUse, PostToolUse and UserPromptSubmit with `additionalContext`. | small |
| 16 | Codex server-request handlers (`CodexAdapterV2.ts:5052-5440`) | Auto-decide escalations Codex asks about. There is no pre-tool hook for auto-approved commands. | small |
| 17 | `Context.Reference` slots with no-op defaults: `RunFinalizationObserver` (`RunFinalizationService.ts:29-38`), `ProviderTurnAnalytics` (`ProviderEventIngestor.ts:79-94`), `AgentScope` (`packages/shared/src/AgentScope.ts`, which wraps every agent launch command), `DispatchModeLimit` | Observe run finalization and turn completion; wrap the agent process launch (sandbox or proxy). | small (provide a layer) |
| 18 | `EventSink.stream({eventType, threadId})` (`EventSink.ts:171`): internal post-commit subscriber, the pattern every reactor uses (table below) | In-process observation of all domain events, durable and ordered. | small |
| 19 | `CommandPolicy` layer (`runtimeLayer.ts:208`) | Dispatch-mode decisions only (steer, queue or restart); no content. | small |

**Internal reactors / observers today** (all wired in `server.ts:489-579`): `PullRequestSyncReactor`, `PullRequestWatchReactor`, `ThreadSettlementService`, `ThreadPullRequestService`, `AgentAwarenessRelay`, `StorageCleanup`, `ProviderUsageLimitsIngestion`, `ProviderContinuationService`, `UsageLimitRecoveryWorker`, the Orchestrator's own terminal-run reactor (`Orchestrator.ts:11172-11190`), and MCP waiters (`OrchestratorMcpService.ts:1509`).

#### F.4 Approval / question flow (end to end)

Provider asks (Claude `canUseTool` `:7980-8046`; Codex `item/*/requestApproval` `:5052-5440`; ACP `session/request_permission`). The adapter builds `RuntimeRequest` + node + turn item, parks a `Deferred` and emits `runtime_request.updated`. `ProviderEventIngestor` → EventSink → WS subscribers. Client sends `runtime-request.respond {decision: accept|acceptForSession|acceptAlways|decline|cancel, answers?}` (`contracts/src/providerPolicy.ts:50-56`; `client-runtime/src/operations/commands.ts:851-864`). The Orchestrator validates it is pending and enqueues `runtime-request.respond`; `RuntimeRequestService.ts:77-122` requires `responseCapability: live` and calls `session.respondToRuntimeRequest` through `decorateRuntime`. Claude maps the decision to `PermissionResult` (`acceptForSession` → session `updatedPermissions`; `cancel` → `interrupt:true`, `:2402-2434`). After a server restart, pending requests become `expired / not_resumable`.

### G. Permissions and auth

| Feature | What / where / how | Maturity |
|---|---|---|
| **Runtime modes** | `approval-required` (Supervised), `auto-accept-edits`, `auto`, `full-access`, plus interaction mode `plan` (`contracts/src/providerPolicy.ts:21-28`). The **default is `full-access`**. Unsupported modes fall back to Supervised (`RuntimePolicy.ts:76-85`). | solid |
| **Mode → harness mapping** | Claude: `default` / `acceptEdits` / `auto` / `bypassPermissions` + `allowDangerouslySkipPermissions`, and `plan` (`ClaudeAdapterV2.ts:1652-1745`). Codex: `untrusted+readOnly` / `on-request+workspaceWrite` / `on-request+workspaceWrite+approvalsReviewer:auto_review` / `never+dangerFullAccess` (`CodexAdapterV2.ts:664-703`). ACP: T3 answers `request_permission` and gates client fs/terminal by mode. Pi: via the injected extension. Read-only sandbox restricts Claude tools to Read, Glob and Grep (`:335`). | solid |
| **Approvals UI** | `apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx` with Cancel / Decline / Always allow this session / Approve; user-input panel; secret request card. | solid |
| **Agent-requested secrets** | `request_secret` MCP tool returns a one-use HMAC `secretRef` with 24 h TTL, project-scoped (`apps/server/src/secrets/SecretRequests.ts:1-60`). | experimental |
| **Server auth** | Methods: browser session cookie, bearer, **DPoP** (`auth/dpop.ts`, replay markers). Bootstrap: desktop-bootstrap or one-time pairing token (5 min; `auth/PairingGrantStore.ts:254`). Sessions last 30 days; WS tickets 5 min (`auth/SessionStore.ts:432-433`). CLI: `t3 auth pairing|session create/list/revoke` (`cli/auth.ts:85-246`). | solid |
| **Scopes** | `orchestration:{read,operate}`, `settings:write`, `providers:manage`, `environment:maintain`, `preview:operate`, `diagnostics:read`, `terminal:{read,operate}`, `source-control:write`, `filesystem:{read,write}`, `review:write`, `access:{read,write}`, `relay:{read,write}` (`contracts/src/auth.ts:82-99`). The scope split landed 2026-10-06. Every RPC maps to a scope (`RpcAuthorization.ts:45-216`), with payload-sensitive rules (`:236-276`). | solid |
| **MCP client audience** | OAuth-issued `mcp-client` sessions are confined to `/mcp` (`auth/EnvironmentAuth.ts:84, 624-631, 1210-1225`). The grant is read-only or an `operate` with a runtime-mode ceiling. | solid |
| **Gaps** | Approvals share `orchestration:operate` with sending messages. `filesystem:read` means whatever the server user can read. Secrets at rest are plaintext. Telemetry is on by default. | — |

### H. Remote and multi-device

| Feature | What / where / how | Maturity |
|---|---|---|
| **Model** | One client ↔ one environment (server) over HTTP + WS. Routes only change reachability (`docs/internals/remote.md`). Route kinds: `relay \| loopback \| lan \| tailnet \| vpn \| public \| ssh` (`client-runtime/src/connection/routes.ts:24-115`). The server advertises learned LAN and tailnet endpoints (`apps/server/src/environment/DirectEndpoints.ts`). | solid |
| **Direct pairing** | `t3 serve --host`, `t3 pair` (QR, `cli/pair.ts:479-493`). The hosted app.t3.codes is a pure client: host in the query, token in the fragment (`apps/web/src/hostedPairing.ts:53-86`). | solid |
| **Tailscale** | CLI wrapper with `tailscale serve --bg --https` (`packages/tailscale/src/tailscale.ts:341-360`); `--tailscale-serve` flag. | solid |
| **SSH** | Desktop-only. Downloads the CLI runtime to the remote `~/.t3/runtime/versions/<v>`, launches or reuses the server, issues a pairing token, `ssh -N -L` (`packages/ssh/src/tunnel.ts:444-506, 862-1159`). | solid (desktop only) |
| **T3 Connect** | Hosted relay (`infra/relay`) **not in the data path**. It provisions a **Cloudflare Tunnel per environment**; the host runs pinned `cloudflared` (`packages/shared/src/relayClient.ts:26-31`; `apps/server/src/cloud/ManagedEndpointRuntime.ts:506-510`). Credential minting: relay → signed JWT → environment `/api/connect/mint-credential` → 2-min DPoP-bound pairing credential → client `/oauth/token` (`apps/server/src/cloud/CloudLink.ts:1449-1654`). The relay never sees session tokens. Limit: 3 tunnels per user. Clerk identity. CLI: `t3 connect login|link|status|publish|unlink|logout`. | solid (reaping/recovery partial) |
| **Mobile push and Live Activities** | Server publishes signed agent activity to the relay (`relay/AgentAwarenessRelay.ts`), which sends to APNs and FCM through Queues (`infra/relay/src/agentActivity/*`). **Requires T3 Connect.** | iOS solid, Android partial |
| **Multiple environments** | The desktop backend pool (primary + WSL, `apps/desktop/src/backend/DesktopBackendPool.ts`), saved environments, and a "local environment off" remote-only mode. Client-side **load balancing across machines** (`apps/web/src/components/settings/LoadBalancingSettings.tsx`) is off by default and fed by host resource telemetry. | load balancing experimental |
| **Simulator / emulator streaming ("Devices")** | `apps/server/src/device/*` with `expo-device-hub` and `agent-device`; streamed to web and mobile; MCP `device_*` tools. | experimental |
| **Server-run browser** | Playwright headless Chrome streamed at `/api/preview-stream` so any client (including mobile) sees the agent's browser (`apps/server/src/preview/ServerBrowser*.ts`). | partial |

### I. Automation

| Feature | What / where / how | Maturity |
|---|---|---|
| **Scheduled tasks** | Triggers: `interval` (≥60 s), `fixed_time` (HH:MM + weekdays) or `webhook` (`contracts/src/scheduledTask.ts:26-195`). Engine: `scheduledTasks/ScheduledTaskService.ts` on a global 5 s `Scheduler` (`scheduling/Scheduler.ts:52-60`). Idempotent fire keys (`:775-781`); missed-run policy (`Schedule.ts:81-95`). Webhooks: 1 MiB cap, optional HMAC-SHA256, templated prompt, delivery log, 429 rate limit, relay forwarding and offline hold. Managed from Settings, a per-thread automations panel, or MCP (`schedule_task` …). There is no user doc. | experimental (since 10/02) |
| **Background service** | `t3 service install` installs systemd user unit `t3code.service` or launchd `com.t3tools.t3code.service` (`cloud/bootService.ts`). A Node-only launcher handles trial/commit updates with SQLite snapshot rollback (`serviceLauncher.ts`). No Windows support. | solid |
| **Self-update** | `t3 update`, remote-triggered updates with "continue running threads" (`cloud/selfUpdate.ts`), SHA256-verified runtime archives, and Electron auto-update polling every 4 min. | solid |
| **Auto-pull** | Fast-forward of the default branch once at startup, only when clean (`serverRuntimeStartup.ts:187-240`). | solid, narrow |
| **Auto-settle, PR watch wakes, usage-limit resume, restart continuation** | See B and D. | mixed |
| **Background policy** | Client activity leases plus host power state gate opportunistic work (`background/BackgroundPolicy.ts`). | partial |

### J. Extensibility

| Feature | What / where / how | Maturity |
|---|---|---|
| **Plugins** | **None.** Drivers, source-control hosts and toolkits are static arrays. A provider can be added at runtime only as an ACP command or registry agent. | — |
| **WS RPC** | The de facto API, but there is **no public SDK**: `client-runtime` is private, so an external client must vendor `@t3tools/contracts` (Effect Schema) and speak Effect RPC over JSON. | solid, unofficial |
| **HTTP** | Read-only orchestration snapshots, auth, projects, PR diff, webhooks, descriptor (`environmentHttp.ts:450-759`). | solid |
| **MCP server** | 82 tools across orchestrator, thread, project, worktree, environment, attachment, pull requests, preview (19), html, devices. Every tool declares its access (`mcp/McpToolAccess.ts`). Outside agents use OAuth. | solid |
| **MCP Apps** | Renders MCP Apps UIs in an opaque-origin frame with ask-first for non-read-only tools (`apps/web/src/components/chat/McpAppFrame.tsx`, `apps/server/src/mcpApps/*`). App-provided model context flows into `appContext`. **Codex only.** | experimental |
| **HTML renders** | Agents publish self-contained HTML (`html_preview` / `html_render`) shown inline above the reply (`apps/server/src/htmlRender/`). | experimental |
| **CLI** | `t3 [serve\|start\|app\|pair\|auth\|browser\|project\|service\|update\|uninstall\|theme\|trace\|triage\|connect]` (`binCli.ts:57-90`). There are **no thread or turn commands**; `acp-mcp-call <tool> <json>` is a backdoor to the MCP tools. `t3 triage` launches claude or codex with a triage playbook. | solid |
| **Keybindings** | About 64 commands with a `when`-expression AST (`contracts/src/keybindings.ts`); `script.<id>.run`. | solid |
| **Themes** | VS Code theme import and Open VSX search. | solid |

### K. Storage and persistence

| Feature | What / where / how | Maturity |
|---|---|---|
| **Engine** | SQLite through Node's built-in `node:sqlite` behind Effect `SqlClient`: WAL, `busy_timeout` 5000, FKs on (`apps/server/src/persistence/Sqlite.ts`). Lives in `~/.t3/userdata` (`T3CODE_HOME` overrides). | solid |
| **Event sourcing** | **Yes.** One append-only log, `orchestration_events` (V2 rows: `application_event_version=2`, `aggregate_kind='thread'`; `persistence/OrchestrationEventStore.ts:405-621`). The global autoincrement `sequence` is the client cursor. Projects share the log. | solid |
| **Projections** | 17 `orchestration_v2_projection_*` tables (threads, runs, attempts, nodes, provider sessions/threads/turns, runtime requests, messages, plans, turn items, checkpoints, handoffs, transfers, subagents, bindings), applied **synchronously inside the write transaction** (`EventSink.ts:332-360`), so projections never lag the log. `ProjectionMaintenance.ts` verify/rebuild/compact exists but has **no production caller**. | solid (maintenance unwired) |
| **Outbox** | `orchestration_v2_effect_outbox` with leases, per-thread FIFO, retries and 7-day retention (`EffectOutbox.ts`). | solid |
| **Receipts** | `orchestration_command_receipts`. | solid |
| **Migrations** | 57 Effect migrations (`persistence/Migrations/`). 055 is the whole V2 schema in 11 sub-steps. The V1 → V2 import is `orchestration-v2/legacy/LegacyV1ThreadImporter.ts` (lazy transcript import). | solid |
| **Attachments** | Filesystem store with a pending area swept after 24 h (`attachmentStore.ts`). | solid |
| **Other state** | Secrets as plaintext files; auth sessions and pairing in SQLite; checkpoints as git refs; terminal history in memory (5,000 lines / 8 MiB); relay state in PlanetScale Postgres plus Durable Objects (hosted). | — |

### L. Observability

| Feature | What / where / how | Maturity |
|---|---|---|
| **Tracing** | Effect-native OTLP (not the OTel JS SDK) (`apps/server/src/observability/Observability.ts`). A local NDJSON trace file is always written (`server.trace.ndjson`, 10 × 10 MB). Optional OTLP traces, metrics and logs via `T3CODE_OTLP_*` / `OTEL_EXPORTER_OTLP_*` or Settings. RPC spans `ws.rpc.<method>`, metrics (`providerTurnsTotal`, `providerTurnDuration` in `decorateRuntime`), event-loop stall monitor, SIGUSR2 heap snapshot, browser traces proxied through the server. `t3 trace summary`, `t3 triage`. | solid |
| **Provider event logs** | `provider/EventNdjsonLogger.ts` (raw provider events to NDJSON). | solid |
| **Usage and cost** | `usage/UsageService.ts` reads **provider-native history on disk** (Codex, Claude and Grok JSONL; OpenCode SQLite; Antigravity; Pi; Cursor API), memoised by size and mtime. Prices come from LiteLLM's JSON, giving API-equivalent cost estimates rather than bills. A usage page (`apps/web/src/components/usage/UsagePage.tsx`) shows cost by token type. | solid (Codex/Claude), partial (others) |
| **Subscription limits** | Per-provider limit readers (`provider/{codex,claude,antigravity}UsageLimits.ts`), CLIProxyAPI pooling, a composer limits badge, mobile widgets and "use reset" credits (Claude banked resets). | solid |
| **Resource telemetry** | Rust sampler child (`native/resource-monitor`), 1 h in-memory history, active only while someone subscribes. | partial |
| **Product analytics** | PostHog, **on by default**, opt out with `T3CODE_TELEMETRY_ENABLED=false` (`telemetry/AnalyticsService.ts:69-76`). No prompt content is sent. | solid |
| **Activity log** | A UI timeline grouping ("Ran 2 commands…"), not an audit log (`client-runtime/src/work-log/*`). | solid |

### M. UI and UX of note

| Feature | Where / how | Maturity |
|---|---|---|
| Stack | React 19 + React Compiler, TanStack Router (file routes), Effect atoms (`@effect/atom-react`) for server state, Zustand for UI stores, base-ui/shadcn-style kit (`apps/web/src/components/ui/`), Tailwind v4 | solid |
| Markdown | `react-markdown` + `remark-gfm` with a custom sanitize pipeline, an **incremental streaming parser** (`apps/web/src/markdown-incremental.ts`), GitHub alerts, Mermaid (rendered after settle), citation chips, markdown-aware copy (`components/ChatMarkdown.tsx`) | solid |
| Highlighting | Shiki in WASM (Oniguruma) via `@pierre/diffs` (`lib/syntaxHighlighting.ts:1-36`), with highlighting in a worker pool | solid |
| Virtualization | `@legendapp/list` 3.3.5, patched (`chat/MessagesTimeline.tsx:88-91, 1612`), with nested virtualized tool groups, scroll anchoring and a minimap; also used for the palette and pickers | solid |
| Diff panel | `@pierre/diffs` + `@pierre/trees` (`components/DiffPanel.tsx`, `components/diffs/*`). Per-turn and branch diffs, inline review comments fed back into the composer, find-in-diff | solid |
| Terminal | **libghostty-vt compiled to WASM** with a Canvas renderer, not xterm (`apps/web/src/terminal/ghostty/*`). Server node-pty (`apps/server/src/terminal/Manager.ts`). Shareable and reconnectable sessions; passive observe scope. Native Ghostty on iOS and Android. | solid |
| Composer | Tiptap 3 with byte-identical markdown round-trip. Triggers: `/` commands, `@` paths, `$` skills, `#` PRs. Context chips (terminal, element, preview annotation, review comment, thread), attachments (HEIC, video frames), prompt stash and history, queue reorder, context-window meter, usage limits. Voice input on iOS only (on-device Apple). | solid |
| Plans / todos / approvals | `ProposedPlanCard`, task badge, approval and user-input panels, Lineage view (subagents, workflows) | solid |
| Sidebar | Pin, reorder, snooze, settle ("inbox"), working fold, projectless threads, find | solid |
| Browser preview | Electron webview or server-side headless browser streamed to clients, with an agent cursor overlay, recording, PiP mini player, device toolbar, user/agent tab ownership | partial |
| HTML renders / MCP Apps | Inline iframe pages and app frames | experimental |
| Snap-shot | Desktop window capture plus accessibility tree attached to the prompt (`apps/desktop/src/snapShot/`) | partial |
| Command palette, keybindings, themes, welcome wizard, notifications (favicon badge, sounds, OS notifications) | `components/CommandPalette.tsx`, `onboarding/WelcomeWizard.tsx`, `ThreadNotificationCoordinator.tsx` | solid |
| PR review | 80-component PR surface with guided review tours | solid / beta |
| Mobile | Expo with native modules, iPad columns, Live Activities, widgets, simulator viewer | partial–solid |

---

## 4. Changes since 2026-09-23

The 9/23 gap analysis was taken at about **f5ef0ddb90** (2026-09-23 06:49 UTC). Since then: **982 commits** (fix 620, feat 147, refactor 64, perf 63). Excluding `.repos` and the lockfile, 4,326 files changed (+730k / −283k).

1. **The new orchestrator (orchestration-v2) landed on main 2026-10-02** in one squash commit, `de34391427` "feat(orchestrator): introduce new orchestrator (#2829)" (1,907 files, +380k / −203k). It had been on side branches since April. It replaced V1 `apps/server/src/orchestration/{Layers,Services}` (81 files) and `contracts/src/orchestration.ts`. **Everything in sections B, C, E and K is post-9/23 on main**:
   - event log + decider + EffectOutbox/EffectWorker + receipts
   - the run/attempt/node graph
   - queued runs, steer/restart policy
   - delegation via MCP (`delegate_task`)
   - fork/merge-back, provider handoffs
   - the V1 importer
   - scheduled tasks
   The 9/23 comparison was against the V1 orchestrator.
2. **Provider packaging (10/08–10/09):** `provider-core`, `provider-testing`, `provider-{pi,muse,opencode,cursor,acp,grok,acp-registry}` were extracted into packages. Pi, generic ACP, ACP Registry (including Devin) and OpenCode 2 arrived with the orchestrator. Muse became native (`d6f47ff972`). Codex protocol regenerated for 0.156/0.159. Managed "Connect with ChatGPT" Codex (`27bdf1aa14`). Claude banked resets (`3412097bff`). Per-project provider enable/disable (`8ac6846a0b`).
3. **Source control split (10/09–10/10):** `source-control-core` plus GitHub, GitLab, Bitbucket, Azure DevOps, Forgejo and GitCafe packages. **GitHub moved off the `gh` CLI to direct API calls** (`1564aaa5d2` …). Guided PR reviews (`1f6df6bf1f`), per-host quick actions, stacks.
4. **Agent-rendered UI:** HTML renders (`677d1527c3`, 10/05), MCP Apps (`4d976d1fc2`), secret request cards and `apps/server/src/secrets` (`9f61ba6741`), Mermaid (`5e35272fda`).
5. **PR watch wakes:** agents can `watch_pull_request` and be woken on CI, comments or conflicts (`18b21325c3`, `758dc290e9`).
6. **Auth scope split (10/06):** admin, source-control write, filesystem read/write, preview control, diagnostics, passive terminal observe (`28ce9d1c17`, `2eda8ac6a3`, `321c6f9d26`, `7175edcff4`, `57b2418d4f`, `cc41482df0`). Outside-agent MCP OAuth (`2c8be5893e`), hosted agents such as ChatGPT (`10f39eb9ac`). Every MCP tool declares its access (`2f85686d9d`).
7. **Webhook-triggered scheduled tasks** with relay forwarding and offline hold (`7dfb86a32b`, `b070e52d3e`, `f33b060caf`).
8. **Remote:** multiple routes per environment plus LAN/tailnet discovery (`979ca66ced`, `745c225f92`), tunnel metrics and cleanup, relay URL signing, bootstrap token rotation.
9. **Server layout refactor:** the `Services/` + `Layers/` folders were flattened to one module per service (`3d17862e58`, 10/05).
10. **Observability:** OTLP env and kill switch, event-loop stalls, SIGUSR2 heap snapshots, `t3 trace`, OTel config UI.
11. **Web/mobile UX:** find in thread and diffs, server-run preview browser (`ac8e9453ca`), device 3D/foldables, reopen closed tabs, compact-before-send, `/goal` (`a172e1c4e8`), mobile v5 navigation and iPad columns, Live Activities and Android notifications.
12. **Removed or reverted:** automatic compaction before resume (`2188bdd8b5`), automatic file-link repair (`801ca76ed6`), the legacy per-driver providers settings map (`2c1160783e`).

The baseline memory "[T3 has] hidden-ref checkpoints + diff panel, revert/fork, stop/queue-vs-steer, markdown/highlight/virtualization, scoped WS" still holds, but the machinery under each item has been rebuilt. **Expect churn:** about 600 fix commits followed the 10/02 cutover within 9 days.

---

## 5. Integration seams: putting a Foundry middleware layer in front of or inside T3

Foundry's thesis is a middleware layer that injects context, rewrites prompts, gates tools and approvals, and observes turns to measure whether feedback stuck. T3 offers **no first-class slot** for this. The options, from least to most invasive:

### 5.1 Beside T3 (no fork): Foundry as a privileged T3 client

- **Mechanism:** Foundry holds a scoped session token (`t3 auth session issue --scope orchestration:operate,orchestration:read`) and opens `/ws` as an Effect-RPC client. Since `client-runtime` is private, Foundry must vendor `@t3tools/contracts` and pin the `orchestration` protocol version (2).
- **Gets:**
  - (a) **Observation**: every normalized event via `subscribeShell` / `subscribeThread`, with sequence cursors and resumable replay. This is enough to feed Oracle ("did the same correction recur?").
  - (b) **Approval gating**: race the user on `runtime-request.respond`, first responder wins.
  - (c) **Steering**: `message.dispatch` with `deliveryIntent: steer` mid-turn, or a queued follow-up.
  - (d) **Context**: custom `t3_context` kinds on messages Foundry itself sends.
  - (e) **Orchestration**: interrupt, fork, provider switch, mode changes, delegate.
- **Misses:** prompts the user types in T3's UI go straight to the provider. Foundry cannot rewrite them or prepend middleware context. Tools auto-approved by the mode (the default is Full access) are invisible until after the fact. The approval UI still shows the request.
- **Fit:** a good **observer and critic** ("Oracle measures"). It is not a gate. It matches Foundry's preMessage hydrate only if users type into Foundry rather than T3.

### 5.2 Inside the harness (no fork): Foundry as harness hooks / proxy

- **Claude:** set the instance's launch args to `--settings <foundry-hooks.json>`, or use a dedicated `CLAUDE_CONFIG_DIR` whose `settings.json` registers Foundry hooks:
  - `UserPromptSubmit` → inject middleware context
  - `PreToolUse` → structural veto
  - `PostToolUse` / `Stop` → observe
  - Alternatively, a binary-path wrapper or an `ANTHROPIC_BASE_URL` proxy for request-level rewrite (which conflicts with subscription auth: **[speculation]** the OAuth subscription path may not honour a base-URL proxy).
- **Codex:** `-c` launch args or a `CODEX_HOME/config.toml` with hooks and extra MCP servers.
- **Project scripts:** a `runOnWorktreeCreate` script with `async:false` can write those configs into every new worktree.
- **Gets:** real per-turn injection and real tool veto that holds even in Full access, because the hooks run inside the harness.
- **Misses:** T3's event log is unaware of the middleware's decisions; they surface only as provider tool results or denials. Hook config is per-harness and has to be duplicated across Claude, Codex and others. **[Unverified]** whether the Claude SDK 0.3.276 default `settingSources` loads user `settings.json` hooks in T3's main query. T3 sets none, and disables hooks explicitly only in its probe and text-generation paths.
- **Fit:** closest to "denial comes from the structure". It also aligns with Signets: the hook is the gate.

### 5.3 As a provider (no fork): Foundry as an ACP agent

- **Mechanism:** register Foundry as a **local ACP command** provider. Foundry receives `session/prompt`, applies middleware (inject, rewrite, route to a warm specialised session via agent-session), drives the real harness itself, and streams ACP updates back.
- **Gets:** total control of prompt, context, tools and permissions. T3 provides UI, threads, worktrees, checkpoints, terminal, mobile and remote for free.
- **Misses:** T3 treats ACP as the lowest tier:
  - weak IDs
  - rollback becomes "fresh session"
  - no native fork unless advertised
  - no MCP-Apps `appContext`
  - Claude/Codex-specific features lost (goals, subagent projection, workflows, `injectHistory`)
  - the T3 instructions block is prepended into the user prompt Foundry receives
- **Fit:** fastest route to "Foundry middleware adapting to T3 Code". It loses fidelity versus native adapters.

### 5.4 Inside T3 (fork): a decorator over `ProviderAdapterV2`

- **Best seam:** `ProviderSessionManager.decorateRuntime` (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1677-1859`). It is already a decorator over every provider's `startTurn`, `steerTurn`, `interruptTurn` and `respondToRuntimeRequest`, plus the raw event stream (`:1891`).
- **A `FoundryMiddleware` decorator could:**
  1. call Foundry with `{appThread, message, modelSelection, runtimePolicy}` before `startTurn` and rewrite `message.text` or add `appContext`;
  2. tap `events` for `turn_item.updated` (tool calls) and `runtime_request.updated`, auto-deciding requests through `respondToRuntimeRequest`;
  3. tag turns for Oracle.
- **Complementary edits:**
  - `RunExecutionService.ts:1416-1437` for provider-agnostic turn-input rewrite;
  - `RuntimePolicy.layerWithOverride` (`RuntimePolicy.ts:138-167`, built and unused) to force Supervised or a sandbox policy per thread, so tool calls *reach* the approval path instead of being pre-approved;
  - Claude `hooks` in `makeClaudeQueryOptions` (`ClaudeAdapterV2.ts:1007-1060`) for PreToolUse on auto-approved tools;
  - `appContext` consumption for non-Codex adapters (today Codex-only, `ProviderAdapter.ts:420-425`).
- **Cost:** the fork is small in lines, but the files are huge and churning (600 fixes in 9 days). Upstream accepts no big features, so this is a permanently rebased fork. **[Speculation]** keeping the patch to one decorator file plus a layer swap in `runtimeLayer.ts` would keep rebases cheap.

### 5.5 What each surface gives

| Surface | Observe | Inject context | Rewrite prompt | Gate approvals | Veto auto-approved tools | Fork needed |
|---|---|---|---|---|---|---|
| WS sidecar client | ✔ all | only own messages | ✘ | ✔ (race) | ✘ | no |
| Outside-agent MCP | ✔ via read/wait | only own messages | ✘ | ✘ (questions only) | ✘ | no |
| Harness hooks (Claude settings / Codex config) | ✔ per harness | ✔ | partial (UserPromptSubmit adds context) | ✔ | ✔ | no |
| Local ACP proxy provider | ✔ | ✔ | ✔ | ✔ | ✔ | no (lower fidelity) |
| `decorateRuntime` decorator | ✔ raw | ✔ | ✔ | ✔ | ✘ unless mode forced | yes, small |
| + `RuntimePolicy.layerWithOverride` / Claude `hooks` | | | | | ✔ | yes, small |
| `dispatchWithReceipt` wrapper | commands only | ✔ | ✔ | ✔ | ✘ | yes |

**Recommendation [opinion]:**
- **Short term:** 5.1 (observe → Oracle) plus 5.2 (harness hooks give structural gates and context). This needs no fork and mirrors how Foundry would sit in front of any runner.
- **Long term:** if T3 becomes a primary surface, run a thin fork at `decorateRuntime`, or ask upstream for a supported "turn middleware" Layer. Upstream already has the `Context.Reference` no-op-default pattern (`RunFinalizationObserver`, `ProviderTurnAnalytics`, `AgentScope`), so a `TurnMiddleware` reference would be idiomatic for them.

---

## 6. Notable design decisions and lessons

1. **Intent before side effects.** The decider performs no I/O. `EventSink` commits events, projections, receipt and outbox effects in one transaction, and `EffectWorker` performs I/O afterwards with leases and retries (`docs/internals/overview.md`; `EventSink.ts:362, 527-593`; `EffectWorker.ts:667-889`). A command ack means "intent durable". Lesson for Foundry: separate the middleware decision from the provider call, and make both idempotent by `commandId`.
2. **Process-bound vs replay-safe effects** (`EffectOutbox.ts:123-134`). After a crash, effects tied to a dead provider process are cancelled, not replayed. Recovery prefers **cancel over resume** (`ProviderRuntimeRecoveryService.ts`); continuation is opt-in.
3. **Projections inside the write transaction** plus a single-permit publish lane, so readers never see projections ahead of the log or events out of order (`EventSink.ts:232-262, 332-360`).
4. **Queue = runs with a status**, not a separate structure (`QueuedRunOrder.ts`). Steering is resolved under the lock from provider capabilities, with a "steer too late → start" fallback (`CommandPolicy.ts:120-164`; `EffectWorker.ts:239-315`).
5. **Capabilities as data, policy in one place** (`CommandPolicy.ts`). Weakened by the fact that ~25 flags are unread; capabilities are partly aspirational.
6. **Continuation keys** (`driver.ts:133-146`) decide whether a thread can switch accounts or instances natively (shared Codex home / Claude config dir) or needs a handoff. This is a clean model of "same conversation, different credential".
7. **Deterministic, budgeted transcript handoff** instead of LLM summaries, with a footer pointing to `t3_thread_read` for the rest (`handoffBudget.ts:140-282`). Cheap and predictable; the docs still promise summaries.
8. **Bounded wire.** Snapshot-or-replay decided by size and count caps, field truncation with on-demand fetch, per-tool-call coalescing, history paging (`ThreadStream.ts`, `WireProjection.ts`, `threadHistoryPaging.ts`). This is directly relevant to Foundry's planned `open → snapshot/append → close` data stream: T3 added seq-cursor replay with a snapshot fallback, which the Foundry 9/23 design deliberately skipped.
9. **Hidden-ref checkpoints with a temp index and HEAD as parent**, plus "authored paths" to exclude pulled-in changes from turn diffs (`GitVcsDriver.ts:810-1284`). File restore is refused unless the worktree is isolated (`CheckpointRestoreSafety.ts`), and provider rollback runs before filesystem restore.
10. **Credentials out of argv.** MCP bearer tokens are sent to Claude over the SDK control channel, not `--mcp-config` (`ClaudeAdapterV2.ts:686-760`). WS tickets keep long-lived tokens out of URLs.
11. **App-owned delegation via an injected MCP server** with mailbox completion semantics (cohorts, generations, ack/dispose) and a mode ceiling (`DispatchModeLimit`). This is the closest analogue to Foundry's cascading agents and agent-session routing, and it is cross-provider.
12. **Relay off the data path.** T3 Connect only brokers credentials and Cloudflare Tunnels. The relay never sees session tokens (DPoP-bound, 2-min mint, `CloudLink.ts:1553-1654`). Compare the Kingdom-as-permission-hub model: T3 deliberately avoids being a hub.
13. **Replay-fixture testing per provider** (`orchestration-v2/testkit/fixtures/`, 89 scenarios × providers, recorders in `apps/server/scripts/`). This is a strong pattern for agent-session transport tests.
14. **Native code isolation.** Native modules never load in the Electron main process; crashy capabilities run in children with deadlines (`docs/internals/overview.md`). The Cursor SDK in-process crash guard shows the cost of not doing that (`CursorSdk.ts:8-83`).
15. **Agents told how to use the app.** Large instruction blocks teach agents to link PRs, delegate, schedule and render HTML (`orchestrationInstructions.ts`). This is effective, but it is static prompt text injected into every session: exactly the kind of context a middleware layer would specialise per thread.

---

## 7. Weaknesses and gaps

1. **No middleware or plugin layer.** All prompt shaping is hard-coded per adapter. There is no supported way to inject context into user-typed turns or veto tool calls without forking or going around T3 through harness config.
2. **Approvals are not a structural gate.** The default runtime mode is **Full access** (`providerPolicy.ts:28`). Even in Supervised mode, T3 sees only what the harness chooses to ask. All orchestration writes, including approvals, share one scope (`orchestration:operate`).
3. **Monolithic files and heavy churn.** `Orchestrator.ts` is 11.6k lines, `ClaudeAdapterV2.ts` 9.3k, `ChatView.tsx` 12k. The orchestrator landed 10/02 followed by about 600 fixes. Forking is expensive to maintain.
4. **Docs lag code** in places:
   - capability doc adapter contract;
   - `adding-a-provider.md` registration and dead links;
   - handoff docs (summaries, 240-char rule);
   - Cursor install docs;
   - Codex MCP injection doc;
   - relay hook path `:environmentId` vs `:endpointKey`;
   - `orchestration_v2_events` table.
5. **Capabilities partly decorative** (about 25 unread flags). `readThreadSnapshot` is required but never called. `ProjectionMaintenance` rebuild/compact is unwired. `resumeQueuedRuns` is unused. `builtInProviderAdapterDrivers.ts` is vestigial.
6. **Checkpoint refs never garbage-collected**, so repositories grow unbounded (`deleteCheckpointRefs` is only called after rollback). Nested checkpoint scopes are advertised but no-op.
7. **Forks share the source worktree**, which blocks file restore on both threads. Merge-back cannot be queued.
8. **ACP/Grok "rollback" is a context reset** while advertising `providerCanRollbackConversation: true`. Cursor and Muse cannot roll back.
9. **No delegation depth limit**. Children receive no parent context beyond the task prompt.
10. **Secrets in plaintext files**; ambient API keys leak into CLI-mode Codex and Claude. PostHog telemetry is on by default.
11. **No public SDK.** The API is Effect RPC over JSON with private client code, so third parties must vendor contracts and track protocol churn.
12. **Single-user, single-environment trust model.** No org, tenancy or multi-user permission model. Sessions are "this server's owner and their devices"; MCP clients get coarse ceilings. Nothing comparable to Kingdom owners or Signets.
13. **Handoffs are lossy by construction**: a 16k-token budget, whole items only, no semantic summary.
14. **Usage cost is estimated** from on-disk transcripts and LiteLLM prices, not metered. Long-tail providers are partial.
15. **Feature sprawl** (devices, snap-shot, HTML renders, MCP Apps, server browser, scheduled tasks, mobile widgets): many surfaces are days old with no user docs (scheduled tasks, preview). Upstream accepts no large outside contributions.
16. **Feedback does not persist across sessions.** Nothing in T3 captures user corrections, tags them, or measures recurrence. This is exactly the gap inixiative's thesis targets.
