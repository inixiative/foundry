# Headless Foundry over ACP

**Status:** accepted by Aron on 2026-10-11 (his answers are folded in below). Slices 1 and 2 are built (2026-10-11); see §9.

It changes what Foundry *is* to an outside client. Foundry becomes an agent you plug into an editor or runner, not a middleware layer bolted onto someone else's agent.

**Basis:**
- Foundry origin/main `5b5de6a`.
- agent-session origin/main `08f5081`.
- Paseo `1939ee79e`.
- T3 Code `f23d0084b6`.
- ACP TypeScript SDK `@agentclientprotocol/sdk` 1.8.0 (Apache-2.0, protocol v1 on its stable entry point).

**Path prefixes:**
- `pf/` = `foundry/packages/foundry/src`
- `pc/` = `foundry/packages/core/src`
- `pa/` = `foundry/packages/acp/src`
- `as/` = `agent-session/src`
- `paseo:` = `~/code/paseo`
- `t3:` = `~/code/t3`

Line references were checked against those commits. Anything not checked is marked **[unverified]**.

---

## 0. Decisions

**Aron, 2026-10-11, before this spec:**
- Middleware is our insight, and it runs in our own harness. Never in vendor hooks: hooking Claude's or Codex's CLI is "not agnostic". This rejected the earlier MIDDLEWARE-ADAPTER proposal (the `RuntimeAdapter` reshape, the `foundry hook …` CLI, per-worktree `.claude/settings.local.json`, a Paseo `before("agent.prompt")` upstream PR). It is superseded in full by this document and deleted.
- `foundry acp` speaks ACP JSON-RPC over stdio upward, so any ACP client (Paseo, T3 Code, Zed) can drive Foundry.
- Every turn passes through Foundry's middleware.
- "We should dogfood our own thing": the ACP surface runs on the same turn path as the viewer.

**Aron's answers to this spec's open questions (2026-10-11):**

| # | Question | Answer |
|---|---|---|
| 1 | Naming and package split | **No rename.** Foundry *is* the harness and the app, and stays `@inixiative/foundry` in `packages/foundry`. The three projects are **foundry-core**, **foundry-acp** (new, `packages/acp`) and **Foundry**. Oracle stays its own repo; its `@inixiative/foundry/runtime` import is untouched. |
| 2 | Daemon dependence | **foundry-acp requires the daemon and auto-starts it** through launchd. No embedded mode. |
| 3 | Sessions, threads, projects | `sessionId` = thread id. A `cwd` outside every registered project uses the existing **global (unscoped) scope**; never refuse. A prompt to a busy thread **queues**, using the existing queue. |
| 4 | What may block | **Wardens are a chorus:** they comment and never block. On a timeout the turn proceeds without them. **Only structural rules can deny.** |
| 5 | Asks under auto-approving hosts | **Access follows the host.** Honour the mode the user chose in the client, full access and dangerously-full-access included ("don't hamstring people"). No hand-wringing about T3 auto-allowing asks. |
| 6 | Mode semantics | ACP modes map onto the hosts' own permission modes, so they stay compatible across Claude, Codex, T3 and Paseo. **No Foundry-only stricter modes.** |
| 7 | Visibility in the host | A visible **"Foundry: context"** item plus `_meta`. Strip host instruction wrappers (`<t3_code_instructions>`) before feedback capture. |
| 8 | The viewer's future | **The viewer does not grow runner features** (worktrees, diffs, checkpoints, queue UI). Worktrees come from the project's own system (template `bun run worktree:*`). Stop/cancel stays, because ACP needs it. |
| 9 | Other ACP agents underneath | **Deferred: "All Claude for now"** (CLAUDE.md). agent-session's `acp` transport is a later item. |
| 10 | Remote | Specced, not built. ACP stays loopback-only until then. |
| 11 | License and dependency | foundry-acp is **MIT**. `@agentclientprotocol/sdk` is Apache-2.0 (verified on npm, 1.8.0, 2026-10-09), which an MIT package may depend on. |
| 12 | Protocol version | **ACP v1 only.** v2 when it leaves draft. |

---

## 1. Intent

The thesis is lasting behavior change without retraining. Feedback is captured while you work and turned into middleware, and Oracle measures whether the same correction stops coming back. Two things break that today:

- **Coverage.** The middleware only runs when Aron works inside the Foundry viewer. Turns in Zed, Paseo, T3 Code or a terminal are "outside Foundry" (FEEDBACK-LOOP H4). They get no injected context, no guards, and no "this rule was present on this turn" evidence, so Oracle cannot measure recurrence there.
- **Portability.** Hooking each vendor's CLI binds the middleware to Claude's and Codex's hook formats.

If Foundry *is* the agent the editor talks to, every turn from every ACP host enters through `Thread.dispatch` (`pc/thread.ts:322`). It passes through the same flow middleware, and the same journal and `InjectionArtifact` record what was delivered. The host owns the UI: editor, worktrees, diffs, mobile. Foundry owns the turn. So the corrections Aron gives in whatever app he is using land in one place, under one measurement.

---

## 2. The three projects

