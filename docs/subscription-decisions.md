# Subscription-only Foundry

Foundry runs subscription-only by default. A fresh install, with no settings at all, runs the Claude Code worker and Foundry's decisions from the logins already on the machine:

- **Worker:** Claude Code, using the default Claude login (`~/.claude`, selected by leaving `CLAUDE_CONFIG_DIR` unset). Set `defaults.provider` to `codex` (for example with `defaults.model: "gpt-6-astra"`) to run main threads on Codex instead, on the Codex CLI's ChatGPT login (`~/.codex`).
- **Decisions:** Claude Haiku 5.5 (`claude-haiku-5-5`) through the same Claude login (`~/.claude`), on primed Claude Code sessions. Classifiers, routers, the Cartographer, the Librarian, Wardens (advise, guard and review), configured experts and thread naming all use this decision profile. The runtime is a setting: `subscriptionOnly.decisionRuntime: "codex"` runs decisions on the Codex CLI's ChatGPT login (`~/.codex`) with GPT-6 Luna instead.

No API provider is constructed in this mode. There is no paid fallback, no automatic retry and no model substitution. API-key providers need an explicit opt-in.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `apiTokens` | absent (`false`) | `true` opts in to API-key providers (Anthropic, OpenAI, Gemini, gateways, Kingdom bindings) and the API decision provider, Anthropic Haiku 5.5 by default, which requires `ANTHROPIC_API_KEY`. It cannot be combined with `subscriptionOnly`. |
| `defaults.provider` | `claude-code` | The main-thread worker. Without API tokens it is a subscription harness: `claude-code` or `codex`. |
| `defaults.nativeAuthenticationId` | absent: `~/.claude` or `~/.codex` | Optional explicit `native-profile` source for the worker; its runtime matches the worker. |
| `defaults.classifierProvider` / `classifierModel` | `subscription-decisions` / `claude-haiku-5-5` | New configurations record the decision profile here; `classifierModel` selects the decision model. A model registered only on the other runtime is refused rather than substituted. |
| `subscriptionOnly.decisionRuntime` | `claude` | Decision runtime when no explicit source is named: `claude` (`~/.claude`) or `codex` (`~/.codex`). `claude-in-session` runs Claude decisions too, but holds each thread's Wardens as subagents inside the thread's own Claude Code process (below); it needs the Claude Code worker. |
| `subscriptionOnly.decisionSourceId` | absent: the runtime's default login | Optional explicit `native-profile` source for decisions. It must match `decisionRuntime` when both are set. |
| `subscriptionOnly.model` | `claude-haiku-5-5` for Claude, `gpt-6-luna` for Codex | Decision model; overrides `classifierModel`. Heavier roles can name `claude-opus-5-5` or `claude-fable-5-1`. |
| `subscriptionOnly.expectedObservedModel` | the requested model | Claude decision profiles only: the id the CLI must report serving (for example the full id behind an alias). Codex does not acknowledge a different model. |
| `subscriptionOnly.directory` | `<project>/.foundry/decision-receipts` | Private (0700) receipt directory. The default is created at startup; an explicit directory must already exist and be private. |
| `subscriptionOnly.maxCalls` | `10000` | Finite decision attempt budget for this Foundry process, including failed admitted attempts. It does not renew automatically. |
| `subscriptionOnly.maxConcurrent` | `16` | Decisions running at once across all threads: Claude CLI processes (~130–230 MB each), or concurrent turns on the one warm Codex process. Sized for a full Warden roster: every Warden is asked on every user message, and every guard-triggered Warden on every action. |
| (primed keys) | `2 × Wardens + 8`, at least 16 | Claude decision roles kept primed, sized at startup from the largest roster any project runs (the enabled Wardens, or a project's chorus of region Wardens; an advice and a review key each). Each holds a spare CLI process (~130–230 MB): 25 Wardens is about 50 processes and 10 GB. An evicted key re-primes cold (5–8 s). Not a setting. |
| `subscriptionOnly.maxQueued` | `512` | Waiting decisions across all threads (up to 1024). |
| `subscriptionOnly.maxQueuedPerThread` | `256` | Waiting decisions per logical thread: deep enough that a burst of guards never refuses admission. |
| `subscriptionOnly.effort` | `low` | Decision reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`; Haiku 5.5 accepts `low` to `high`). The model default, `medium`, adds latency per decision. |
| `subscriptionOnly.hedgeAfterMs` | `4000` for Codex | A decision still running after this long starts the same input on a second branch; the first to finish wins (500 to 30000). |
| `subscriptionOnly.callTimeoutMs` | `30000` | Per-decision deadline including queue and preflight time (100 to 30000). |

Explicit profile sources are credential references in `nativeAuthentication`, never tokens:

```json
{
  "nativeAuthentication": [
    { "id": "22222222-2222-4222-8222-222222222222", "integrationId": "44444444-4444-4444-8444-444444444444",
      "runtime": "codex", "mode": "native-profile", "profileDirectory": "/private/path/decisions" }
  ],
  "subscriptionOnly": { "decisionSourceId": "22222222-2222-4222-8222-222222222222" }
}
```

An explicit profile directory must be an owned private (0700) directory with private files. The default login locations are referenced in place: they must be owned, real directories whose credential files (`auth.json`, `.credentials.json`) are private, but Foundry does not require or change their mode. The worker and the decisions may share one login: both are shared holders of it, like the user's own concurrent CLI sessions. Gateways, Kingdom bindings and per-thread authentication selections cannot be mixed into subscription mode.

## Main threads

Main threads (the default worker and every enabled executor) run on models from five labs: Anthropic, OpenAI, Google, Meta and xAI (`MAIN_THREAD_LABS` in the core model registry). Other labs, gateways and local hosts are refused as main threads in every mode. How each lab runs:

| Lab | Subscription (default) | With `apiTokens: true` |
|---|---|---|
| Anthropic | `claude-code` on the Claude login | also `anthropic` (`ANTHROPIC_API_KEY`) |
| OpenAI | `codex` on the Codex ChatGPT login | also `openai` (`OPENAI_API_KEY`) |
| Google | no harness yet (agent-session's ACP transport for Gemini CLI is a stub) | `gemini` (`GEMINI_API_KEY`) |
| Meta | no harness yet | `meta` (`MODEL_API_KEY`) |
| xAI | no harness yet | `xai` (`XAI_API_KEY`) |

A refused main thread names what it needs, in the settings API, the viewer's Defaults editor and setup.

A Codex worker is checked with `codex login status` and must be a ChatGPT login; an API-key login is refused. It shares the Codex login with Codex decisions (both are shared holders, so they may use the same `~/.codex`) and runs on its own Foundry-private `CODEX_HOME` (`.foundry/runtime-profiles/<source id>/codex-home`, kept across restarts so sessions resume) that links the profile's `auth.json`. None of the user's Codex config, instructions or MCP servers apply to it, and it runs with Codex's own sandbox and approvals off, like the Claude worker's bypass mode.

## Existing settings

Subscription mode runs every enabled non-executor agent on the decision profile. An agent saved with another provider or model (for example a classifier on `gemini` or a Librarian on `claude-code`) is routed to `subscription-decisions` at startup; the startup log lists each routed agent. The saved settings file is not rewritten. Settings that cannot be enforced are refused rather than routed: a worker that is not a subscription harness, an executor on another provider or model, decision agents with tools, thinking, cache or non-zero temperature overrides, and `learning.review` provider/model overrides.

## Sharing the user's own logins

Foundry adds processes to the logins the user already uses interactively, like another terminal session would. It does not change their files or settings:

- **Profile locks.** Subscription workers and decisions are shared holders of their login: each registers `.foundry-auth-shared/<owner>.json` in the profile (`~/.claude` or `~/.codex`) for its lifetime, and the last holder removes the directory. Claude decisions hold one registration for the decision host's lifetime. An exclusive `.foundry-auth-lock` (a non-subscription native profile) and shared holders refuse each other. Every lock is released when its process exits, including on a clean shutdown, which stops live processes first. Interactive `claude` and `codex` sessions ignore these locks. After a hard crash, remove a lock only after confirming the recorded Foundry owner and its children are dead.
- **User settings.** The Claude worker launches with `--setting-sources ""`, so the user's hooks, permissions and plugins in `~/.claude/settings.json` do not apply to Foundry's worker. The decision app-server disables tool, plugin and app features at launch, and each decision thread overrides the user's notify hook, MCP servers, project docs, skills and tool/environment instructions.
- **Private Codex home.** Codex has no setting that drops the user-level `~/.codex/AGENTS.md`, so the decision app-server runs on its own `CODEX_HOME`, `<receipt directory>/<source id>/codex-home`, kept across restarts. It holds only Foundry's `config.toml` (`cli_auth_credentials_store = "file"`) and `auth.json` as a symlink to the profile's. None of the user's instructions, memories, skills, rules, config or history reach a decision (`instructionSources` is empty), and its threads, logs and state stay out of `~/.codex`. The link, not a copy, is what keeps the login whole: Codex rewrites `auth.json` in place when it refreshes, so the refresh lands in the profile, and every process on the login reads the current single-use refresh token. A copy would fork that token and sign the user's own Codex out. The lock stays on the profile. A login kept in the system keyring (`cli_auth_credentials_store = "keyring"`) has no `auth.json`, so decisions are refused as not logged in.
- **Codex history.** Each role's primed thread is persisted while it lives (Codex can only fork persisted threads) in the private Codex home, under a private working directory, and deleted when the role is evicted or Foundry shuts down. A recycled app-server deletes the threads its predecessor left; a crashed Foundry's leftovers stay in the private home. Nothing reaches the user's Codex history.
- **Credentials.** Child environments drop API keys and competing profile overrides (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_*` credentials, inherited `CLAUDE_CONFIG_DIR` and `CODEX_HOME`). No credential is copied or moved; the decision home links the login in place.

