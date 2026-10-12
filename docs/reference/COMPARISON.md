# Paseo vs T3 Code vs inixiative: comparison

**Inputs:**
- `PASEO.md`: getpaseo/paseo `1939ee79e`, Apache-2.0.
- `T3CODE.md`: pingdotgg/t3code `f23d0084b6`, MIT.
- `INIXIATIVE.md`: origin/main of agent-session `08f5081`, foundry `d51564b`, kingdom `4f46cf5c`, oracle `6656362`, archive `b40602f` and signet `6aa5937`.

I re-checked the claims this comparison rests on against code; see §6 for what was checked and what I corrected.

**Framing (Aron, 2026-10-11).** Paseo and T3 Code are resources. Our insight is the middleware: feedback captured while working becomes a middleware layer, and Oracle measures whether the correction stuck. Foundry runs *inside* runners like these as an ACP agent, with the middleware in our own harness (see [FOUNDRY-ACP.md](FOUNDRY-ACP.md)), not in front of them through vendor hooks.

**Maturity key:**
- **S** solid: wired and tested.
- **P** partial: works, with gaps.
- **X** experimental, or stub/unwired.
- **—** absent.

---

## 1. Matrix, areas A–M

| Area | Paseo | T3 Code | inixiative |
|---|---|---|---|
| **A. Runtime / providers** | Claude through the Agent SDK pointed at the user's `claude`; Codex app-server; OpenCode; Pi/OMP; 6 ACP adapters + 38 presets; plugin providers. Subscription logins are inherited. **S** (Claude/Codex/OpenCode); ACP **X** | Claude through the SDK; Codex app-server with a schema generated from openai/codex; Cursor SDK, Grok, OpenCode, Pi, Muse, Antigravity; ACP registry and local command. Multi-account shadow homes. **S** core; long tail **P** | agent-session: Claude CLI stream-json and Codex app-server. The Agent SDK driver is unused; ACP/API are stubs. Its unique pieces are primed warm decision sessions and pools/routing, though Foundry uses no pools. **S** but narrow (2 harnesses) |
| **B. Session lifecycle** | 5 states. Idempotent creation journal. Lazy resume. Archive cascade. Cancel with settle tokens. Native steer, else interrupt and replace. Queue is client-side only. Rewind is provider-native. **S** (queue **P**) | Event-sourced Run/Attempt/Node graph. Durable queue (a queued Run is a row). Steer/queue/restart policy. Recovery cancels rather than resumes. Settlement inbox. Fork/merge-back. **S** | Thread + SQLite turns. Native resume. Admission evidence before the native write. **No stop route.** Revert/fork return 501. **P** |
| **C. Streaming / wire** | zod WS with ~430 message types and ~80 feature flags. Timeline fetch uses an epoch+seq cursor. Binary terminal frames. **S** | Effect RPC with ~300 scoped methods. Per-thread snapshot plus seq replay with size caps. Bounded wire projection. **S** | One data-stream WS: open → snapshot/append → close, with **no seq/replay, by Aron's 9/23 design**. Kingdom mirrors the same shape. agent-session normalizes events in process. **S** (deliberately simple) |
| **D. Workspaces / git** | Worktrees with setup/teardown and a gate for untrusted PRs. Live diff, review comments, forge via gh/glab/tea, PTY terminals, service proxy. No checkpoints. **S** | Worktree per thread with setup scripts. Hidden-ref checkpoints, per-turn "authored" diffs, rollback with an isolation guard. PR pipeline and an 80-component review UI. **S** (refs never GC'd) | Lists existing worktrees only. `diffStat` is never called. Revert/fork return 501 (`viewer/routes/runtime.ts`). **X** |
| **E. Multi-agent** | `create_agent` over MCP (off by default). Children push a finish notification into the parent turn. Advisor/committee/handoff skills. Provider subagents shown. **S** | `delegate_task` across providers with mailbox semantics and a mode ceiling. Thread launch/send/wait tools. Subagent projection. No depth limit. **S** | One executor per thread. Cartographer + N Wardens run in parallel on warm primed sessions. Herald/Planner are unwired. Decision roles **S**; sub-agents **—** |
| **F. Middleware / interception** | Create-time `systemPrompt`. Plugin `before(agent.create, agent.session_open, workspace.create)`. Turn events are fire-and-forget. Permission responses are async and race the user. **No per-prompt hook, no synchronous gate.** It loads the user's Claude hooks. **P** (shallow by design) | **None.** Instruction blocks are hard-coded per adapter. Seams exist only by fork (`decorateRuntime`) or through harness-native hooks. **—** | FlowOrchestrator pre-message: route and advise, frozen plan, ledger, delivery evidence, phase journal. Post-tool guards. Per-thread learning. **No blocking gate, no mid-turn push**, criticals only logged, feedback→middleware not closed. Core **S**; loop **P** |
| **G. Permissions / auth** | 9-permission enum enforced per RPC. Effectively one principal (owner). No password means no auth. A relay QR link grants owner. Hub gets `hub.execute`. **P** | DPoP/bearer/cookie. 15 scopes on a total RPC map. MCP OAuth with a mode ceiling. Single user. Default runtime mode is **full-access**. **S** for a single user | Kingdom owners, Integrations, Credentials, Signets, DPoP enrollments, metered execution (`AccessExecution`/`UsageEvent`). Locally: worker runs `bypassPermissions`, `CapabilityGate` is unwired, the Foundry pairing Signet has `operations: []`. Hub **S**; local gate **—** |
| **H. Remote / multi-device** | Direct, SSH or an E2EE relay. iOS/Android/web/Electron. Push notifications with plaintext previews. **S** | LAN, Tailscale, SSH, T3 Connect (Cloudflare tunnel per environment, relay off the data path). Mobile with Live Activities. **S** | localtunnel/cloudflared plus Kingdom "Open Foundry" handoff and embed. Installation presence socket. Browser only. **P** |
| **I. Automation** | Cron schedules, heartbeats, Hub triggers (closed source). **S** | Scheduled tasks (interval, fixed time, webhook). PR-watch wakes. Usage-limit resume. `t3 service`/self-update. **X→S** | launchd daemon with staged self-update. Archive collectors. Hosted Archive provisioning. No schedules. **oracle-worker cannot boot.** **P** |
| **J. Extensibility** | Server and client plugin API, plugin providers, registry, public SDK, large CLI. Unsandboxed. **S** | **No plugins.** 82 MCP tools. ACP local command. Private RPC client. **P** | Settings-driven agents, layers and sources with live reconfigure. 7-tool MCP bridge. `RuntimeAdapter` exists but is unused. User hooks are off by design. Config **S**; plugins **—** |
| **K. Storage** | JSON files. **No durable transcript**: provider files are the authority. No migrations. **S** (simple) | SQLite event log with 17 projections committed in the same transaction. Effect outbox, receipts, 57 migrations. **S** | Foundry SQLite + files, optional Postgres. Kingdom on Postgres + Redis. Archive on Postgres + pgvector (embedding column unused). **S** |
| **L. Observability** | Per-turn usage, not persisted. Quota readers for 9 vendors. pino logs, diagnostics. No audit trail, no cost ledger. **P** | OTLP traces and metrics, NDJSON provider logs, usage parsed from native transcripts, limit readers. PostHog on by default. **S** | Span traces, **phase journal**, **injection/delivery evidence**, decision receipts, per-Signet usage. No OTel, no quota view. **S** for middleware audit |
| **M. UI / UX** | Expo app + Electron. Terminals, diff review, voice, in-app browser automation, 9 locales. **S** | React web + Electron + Expo. Virtualized timeline, Shiki, `@pierre/diffs`, ghostty-WASM terminal, Tiptap composer, PR review. **S** | Preact no-build viewer. **Middleware views** (flow graph, layer band, traces, corrections). No stop, diff, terminal or approvals. **P** (unique views) |

---

## 2. Where each one is strongest

- **Paseo** is strongest at breadth and openness:
  - It has the most providers.
  - It has the only real **plugin API** among the three, covering server hooks, plugin providers and client panels, so it is the one runner we can sit *inside* without forking.
  - It is one daemon with one protocol for app, CLI, plugins and SDK.
  - It is mobile-first, with remote reach through an E2EE relay.
  - It loads the user's Claude settings, so `settingSources: ["user","project","local"]` makes Claude-native hooks work inside it.
- **T3 Code** is strongest at engine rigor and git depth:
  - Its event-sourced orchestration commits intent before side effects, and recovery prefers cancelling over resuming.
  - It has a durable queue with steer/restart policy, hidden-ref checkpoints with rollback safety, and cross-provider delegation.
  - It has OTLP observability and the most polished web UI (diffs, terminal, composer).
  - It is weakest exactly where we are strongest: it has no middleware, and its trust model is single-user.
- **inixiative** is strongest where neither runner has anything:
  - the **middleware decision core** (frozen plan, warm primed decision sessions, per-call deadlines, delivery evidence, phase journal);
  - the **multi-party permission hub** (Kingdom owners/Signets/lenses, metered execution);
  - **Archive**, which captures sessions across tools;
  - **Oracle**, which builds fixtures and scores them.

  We are weakest at everything a runner does: worktrees, checkpoints, diff, stop, queue, terminals, mobile, providers.

---

## 3. Adopt list

**Rules applied:**
- **Licenses.** Paseo is Apache-2.0 only from `a8734a97` (2026-08-27); code in its history from 2026-02-25 to 2026-08-27 is **AGPL**, so port from current HEAD only. Copying code verbatim requires keeping the notice: Apache needs the LICENSE/NOTICE text and a statement of changes; MIT needs the copyright line. Reimplementing a pattern needs no notice.
- **T3 is written in Effect.** Porting it into our Bun/plain-TS repos means rewriting it, which means pattern-level reuse.
- **Targets.** agent-session and foundry-core are MIT and Foundry is BSL 1.1. Including Apache or MIT code in any of them is fine with notices.
- **Sizes.** S is under 200 LOC, M is 200–800, L is over 800.
- **Priorities.** P0 means headless Foundry over ACP (FOUNDRY-ACP.md) needs it. P1 is runner parity that Aron asked for on 9/23. P2 and P3 are later.

| # | Adopt | Source (path) | Target | License note | Size | Pri |
|---|---|---|---|---|---|---|
| 1 | ~~**Harness hook installer and receiver.**~~ **Rejected 2026-10-11:** vendor hooks are not agnostic. Replaced by headless Foundry over ACP ([FOUNDRY-ACP.md](FOUNDRY-ACP.md)), where Paseo and T3 drive Foundry as an ACP agent. | paseo `packages/server/src/terminal/agent-hooks/` | — | — | — | — |
| 2 | **Claude mid-turn steer.** Write an SDK user message with `priority: "next"`/`"now"` into the live stream-json input. This replaces `push_ignored`. | paseo `server/agent/providers/claude/agent.ts` `steerActiveTurn`/`enqueueSteer` (~2386-2425); t3 `orchestration-v2/Adapters/ClaudeAdapterV2.ts:8705-8737` | agent-session `src/claude-code-session.ts` `push()` (:389-401); flip `TRANSPORTS` `push` for claude-code to `steer` | Apache/MIT, pattern (~40 LOC) | S | **P0** |
| 3 | **Per-call approval gate for Claude and Codex.** Claude: permission callback that can rewrite input (`updatedInput`) and deny with a message. T3's ExitPlanMode veto-and-capture is the precedent for "deny with a structured reason". Codex: answer `item/*/requestApproval` instead of returning -32601. | paseo `claude/agent.ts` `handlePermissionRequest` (~4840-4935), `codex-app-server-agent.ts:3945-3963`; t3 `ClaudeAdapterV2.ts:7820-8050`, `CodexAdapterV2.ts:5052-5440` | agent-session `claude-code-session.ts` (wire `--permission-prompt-tool stdio`, noted unwired at `transport.ts:87`), `codex-session.ts` (server-request handler); foundry-core `permission-middleware.ts` + `capability.ts` (exist, unwired) | Apache/MIT, pattern | M | P1 (the optional gate) |
| 4 | **Stop a running turn**, with settle tokens so an old cancel cannot settle a new turn, and a synthetic `canceled` if the provider acknowledges but never settles. | paseo `server/agent/agent-run-state.ts`, `agent-manager.ts` `cancelAgentRunNow` (~3127-3190) | foundry `POST /api/threads/:id/turns/:turnId/interrupt` → `TurnService.interrupt` → agent-session `interruptNative` (FOUNDRY-ACP slice 1; ACP `session/cancel` uses it) | Apache, pattern | S–M | **P0** (ACP) |
| 5 | **Hidden-ref checkpoints, per-turn authored diff, rollback.** Uses a temp index with HEAD as parent and never touches the user's index. Rollback runs the provider first, then the files, and only in an isolated worktree. | t3 `orchestration-v2/CheckpointService.ts`, `CheckpointCaptureService.ts`, `CheckpointRestoreSafety.ts`, `CheckpointRollbackService.ts`, `vcs/GitVcsDriver.ts:799-1284`, `checkpointing/CheckpointDiffQuery.ts` | foundry `packages/foundry/src/git/` + `viewer/routes/runtime.ts` revert/fork (now 501). Add ref GC, which T3 lacks. | MIT; Effect → rewrite | L | P1, but see use-instead §4 |
| 6 | **Queue vs steer policy as data.** `auto` resolves to start, queue, steer or restart from capabilities, and a steer that arrives too late becomes a start. | t3 `orchestration-v2/CommandPolicy.ts:120-164`, `QueuedRunOrder.ts`, `EffectWorker.ts:239-315` | foundry thread send path (`viewer/routes/runtime.ts` `/api/messages`) over agent-session `TRANSPORTS` capabilities | MIT, pattern | M | P2 |
| 7 | **Child→parent finish push.** A child's result is steered into the parent's turn as a tagged envelope, so the parent never polls. | paseo `server/agent/agent-prompt.ts` `setupFinishNotification` (:467+), `agent-messages/index.ts:69-145` | foundry (future cascading agents; Herald's cross-thread role) | Apache, pattern | M | P2 |
| 8 | **Deterministic budgeted handoff** for switching runner or provider mid-thread. Keep whole items, prioritised last-user → last-assistant → first-user → newest, with a "read more" footer. Use this instead of LLM summaries. | t3 `packages/provider-core/src/server/handoffBudget.ts:111-282`, `ContextHandoffService.ts:410-486` | foundry-core context assembly (`pc/context-stack.ts`) | MIT, small and portable | S | P2 |
| 9 | **Generated Codex app-server schema.** Generate the protocol from upstream openai/codex instead of hand-written JSON-RPC shapes. | t3 `packages/effect-codex-app-server/scripts/generate.ts`, `src/_generated/` | agent-session `src/codex-session.ts` | MIT; regenerate for plain TS | M | P2 |
| 10 | **Subscription quota readers:** Claude OAuth usage, ChatGPT wham usage. | paseo `plugins/*-usage-source`; t3 `provider/{claude,codex}UsageLimits.ts` | agent-session `src/limits-probe.ts` (compare and fill gaps) | Apache/MIT; undocumented vendor endpoints | S | P3 |
| 11 | **Untrusted-source gating.** Setup scripts are blocked in worktrees for cross-repo PRs until the user opts in. | paseo `workspace-automation-gate.ts` | foundry worktree provisioning, via the repo's own `worktree:create`, per Aron 9/23 | Apache, pattern | S | P3 |

Not adopted, because we already have it:
- **Paseo creation/delivery receipts.** agent-session's `onAdmission` prewrite evidence covers this.
- **T3 replay fixtures.** Foundry's VCR cassettes cover this.
- **T3/Paseo seq replay.** Aron chose no replay on 9/23; on 2026-10-11 he approved per-stream seq numbers with resync-on-gap instead (no replay).

---

## 4. Use-instead list

| We are rebuilding | Reference that does it well | Verdict |
|---|---|---|
| **Runner UX in the Foundry viewer**: worktree picker, revert/fork, diff, stop, queue, terminal, approvals, mobile. Most of these are stubs or 501 today. | Paseo app (Expo + Electron, mobile, terminals, diff review). T3 web (checkpoints, diffs, queue, PR review). | **Run on top of them.** The viewer is years of UI behind on runner features, and the rows Aron asked for on 9/23 (worktrees, checkpoints, diff, stop/queue) are what these runners already do best. Keep the viewer for what only we have: middleware visibility (flow graph, layer band, phase journal, corrections), settings, and Kingdom pairing. **Aron decided 2026-10-11: the viewer does not grow runner features** (worktrees, diffs, checkpoints, queue UI); worktrees come from the project's own system. Stop stays, because ACP needs it (adopt #4). Items 5–6 are not adopted. |
| **agent-session as the main-thread runner** | Paseo daemon and T3 server both drive the same CLIs, with far more lifecycle (steer, cancel, rewind, resume, subagents). | **Keep agent-session, narrowed.** It is ~9.5k LOC and embeddable. Neither reference exports its provider layer as a library: Paseo's in-tree adapters are not available to plugins, and T3's `provider-core` is Effect-based with a private client. agent-session is the only one with **primed warm decision sessions** (`as/primed.ts`, `claude-primed.ts`, `codex-primed.ts`), which the middleware needs and neither runner has. Its job becomes: the decision host, the headless worker for Foundry-driven and Oracle runs, and the one place that knows vendor wire formats. Stop growing it toward runner parity. Its client-side ACP transport is wanted later, to put other ACP agents under a Foundry thread, but is deferred under "All Claude for now" (FOUNDRY-ACP §6). |
| **Sub-agent orchestration** (Herald, Planner, unwired) | T3 `delegate_task` (cross-provider, mailbox); Paseo `create_agent` with finish push | **Use the runner's.** Middleware observes the child threads through the same adapter. Herald's cross-thread *awareness* (what the middleware knows across threads) stays ours. |
| **Scheduling / triggers** (absent) | Paseo schedules/heartbeats; T3 scheduled tasks and webhooks | **Use the runner's.** Don't build schedules in Foundry. |
| **Remote reach** (localtunnel/cloudflared) | Paseo E2EE relay; T3 Connect | **Keep ours.** CLAUDE.md makes Kingdom the permission hub: only local pieces talk directly, everything else goes through Kingdom and Signets. A runner on the same machine counts as local. |
| **Provider breadth** (ACP/API stubs in agent-session) | Paseo ACP + 38 presets; T3 ACP registry | **Use the runner's** for non-Claude/Codex main threads. Note that both runners drop or wrap the system prompt for ACP, so middleware there is prompt-prefix only. |
| **Usage/limits view** | Paseo usage sources; T3 limit readers | Borrow the readers (adopt #10). The view belongs to whichever UI wins. |

---

## 5. What's uniquely ours: actual state, verified

| Asset | Real state on origin/main | Gap that matters for the thesis |
|---|---|---|
| **Middleware feedback loop** | **Decision core:**<br>• `FlowOrchestrator.preMessage/hydrateDelta/commitDelivery/postAction/onInvalidation` (`pf/agents/flow-orchestrator.ts:415,441,846,930,953`).<br>• Bound only as `Thread.middleware` for `kind==='executor'` dispatches (`thread-runtime.ts:905-916`).<br>• Decisions run on warm primed sessions; the phase journal is sealed before the executor runs.<br>**Delivery:** standing layers once in the native session's system prompt; each turn carries the decoration and only changed layers (FLOW.md "Delivery", `providers/session-delivery.ts`).<br>**Guards:** post-hoc only; criticals go only to `warn()` (`thread-runtime.ts:1239-1243`).<br>**Learning:** thread-private `thread-knowledge:<domain>` only.<br>**Corrections:** captured but **audit-only** (`pc/adapters/file-memory.ts:56-75`). | The loop is not closed. Nothing turns a correction into a cross-thread rule, and `FEEDBACK-LOOP.md` capture/resolution is unbuilt. Middleware runs only inside Foundry's own turn loop, so sessions in Paseo, T3 or plain Claude Code get none of it and are not measured (FEEDBACK-LOOP H4). FOUNDRY-ACP.md targets this: Foundry becomes the ACP agent those hosts drive. |
| **Kingdom / Signets** | **Solid:**<br>• Installation pairing through an auto-approving `registerIntegration` Inquiry.<br>• Signet issue/revise/revoke, audit-enabled.<br>• DPoP enrollments and 5-min access tokens.<br>• Idempotent metered `executeAccess` with 10 provider adapters.<br>**But:**<br>• The `foundry` catalog entry has `operations: []` (`k/packages/access/src/catalog.ts:228-234`), so the pairing Signet is presence only.<br>• Foundry's agent access goes through hand-issued static tokens, not the paired Signet.<br>• Access tokens live in Postgres, not Redis. | Runner bindings and agent tool permissions are not Signet-governed yet (CLAUDE.md 2026-10-08: "Signets should govern agent permissions too"). |
| **Oracle** | **CLI:** `mine` (phrase-heuristic correction extraction plus an optional LLM classifier, `src/session-miner.ts:223-282,444`), `run`, `score`, `compare`, `trends`, `gaps`, `suggestions`.<br>**Hosted:** summary viewer.<br>**Gaps:**<br>• Paid API only.<br>• No CI.<br>• **oracle-worker cannot boot**: `src/delegation/bootstrap.ts:57-66` imports `RuntimeJobWorker`/`RuntimeJobRegistry`/`KingdomRuntimeConnection`, but `@inixiative/foundry/runtime` exports only `SignetClient`, `SignetHttpError` and `KingdomInstallationConnection`.<br>• `corrections.jsonl` is written by `mine` and re-read only for dedupe (`cli.ts:213-226`). | **No recurrence measurement exists.** The metric the thesis rests on ("did the same correction recur after injection?") needs per-turn "rule was injected" evidence. Foundry has that (`InjectionArtifact`, delivery evidence), but only for its own turns. |
| **Archive** | **Solid:**<br>• Collectors for Claude Code and Codex, Postgres + pgvector + pg_trgm.<br>• Sync, retention.<br>• Hosted provisioning from Kingdom.<br>**Gaps:**<br>• Embedding column never written.<br>• Tags heuristic.<br>• No correction tag.<br>• No model/effort per turn. | Archive already captures sessions run in *any* runner. That is the backfill path for Oracle's "before" rate. |
| **Lenses** | Enforced as a data filter (documentIds, fields) **only for `archiveLibrary`** (`signets/resolveArchiveSelection.ts:12-27`, used by `executeArchiveOperation`, `selectSignetArchive`, `verifyAuthority`). For other providers, `signetScope` only checks that a grant exists (`authorizeSignetRequest.ts:65-80`). | The general "authority over data delegated down trust boundaries" is real for one resource kind. |

Neither runner has any of these. T3's DPoP and scopes, and Paseo's permission enum, are single-owner access control, not delegation.

---

## 6. Spot-check record and corrections to the input docs

**Confirmed against code:**
- **FlowOrchestrator:** methods at `flow-orchestrator.ts:415/441/846/930/953`. The executor-only binding is at `thread-runtime.ts:905-916`.
- **RuntimeAdapter is unused:** `setRuntime`/`registerRuntime` exist (`agents/project.ts:96`, `viewer/actions.ts:66`). The only instantiations are in `tests/runtime.test.ts`.
- **Full-context resend:** confirmed (`session-backed.ts:453,488`).
- **agent-session hooks exist and Foundry calls neither:** `onBeforeSend` and `push` are at `harness-session.ts:298,309`. `git grep onBeforeSend` in foundry returns nothing.
- **Defaults and native flags:** `bypassPermissions` default (`claude-code-session.ts:320`). `--append-system-prompt` from `baseContext` (`:1137`). `--include-hook-events` is already passed (`:1116`).
- **Codex:** `push` → `turn/steer` (`codex-session.ts:1179-1228`); `fork()` throws (`:1267`).
- **Agent SDK driver:** `canUseTool` present (`claude-agent-sdk-session.ts:47,280-293`).
- **Kingdom catalog, Oracle bootstrap, Foundry runtime exports:** confirmed as quoted above.
- **Paseo:**
  - License is Apache-2.0 (`LICENSE:8`, `package.json:14`).
  - `beforeHookNames` = 3 (`plugins/lifecycle/index.ts:29`).
  - `CLAUDE_SETTING_SOURCES = ["user","project","local"]` (`claude/agent.ts:153-156`), used at `:3426`.
  - `canUseTool` at `:3417`.
  - `disableAllHooks` only for internal agents (`:3478`).
  - Codex and Claude hook installers exist (`terminal/agent-hooks/`).
  - `providerOptions` schema is `.strict()` (`claude/options.ts`).
- **T3:**
  - License is MIT.
  - `decorateRuntime` is at `ProviderSessionManager.ts:1677`, wrapping `startTurn` `:1801`, `steerTurn` `:1843`, `respondToRuntimeRequest` `:1851`.
  - Turn input with `appContext` and `startTurn` at `RunExecutionService.ts:1402-1453`.
  - `RuntimePolicy.layerWithOverride` is used only in the testkit.
  - `DEFAULT_RUNTIME_MODE = "full-access"`.
  - The Claude adapter passes `extraArgs` and a `claude_code` preset with `append`, and contains **zero** `settingSources` references.
  - The local ACP command is documented in `docs/user/providers-acp.md`.

**Corrections:**
1. **Claude mid-turn push is feasible.** agent-session's comment says "stream-json stdin has no OOB channel" (`claude-code-session.ts:384-401`), and INIXIATIVE.md §4.3/§5 repeats "mid-turn push absent / Claude emits push_ignored" as if it were a runtime limit. Both Paseo (`message.priority = "next"`, `claude/agent.ts` ~2406) and T3 (`priority: "now"` + `query.offer`, `ClaudeAdapterV2.ts:8727-8737`) steer an in-flight Claude turn by writing a user message into the same streaming input. Both go through the Agent SDK, which drives the CLI over stream-json stdin. So this is an agent-session gap, not a Claude limit. Whether the bare CLI honours `priority` without the SDK still needs one VCR cassette to confirm.
2. **Oracle's `corrections.jsonl` has one reader.** INIXIATIVE.md says it has "no reader". `oracle mine` reads it, but only to dedupe (`cli.ts:213-226`). Nothing *consumes* it, so the conclusion stands.
3. **Paseo permission hook line.** PASEO.md cites `onStreamPermissionRequested` at `AM:4723`. The call site is `agent-manager.ts:4497`, and `respondToPermission` is at `:3085`. The line numbers drifted; the claim holds.
4. **T3 Claude hooks.** T3CODE.md is right to mark this unverified. No `settingSources` is set, and the SDK is not installed in the clone, so I could not check the default. The no-fork T3 path in the spec therefore uses the explicit `--settings <file>` flag through `extraArgs`, which does not depend on that default. It still needs one live check.
5. **New finding: dead concept.** Foundry ships `packages/foundry/src/demo.ts` ("Foundry Demo"), and CLAUDE.md lists "Demos in product repos" as dead. This is in addition to the `LICENSE:26` Oracle section INIXIATIVE.md already flagged.