```
        ACP clients: Paseo (extends:"acp") · T3 (Local ACP command) · Zed · JetBrains
                                   │  ACP v1 JSON-RPC over stdio
                                   ▼
   ┌──────────── @inixiative/foundry-acp  (packages/acp, MIT) ────────────┐
   │  `foundry-acp`: stdio ACP agent ⇄ loopback client of the daemon       │
   │  maps session/* ⇄ threads, turns, thread + flow data streams          │
   └──────────────────────────────┬────────────────────────────────────────┘
                                  │ imports @inixiative/foundry/client only
                                  ▼   loopback HTTP + WS (the viewer's own API)
   ┌──────────── @inixiative/foundry  (packages/foundry, BSL 1.1) ─────────────┐
   │  daemon (launchd) · TurnService · viewer + data streams · FlowOrchestrator │
   │  Cartographer, Wardens, Librarian · persistence · MCP bridge · Kingdom    │
   └──────────────┬──────────────────────────────────────┬─────────────────────┘
                  ▼                                      ▼
   @inixiative/foundry-core (packages/core, MIT)    @inixiative/agent-session (MIT)
```

**Dependency direction:** foundry-acp → `@inixiative/foundry/client` → nothing heavy (types plus a small loopback client). Foundry → foundry-core and agent-session. foundry-core → no inixiative package. Nothing depends on foundry-acp.

### 2.1 foundry-core (`packages/core`, MIT)

Engine primitives with no runner and no I/O policy: Thread, the `Harness` pipeline, Executor, MiddlewareChain, ContextLayer/Stack, SignalBus, evidence types, CapabilityGate/ActionQueue. Nothing moves in or out.

**Changes:**
- **Slice 1:** `NativeObservation.interruptible` (`pc/native-evidence.ts`): the provider hands the turn that owns an admission the means to stop it. The thread forwards it like the other observation fields (`pc/thread.ts`).
- **Slice 2 (the gate):** `CapabilityGate` (`pc/capability.ts:136`) and `ActionQueue` (`pc/action-prompt.ts`) get their first real caller. `permissionMiddleware` (`pc/permission-middleware.ts:38`) gates `llm:call` per dispatch, not per tool call, and has no caller; delete it.

### 2.2 Foundry (`packages/foundry`, `@inixiative/foundry`, BSL 1.1)

The one place a Foundry turn runs: the daemon, turn acceptance and lifecycle, the middleware, persistence and evidence, the viewer, Kingdom pairing and Archive capture.

| Change | Slice |
|---|---|
| **`TurnService`** (`pf/turns/turn-service.ts`). The turn lifecycle that was written inline twice, in `POST /api/messages` and `POST /api/messages/send` with `runStreamedTurn` (`pf/viewer/routes/runtime.ts:405-707`), is one service: accept (durable `beginTurn`, 409 on duplicate, 503 if not durable), queue per thread, run through `Harness.send`, complete or fail, persist, notify the namer. Both routes are thin callers. | 1 |
| **Per-thread queue.** A turn sent to a busy thread is accepted at once and runs after the thread's previous turn settles. The queue is the existing `SerializedQueue` primitive (`pf/ws/serialized-queue.ts`, copied from the template's `serializedQueue`), one per thread. Beneath it, agent-session's native turn queue is unchanged. | 1 |
| **Stop.** `POST /api/threads/:threadId/turns/:turnId/interrupt` → `TurnService.interrupt`, answering one outcome: <br>• `cancelled`: a queued turn, settled at once without running. <br>• `requested`: a running turn not yet natively admitted; the native preflight or the admission registration (which precedes the native write) refuses it, so nothing is sent. <br>• `acknowledged` / `unacknowledged` / `no-turn`: a dispatched turn, stopped through `HarnessSession.interruptNative` (`as/harness-session.ts:251`), which `SessionBackedProvider` hands to the executor's turn through `NativeObservation.interruptible` (never to an auxiliary role's session). <br>• `unsupported`: admitted on a runtime with no native stop (Codex in agent-session 0.5.2); the turn runs to its end. <br>A cancelled turn is journalled `failed` with `cancelled: true`; `interrupted` stays reserved for "Foundry restarted and the native outcome is unknown". Live check (Claude, 2026-10-11): the stopped turn ends `Native terminal failed: aborted_streaming` and the thread takes the next turn. | 1 |
| **`POST /api/threads` accepts `cwd`.** The daemon resolves the project: the longest registered project path containing `cwd`, else the registered project whose path is `cwd`'s main git worktree (`git worktree list`, `pf/git/worktree.ts`). No match means the global scope: the thread has no `projectId`, as threads created without a project always have. Foundry never creates worktrees. | 1 |
| **`LiveActivity` carries tool input and output** (bounded) and text rows carry the exact appended text, so a client can stream deltas without diffing a bounded tail. The viewer ignores the new fields. | 1 |
| **`./client` export.** Wire types (`TurnAppend`, `LiveActivity`, `StreamBufferSnapshot`, `TurnTerminal`), a loopback HTTP client, a data-stream socket client, the ACP launch file reader and the launchd starter. This is the **only** surface foundry-acp imports, and the one Oracle uses when it drives turns through the daemon. | 1 |
| **ACP launch file.** The daemon (`FOUNDRY_DAEMON=1`) writes `~/.foundry/acp-launch.json` at startup, mode 0600, never through a symlink: `{version: 1, endpoint: "http://127.0.0.1:<port>", capability, pid, createdAt}`. `FOUNDRY_ACP_LAUNCH` overrides the path (tests, a second Foundry). With a tunnel active, the viewer accepts `Authorization: Bearer <capability>` **only on a direct loopback request** (loopback `Host`, no reverse-proxy headers such as `X-Forwarded-For` or `Cf-Connecting-Ip`), so the capability never works through the tunnel; without a tunnel, loopback needs no auth (`pf/viewer/server.ts:166-176`). The pattern is the MCP bridge's (`pf/mcp/transport.ts:109`, read with the same private-file checks as `pf/mcp/proxy.ts` `readLaunchFile`). | 1 |
| Delete `pf/demo.ts` and its scripts: CLAUDE.md lists demos in product repos as dead. | 1 |
| Thinking rows in `LiveActivity` (for `agent_thought_chunk`). | 2 |
| Delete `pf/providers/runtime.ts` `RuntimeAdapter` and its file injectors (never registered; the hook plan is dropped) and `pf/providers/claude-code.ts` `ClaudeCodeProvider` (imported in `pf/start.ts:42`, never constructed outside tests). Hard cut. | 2 |