## Claude decisions

Claude decisions run on agent-session's `ClaudePrimedSessions`, with the same per-role keys and per-cycle split as Codex decisions below:

- **Prime once.** A role with stable context (`CompletionOpts.stablePrefix`) gets one persisted Claude session: Foundry's decision base and the role instructions as the appended system prompt, plus one primer turn carrying the stable context. The primer process exits once primed.
- **Fork per cycle.** Each decision forks the primed session (`--resume <id> --fork-session`, not persisted) and sends only the per-cycle part. After a decision, the next fork for that role is pre-spawned so a warm decision pays no process start. Roles without stable context run inline on a fresh process.
- **Bounds.** Every decision process launches text-only (`--safe-mode --tools "" --strict-mcp-config` with an empty MCP config, no slash commands, no Chrome) with `--setting-sources ""`, so the user's hooks, permissions and plugins never apply, and with paid credentials stripped. At most 16 roles stay primed (each holds one idle spare process, about 215 MB); idle roles are evicted after 30 minutes. Any tool activity is a violation that closes admission.
- **Login.** Before the first decision the host checks `claude auth status --json` for a `claude.ai` subscription login (never an API key) and registers as a shared holder; a failed check dispatches nothing. The CLI reports the served model (`claude-haiku-5-5` for Haiku 5.5), and a substitution is refused.
- **History.** Primed transcripts live in `~/.claude/projects/<private host cwd>` while their role is primed and are deleted when it is evicted or the host closes; the empty directory is removed on close. A crash leaves them there.

