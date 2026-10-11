# PROPOSAL: needs Aron's yes before build

# Foundry middleware in front of any runner: adapter spec

**Status:** draft spec, no code. It changes what "Foundry middleware" means: today the middleware binds to Foundry's own turn loop, and this spec binds it to any runner. So it needs a yes before anyone builds it (CLAUDE.md, 2026-10-08).

**Basis:** origin/main of foundry `d51564b` and agent-session `08f5081`, Paseo `1939ee79e`, T3 Code `f23d0084b6`. Line references are verified unless marked **[unverified]**. See COMPARISON.md §6.

## 1. Intent

Foundry's product is the middleware. Feedback captured while working becomes routed, specialised context and guards in front of the agent, and Oracle measures whether the same correction stops recurring.

Today that middleware runs only when the turn passes through Foundry's own `Thread → Harness → Executor → agent-session` loop. Work done in Paseo, T3 Code or plain Claude Code gets no middleware and produces no "rule was injected on this turn" evidence. FEEDBACK-LOOP H4 already counts those sessions as "outside Foundry".

This proposal keeps the decision core exactly as it is: `FlowOrchestrator`, the Cartographer, the Wardens, the Librarian, primed decision sessions and the phase journal. It changes only the **binding**. The existing, unused `RuntimeAdapter` (`pf/providers/runtime.ts`) becomes the one runner-neutral contract. agent-session is its reference implementation, and Claude/Codex native hooks are the implementation that reaches Paseo and T3 without a fork. Foundry stops needing to be the runner in order to be the middleware.

## 2. The contract

### 2.1 What the middleware already consumes

From `pf/agents/thread-runtime.ts` and `flow-orchestrator.ts`:

| Need | Today (Foundry's own loop) |
|---|---|
| A turn boundary with a stable `messageId` and `dispatchId` | `Thread.dispatch` mints `dispatchId` (`pc/thread.ts:322-413`). Flow middleware fires only for `kind==='executor'` with a string payload (`thread-runtime.ts:905-916`). |
| Pre-turn delivery | `ctx.annotations.{injectionPlan, decoration}` → `Executor` assembles every warm layer → `SessionBackedProvider` flattens it to `# System Context …` user text (`session-backed.ts:453,488,885-899`) |
| Delivery evidence | `result.meta.injection.providerMessages` gates `flow.commitDelivery` (`thread-runtime.ts:~1016-1074`) |
| Tool evidence | `NativeEvidence` → `createNativeToolProjector` → `meta.observeTool` → `tool_observation{dispatchId,callId}` → `flow.postAction` (`thread-factory.ts:646-678`, `thread-runtime.ts:1089-1270`) |
| Turn completion | `dispatch` signal with output → Warden review/learning (`thread-runtime.ts:1272-1291`) |
| Reset/compaction | `session_compacted` signal → ledger cleared and plan invalidated (`flow-orchestrator.ts:1114-1126`) |
| Identity | `thread.meta.cwd` (worktree) for every decision |

### 2.2 The contract: an extension of `RuntimeAdapter`

We extend the existing interface rather than add a layer. It reuses three things that already exist:
- agent-session's normalized `SessionEvent` (`as/harness-session.ts:82-177`) replaces the thinner `RuntimeEventKind`;
- agent-session's `TransportCapabilities` (`as/transport.ts:26-48`) supplies the capability flags;
- `HarnessSession.onBeforeSend`/`push` (`:298,309`) supply the hook shapes.

```ts
// pf/providers/runtime.ts (hard cut: the file-writing inject() goes; no compat shim)
export interface RuntimeAdapter {
  readonly id: string;
  readonly runtime: TransportRuntime;               // 'claude' | 'codex' | 'external'
  readonly capabilities: Pick<TransportCapabilities, 'push' | 'approvals' | 'interrupt'> & {
    readonly beforeTurn: 'rewrite' | 'append' | 'none';   // rewrite = whole message; append = additionalContext
    readonly delivery: 'acknowledged' | 'inferred';        // see 2.3 delivery
  };

  /** Format assembled context for this runtime (kept from today). */
  prepareInjection(assembled: AssembledContext): ContextInjection;

  /** 1. Pre-turn inject (REQUIRED). Generalises HarnessSession.onBeforeSend. */
  onBeforeTurn(hook: (turn: RunnerTurn) => Promise<TurnInjection>): () => void;

  /** 2. Turn event stream (REQUIRED). agent-session SessionEvent + runner correlation. */
  onEvent(handler: (e: SessionEvent & RunnerCorrelation) => void): () => void;

  /** 4. Blocking tool gate (OPTIONAL; capabilities.approvals === 'callback'). */
  onToolRequest?(gate: (call: RunnerToolCall) => Promise<ToolVerdict>): () => void;

  /** 5. Mid-turn push (OPTIONAL; capabilities.push === 'steer'). Same payload as HarnessSession.push. */
  push?(runnerSessionId: string, payload: { kind: string; text: string }): Promise<'steered' | 'ignored'>;
}

interface RunnerTurn { runnerSessionId: string; turnId: string; text: string; cwd: string }
interface TurnInjection { prepend?: string; systemAppend?: string; layersDelivered: string[] }
interface RunnerCorrelation { runnerSessionId: string; turnId?: string; callId?: string }
type ToolVerdict = { decision: 'allow' } | { decision: 'deny'; reason: string } | { decision: 'ask' };
```

### 2.3 Mapping each contract point to existing machinery

The Foundry side adds **one** new piece: `RunnerBackedProvider`, a sibling of `SessionBackedProvider` that implements the same `LLMProvider.complete()`. Everything above it is unchanged: `Thread`, `Harness`, flow middleware, `Executor`, journals, signals. That keeps `Thread.dispatch` as the single boundary, so `dispatchId` correlation, the phase journal, Librarian state and learning all keep working.

| Contract point | Runner → Foundry | Foundry machinery it drives |
|---|---|---|
| **1. Pre-turn inject** | The runner calls `onBeforeTurn` for a session bound to a Foundry thread. | Foundry runs `thread.dispatch(executorAgent, turn.text)`: classify and route start `prepare()` early, then flow-pre-message runs `preMessage` → `hydrateDelta`. When the Executor calls `RunnerBackedProvider.complete(messages)`, it does **not** send. It resolves the parked `onBeforeTurn` promise with `prepareInjection(system part)` and then awaits the turn's terminal event. **Fail-open:** past the budget it returns `{}`, matching today's "pre-message failure is non-fatal" (`thread-runtime.ts:993-995`). |
| **delivery** | `acknowledged`: the runner confirms the injected turn started, e.g. agent-session admission or a T3 decorator. `inferred`: the first event for that `runnerSessionId` after the hook returned, e.g. a PostToolUse or Stop hook. | `complete()` returns `meta.injection.providerMessages` → `commitDelivery`. If no evidence arrives, the ledger stays uncommitted, which is safe today. |
| **2. Turn event stream** | `tool_use`/`tool_result` with `callId`, `text`/`result`, `session_end`, `error`, all tagged with `runnerSessionId`/`turnId`. | Mapped to `NativeEvidence` → the existing `createNativeToolProjector` → `tool_observation` → `postAction` (guards). `result` resolves `complete()` → `dispatch` signal → Warden review/learning. User text also goes to correction capture (FEEDBACK-LOOP §1). |
| **3. Reset / compaction** | `session_compact`, or `session_start` with a new native id after `/clear`, a fork or a resume. | Emit the existing `session_compacted` signal → `FlowOrchestrator` clears the ledger and the next turn re-delivers. |
| **4. Blocking tool gate** | `onToolRequest` before execution. | foundry-core `permissionMiddleware`/`CapabilityGate` (`pc/permission-middleware.ts:38`, exported, unwired) for structural rules. Optionally Warden `guard()` for a configured critical-trigger set. Deny returns the finding as the reason, so the model reads it in the turn. |
| **5. Mid-turn push** | `push(runnerSessionId, {kind:'guard', text})`. | Today `postAction` criticals only go to `warn()` (`thread-runtime.ts:1239-1243`). With push, criticals become a steer into the live turn, which is FLOW.md channel ④. |
| Identity | `cwd` plus `runnerSessionId` → a Foundry thread id. The mapping is persisted like `.foundry/sessions.json`. | `thread.meta.cwd` for decisions. |

**Auth on the local seam.** A hook process reaches Foundry over loopback HTTP using the capability-in-a-0600-launch-file pattern the MCP bridge already uses (`pf/mcp/transport.ts`, `authority.ts`). No new auth scheme is needed. A runner on the same machine counts as "local" under CLAUDE.md's hub rule. Remote runners are an open question (§6).

## 3. Per runner

### 3.1 agent-session (Foundry's own loop): the reference implementation

| Contract | Seam | Works without change? | Needs (our repo, not a fork) |
|---|---|---|---|
| 1 Pre-turn | Today: Executor message composition → `formatMessagesForNativeSession` → `send()`. Available: `onBeforeSend` (`claude-code-session.ts:378`) and `baseContext` → `--append-system-prompt` (`:1137`). | **Yes**, as today: full context every turn. | Implement `RuntimeAdapter` over `HarnessSession`: `onBeforeTurn` = `onBeforeSend`, `onEvent` = `onEvent`. Delivering only the delta and moving stable layers into `baseContext` is a ledger-semantics change; see §6 Q3. |
| 2 Events | `HarnessSession.onEvent` → `SessionEvent` | **Yes** | — |
| 3 Compaction | `session_compact` event | **Yes** | — |
| 4 Gate | Claude: `--permission-prompt-tool stdio` exists natively but is unwired (`transport.ts:87`); the worker runs `bypassPermissions` (`:320`). Codex: `approval_policy="never"`, and server requests get -32601. | **No** | agent-session: wire the Claude stdio permission prompt and answer Codex `item/*/requestApproval`; set `approvals: 'callback'`. Port the patterns from Paseo/T3 (COMPARISON adopt #3). |
| 5 Push | Codex `push` → `turn/steer` (`codex-session.ts:1179-1228`). Claude emits `push_ignored` (`claude-code-session.ts:389-401`). | Codex **yes**; Claude **no** | Claude: write a user message with `priority` into stream-json stdin, the pattern Paseo and T3 both use (adopt #2). |

Patch sketch for agent-session Claude push **[verify with one VCR cassette]**:
```ts
// src/claude-code-session.ts
async push(p: { kind: string; text: string }): Promise<void> {
  if (!this._proc || !this._activeTurn) return this._ignored(p, 'no in-flight turn');
  this._writeLine({ type: 'user', priority: 'next', parent_tool_use_id: null,
    session_id: this._externalSessionId,
    message: { role: 'user', content: [{ type: 'text', text: `<foundry-${p.kind}>\n${p.text}\n</foundry-${p.kind}>` }] } });
}
// transport.ts: claude-code capabilities.push = 'steer'
```

### 3.2 Paseo

| Contract | No-fork seam | Notes |
|---|---|---|
| 1 Pre-turn | **Claude `UserPromptSubmit` hook** returning `hookSpecificOutput.additionalContext`. Paseo launches Claude with `settingSources: ["user","project","local"]` (`claude/agent.ts:153-156,3426`), so a worktree's `.claude/settings.local.json` loads. **Codex** `hooks.json` `UserPromptSubmit` uses the same event names Paseo's own installer writes (`terminal/agent-hooks/codex/codex.ts`). | `beforeTurn: 'append'`. Correlation: Paseo sets `PASEO_AGENT_ID` in the agent env (`agent-manager.ts` ~5358), so the hook gates on it and maps `PASEO_AGENT_ID` + the hook `session_id` to a Foundry thread. Without that env var the hook exits 0 immediately. Disabled for Paseo's internal agents (`disableAllHooks`, `:3478`), which is fine. |
| 2 Events | `PostToolUse`, `Stop` (read the final text from `transcript_path`) and `SessionEnd` hooks. Optionally a **Paseo server plugin** `on("agent.turn_ended")` with the full timeline snapshot, and a client plugin panel to show the flow graph inside Paseo's app. | `delivery: 'inferred'`. Plugin events are fire-and-forget (`plugins/runtime.ts:518-544`), so use them for observation only. |
| 3 Compaction | `PreCompact` and `SessionStart` (source `compact`/`clear`) hooks. | Re-deliver on the next `UserPromptSubmit`. |
| 4 Gate | **`PreToolUse` hook** returning a deny decision. It runs inside the harness, so it holds whatever permission mode Paseo chose **[verify under bypassPermissions]**. | Plugin `respondToPermission` is a race against the user, not a gate (`agent-manager.ts:3085-3118`, first responder wins). |
| 5 Push | Paseo's `send_agent_message` with `activeTurnBehavior: "steer"` over `@getpaseo/client`, which uses native steer for Claude and Codex (`agent-manager.ts` `steerOrReplaceActiveTurn`). | Needs a daemon credential: the local credential gives owner access, so treat it like a Signet-worthy grant (§6). |

**Needs a fork or upstream PR:** a provider-agnostic per-prompt hook and a synchronous permission hook. That covers ACP providers, which ignore `systemPrompt`, and it would give `acknowledged` delivery. Paseo's stance ("lean core, extend by plugin"; it accepts outside contributors) makes an upstream PR plausible:
```ts
// packages/server/src/server/plugins/lifecycle/index.ts
export const beforeHookNames = ["agent.create", "agent.session_open", "workspace.create",
  "agent.prompt", "agent.permission"] as const;
// agent/agent-prompt.ts startAgentRun (:95), before streamAgent:
({ prompt } = await plugins.runBefore("agent.prompt", { agentId, provider, cwd, prompt, clientMessageId }));
// agent-manager.ts at the onStreamPermissionRequested call site (:4497):
const v = await plugins.runBefore("agent.permission", { agentId, request });
if (v.response) return this.respondToPermission(agentId, request.id, v.response);
```
This reuses the existing sequential before-runner with its 30 s timeout.

### 3.3 T3 Code

| Contract | No-fork seam | Notes |
|---|---|---|
| 1 Pre-turn | **Claude:** instance launch args flow into SDK `extraArgs` (`ClaudeAdapterV2.ts` ~1059), so pass `--settings <foundry-hooks.json>` with a `UserPromptSubmit` hook. T3 sets no `settingSources` (0 references), so worktree `settings.local.json` loading is **[unverified]**. The explicit `--settings` flag avoids depending on it **[verify live]**. **Codex:** `T3CODE_CODEX_LAUNCH_ARGS` `-c` or `CODEX_HOME` `hooks.json`. Alternatively a project `t3.json` `runOnWorktreeCreate` (`async:false`) writes the hook config into each worktree. | `beforeTurn: 'append'`. Correlation: hook `session_id` + `cwd`. T3 sets no per-thread env marker we can rely on, so binding is per worktree (the hook config is present only where Foundry wrote it). |
| 2 Events | Same hooks. Optionally a sidecar WS client with an `orchestration:read` session token. This needs vendoring `@t3tools/contracts` (Effect RPC); the client is private. | Prefer hooks. The sidecar is heavy and churns: ~600 fixes since 10/02. |
| 3 Compaction | `PreCompact`/`SessionStart` hooks | — |
| 4 Gate | `PreToolUse` hook. T3's default is **full-access** (`providerPolicy.ts`), so its own approval path never fires; the in-harness hook is the only real gate. | — |
| 5 Push | Sidecar `message.dispatch` with `deliveryIntent: "steer"` | Needs the sidecar. |

**Needs a fork** (upstream says big features are not accepted, so this would be a permanent fork):
```ts
// apps/server/src/orchestration-v2/ProviderSessionManager.ts decorateRuntime (:1677), startTurn (:1801)
startTurn: (input) => Effect.flatMap(TurnMiddleware, (mw) =>
  mw.beforeTurn(input).pipe(Effect.flatMap((next) => runtime.startTurn(next).pipe(turnMetrics("send", next.modelSelection.model))))),
// TurnMiddleware = Context.Reference<{ beforeTurn(i): Effect<i>; onEvent(e): Effect<void> }>(…, { defaultValue: () => identity })
```
This is idiomatic for them: `RunFinalizationObserver`, `ProviderTurnAnalytics` and `DispatchModeLimit` are all no-op-default `Context.Reference` slots. **Do not fork now.**

### 3.4 Shared hook binding (Claude/Codex): one implementation, three hosts

```jsonc
// <worktree>/.claude/settings.local.json  (written by Foundry; gitignored by Claude convention)
{ "hooks": {
  "SessionStart":     [{ "hooks": [{ "type": "command", "command": "foundry hook claude session-start", "timeout": 15 }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "foundry hook claude prompt",        "timeout": 20 }] }],
  "PreToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "foundry hook claude pre-tool", "timeout": 10 }] }],
  "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "foundry hook claude post-tool" }] }],
  "PreCompact":       [{ "hooks": [{ "type": "command", "command": "foundry hook claude pre-compact" }] }],
  "Stop":             [{ "hooks": [{ "type": "command", "command": "foundry hook claude stop" }] }] } }
```

`foundry hook …` reads the hook JSON from stdin and POSTs it to the local daemon with the launch-file capability. It then prints the hook response: `additionalContext` for a prompt, or a deny for a pre-tool request. It exits 0 with no output when the daemon is down or the session is unbound.

This implements `RuntimeAdapter` as `ClaudeCodeRuntime`/`CodexRuntime`, which exist in `runtime.ts` today, are tested, and already carry a `hooksDir` option. The installer pattern is Paseo's `agent-hook-installer.ts` (COMPARISON adopt #1).

The same binding also covers **plain Claude Code in a terminal**, which is where Aron works today.

## 4. Recommended first target: the Claude hook binding, exercised under Paseo

**Why this target:**
1. **No fork, and verified seams.** Paseo verifiably loads project, local and user Claude settings and exposes `PASEO_AGENT_ID` per agent for correlation. The plugin API adds turn-ended observation and an in-app panel later. Apache-2.0.
2. **One binding, three hosts.** The same hook binding works for plain Claude Code and, after one live check of `--settings`, for T3. Under T3 it is the only real gate, because T3 defaults to full-access. Work done outside Foundry starts producing injection evidence, which is what Oracle's recurrence metric needs (FEEDBACK-LOOP §4: "after" counts only turns where the rule was actually injected).
3. **It exercises 4 of the 5 contract points for real.** Pre-turn uses `UserPromptSubmit`, events use `PostToolUse`/`Stop`, compaction uses `PreCompact`/`SessionStart`, and the gate uses `PreToolUse`. Only push needs the Paseo client.
4. **It proves the contract is runner-neutral.** agent-session is refactored onto the same `RuntimeAdapter` in the same step, and one conformance suite (§5 case 8) runs against both. If agent-session went first, the refactor would only prove Foundry can talk to itself.

**Why not T3 first:** no plugin API, `settingSources` unverified, heavy churn, and the full-access default means none of T3's own UI would show middleware decisions.

**Why not a Paseo upstream PR first:** it is worth proposing, but it gates nothing. The hook path works today.

**Order of work:**
1. Reshape `RuntimeAdapter` to the contract.
2. Add `RunnerBackedProvider`.
3. Write the `foundry hook` CLI and receiver route.
4. Build the `ClaudeCodeRuntime` hook installer.
5. Run the conformance tests under Paseo and agent-session.
6. Codex hooks.
7. agent-session gate and Claude push (adopt #2 and #3).

## 5. Test cases

These are DB-backed and dynamic where possible. Live-harness cases are recorded as VCR cassettes.

1. **Injection lands and is journalled.** A Paseo Claude agent sits in a bound worktree, with a Warden whose rule matches the prompt. Assert all of the following:
   - the `route` and `advice` phase rows are sealed before the hook returns;
   - the transcript turn contains the decoration block as additional context;
   - `commitDelivery` commits only after the first post-prompt event for that `runnerSessionId`;
   - the `InjectionArtifact` lists the delivered layers.
2. **Fail-open on a slow decision host.** Stall the primed decision host past the hook budget. Assert:
   - the hook returns `{}` before its `timeout`;
   - the turn proceeds;
   - the journal records `timeout`;
   - the ledger has no committed layers.
3. **No cross-talk.** Run two concurrent Paseo agents in the same repo but in different worktrees, and one plain-terminal Claude session with no marker. Assert:
   - each tool observation attaches to its own thread and `dispatchId`;
   - the unbound session's hooks exit 0 in under 50 ms and create no thread.
4. **Compaction re-delivers.** Run `/compact`, which fires `PreCompact` and then `SessionStart(source=compact)`. Assert:
   - the `session_compacted` signal fires;
   - the next turn's `hydrateDelta` reports those layers as `reinjected`, not `skipped`.
5. **Structural deny holds in bypass mode.** A configured structural rule denies `Bash` matching `rm -rf` (`CapabilityGate`, no LLM call). Run the agent in `bypassPermissions`. Assert:
   - the tool does not execute;
   - the model receives the deny reason;
   - a `guard-outcome` row is written;
   - gate latency is under 100 ms.
6. **Critical post-hoc finding reaches the live turn.** Codex runs via agent-session, and the Warden emits a critical on a `tool_result`. Assert:
   - `push` steers within the same turn (`turn/steer` accepted);
   - when the turn has already ended, the result is `ignored` and the existing `security-concern-active` flag carries it to the next turn.
7. **Correction capture under a foreign runner.** The user types a correction in Paseo's UI. Assert:
   - `UserPromptSubmit` delivers the text to capture as a `correction` (audit-only, as today);
   - the turn's `InjectionArtifact` records which rules were present, so Oracle can compute recurrence on injected turns only.
8. **Contract conformance.** One suite drives the same scenario (cases 1, 3 and 4) through agent-session's `RuntimeAdapter` and the hook adapter. Assert identical phase-journal shapes and signal sequences, with only `delivery: acknowledged | inferred` differing.

## 6. Open questions for Aron

1. **Is the runner theirs now?** If Foundry's main worker runs in Paseo or T3, should the viewer stop accruing the runner features you asked for on 9/23 (worktree per thread, checkpoints and diff panel, stop/queue-vs-steer)? It would keep only middleware visibility, settings and Kingdom. This reverses 2026-04-05 ("this is supposed to replace cmux/claude code/t3code").
2. **Where do hook configs live?**
   - **(a)** Per-worktree `.claude/settings.local.json` and `.codex/hooks.json`, written by Foundry when a worktree is bound. This is opt-in per worktree.
   - **(b)** User-level `~/.claude/settings.json`, gated on an env marker. This also puts middleware into your plain terminal Claude Code sessions.

   Is (b) wanted? Should agent-session's worker keep `--setting-sources ""` (`subscription-authentication.ts:67`) either way?
3. **Ledger semantics.** Hook-injected context persists in the conversation, so re-sending every layer every turn becomes pure waste. Should `skipped` become real for runners that keep history: deliver deltas only, and re-deliver everything after compaction? That changes the current guarantee that "the executor assembles every warm layer on every turn" (`flow-orchestrator.ts:19-25`).
4. **What may block?** Should Warden findings ever block a tool, or only structural rules (`CapabilityGate`)? An LLM guard on every tool call costs ~1.7 s median (and the default `memory` guard already fires an LLM call on every tool, `thread-runtime.ts:178,820`). Today's guards are advisory and post-hoc, so blocking changes what a guard means.
5. **Thread identity.** Should there be one Foundry thread per Paseo agent or T3 thread, created lazily on its first hook? Or should a binding attach a runner session to an existing Foundry thread?
6. **Signets for runner bindings.** A local runner reaching local Foundry counts as "local", so a direct connection is fine. But steering through Paseo's daemon uses an owner credential. Should that grant be a Signet on the Foundry integration, in line with "Signets should govern agent permissions too" (10-08)? And do remote runners (a Paseo daemon on another machine, T3 over Connect) go through Kingdom?
7. **Upstream.** Should we propose `before("agent.prompt")` plus a blocking `before("agent.permission")` to Paseo? Rule out a T3 fork for now?
8. **Seq/replay.** On 9/23 you chose no seq/replay for the data stream. Both runners use cursor replay with a snapshot fallback. Keep the decision?