### 2.3 foundry-acp (`packages/acp`, `@inixiative/foundry-acp`, MIT)

The ACP agent surface and nothing else. A thin stdio process:
1. Speak ACP v1 to the host (official SDK, `agent({name}).onRequest(…).connect(ndJsonStream(…))`).
2. Translate each ACP call into calls on the local daemon's API.
3. Project the daemon's `thread:<id>` and `flow:<id>` streams back as `session/update`.
4. (Slice 2) Forward the daemon's pending prompts for its own threads as `session/request_permission`.

It holds no Thread, no context and no middleware: the same stance as the MCP proxy, "a transport adapter: no Thread is reconstructed, no configuration is loaded" (`pf/mcp/proxy.ts:4-11`).

**Running it:** `bun run acp` at the repo root, or `bun <repo>/packages/acp/src/cli.ts`; the package declares a `foundry-acp` bin. The host spawns it per connection. See §10 for host configuration.

---

## 3. Dogfooding: one turn path

foundry-acp is the **second client of the daemon's API**, the one the viewer uses. The viewer does not become an ACP client:

1. **ACP is too narrow for the viewer.** The flow graph, phase journal, layers, traces, corrections, settings and Kingdom pairing have no ACP message. Routing them through ACP would be a private protocol inside `_meta`.
2. **The browser cannot be an ACP client.** ACP's transport is stdio; ACP over HTTP/WS is still experimental in the SDK.
3. **Gaps surface where they belong.** A gap foundry-acp hits is a gap the viewer has too (the missing stop route was one). Fixing it once fixes both.
4. **No new trust surface.** The proxy reaches the daemon over loopback, like the MCP bridge proxy.

**The one turn path.** A turn from Zed, Paseo, T3, the viewer or an Oracle run:

```
TurnService.accept             (beginTurn: 409 duplicate, 503 not durable; 202 to the caller)
  → per-thread SerializedQueue  (a busy thread queues; cancel before start never dispatches)
  → Harness.send               (pc/harness.ts:277)
  → classify ∥ route ∥ flow.prepare (early start, pf/agents/thread-runtime.ts:905-915)
  → flow-pre-message           (preMessage → hydrateDelta; route/advice phase rows sealed before the executor, :930-988)
  → Executor → SessionBackedProvider → HarnessSession.send (native preflight, admission, interruptible)
  → commitDelivery, postAction guards, Warden review (unchanged)
  → thread:<id> appends and the sender's terminal → viewer tab   and   → foundry-acp → session/update
```

ACP-originated threads are ordinary threads, so the viewer shows them live: flow graph, journal, corrections.

---

## 4. The ACP surface

### 4.1 Protocol version

**ACP v1.** Paseo sends `PROTOCOL_VERSION` from SDK `^0.17.1` (`paseo:packages/server/src/server/agent/providers/acp-agent.ts:1459-1465`), which is 1. T3 sends `protocolVersion: 2` (`t3:packages/provider-acp/src/server/AcpSessionRuntime.ts:2177`) and picks the generation from the response's *shape*: a v1 response has `agentInfo`/`agentCapabilities` (`t3:packages/effect-acp/src/client.ts:1128-1144`). The agent answers 1 whatever the client sends.

### 4.2 Method map