## Wardens in the thread's own process (`claude-in-session`)

Off by default (docs/THREAD-TREE.md spec C; numbers in §C.9). With `decisionRuntime: "claude-in-session"`:

- **One process per thread.** Each executor session hosts its thread's Wardens through agent-session's `ClaudeInSessionDecisions`. The thread's session opens when its first turn is accepted; the turn waits `queued` while an internal setup turn starts the Warden tree, and `ThreadMeta.setup` drives "Setting up your thread" in the viewer and in foundry-acp.
- **What runs there.** Warden advice, guard and review calls. Other decision roles (Cartographer, classifiers, routers, naming, feedback) stay on primed sessions. In-session calls take none of the `maxConcurrent` slots.
- **Login.** In-session Wardens run on the thread's own login (and its Kingdom capacity pool), not on the decision profile.
- **Fallback.** A thread whose Warden tree is not running (setup failed, or too many orphaned members) sends its Wardens to primed sessions, as if the setting were off.
- **Subagents.** In this runtime only, the main thread's subagents' tool calls get the root thread's guard Wardens, journalled on the subagent's node.

## Codex decisions

With `decisionRuntime: "codex"`, decisions run on one warm `codex app-server` process per decision profile, through agent-session's `CodexPrimedSessions`. Every middleware role keeps its own live, primed session on that process: the Cartographer, each classifier and router, and each domain's advice, guard and review. A role is keyed by its auxiliary session id (`<thread>:aux:<role>`) plus a hash of its instructions, so a domain's advice and guard stay separate.

