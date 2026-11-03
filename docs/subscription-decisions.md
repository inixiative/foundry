# Subscription-only Foundry

Foundry runs subscription-only by default. A fresh install, with no settings at all, runs the Claude Code worker and Foundry's decisions from the logins already on the machine:

- **Worker:** Claude Code, using the default Claude login (`~/.claude`, selected by leaving `CLAUDE_CONFIG_DIR` unset). Set `defaults.provider` to `codex` (for example with `defaults.model: "gpt-6-astra"`) to run main threads on Codex by default instead, on the Codex CLI's ChatGPT login (`~/.codex`). A project may set its own default (`projects[id].defaults.provider`), and any thread may start on another worker (below).
- **Decisions:** Claude Haiku 5.5 (`claude-haiku-5-5`) through the same Claude login (`~/.claude`), on primed Claude Code sessions. Classifiers, routers, the Cartographer, the Librarian, Wardens (advise, guard and review), configured experts and thread naming all use this decision profile. The runtime is a setting: `subscriptionOnly.decisionRuntime: "codex"` runs decisions on the Codex CLI's ChatGPT login (`~/.codex`) with GPT-6 Luna instead.

No API provider is constructed in this mode. There is no paid fallback, no automatic retry and no model substitution. API-key providers need an explicit opt-in.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `apiTokens` | absent (`false`) | `true` opts in to API-key providers (Anthropic, OpenAI, Gemini, gateways, Kingdom bindings) and the API decision provider, Anthropic Haiku 5.5 by default, which requires `ANTHROPIC_API_KEY`. It cannot be combined with `subscriptionOnly`. |
| `defaults.provider` | `claude-code` | The default main-thread worker (a project's `defaults.provider` overrides it). Without API tokens it is a subscription harness: `claude-code` or `codex`. |
| `defaults.nativeAuthenticationId` | absent: each runtime's first configured `native-profile` source, else `~/.claude` or `~/.codex` | Names a runtime's primary login. Every configured `native-profile` source of a runtime is a login of its worker, except the decision source (`subscriptionOnly.decisionSourceId`, the Wardens' login) unless it is also the named primary; several are a pool, balanced (below). With none configured besides the decision source, the worker runs on the default location. Naming a Codex source never moves the Claude worker to `~/.claude`. |
| `subscriptionPools.<claude\|codex>` | absent: `quartile-balanced`, balancing on | How a runtime with several logins balances them (below): `routing` (`quartile-balanced`, `owner-first`, `priority-balanced`), `preferredLoginId` (the login `owner-first` prefers and pinning runs on) and `pinned` (`true` is balancing off: every launch runs on the preferred login; the routing is kept for when it is turned back on). A project's `projects[id].subscriptionPools` overrides it for that project's threads. |
| `defaults.classifierProvider` / `classifierModel` | `subscription-decisions` / `claude-haiku-5-5` | New configurations record the decision profile here; `classifierModel` selects the decision model. A model registered only on the other runtime is refused rather than substituted. |
| `subscriptionOnly.decisionRuntime` | absent: Claude decisions, Wardens in project hosts | Decision runtime when no explicit source is named. Absent or `claude-project`: Claude decisions (`~/.claude`), every Warden of a project held warm in one Foundry-owned Claude Code process per project, asked for advice by every thread of the project, whatever its worker (below). `claude`: Claude decisions with every Warden on its own primed session (the evals' baseline). `codex`: Codex decisions (`~/.codex`), primed Wardens. `claude-in-session` (a thread's Wardens inside its own process) was removed on 2026-11-03 and is refused by name, with the fix. |
| `subscriptionOnly.projectHost` | absent: the defaults below | Project hosts only (refused with `claude` or Codex decisions): `sparesPerWarden` (1), `concurrentTurns` (2), `maxRssMb` (1536), `hardRssMb` (4096), `maxRecyclesPerHour` (20), `recycleTokens` (140000), `setupDeadlineMs` (30 s + 0.6 s per held spare), `restartBackoffMs` (5000), `maxRestarts` (5), `idleMs` (30 minutes). See "Project Warden host". |
| `subscriptionOnly.decisionSourceId` | absent: the runtime's default login | Optional explicit `native-profile` source for decisions. It must match `decisionRuntime` when both are set. |
| `subscriptionOnly.model` | `claude-haiku-5-5` for Claude, `gpt-5.6-luna` for Codex (a ChatGPT login on an older Codex CLI, 0.153.4, is refused `gpt-6-luna`) | Decision model; overrides `classifierModel`. Heavier roles can name `claude-opus-5-5` or `claude-fable-5-1`. |
| `subscriptionOnly.expectedObservedModel` | the requested model | Claude decision profiles only: the id the CLI must report serving (for example the full id behind an alias). Codex does not acknowledge a different model. |
| `subscriptionOnly.directory` | `<project>/.foundry/decision-receipts` | Private (0700) receipt directory. The default is created at startup; an explicit directory must already exist and be private. |
| `subscriptionOnly.maxCalls` | `10000` | Finite decision attempt budget for this Foundry process, including failed admitted attempts. It does not renew automatically. |
| `subscriptionOnly.maxConcurrent` | `16` | Decisions running at once across all threads: Claude CLI processes (~130–230 MB each), or concurrent turns on the one warm Codex process. Sized for a full chorus: every Warden is asked on every user message, and every guard-triggered Warden on every action. |
| (primed keys) | `2 × Wardens + 8`, at least 16 | Claude decision roles kept primed, sized at startup from the largest chorus any project runs (its region Wardens; an advice and a review key each). Each holds a spare CLI process (~130–230 MB): 25 Wardens is about 50 processes and 10 GB. An evicted key re-primes cold (5–8 s). Not a setting. |
| `subscriptionOnly.maxQueued` | `512` | Waiting decisions across all threads (up to 1024). |
| `subscriptionOnly.maxQueuedPerThread` | `256` | Waiting decisions per logical thread: deep enough that a burst of guards never refuses admission. |
| `subscriptionOnly.effort` | `low` | Decision reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`; Haiku 5.5 accepts `low` to `high`). The model default, `medium`, adds latency per decision. |
| `subscriptionOnly.hedgeAfterMs` | `4000` for Codex | A decision still running after this long starts the same input on a second branch; the first to finish wins (500 to 30000). |
| `subscriptionOnly.callTimeoutMs` | `60000` | Per-decision deadline including queue and preflight time (100 to 120000). |

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


## Several logins of one runtime (Aron, 2026-11-02)

A runtime can have several subscription logins, for example three Claude subscriptions (inixiative, personal, work). Settings › Providers adds one: "Add a Claude login" runs `claude setup-token` (Anthropic's own sign-in: inference only, one year) on a terminal of its own in a fresh private home, `<foundry dir>/logins/<id>/` (0700). You finish it in the browser it opens, or paste the code the page shows back into Settings. The token is written only to `setup-token.json` (0600) in that home and handed to the native child as `CLAUDE_CODE_OAUTH_TOKEN` at launch; settings hold its path (`tokenFile`), never the token, and no response or log carries it. "Add a Codex login" runs `codex login` in a fresh `CODEX_HOME` the same way. The first login added keeps the machine's own login (`~/.claude`) in the pool, so a second subscription never drops the first; any login can be named or removed (a home Foundry made is deleted with its token; the machine's own login location is only forgotten). Code: `providers/login-setup.ts`.

Several logins of a runtime are balanced (`providers/login-pool.ts`): which one serves a launch is agent-session's `SubscriptionPool` ranking (`rankCandidates`) from each login's 5-hour and 7-day readings (`probeClaudeLimits` / `probeCodexLimits` in the login's own home, cached a few minutes, plus the `rate_limit` events its sessions report). An exhausted, rate-limited or cooling login is skipped, a login that fails its sign-in check (`claude auth status`) is set aside as needing signing in again, and when none can serve the launch is refused with each login's reason: there is never a fallback to an API key. A login that reports no usage windows (a `claude setup-token` login reports none) can't be ranked by usage, so the balanced routings then order by turns served in the last five hours. A thread keeps the login it last ran on while that login can serve, because its native session and prompt cache live in that login's home; it moves only when its login is exhausted, signed out or removed, or balancing is pinned to another login, and the move starts a fresh native session seeded from the thread's journal. Each move bumps the thread's binding epoch (`…:move:<n>`), so a thread that comes back to a login it left never resumes that login's older session. A login with a thread running on it can't be removed (409) until the thread stops. Every admitted turn records the login that served it (`<foundry dir>/state/login-runs.json`, `GET /api/providers/runs?thread=<id>`), which also lets a restarted daemon resume a thread on its own login.

`GET /api/providers/pools` reports each runtime's pool: the routing, whether it is balancing across how many logins or why it stopped (pinned to a login, one login, only one left, none left), each login's status (ready, signing in, needs signing in again, exhausted), meters and turns in the last five hours, and the last turns' logins. The rail footer's Subscriptions block shows it with a scale per runtime; clicking the scale toggles the load balancer (balanced ↔ pinned to the preferred login), Foundry-wide; a project that sets its own `subscriptionPools` keeps its own and is named under the scale. Settings › Providers shows the same with the routing and preferred-login choices, and Analytics' capacity band reads the same record. A project on a Kingdom pool is balanced by Kingdom; its state is not shown yet (Kingdom FEAT-024).

Decisions (Wardens, classifiers) stay on the decision login (`subscriptionOnly.decisionSourceId`, default `~/.claude`); only main threads are pooled. Muse Code runs one login.

## Main threads

Main threads (the default worker and every enabled executor) run on models from five labs: Anthropic, OpenAI, Google, Meta and xAI (`MAIN_THREAD_LABS` in the core model registry). Other labs, gateways and local hosts are refused as main threads in every mode. How each lab runs:

| Lab | Subscription (default) | With `apiTokens: true` |
|---|---|---|
| Anthropic | `claude-code` on the Claude login | also `anthropic` (`ANTHROPIC_API_KEY`) |
| OpenAI | `codex` on the Codex ChatGPT login | also `openai` (`OPENAI_API_KEY`) |
| Google | no harness yet (agent-session's ACP transport for Gemini CLI is a stub) | `gemini` (`GEMINI_API_KEY`) |
| Meta | `muse` (Muse Code, `muse serve`) on the user's own Muse login; off until Meta's subscription mode is turned on | `meta` (`MODEL_API_KEY`, Meta's pay-as-you-go Model API: separate billing) |
| xAI | no harness yet | `xai` (`XAI_API_KEY`) |

A refused main thread names what it needs, in the settings API, the viewer's Defaults editor and setup.

A Codex worker is checked with `codex login status` and must be a ChatGPT login; an API-key login is refused. It shares the Codex login with Codex decisions (both are shared holders, so they may use the same `~/.codex`) and runs on its own Foundry-private `CODEX_HOME` (`.foundry/runtime-profiles/<source id>/codex-home`, kept across restarts so sessions resume) that links the profile's `auth.json`. None of the user's Codex config, instructions or MCP servers apply to it, and it runs with Codex's own sandbox and approvals off, like the Claude worker's bypass mode.

A Muse Code worker (FEAT-006) runs through agent-session's `MuseSession` on the user's own Muse login, referenced in place (`$XDG_CONFIG_HOME/muse`, by default `~/.config/muse`), or, in a Kingdom-capacity project, on a Muse login its pool releases (native-authentication.md, "Kingdom-held subscription logins"). No other local Muse profile is supported, because moving it means moving `XDG_CONFIG_HOME`, which every command Muse runs inherits; the Kingdom path moves it and links the user's other config in. Why it is a native worker and not an API provider: a Muse subscription is billed only through Meta's own CLI, while the `meta` provider's `MODEL_API_KEY` is pay-as-you-go.

- **The login is the proof.** It is checked with `muse usage --json` (no model turn): signed in when it reports an allowance tier; nothing else about the account is read. The CLI must be the version agent-session's SDK is pinned to (`MUSE_SDK_VERSION`, 1.4.14); the doctor reports a mismatch, and agent-session refuses a host serving another version.
- **Nothing competes with the login.** A Muse launch loses every inherited Meta key and endpoint (`META_*`, `LLM_*`, `MODEL_*`, `LLAMA_*`, `OPENROUTER_*`, `TBH_AUTH_BASE_URL`, `TBH_MINT_BASE_URL`) and Muse's switches for the model, experiments, contributor mode, the approval judge and a fail-open permission profile (`withoutCompetingCredentials`), and gets `MUSE_NO_AUTO_UPDATE=1`, so the CLI stays on the pinned version. In subscription mode it launches with the same environment allowlist as the other workers (`boundLaunchEnvironment`, plus `XDG_CONFIG_HOME` / `XDG_DATA_HOME` so it finds the user's login and sessions). Muse's own tool runs inherit that environment.
- **Access follows the host.** Full access (and no host mode) is `allowAll` with the `:unrestricted` profile and no sandbox; a gated mode is `promptUnmatched` with `:ask-me`, so every approval reaches Foundry's tool gate and approval queue, never Muse's AI reviewer. Like Codex, a thread with structural deny or prompt rules is refused at launch: Muse's only pre-use stage is a vendor hook.
- **Questions.** A question Muse asks (`userInput/request`) goes to the thread's person on the same `ActionQueue` the tool gate asks on (a `choice` prompt for a single choice, else `input`), so it shows as "the agent asks" and the viewer answers it. foundry-acp forwards only approvals, so a question asked under an ACP host waits for the viewer or its timeout. A rejection, a timeout (15 minutes) or nobody to ask cancels it with a reason, so the turn goes on.
- **Turns Muse starts itself** (cron firings, monitor and background-terminal wakes, goals, messages from its other clients) land on the thread as observed turns, journalled and pushed live (`turns/native-turns.ts`); their lifecycle also shows as a running task, and one still open when the session ends is closed as failed. The thread then reads as done (its last turn completed). An orange "new arrival" needs the attention tag (`meta.attention`, the attention board's data, not built yet).
- **Resume.** The Muse session id is the thread's binding; a restart resumes it, and a missing one (or an ephemeral host that died) starts a fresh session seeded from the journal.
- **Kingdom pool.** A Kingdom-capacity project runs Muse threads (and may default to Muse) on its pool, never on this machine's login; a pool with no Muse login is refused with Kingdom's reason. A login Meta rejects is confirmed with `muse usage` and reported to Kingdom (`reportCredentialRejected`).
- **Not yet:** Foundry's tools and a host's MCP servers (agent-session offers Muse no session MCP, so Muse threads carry neither the `foundry` tools nor the note that teaches them), and decisions (Muse runs main threads only).
- **Personal only.** Archive captures of a Muse thread carry `runtime: { provider: 'meta', accessPath: 'subscription' }`, which Archive's `alwaysPersonal` keeps out of every organization. Foundry claims no Muse session with Archive's collector (claims name Claude Code and Codex sessions only), so the collector's Muse source captures the native transcript too, also personal. Muse may run in any project.
- **The login is released when `muse serve` has exited**, not when the session object closes, so a relaunch (a host's mode or effort changed) never resumes the session while the old host still writes it.

## Each thread picks its worker

A project has a default worker; any thread may start on another worker the user has a login for (FEAT-007). The worker is stored on the thread record (`ThreadMeta.worker`), set when the thread is created and never changed silently. `worker` names the provider running the thread's main session: a subscription worker (`claude-code`, `codex`, `muse`) in subscription mode, the default API provider (for example `anthropic`) with `apiTokens: true`.

- **Startup builds every offered worker.** A worker is offered when its vendor's subscription mode is on (or a project defaults to it), and each gets its own adapter, started on its own default model (the global model on the global worker). Building one spawns nothing: processes start per thread. A worker runs a local thread only with its login here: every default worker of threads run on this machine must have one, or Foundry refuses to start; another worker without one is simply not offered for local threads.
- **Choosing one.** `POST /api/threads` takes `worker`; the ACP agent reads `_meta.foundry.worker` on `session/new`. The worker can change whenever the thread is idle (`PATCH /api/threads/:id` with `worker`, or the ACP `worker` config option); while a turn runs or waits, the answer is 409. The launch view (`GET /api/threads/:id/launch`) returns the thread's `worker`, its models and `options.workers`. The viewer's command palette offers "New <worker> thread in this scope" for each other usable worker, and a thread's row tag names its worker.
- **Refusals.** A thread is refused (400 with the reason) when its worker is not a subscription worker, its vendor's subscription mode is off, or it has no login (`threadWorkerRequirement`, checked on create, restore and reopen). There is never a fallback to another login or an API provider. With `apiTokens: true`, every thread runs on the default provider.
- **What a thread on another worker runs.** Its view (`resolveThreadView`) is its project's view with the worker's default model (`SUBSCRIPTION_WORKER_MODELS`: `fable` for Claude Code, `gpt-6-astra` for Codex, `muse-wonder-1.0` for Muse Code) and its executors on that worker. An executor model pinned in settings that the worker does not run gives way to the worker's default; the launch view lists it under `setAside`.
- **Kingdom capacity.** A Kingdom-capacity project runs every worker on its pool, so its threads need no login here, and its default worker needs none at startup. A thread whose pool has no login for its worker is refused with Kingdom's reason and is never run on this machine's login.
- **Records.** Every thread record names its worker. At startup, before anything reads them, records without one are stamped once (`LocalSessionStore.stampWorkers`): from the runtime bucket of `.foundry/sessions.json` that holds the thread's own native binding; an observed subagent from its parent; a thread that never ran natively from its project's default, since no native session can disagree. A record bound under two runtimes, or one no worker owns, is left unstamped: it is retained on disk with a warning, a save never stamps it, and a main thread in that state stops startup. So a plain merge deploys. The main thread keeps the worker it last ran on. Observed subagents and forks carry their parent's worker.
- **Changing it.** A worker change before the first turn rebuilds the thread at once, with no await between the check and the rebuild.
- **Switching mid-conversation (Aron, 2026-11-02).** After the first turn a change carries the conversation over, not the old session's state. The route settles or refuses a lost turn first (`nativeRecovery`) and reads the session the thread held on the old worker; then, with no await between the last lock check and the save, it rebuilds the thread, journals a `worker-switch` row (from, to, that session kept on record) and saves the new worker. The store accepts a worker change after the first turn only behind that row. Only then is the old worker's session retired (`SessionBackedProvider.retireThread`, on `_forget`: ended, binding forgotten), so returning to a worker never resumes its stale session. The next turn starts a fresh session on the new worker, seeded once by `turns/journal-history.ts` (the CORE-004 seeding that fresh and forked sessions use): the conversation verbatim within `workerHistoryBudget(worker)` (a tenth of the worker's smallest context window, oldest left out past it), a "Continued on <worker> from here" marker, and the thread's plan. Foundry writes no summary of its own: what outgrows the window later is the harness's auto-compaction's (Foundry's rule against a separate summariser). The launch view lists `switches`, which the transcript shows as markers. A thread that ever ran on Muse stays personal in Archive (`runtime: meta`) after it moves off.

## Existing settings

Subscription mode runs every enabled non-executor agent on the decision profile. An agent saved with another provider or model (for example a classifier on `gemini` or a Librarian on `claude-code`) is routed to `subscription-decisions` at startup; the startup log lists each routed agent. The saved settings file is not rewritten. Settings that cannot be enforced are refused rather than routed: a worker that is not a subscription harness, an executor on another provider, a main-thread model the worker does not run, decision agents with tools, thinking, cache or non-zero temperature overrides, and `learning.review` provider/model overrides.

The default model is only the default. An executor (`agents[id].model`), a project (`projects[id].defaults.model`) and a thread (the launch settings a host or the viewer chooses) may each run any model its subscription worker runs, as its registry entry lists them (`workerModelRequirement`); a model of another provider is refused. Decision roles are different: every decision runs on one shared primed host per runtime, which launches with the decision model and refuses a call naming any other, so a decision agent's own model is routed to the decision model rather than honoured.

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
- **Bounds.** Every decision process launches text-only (`--safe-mode --tools "" --strict-mcp-config` with an empty MCP config, no slash commands, no Chrome) with `--setting-sources ""`, so the user's hooks, permissions and plugins never apply, and with paid credentials stripped. Primed roles are sized for the largest chorus any project runs: max(16, (stages on the decision host + 1) × the largest roster + 8) (`liveDecisionHosts`, `providers/decision-host.ts`); each holds one idle spare process, about 215 MB; idle roles are evicted after 30 minutes. Any tool activity is a violation that closes admission.
- **Login.** Before the first decision the host checks `claude auth status --json` for a `claude.ai` subscription login (never an API key) and registers as a shared holder; a failed check dispatches nothing. The CLI reports the served model (`claude-haiku-5-5` for Haiku 5.5), and a substitution is refused.
- **History.** Primed transcripts live in `~/.claude/projects/<private host cwd>` while their role is primed and are deleted when it is evicted or the host closes; the empty directory is removed on close. A crash leaves them there.

## Wardens in the thread's own process (removed)

`decisionRuntime: "claude-in-session"` (docs/THREAD-TREE.md spec C) held each Claude Code thread's Wardens as subagents inside the thread's own process, set up by a hidden turn while the first turn waited queued. It was removed on 2026-11-03 for the project host below (Aron: "the Claude project is the only thing that actually makes sense. Maybe we clean that up"): one warm process per project serves every thread of it, where spec C cost one process and a setup per thread. A saved setting naming it is refused with the fix. Spec C and its measurements stay in THREAD-TREE.md as history.

## Project Warden host (`claude-project`)

The default for Claude decisions since 2026-11-03 (Aron: "the Claude project is the only thing that actually makes sense"), with no `decisionRuntime` or `decisionRuntime: "claude-project"`; `claude` keeps every Warden primed. Aron, 2026-11-02: "All of these wardens should always be warm… run and then output and then reset." Spec: Oracle `docs/foundry/PROJECT-WARDEN-HOST.md` (rev 2) and its review. Not yet measured: detection through the host against the stage-one bar (parked with the other tests). With project hosts:

- **One host per project.** One Foundry-owned Claude Code session per project with a chorus, on the decision login, built by the decision host (`createPrimedDecisionHost`): a private directory below its stamped root (Archive drops it). The launch is as bare as a subscription launch goes (`--bare` and `CLAUDE_CODE_SIMPLE` refuse subscription logins; Aron, 2026-11-02: "wardens should be as bare as possible"): `--setting-sources ""`, `persistSession: false`, `--effort` at the decision effort, `--strict-mcp-config` with only the host's own server, `--disable-slash-commands`, `--exclude-dynamic-system-prompt-sections`, CLAUDE.md off, no telemetry, non-essential traffic or autoupdate (`PROJECT_HOST_ARGS`, `PROJECT_HOST_ENV`). A `claude setup-token` decision login reaches it as `CLAUDE_CODE_OAUTH_TOKEN` through the login's own launch, so no keychain is read; the default `~/.claude` login is read by the CLI as usual. It is extended with agent-session's `ClaudeInSessionDecisions` (spec C's held, fresh-per-call members). It is never built through the session adapter, so main threads keep the user's harness settings.
- **Only while someone works in the project** (Aron, 2026-11-02: "only while you're working in a project would its wardens be turned on"). A project's host opens on the project's first activity after startup: a turn journalled in it or a thread of it opened (the daemon's event stream, `journal` and `thread:added`; `followProjectActivity`). It closes after `projectHost.idleMs` (30 minutes, as primed roles are evicted) without any. Until it serves, and after it closes, calls go to primed Wardens. The first turn in a cold project is therefore advised by primed Wardens while its host sets up.
- **Roster.** On opening, on every settings change and every minute, an open host's roster is composed from a hidden thread of the project (`composeProjectRoster`, `agents/chorus-thread.ts`, the same hidden thread `chorus-advise` uses) and held (`ProjectWardenHosts.openProject`, `providers/project-warden-hosts.ts`). The refresh never opens a host. The same roster again changes nothing. A changed roster of the same size is held in place (spares holding the old text are retired as replacements hold). A larger roster starts a new host.
- **Stateless Wardens.** A held spare holds a Warden's system (charter, region instructions) and its stable prefix (the region's knowledge), nothing of any thread: the split is at `stablePrefix` with an empty standby. The thread's own part (its understanding, the thread state, the moment, the protocol) rides in the moment. Every thread of the project matches the same spares. Threads never pre-start or release the host.
- **Composition at the project root.** With project hosts a thread's Wardens compose at the project's path, worktree threads included (`projectWardenRoot`, `ThreadRuntimeDeps.wardenRoot`), so a worktree's unmerged role-file edit (`.foundry/roles/<region>/`) reaches Wardens once it merges. Wardens never get CLAUDE.md (Aron, 2026-11-02; no switch): a Warden is its charter, the project's warden brief (`.foundry/warden-brief.md`, the `warden-brief` ladder node) and its region, composed the same way for every thread and the host. Because Wardens bind to the project's registered path, every thread reads the registered checkout's warden brief and role files, not its worktree branch's; a brief edited on a branch reaches the Wardens once it is in the registered checkout. That is intended: one composition per project is what a shared host holds.
- **Run, output, reset.** Each held spare serves one decision and ends; its replacement starts at once from the same prefix (cache reads, not writes).
- **Routing.** A thread's advice calls (`<thread>:aux:domain:<d>` at turn priority) go to its project's host while it serves (`projectHostTarget`, by `threadMeta(thread).projectId`, the login pool's lookup); they take none of the `maxConcurrent` slots. Guards (guard priority), reviews (`review:<g>:domain:<d>`) and Layer 2 (`domain:<d>:stage:<n>`) stay on primed sessions. A project with no serving host, a thread without a project, and every call when the host is down go to primed (fail-open); host state changes are logged and failures pushed to the viewer's decision warnings.
- **Subagents.** A main thread's subagent turns are guarded from the main thread's Wardens in every runtime and on every worker (on primed sessions, like any guard), journalled on the subagent's node; nothing about them depends on the host.
- **Login.** The host runs on the decision login (`subscription.decision`), like primed decisions, not on the thread's login or Kingdom pool (spec C's removed per-thread runtime used the thread's).

**Bounds.** A used spare's replacement starts while it still answers, so the subagent bound is `roster × (spares + 1) × concurrentTurns + 4` (root and dispatchers), raised on top of the user's own cap (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`). `maxOrphans` is one dispatcher's members, `roster × (spares + 1)`. The setup deadline scales with the roster. One spare per Warden to start.

**Health and reset.** The host is Foundry's own process, so its whole state can be thrown away. Every 2 s the supervisor reads the host's process tree memory (`ps`) and whether it serves:

| Condition | Action |
|---|---|
| Process ended | Routing leaves it at once; a new host starts. |
| Not serving for two reads (orphaned out, root gone) | A new host starts (blue/green). |
| Memory over `maxRssMb` for three reads in a row | A new host starts while the old one serves; routing switches once it serves; the old one stops once its calls in flight settle. |
| Memory over `hardRssMb` on one read | Routing leaves it at once (primed serves), a new host starts, the old one stops once its calls settle. |
| More than `maxRecyclesPerHour` dispatcher recycles | A new host starts (blue/green). |
| A start fails (setup not serving by the deadline) | Retried after `restartBackoffMs`, doubling to 5 minutes; after `maxRestarts` failures in a row the project stays on primed Wardens until restart. |

Why both memory bounds: a 15-round run of one process holding 75 Wardens (48 KB each, agent-session `scripts/measure-in-session.ts`, 2026-11-02) sat at about 1.0 to 1.4 GB between rounds, every fan-out peaked at 1.5 to 2.5 GB for about two seconds and fell back, and twice memory climbed at about 400 MB/s (to 5.9 GB, which fell back, and to 12.5 GB at the end, which did not). A single read over 1.5 GB is a normal fan-out; three in a row is growth; past 4 GB a replacement's ~30 s setup is too slow to wait for. Those readings were of the measuring script's whole process tree, the Bun parent included.

**Why (measured 2026-11-02, spec "Why").**

| | Primed (one CLI per Warden) | One process, 75 held Wardens |
|---|---|---|
| Processes, memory | 79, ~15 GB | 1, 650 MB idle → 1.9 GB after 4 rounds |
| Whole-chorus Layer 1, warm | 9–10 s (16 slots); 2 of 75 timed out in a live advise | 3.4–6.0 s per round, p95 call 5.6 s |
| Failures | — | 0 of 300 |

Queue position drove primed latency (2.5 s → 15 s); each Haiku CLI process takes about 35% of a core, so 75 processes need about 26 cores on a 10-core laptop.

**Refill.** A fan-out uses every spare; replacements go out through one dispatcher, one Agent call each, written as output tokens (about 4 a second on Haiku), and the measured refill of 75 is about 20 s. A second turn inside that window finds most Wardens unheld: they start their own member on the host (`prime: cold`), slower but still in-process. Not yet built here: several dispatchers, each refilling a fixed slice of about 8 Wardens at once (agent-session `ClaudeInSessionDecisions` `dispatchers`, in review, unreleased; it needs `test:live` and a release before the host can pass `dispatchers`).

**Evals.** `scripts/evals/chorus-advise.ts --decision-runtime claude-project` sets the host up as the daemon does and records it in `<out>/host.json`: setup, per message held (`warm`), own-member (`cold`) and primed counts with latencies, and memory every 2 s. `--message-file` may repeat (`--gap-ms` between, 0 back to back). `scripts/evals/warden-charter.ts --decision-runtime claude-project --session <s> --projects <one>` asks the first stage through a project host. `decisionHost(model, 'claude-project', …, { project })` and `liveDecisionHosts(…, { project })` build it.

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

Every decision, including classification and routing, has a 60 s deadline (`DECISION_DEADLINE_MS`; a Warden's advice and routing default to it too). It is a safety net, not the normal path. It was 10 s until 2026-11-01, when a 70-Warden chorus on 16 concurrent calls timed out on 11 of 70 Wardens in a live template replay: the deadline was cutting real answers, not catching hangs (Aron: "really extend the timeout limit, and then we can figure out how to make things faster"). On a timeout: a late answer is recorded as a timeout, the call is cancelled, and a classifier or router falls back to keywords.

Claude Haiku 5.5 at low effort, measured live on 2026-10-11 through the primed host (eight roles at once on one Claude login): a warm decision takes 1.1–4.3 s (median about 1.7 s); a cold role (status check, priming and a first fork) takes 5–7 s. One warm decision alone takes about 1.1 s.

The earlier Codex budget (`providers/decision-budget.ts`), measured live with `bun scripts/measure-decisions.ts` (six experts, gpt-6-luna at low effort, a spare `VIEWER_PORT`):

| | Before (per-call `codex exec`, classify → route → advise) | After |
|---|---|---|
| Message to worker start (turns 30 s apart) | p50 18.2 s, p95 22.7 s | p50 6.5–7.2 s, p95 8.2–8.7 s (two runs) |
| One decision | p50 4.3 s, p95 6.5 s | p50 3.5–3.9 s, p95 5.5–7.4 s under the full fan-out |

The budget is 7.5 s p95 per decision and 9 s p95 from message to worker start. About one decision in six is hedged. No websocket-to-HTTPS fallback appeared in 165 warm-host decisions. Back-to-back messages (a request burst every few seconds) trip provider throttling; those turns ended at the decision deadline (then 10 s; 60 s since 2026-11-01) and are reported separately.

The floor is the decision model's own first-token latency: about 2.2 s for gpt-6-luna alone, and about 3.5 s under a nine-decision fan-out. A faster decision model or provider lowers it without structural changes.

## Warden pre-filter

**Off by default** (Aron, 2026-10-15: "leave pre-filtering on but switch it off for now until we figure out if we can make it work"). The code stays in Foundry; no local model clears the bar yet (below). Off, every Warden is asked on every trigger, no model server starts, `foundry-acp setup` downloads nothing, and neither `bun run doctor` nor the viewer mentions a model.

When turned on (`prefilter.enabled: true`), before a trigger point fans out to the Wardens, one local decision-model call asks, per Warden, whether the moment is about its domain. A Warden is skipped only on a confident no (its score below `skipBelow`); an unsure score, a failed call or a missing model asks it, as without the pre-filter. It runs at both ends of a turn: before (the user's message, the advice phase) and after (the turn's guard over its tool activity, and the post-work review of the finished turn), and at a handoff to a subagent (the brief).

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

Run `bun run test` and `bun run typecheck`. Focused tests are `packages/foundry/tests/subscription-default.test.ts`, `subscription-scheduling.test.ts`, `primed-decisions.test.ts`, `primed-claude-decisions.test.ts`, `subscription-policy.test.ts`, `subscription-decisions.test.ts` and `project-warden-host.test.ts`; they use controlled Claude and app-server doubles and a temporary `HOME`. The startup tests deny external requests and set synthetic API keys to verify they are never used.