| ACP | Foundry machinery | Slice |
|---|---|---|
| **`initialize`** → `{protocolVersion: 1, agentInfo: {name: "foundry", title: "Foundry", version}, agentCapabilities: {loadSession: true, sessionCapabilities: {resume: {}}, promptCapabilities: {image: false, audio: false, embeddedContext: true}, mcpCapabilities: {http: true, sse: false}}, authMethods: []}` | Read the launch file and `GET /api/health`. **Daemon down:** start it through launchd (`launchctl kickstart`, or `bootstrap` of the installed LaunchAgent) and wait, bounded, for a fresh launch file and a healthy daemon; otherwise a JSON-RPC error that says to run `bun run daemon:install`. Client `fs`/`terminal` capabilities are ignored: the native worker does its own file and shell I/O. | 1 |
| **`session/new` `{cwd, mcpServers}`** → `{sessionId}` | `POST /api/threads {cwd, tags: ["acp", "acp:<clientInfo.name>"]}`. **`sessionId` is the thread id.** The client's name is a thread tag rather than a `ThreadContext` reference, because `ThreadContextTracker` re-derives references from Archive and would overwrite it (`pf/archives/thread-context.ts:83-101`). **Kingdom lock:** the daemon answers 503 with `recoveryUrl`; the error names `http://localhost:<port>/kingdom`. | 1 |
| **`session/resume` `{sessionId, cwd, mcpServers}`** | Reattach to the existing thread, no replay. Both hosts use it when `loadSession` is not advertised (`paseo acp-agent.ts:1856-1866`; `t3 AcpSessionRuntime.ts:2312-2326`), so a host survives its own restart. A `cwd` that differs from the thread's re-points it (`PATCH /api/threads/:id {worktreePath}`). | 1 |
| **`session/prompt` `{sessionId, prompt: ContentBlock[]}`** → `{stopReason}` | Content blocks flatten to one string: `text` verbatim, `resource_link` as `@<path or uri>`, embedded `resource` text fenced with its URI. The proxy holds `thread:<id>` and `flow:<id>` on its own socket client id, then `POST /api/messages/send {threadId, id, message, clientId}` (202). It answers when the sender-only terminal `{kind: 'done' \| 'error'}` arrives (`pf/viewer/data-streams.ts:21-22`); after a reconnect it settles from the thread snapshot's turn status instead. **stopReason:** `done` → `end_turn`; a cancel requested before the terminal → `cancelled`; `error` → a JSON-RPC error carrying the turn id. **Busy thread:** the turn queues (§2.2). | 1 |
| **`session/cancel`** (notification) | `POST /api/threads/:id/turns/:turnId/interrupt` for the session's active and queued turns. The pending prompt resolves `cancelled`. (Slice 2: pending `request_permission` calls are answered `cancelled` and their prompts resolved `rejected`.) | 1 |
| **`session/update`** | §4.3 | 1 |
| **`session/load`** `{sessionId, cwd, mcpServers}` | Replay history as `user_message_chunk`/`agent_message_chunk`/`tool_call` from `GET /api/threads/:id/history` (`runtime.ts:801`) and turn detail (`:826`), then respond; advertise `loadSession: true`. | 2 |
| **`session/set_mode`**, `session/set_config_option`, `unstable_setSessionModel` | §4.5 | 2 |
| **`session/request_permission`** | ActionQueue prompts for this session's thread (§5.2) | 2 |
| `session/list`, `session/fork`, `session/close` | `list` → `GET /api/threads?project`. `fork` returns 501 today (`runtime.ts:1049`), so it is not advertised. | later |
| `authenticate` | Not offered (`authMethods: []`). Native logins stay where they are. | — |

### 4.3 `session/update` projection