- **Prime once.** A role's session is a thread started with the role instructions as developer instructions and Foundry's decision base (no tools, task data is not authorization) as base instructions, plus one primer turn carrying the stable context: the domain cache, or the topology map and atlas. Agents declare that context with `CompletionOpts.stablePrefix`; the messages sent to API providers are unchanged.
- **Reset per cycle.** Each decision forks the primed thread (ephemeral, through the primer turn, same instructions) and sends only the per-cycle part: thread state, the message or tool observation and the response protocol. The primed thread never receives a decision, so one cycle never sees another's turns. The fork shares the primed prefix, which the provider can serve from its prompt cache.
- **Re-prime** only when the stable context or instructions change, after idle eviction (30 min), or after the process is lost. Those are the only cold paths.

The process launches with `approval_policy="never"`, web search disabled and tool features (shell, unified exec, apps, plugins, browser and computer use, image generation, memories, multi-agent, hooks and similar) disabled; threads run in a read-only sandbox in a private empty directory, with MCP servers, the notify hook, project docs, skills and tool/environment instructions disabled per thread. The account must be a ChatGPT login (`account/read`) before any decision; an API-key login is refused. Any non-text item, MCP server start or runtime request on a decision thread is a violation: the turn is interrupted, the process recycled and further admission closed. The app-server reports the model serving each session, and a substituted model is refused. Receipts (`decisions.jsonl` beside `host.json`) record ownership, model, priming and settlement evidence without prompt or answer text.

## Scheduling

One process-wide scheduler serves every thread's decisions, with up to `maxConcurrent` processes at once:

- **Priority.** Calls carry `CompletionOpts.priority`: pre-message decisions (classifier, router, Cartographer, expert advice) run before post-action guards, which run before learning review and thread naming. Guards may hold at most three quarters of the slots and reviews at most half, so a turn waiting to start always finds capacity.
- **Fairness.** Within a priority, the thread served longest ago goes next, so one busy thread cannot starve another.
- **Shedding.** A full queue (per thread, then global) sheds its oldest lowest-priority wait to admit a more urgent call; only a call that cannot displace anything is refused. Shed guards report as unchecked, never as all-clear.
- **Rate limits.** A usage or rate limit fails that decision without retry, pauses new starts with exponential backoff (5 s to 60 s) and is logged and pushed to the viewer's event stream. It does not close admission. While the account reports usage blocked, the warm host refuses decisions before sending anything and re-reads limits at most once a minute.
- **Failures.** A refusal before any native write (expired deadline, revoked preflight or registration) leaves nothing owned and does not close admission. A turn the runtime settled (a native failure, or a deadline whose interrupt was acknowledged or whose process exit was observed) leaves nothing owned either and does not close admission. A violation, a substituted model or an unproven result still closes further admission.

## Latency

Every advisor has to be fast, so the pre-message phase is one concurrent round:

- The classifier and router run at the same time, both on the frozen message. The router no longer waits for the classification.
- The Cartographer and every domain assessment start on the message's first decision dispatch, against the same frozen input. They run alongside classification and routing, with no parallelism cap by default (`maxAdviseParallel`).
- The worker starts once the slowest of them answers.
- Composition stays deterministic: configured order, hash provenance, and the sealed plan are journalled before the worker starts.

Speed comes from how each decision runs:

- Each decision runs on its role's warm primed session.
- Contexts that change are decided inline, and priming never sits on the critical path.
- A decision still running after `hedgeAfterMs` is hedged.

Every decision, including classification and routing, has a 10 s deadline (`DECISION_DEADLINE_MS`). It is a safety net, not the normal path: a late answer is recorded as a timeout, the call is cancelled, and a classifier or router falls back to keywords.

Claude Haiku 5.5 at low effort, measured live on 2026-10-11 through the primed host (eight roles at once on one Claude login): a warm decision takes 1.1–4.3 s (median about 1.7 s); a cold role (status check, priming and a first fork) takes 5–7 s. One warm decision alone takes about 1.1 s.

The earlier Codex budget (`providers/decision-budget.ts`), measured live with `bun scripts/measure-decisions.ts` (six experts, gpt-6-luna at low effort, a spare `VIEWER_PORT`):

| | Before (per-call `codex exec`, classify → route → advise) | After |
|---|---|---|
| Message to worker start (turns 30 s apart) | p50 18.2 s, p95 22.7 s | p50 6.5–7.2 s, p95 8.2–8.7 s (two runs) |
| One decision | p50 4.3 s, p95 6.5 s | p50 3.5–3.9 s, p95 5.5–7.4 s under the full fan-out |

The budget is 7.5 s p95 per decision and 9 s p95 from message to worker start. About one decision in six is hedged. No websocket-to-HTTPS fallback appeared in 165 warm-host decisions. Back-to-back messages (a request burst every few seconds) trip provider throttling; those turns end at the 10 s safety net and are reported separately.

The floor is the decision model's own first-token latency: about 2.2 s for gpt-6-luna alone, and about 3.5 s under a nine-decision fan-out. A faster decision model or provider lowers it without structural changes.

## Warden pre-filter

**Off by default** (Aron, 2026-10-15: "leave pre-filtering on but switch it off for now until we figure out if we can make it work"). The code stays in Foundry; no local model clears the bar yet (below). Off, every Warden is asked on every trigger, no model server starts, `foundry-acp setup` downloads nothing, and neither `bun run doctor` nor the viewer mentions a model.

When turned on (`prefilter.enabled: true`), before a trigger point fans out to the Wardens, one local decision-model call asks, per Warden, whether the moment is about its domain. A Warden is skipped only on a confident no (its score below `skipBelow`); an unsure score, a failed call or a missing model asks it, as without the pre-filter. It runs at both ends of a turn: before (the user's message, the advice phase) and after (each agent action that reaches a Warden's guard, and the post-work review of the finished turn).