| Source | ACP update | Slice |
|---|---|---|
| Turn accepted | `tool_call {toolCallId: "foundry-context:<turnId>", title: "Foundry: context", kind: "think", status: "in_progress"}`, so the host is never silent while the middleware runs. | 1 |
| `flow:<id>` turn append whose phases include the sealed `route`/`advice` rows (written before the executor, `thread-runtime.ts:946-988`) | `tool_call_update {status: "completed", content: <summary>, _meta: {foundry: {threadId, turnId, routing, participants}}}`. The summary names the routing outcome (status, layers, domains, confidence) and each Warden's decision and reason. When the executor's first output arrives first, the proxy reads the same rows from the turn-detail route (they are durable before the executor runs), so the item completes as the answer starts. A turn with no rows recorded completes saying so; a send Foundry refused completes with the refusal. | 1 |
| `thread:<id>` `{kind: 'delta', text}` | `agent_message_chunk {content: {type: "text", text}}` | 1 |
| `{kind: 'activity', row}` text rows | `agent_message_chunk` with the row's `appended` text; a snapshot row that extends the text already sent sends only the new suffix. | 1 |
| `{kind: 'activity', row}` tool rows | First sight of a row: `tool_call {toolCallId: <admissionId>:<callId>, title, kind, status, rawInput, locations}`; later states: `tool_call_update {title, kind, status: completed \| failed, rawOutput, content}` (title and kind repeated, because T3 rebuilds a call's label from each update). `kind` comes from the tool name (Paseo renders `read/edit/delete/search/execute/fetch/think/switch_mode`, `acp-agent.ts:3774-3792`); `locations` from `file_path`/`path`/`notebook_path` in the input. | 1 |
| Terminal `done` with no text streamed at all | One `agent_message_chunk` with the final content. | 1 |
| Native `thinking` events (`as/harness-session.ts:82-95`) | `agent_thought_chunk` (needs thinking rows in `LiveActivity`). | 2 |
| Claude `TodoWrite`, Codex `update_plan` (`pf/viewer/turn-flow.ts` `TASK_SOURCES`) | `plan {entries}` | 2 |
| Guard findings and critical post-hoc findings | `tool_call {kind: "think", title: "Foundry: guard"}`: a comment, never a block (§5.2). | 2 |
| Mode or config changes | `current_mode_update`, `config_option_update` | 2 |
| `available_commands_update` | `/correction <text>` → `POST /api/threads/:id/interventions` (`runtime.ts:772`): feedback typed in an editor reaches capture. | 2 |

### 4.4 MCP servers passed by the client

**Built in slice 2.** Paseo injects its own tool catalog as MCP servers by default (`paseo:docs/custom-providers.md:513-530`); Foundry now passes them through.

**As built:** `session/new`/`load`/`resume` send them to `PATCH /api/threads/:id/launch` (`pf/providers/thread-launch.ts`, daemon memory only). For Claude they become one more `--mcp-config` pointing at a private file (0600 in a 0700 temp directory outside `.foundry`, deleted when the process exits), so env and header values are in neither argv nor the environment Claude's tools inherit; for Codex they are `mcp_servers.<name>` app-server config over stdio. A change relaunches the idle executor session on the thread's next turn, resuming its binding. SSE servers are dropped.

**Original plan:** `session/new`/`load`/`resume` pass `mcpServers` to the thread's `SessionAdapter.createSession` (`pf/providers/session-adapter.ts:271`), next to Foundry's own bridge, through `pf/providers/native-launch.ts`: an extra `--mcp-config` for Claude (`withNativeBridge` composes and refuses name collisions, `:62-117`), `mcp_servers.<name>` keys for Codex (`:27-58`). Server `env` and `headers` can hold secrets, so they live only in daemon memory for the thread's process, never under `.foundry`; `session/load` re-supplies them. Advertise `http: true` once Claude's http config is wired. `sse` and v2 MCP-over-ACP are not offered.

### 4.5 Modes and models (slice 2)

**Modes are the host's permission modes**, passed through to the native runtime. Foundry adds no mode of its own and none stricter than the host's:

| ACP mode id | Claude (`--permission-mode`) | Codex (app-server approval policy / sandbox) |
|---|---|---|
| `default` | `default` (asks) | `on-request` / `workspace-write` |
| `acceptEdits` | `acceptEdits` | `on-request` / `workspace-write`, edits auto-approved |
| `plan` | `plan` | `never` / `read-only` |
| `bypassPermissions` | `bypassPermissions` | `never` / `danger-full-access` |

The ids are the Claude Code ACP adapter's, which Zed and Paseo already render. T3's runtime modes (`approval-required`, `auto-accept-edits`, `full-access`, `dangerFullAccess`) select them by the same meaning **[unverified: T3's mode-id matching for ACP agents]**. Today the native worker runs `bypassPermissions` (`as/claude-code-session.ts:84-85,320`); slice 2 makes the host's choice reach it.

**Which mode a session starts in (built 2026-10-12, Aron: "access follows the host").** Neither Paseo nor T3 puts a mode in `session/new`; each sets the user's choice right after it, before the first prompt. So a session's mode is, in order:
1. a mode the host sets on the session: `session/set_mode`, or `session/set_config_option` on the `mode` option. Paseo sends `set_mode` for the mode chosen for the agent (`applyConfiguredOverrides`, `paseo acp-agent.ts:2926-2935`); T3 sends the composer's persisted Mode selection, which is a native config option once the agent offers one (`t3 adapter.ts:6336-6412`, `sessionConfig.ts:18`) and plan mode through the same option (`:6424-6445`);
2. on `session/load` and `session/resume`, the thread's current mode. A viewer thread with no mode keeps full access. An ACP thread with none goes on to step 3: launch settings live in daemon memory, so a daemon restart forgets them, and Paseo and T3 re-apply their choice after a load;
3. the mode the host's configuration passes: `foundry-acp --permission-mode <mode>` in the host's command (§10), for a host whose own setting never reaches the agent. T3's runtime mode (Full access by default) and Paseo's Auto Accept toggle are such settings: each answers `request_permission` by its own policy (`t3 clientPolicy.ts:178-236`; `paseo acp-agent.ts:860-875`) and tells the agent nothing;
4. otherwise `default`.

The mode is advertised twice and kept in step: as `modes` and as a `mode` config option (category `mode`), so a host that drives modes through config options (T3; Zed **[unverified]**) sees one Mode control. Each `request_permission` carries the call's `rawInput` and `locations`, which a host's policy reads (T3 confines edits to the workspace by path). `locations` come from `file_path`/`path`/`notebook_path` only, so a Codex `apply_patch` names none, and T3's `workspaceWrite` policy refuses a path-less edit.

Verified with the hosts' own clients from scratch copies (2026-10-12): Paseo's `GenericACPAgentClient` with a chosen mode, with `--permission-mode` in its command, with both (the chosen mode wins) and with neither (`default`); its features stay `auto_accept` only. T3's `AcpSessionRuntime` with T3's own `acpProviderOptionDescriptors` (one Mode option, no synthetic duplicate), a persisted Mode selection and plan through the config option, `--permission-mode`, and asks answered by T3's own `acpPermissionDisposition` in each runtime mode. Zero decode failures. In each case the executor launched in the expected mode.

An `ask` from the native runtime becomes `session/request_permission`. Whatever the host answers is the answer: if its mode auto-allows (T3 full access, Paseo "Auto Accept"), so be it. **Structural rules are the only denials** and hold in every mode, because they are the user's own configured structure, not a mode.

**`configOptions`:** category `mode` (the mode again, above), category `model` (native models for the thread's runtime, `pf/models/registry.ts:53`), category `thought_level` (effort, `as/claude-code-session.ts:75-79`), and a `select` of the project's executor agents. Switching model within a runtime respawns with `--resume` and the new `--model` on the next turn.

---

## 5. Middleware on the ACP path

Nothing is ACP-specific: every point applies equally to viewer turns, because the turn path is shared.

### 5.1 Pre-turn injection

Unchanged. `flow.prepare` starts early, in parallel with classify and route (`thread-runtime.ts:905-915`); `preMessage` → `hydrateDelta` follows (`pf/agents/flow-orchestrator.ts:441,846`); the native session holds the standing layers in its base context, and each turn carries the decoration plus only the layers whose hash changed, as `# System Context` text (FLOW.md "Delivery", `pf/providers/session-delivery.ts`); `commitDelivery` records what the provider reports it delivered; a pre-message failure is non-fatal.

**Host instruction wrappers (slice 2).** T3 wraps prompts for ACP agents as `<t3_code_instructions>…</t3_code_instructions>\n\n<user_request>…</user_request>` (`t3:packages/provider-core/src/server/orchestrationInstructions.ts:93`). The prompt reaches the native agent verbatim. Before feedback capture and classification, known wrappers are stripped into turn metadata, so a host's instructions never count as Aron's words.

### 5.2 Tools: structural gate, chorus Wardens (slice 2)

**Where the request comes from.** agent-session normalises each runtime's native approval channel into one callback:

| Transport | Approval channel today | Change |
|---|---|---|
| `claude-cli` | `approvals: 'mode'`, runs `bypassPermissions` (`as/claude-code-session.ts:84-85,320`; `as/transport.ts:75,87`) | Wire `--permission-prompt-tool stdio` (the `can_use_tool` control request) **[unverified wire detail; one VCR cassette]**, run the host's mode, declare `approvals: 'callback'`. Fallback: the `claude-agent-sdk` transport, which already has `canUseTool` (`as/claude-agent-sdk-session.ts:37-47,280-283`). |
| `codex-app-server` | `approvals: 'refuse'`; every server request gets -32601 | Answer `item/*/requestApproval` (COMPARISON adopt #3). |

**Contract (agent-session).** `HarnessSession.onToolRequest(gate: (call) => Promise<'allow' | {deny: reason} | {ask}>)`.

**Decision (Foundry).** `SessionBackedProvider` routes the request to the thread's gate:
1. **Structural (always, ~0 ms, no model call).** Classify the call into a capability (`Bash` → `exec:shell`; `Write`/`Edit` + path → `file:write` with `protectedPaths`; `mcp__*` → `net:api`), then `CapabilityGate.check` (`pc/capability.ts:158`) against the user's configured structural rules. `deny` is final and its reason reaches the model through the native deny message. Anything the native mode would ask about becomes `ActionQueue.prompt`.
2. **Wardens are a chorus, not a gate.** A Warden finding on a tool call is a comment: it is journalled and shown in the host as a "Foundry: guard" think item. It never turns into `ask` or `deny`. Wardens on this path run with a deadline; on timeout the call proceeds without them. The memory "programmatic" guard does not run here (it is an LLM call per tool today, `thread-runtime.ts:178,820`).

**As built (slice 2).**
- agent-session 0.6.0: `HarnessSession.onToolRequest(gate)`. Claude (`toolGate: true`) launches with `--permission-prompt-tool stdio` and registers a PreToolUse callback over the control protocol: the `pre-use` stage runs before every tool call in every mode (verified on CLI 2.1.296: a deny holds under `bypassPermissions`); `can_use_tool` is the `permission` stage. Codex app-server answers `item/commandExecution|fileChange/requestApproval` (approvals routed to the user reviewer). Gate failures and unparseable callbacks deny.
- Foundry: `toolRules` in settings (project capabilities override global; protected paths add up) through core `permissionLevel`; `pf/turns/tool-gate.ts`. `deny` is final in every mode; a structural `prompt` asks in every mode and is never answered by an "always" policy; a native ask becomes an `ActionQueue` prompt. Codex has no pre-use stage, so a Codex thread with deny/prompt rules refuses to start. The gate is bound lazily and fails closed before it exists.
- Wardens stay the post-action chorus: their findings are journalled as `notes` on `guard-outcome` rows and shown in hosts as "Foundry: guard" comments. Nothing in that path blocks.

**Escalation.** One prompt shows in two places and the first responder wins: the viewer's `prompts` stream (`pf/viewer/data-streams.ts:152-165`), and foundry-acp's `session/request_permission` with `allow_once`, `allow_always`, `reject_once`, `reject_always`. The answer goes to `POST /api/prompts/:id/resolve` (`pf/viewer/routes/control.ts:726`). `allow_always`/`reject_always` install a thread-scoped `ActionQueue.addPolicy` (`pc/action-prompt.ts:118`).

**Journal.** `gate-request` and `gate-outcome` join the phase union (`thread-runtime.ts:331`), written through the same `session_phase` table.

### 5.3 Post-turn learning, the journal and Oracle evidence

Unchanged: `tool_observation` → `postAction` guards (`thread-runtime.ts:1089-1270`), the `dispatch` signal → Warden review and learning, phase rows, the `InjectionArtifact`, delivery evidence, Archive capture.

New for evidence: the `acp:<client>` thread tag travels with the thread into Archive capture, so Oracle can split recurrence by host, and sessions in Zed, Paseo and T3 stop being "outside Foundry" (FEEDBACK-LOOP H4).

### 5.4 Latency

Warm decisions take 1.1–4.3 s, median ~1.7 s; a cold role 5–7 s; a 10 s safety deadline per decision (`docs/subscription-decisions.md:120-122`). The ACP path adds no budget of its own: the "Foundry: context" item opens the moment the turn is accepted, the structural gate makes no model call (target < 100 ms), and guards and learning stay off the critical path.

---

## 6. Downward: agent-session

**Role (unchanged):** native sessions and transports, primed decision sessions, subscription logins, pools and limits. It is the only place that knows vendor wire formats.

**Deferred under "All Claude for now".** The client-side `acp` transport (`as/transport.ts:162-183` is a stub; `as/transports.ts:47-54` throws) and a Foundry `AcpSessionAdapter`, which would put Gemini CLI or another ACP agent under a Foundry thread, wait until Aron branches off Claude. The design stays as written in this doc's history: an `AcpSession implements HarnessSession` on the official SDK, `agent_message_chunk` → `text_delta`, `tool_call` → `tool_use`, `request_permission` → `onToolRequest`, `interruptNative` via `session/cancel`, and a `FOUNDRY_ACP_DEPTH` guard so Foundry never wraps itself.

**Conformance in the meantime** uses a small client built on the official SDK, scripted with the exact request sequences Paseo and T3 send (§8), plus a run of T3's own `effect-acp` client from a scratch copy.

**Sessions and subscriptions (unchanged):** one native session per thread, the thread→native-id map in `.foundry/sessions.json`, API keys stripped, `apiTokens` the only paid path, decision roles on primed Claude sessions.

---

## 7. Identity and authority

### 7.1 Local stdio clients are local

The host spawns foundry-acp as the same OS user, and it talks to the daemon over loopback. Under the hub rule ("Only locals connect directly to Foundry", CLAUDE.md 2026-10-07), that is local. Without a tunnel the viewer API needs no auth on loopback; with one, foundry-acp presents the launch file's capability (§2.2), never the tunnel token. The Kingdom lock applies unchanged.

### 7.2 Remote clients (specced, not built)

ACP over stdio has no remote mode of its own.

- **Host-relayed remote** (Paseo relay, T3 Connect, a phone driving a desktop host): the host spawns foundry-acp on the Foundry machine, so the Foundry connection is still local, and the remote human is the host's to authenticate. Whoever holds owner on that host can drive Foundry; the `acp:<client>` tag records which host it was.
- **Foundry on another machine** goes through Kingdom: Signet operations on the `foundry` integration (`thread.read`, `thread.prompt`, `prompt.resolve`; the catalog has `operations: []` today), metered through `AccessExecution`/`UsageEvent`. Do not open the daemon's ACP surface to the tunnel.

### 7.3 Thread identity per ACP session

- **One ACP session = one Foundry thread.** `sessionId === thread.id`.
- **Restarts:** threads persist in the local store and are restored on daemon restart (`pf/viewer/server.ts:227-232`). A host that kept the `sessionId` calls `session/resume` (slice 1) or `session/load` (slice 2) and gets the same thread with its knowledge, ledger and journal.
- **Two hosts, one thread:** their turns queue on the thread (§2.2).

### 7.4 Project and worktree mapping

- **`cwd` → project:** the longest registered project path that contains `cwd`; otherwise the project registered at `cwd`'s main git worktree.
- **No match:** the global scope (no `projectId`). Never refuse, never auto-register.
- **`cwd` → thread:** `thread.meta.cwd = cwd`, and `ThreadContext` is refreshed. Hosts such as T3 and Paseo create a worktree per thread with the project's own tooling; Foundry adopts it and never creates one.

---

## 8. Test cases

**Conventions** (the foundry repo's): real `LocalSessionStore` on a temp `.foundry` dir; a real viewer on an ephemeral loopback port; controlled native sessions (`tests/helpers/live-watch-fixture.ts`) or VCR cassettes for the CLIs; no mocks of Foundry internals.

**Slice 1:**
1. **One turn path.** The sync and streamed routes run through `TurnService`; every existing route test passes unchanged.
2. **Busy thread queues.** Two sends to one thread: the second is accepted (202) at once, runs only after the first settles, and both complete in order.
3. **Cancel.** Before dispatch (queued, or in pre-message middleware): no native admission, the turn is journalled failed with `cancelled: true`. After dispatch: `interruptNative` is called, the turn settles cancelled, and the next turn on the thread runs.
4. **cwd → project.** A `cwd` inside a registered project, a linked worktree of it, and a `cwd` outside every project (global scope, accepted).
5. **Launch file.** Written 0600, refused when group/other-readable or a symlink; with a tunnel active, the capability bearer is accepted and a wrong one refused.
6. **ACP end to end (Paseo's sequence).** foundry-acp as a subprocess against a real viewer: `initialize` with Paseo's `clientInfo` and capabilities, `session/new {cwd, mcpServers: []}`, `session/prompt` with `messageId`; updates arrive as the "Foundry: context" item, message chunks and `tool_call` (kind, `rawInput`, `locations`) → `tool_call_update completed`; `stopReason: end_turn`; the thread carries the `acp:Paseo` tag; then `session/cancel` mid-turn → `cancelled`; then `session/resume`.
7. **ACP end to end (T3's sequence).** `initialize` with `protocolVersion: 2` gets a v1-shaped answer; cancel followed immediately by a new prompt (T3's default cancel behaviour, `AcpSessionRuntime.ts:2449-2470`) queues behind the cancelled turn and completes.
8. **T3's own client.** A scratch copy of t3 `packages/effect-acp` drives foundry-acp and negotiates generation 1.

**Slice 2:**
9. **Load after daemon restart.** History replayed before the response; same thread; the next turn resumes the stored native id; client MCP servers re-applied; nothing secret under `.foundry`.
10. **Structural deny holds in every mode,** `bypassPermissions` included: the tool never executes, the model gets the reason, `gate-request`/`gate-outcome` rows are written, no model call, < 100 ms.
11. **Ask reaches the host, first responder wins:** one ActionQueue prompt; `session/request_permission` with the 4 option kinds; `allow_always` installs a thread-scoped policy; a viewer answer first makes the ACP request return `cancelled`.
12. **A Warden comments, never blocks:** a critical finding is a "Foundry: guard" item and the tool still runs; a Warden timeout does not delay the call.
13. **Wrapper stripping:** a `<t3_code_instructions>` prompt reaches the native agent verbatim and feedback capture sees only the `<user_request>` body.
14. **Live hosts:** a Paseo daemon from a scratch copy with an `extends: "acp"` provider, and a T3 server with a "Local ACP command" instance, both pinned to recorded commits, as a nightly live job.

---

## 9. Build order

**Slice 1 (built 2026-10-11, main a302b41):** TurnService with the per-thread queue; the interrupt route; `cwd` → project with global fallback; `LiveActivity` input/output and exact text deltas; `./client`; the ACP launch file and capability; `NativeObservation.interruptible`; foundry-acp with `initialize`, `session/new`, `session/resume`, `session/prompt`, `session/cancel` and `session/update` (the context item, message chunks, tool calls); demo deleted. Tests: cases 1–8.

**Verified for slice 1:** the repo's full check and browser suite; foundry-acp driven as a subprocess with Paseo's and T3's request sequences (`packages/acp/tests/conformance.test.ts`); T3's own `effect-acp` `AcpClient` and its `AcpSessionRuntime`, and Paseo's own `GenericACPAgentClient` (SDK 0.17.1), all from scratch copies with zero decode failures; a live run on Claude through an isolated Foundry (real routing and Warden decisions in the context item, a real `Bash` tool call, cancel, the next turn).

**Known gaps from slice 1:**
- ~~A queued turn is journalled `active` from acceptance.~~ Fixed in slice 2 (Aron, 2026-10-11): a turn is `queued` until the executor takes its input (Harness `onExecutorInput`) or its executor admission registers, then `active`; restart recovery fails a queued turn as never sent and keeps `interrupted` for an active one.
- A host that cancels a turn on a runtime without a native stop (`unsupported`) gets `cancelled` per ACP while the journal records the turn's real outcome.
- Text rows are diffed against a bounded 4 KiB tail when a runtime sends repeated full-text snapshots for one item longer than that; deltas are exact.

**Slice 2 (built 2026-10-11):** all of items 1–3 below, plus the `queued` turn status. Tests: `packages/acp/tests/slice2.test.ts` (cases 9–13 against the controlled native fixture), `tests/tool-gate.test.ts`, the adapter and provider tests, and a live Claude cassette (`worker.gate`: a structural Bash deny under `bypassPermissions`). Not built: the executor-agent `select` in `configOptions`; case 14 (nightly live hosts) and the Zed smoke. Thinking now reaches the live stream as `thought` rows (never the journal), which changes the earlier live-watch contract that kept reasoning out of the stream entirely.

**Slice 2 (plan):**
1. `session/load` with replay; client `mcpServers`; modes and `configOptions` (§4.5); `/correction`; wrapper stripping; thinking and plan updates; a viewer stop button on the existing route.
2. The gate (§5.2): agent-session `onToolRequest`, Claude stdio permission prompt, Codex `requestApproval` (ships through the agentic train first); Foundry structural classification → `CapabilityGate` → `ActionQueue` → `request_permission`; gate journal rows; Warden chorus items; delete `permissionMiddleware`.
3. Dead code: `RuntimeAdapter`, `ClaudeCodeProvider`.
4. CI: Paseo and T3 live conformance as a nightly job; a manual Zed smoke **[unverified: Zed's custom agent settings key]**.

**Later:** agent-session `acp` transport and `AcpSessionAdapter` (when Aron branches off Claude); Kingdom `foundry` catalog operations for remote, Signet-governed access (§7.2); ACP v2 once it leaves draft.

---

## 10. Pointing a host at Foundry

The daemon must be installed once (`bun run daemon:install` in the Foundry checkout); foundry-acp starts it when it is down. Use the checkout the daemon runs from.

**Paseo** (`~/.paseo/config.json`, `paseo:docs/custom-providers.md:489-531`):

```json
{
  "agents": {
    "providers": {
      "foundry": {
        "extends": "acp",
        "label": "Foundry",
        "command": ["bun", "/Users/arongreenspan/code/inixiative/foundry/packages/acp/src/cli.ts"]
      }
    }
  }
}
```

**T3 Code:** Settings → Providers → Add provider → **Local ACP command** (`t3:docs/user/providers-acp.md:26-35`). Executable `bun`; one argument `/Users/arongreenspan/code/inixiative/foundry/packages/acp/src/cli.ts`; display name `Foundry`.

**A default mode for every session a host opens:** add `--permission-mode <default | acceptEdits | plan | bypassPermissions>` after the `cli.ts` path (Paseo: two more `command` entries; T3: two more arguments). A mode picked for a session in the host still wins. Without it, a session the host sets no mode on starts in `default`, and the host answers each ask by its own policy.

**Zed / JetBrains:** a custom agent server whose command is `bun` with the same argument **[unverified: exact settings key]**.

---

## History

- **2026-10-11, MIDDLEWARE-ADAPTER.md (rejected).** It proposed keeping the decision core and changing only the binding: the unused `RuntimeAdapter` as the runner-neutral contract, Claude and Codex native hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`) written into per-worktree settings so Paseo and T3 would reach Foundry without a fork, and a Paseo `before("agent.prompt")` upstream PR. Aron: "this will just be a claude hook… not our harness? … i dont like running via claude hooks. thats not agnostic." He chose headless Foundry over ACP instead, and this document replaced it the same day.