- **Model.** Kev-4B (Jared Palmer, Apache-2.0: a LoRA and pointer head on Qwen3.5-4B-Base, MLX on Apple Silicon), served on this machine on TypeSafe's System One API (`POST /v1/systemone`), so the call is `TypeSafeDecisionClient` with a `baseUrl` (`providers/warden-prefilter.ts`). One request per trigger carries one yes/no question per Warden: "Is this about <the Warden's instructions, without its opener>?" over a bounded view of the moment and the thread state (core `feedback/warden-prefilter.ts`). The moment never leaves the machine: `baseUrl` must be loopback.
- **Install.** Opt-in: `foundry-acp setup` installs it only when the daemon's settings turn the pre-filter on (`providers/prefilter-model.ts`): the pinned server source, its uv environment and the pinned weights, all under `~/.foundry/models` (`FOUNDRY_MODELS` overrides), about 9 GB. It needs `uv` (`brew install uv`) and `git`. The daemon starts the server at its own start (so turning it on needs a daemon restart) on the `decisions` port, 8680 in Foundry's block (registry entry pending in inixiative/config#8; the code's default does not read the registry), and stops it on shutdown; a server already answering there is used as is.
- **On, but missing or down.** Every Warden is asked, exactly as without it. The daemon log, the viewer's event stream (`warden-prefilter`, a warning) and `bun run doctor` (`prefilter-not-installed` or `prefilter-unavailable`, warnings, never errors) say so. Nothing is silent.
- **Journal.** Every skip is recorded with its score: the advice row's `prefiltered` list and `prefilter` call (`status`, `elapsedMs`, `skipped`), the guard outcome's `prefiltered`, and a review's `prefiltered` learning record (`pre-filter score 0.031 < 0.1`). Oracle can audit the misses.
- **Settings.** `prefilter`, off by default:

| Key | Default | Meaning |
|---|---|---|
| `prefilter.enabled` | `false` | Off asks every Warden on every trigger, makes no pre-filter call and starts no model server. `true` opts in. |
| `prefilter.baseUrl` | `http://127.0.0.1:8680` | The local System One server; loopback only. |
| `prefilter.model` | `kev-latest` | The server's model name. |
| `prefilter.skipBelow` | `0.26` | Skip a Warden when its score is below this. |
| `prefilter.timeoutMs` | `3000` | One call per trigger; past it every Warden is asked. |

**Measured** (`bun scripts/evals/warden-prefilter.ts measure`, 2026-10-14; the Prospector's 740 labelled moments, Opus run-1 labels, plus the 599 charter probes; this MacBook Pro M1 Max, 64 GB):

Recall is the share of (moment, Warden) pairs labelled relevant that are still asked; skip is the share of all pairs not asked. "r1" is the Opus run-1 labels on the 740 fixtures (the primary bar: broad, so conservative for a fail-open filter); "hand" is the 50 hand-checked fixtures; "probes" labels only each probe's gold Wardens (the rest count toward skips). Chance would skip 20% at 80% recall.

| Model (local, System One API) | Pairs | AUROC (r1) | Recall at 50% skip (r1) | Skip at 80% recall: r1 / hand / probes | Skip at 90% recall: r1 / hand / probes | Same decision on repeat | Latency per trigger p50 / p95 | Memory (physical) |
|---|---|---|---|---|---|---|---|---|
| Kev-4B (Qwen3.5-4B + LoRA, MLX bf16) | subset: 150 fixtures + 100 probes | 0.673 | 0.708 | 38% / 45% / 18% | 26% / 34% / 6% | 100% | 3.98 s / 4.62 s | 9.9 GB |
| Kev-0.8B (same subset) | 150 + 100 | 0.575 | 0.582 | 28% / 28% / 23% | 16% / 15% / 12% | 100% | 0.74 s / 0.88 s | 3.1 GB |
| Kev-0.8B (all) | 740 fixtures + 599 probes | 0.582 | 0.596 | 28% / 28% / 27% | 17% / 15% / 15% | 100% | 0.75 s / 0.88 s | 3.1 GB |
| Laya (ModernBERT-large) | 740 + 599 | 0.553 | 0.568 | 25% / 15% / 23% | 13% / 9% / 11% | 100% | 0.91 s / 1.25 s | 0.3 GB RSS |

By trigger, Kev-4B is best on the user's message (51% skipped at 80% recall, AUROC 0.74) and agent plans (45%), and weak on agent actions (25%) and finished turns (the probes, 18%). Within a Warden the topic Wardens separate (frontend, schema, security, types) and the process Wardens (intent, surface, verify, assumptions) do not.

**Status: not passing.** No model clears 80% recall with a skip rate worth its cost on this machine: Kev-0.8B is fast but barely beats chance, and Kev-4B adds 4–4.6 s before any Warden can start and about 10 GB. So the setting ships off by default.

Laya (ConvAI's ModernBERT-large decision model) was tried first and dropped: on the probes it recalled 0.53 of relevant Wardens while skipping half (chance is 0.5) and skipped only 23% at 80% recall; on the fixtures its AUROC was 0.55.

## Ownership and bounds

Decisions are bounded per call and per process. Guards retain their existing post-action semantics. The deadline includes queue, preflight and priming time; cleanup has its own bounded wait. Revocation or shutdown closes waiting admission and cancels active decisions: refused before dispatch, or interrupted with the interrupt's acknowledgment (or the process exit) as settlement. A worker authentication check with unknown exit likewise blocks further checks for that authentication instance.

Logical thread/generation/dispatch/review-job ownership is preserved while physical native session identities remain private. Inspection and release require the exact owner and admission ID. Learning cannot inspect accepted answer content until model, tool, ownership, receipt and process-release checks pass.

Claude decisions carry the same ownership evidence: one turn per decision, tools disabled, a strict empty MCP configuration, the served model checked, and process exit observed on settlement.

## Integration limits

Local profile references are not Kingdom capacity grants. A project execution contract must independently authorize worker and decision roles, purposes, model identities, aggregate budgets, deadlines and generation revocation. Startup makes no model calls unless `FOUNDRY_STARTUP_SELF_TEST=1` is set; in subscription mode that self-test consumes a decision allowance.

## Validation

Run `bun run test` and `bun run typecheck`. Focused tests are `packages/foundry/tests/subscription-default.test.ts`, `subscription-scheduling.test.ts`, `primed-decisions.test.ts`, `primed-claude-decisions.test.ts`, `subscription-policy.test.ts` and `subscription-decisions.test.ts`; they use controlled Claude and app-server doubles and a temporary `HOME`. The startup tests deny external requests and set synthetic API keys to verify they are never used.
