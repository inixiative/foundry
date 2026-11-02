# FEAT-006: Muse Code worker: Aron's Muse subscription in Foundry threads

**Status**: 🔨 Built (2026-11-02) on agent-session 0.8.0 (`MuseSession`) and FEAT-007 (#260, merged). The Kingdom-held Muse login is built on Kingdom #204 (PR open). See "As built" below; it overrides the design sections where they differ.
**Assignee**: inixiative-b9 (handed over by inixiative-da, 2026-11-01)
**Priority**: High (Aron asked for it, 2026-11-01)
**Created**: 2026-11-01

---

## As built (2026-11-02)

Aron's decisions (2026-11-01) override the design below: **full coding from the start** (not text-only), **Muse may run in any project** (no owner check), and **every Muse session goes to the personal Archive**.

| Concern | Existing primitive used |
|---|---|
| Native session | agent-session `MuseSession` (0.8.0), `musePermissions`, `NativeBindingMissingError` (runtime `muse`) |
| Worker registry | `SUBSCRIPTION_WORKERS.muse`, `WORKER_SESSION_RUNTIMES.muse = 'muse-serve'` (`models/registry.ts`); core `muse` provider, `meta` vendor subscription `{ provider: 'muse' }`, `SUBSCRIPTION_WORKER_MODELS.muse = 'muse-wonder-1.0'` (the default in Muse's catalogue) |
| Adapter | `MuseSessionAdapter` beside the Codex adapter (`providers/session-adapter.ts`), same contract: store binding, construction record, auth `check()` around admission, `structuralRulesAtLaunch` |
| Login | `NativeAuthenticationSource.runtime` gains `muse` (default profile `$XDG_CONFIG_HOME/muse`, `default-profiles.ts`); `SubscriptionAuthentication` checks it with `muse usage --json`; `withoutCompetingCredentials(env, 'muse')` |
| Tool gate | `turns/tool-gate.ts` via `onToolRequest` in gated modes; structural rules refused at launch like Codex |
| Questions | Foundry's `ActionQueue` (`choice` / `input` prompts), the queue the tool gate asks on: `turns/native-questions.ts` |
| Muse-started turns | the observed-turn store calls subagents use (`startObservedTurn` / `appendObservedNative` / `endObservedTurn`): `turns/native-turns.ts`, fed by `SessionBackedProvider.observeNativeTurns` |
| Recovery | `NativeBindingMissingError` → fresh session seeded from the journal (unchanged, generic in `session-backed.ts`) |
| Host lifecycle | the SDK's own handshake (`spawnMspConnection`), as agent-session's default host, so the adapter learns when `muse serve` exited and releases the login only then |
| Limits | `rate_limit` events → `auth.observeLimits` (the Kingdom path), as Codex |
| Archive | `captureThread` stamps `runtime: { provider: 'meta', accessPath: 'subscription' }` (`workerArchiveRuntime`), which Archive's `alwaysPersonal` keys on |
| Setup/doctor | `inspectNativeClis`: `muse` CLI found, version equal to `MUSE_SDK_VERSION`, login via `muse usage` (doctor without `--offline`) |
| Tests | scripted MSP host (`tests/helpers/fake-muse.ts`, from agent-session) and a live cassette (`tests/fixtures/vcr/muse/`, two turns) |

Decisions made while building, and why:

- **Muse loads the user's own Muse config.** Its login and its config share `$XDG_CONFIG_HOME/muse`; a Foundry-owned home means moving `XDG_CONFIG_HOME`, which every command Muse runs inherits. What could take the subscription away is closed outside the config (provider forced `meta`, Foundry's model, competing env stripped). `harnessSettings: off` cannot apply to Muse.
- **Only the user's default Muse login.** Another profile directory is refused (`profileEnvironment`, `assertProfile`) for the same reason; it comes with the Kingdom-pool ticket.
- **No Foundry tools on Muse threads.** agent-session 0.8.0 offers Muse no session MCP, so `SessionBackedProvider` gives a Muse session no native bridge and the thread gets no `foundry-tools` note (`workerHostsFoundryTools`). A host's MCP servers are not passed either (logged).
- **Muse is never a decision runtime.** A Muse `decisionSourceId` and choosing `muse` as the decision model are refused.
- ~~**Kingdom-capacity projects refuse Muse threads**~~: superseded by "Kingdom-held Muse login" below. A pooled Muse thread still never falls back to this machine's login (FEAT-007's rule).
- **Muse is off by default** (`enabledByDefault: false`): few machines have it signed in. The daemon resolves `muse` on its PATH when installed but does not require it.
- **No version probe updates the CLI.** Every `muse --version` / `muse usage` Foundry runs sets `MUSE_NO_AUTO_UPDATE=1`: the launcher otherwise updates itself hourly, past the SDK pin.

Still open:

- **Questions under an ACP host.** foundry-acp forwards only approval prompts, so a Muse question asked from Zed, Paseo or T3 waits for the viewer or its 15-minute timeout. Mapping choice/input prompts into ACP is a foundry-acp change.
- **Conversation layers.** A Muse thread in a shared conversation still gets the roster and floor layers that name the conversation tools, which its session lacks (no session MCP). Only the `foundry-tools` note is suppressed.
- **Overlapping turns.** While a Muse-started turn and a Foundry-sent turn are both active, `LocalSessionStore.openTurn` picks the later-started one, so a member post or a subagent spawn in that window can attach to the Muse turn.
- **The host-exit seam.** The adapter keeps its own `spawnMuseHost` (the SDK handshake agent-session uses) only to learn when `muse serve` exited; when agent-session exposes that (and the child pid, for `adopt`), it goes.
- **Viewer setup wizard** keeps its own worker list (`viewer/ui/wizard.js`), without Muse: viewer lane.
- **Login check in setup.** Only the doctor (without `--offline`) runs `muse usage`; setup's Agent CLIs step does not.
- **Archive claims.** Archive's claim sources are Claude Code and Codex only; adding `muse` there would let Foundry claim its Muse sessions (Archive ticket).

- **New-arrival attention.** A Muse-started turn lands on its thread and the thread reads as done; an orange "new arrival" needs `meta.attention` (attention-board data lane, not built). The recorder exposes `arrived` for it.
- **Session MCP** (Foundry's tools, host MCP servers) and **workspace trust** (agent-session always passes `--trust-workspace`): agent-session changes.
- **agent-session evidence gap:** a Muse turn after the first carries no `nativeSessionId` (only `externalSessionId`).
- **The login lock** has no child pid (the SDK's child exposes none), so a crashed Foundry's shared registration on `~/.config/muse` is not reclaimed automatically; it blocks only exclusive holders, and nothing holds a Muse login exclusively.

## As built: the Kingdom-held Muse login (2026-11-02)

Aron, 2026-11-02: "Kingdom can definitely hold [Muse]… we should build that." Kingdom #204 made `muse` a subscription runtime: a `bearer` Credential with no expiry and no refresh, personal owners only, released per run with its `credentialVersion`, and `access/reportCredentialRejected`.

| Concern | Existing primitive used |
|---|---|
| Storing the login | `foundry kingdom login muse` beside `claude`/`codex`: `nativeLogin` → `museDeviceLogin` (Meta's device flow, the launcher's `device_login`: client `1031625952748946`, `interval`, `slow_down` +5 s, `access_denied`, `expired_token`, redirects refused), then `uploadSubscriptionLogin` (`setSubscriptionLogin`, runtime `muse`, access token only) |
| Release per launch | `KingdomSubscriptionAuthentication` (resolve, release, holders, one home per integration); `ProjectCapacityAuthentication` no longer refuses `muse` |
| The login's home | `XDG_CONFIG_HOME = <subscriptions>/<integrationId>/muse/muse-config`, a file-backed login in `muse/auth.json` (0600, `writePrivateFile`, `assertPrivateProfile`), kept while it holds the same token (the CLI adds its api key), deleted by the last holder |
| The user's config | `shareMuseUserConfig` on CORE-003's `linkUserFolders` / settings copy (`harness-settings.ts`): every other entry of the user's config home linked; in `muse/` the user's files (`settings.json`, `trust.json`) private copies, their folders links, `auth.json` and lock files never; `XDG_DATA_HOME` untouched |
| Competing env | `withoutCompetingCredentials(env, 'muse')` on the Kingdom launch too |
| Rejected login | `NativeAuthenticationLaunch.loginFailed` (new, optional), called by `MuseSessionAdapter` on a failed (not cancelled) turn or a host that would not start; confirmed with `muse usage --json` in a throwaway config home beside the login's (so the check never rewrites a newer token another thread runs on) (`museLoginRejected`, beside `museSubscriptionStatus`: only `credential_rejected` counts), five-minute cooldown, reported once and retried if the report fails (`KingdomClient.reportCredentialRejected`), cached run dropped, the session ended so its next turn launches on another login, a later refusal names the rejected login |
| Limits | `limitReading` already sends only windows; Muse's tier never reached the reading (agent-session does not read it), now tested against `kingdomLimitReadingSchema` |
| Release schema | `kingdomSubscriptionReleaseSchema` gains `credentialVersion` (Kingdom #204 sends it; the strict schema refused every release without it) and `muse` in every runtime enum (`subscriptionRuntimeSchema`) |
| Policy | `threadWorkerRequirement`, the startup policy check and `validateProject` accept Muse on a Kingdom-capacity project |

Decisions and why:

- **`XDG_CONFIG_HOME` moves, not `MUSE_AUTH_PATH`.** The launcher honours `MUSE_AUTH_PATH`, the 1.4.14 binary does not (measured: "not logged in" with it set; `credential_rejected` from a file at `$XDG_CONFIG_HOME/muse/auth.json`).
- **Confirm before reporting.** agent-session folds a failed turn's `error.kind` (`authRequired`) into the terminal's reason only, so the adapter cannot tell an auth failure from others; every failed turn asks, and the read-only `muse usage` decides. A wrong report would lock the user out of a working login until a new sign-in.
- **No local block after a rejection.** Kingdom stops releasing the marked login; Foundry re-resolves so the pool can pick another one.
- **Signet.** The rejection report goes through `SignetClient.post('reportCredentialRejected', …)`, allowed from signet 0.12.2 (signet#26); Foundry requires `^0.12.2`.

Still open (Kingdom login):

- Muse's own writes to its settings or trust file in a login's home are overwritten by the user's copy at the next launch when they differ.
- The rejection check runs `muse` from PATH, not the adapter's `museBin` (unset in production).
- A project switched to Kingdom capacity while the daemon runs uses the local login until restart (routing is built at startup; pre-existing, now also for Muse).
- Claude and Codex have no read-only rejection check; their rejected logins are not reported yet.
- agent-session could carry `error.kind` on the terminal, so only an `authRequired` failure asks.

## Why

Aron, 2026-11-01: "Let's do one for us: yes, a Muse code, Meta's coding CLI. Again, I don't even want to be coding on this. I just want to be able to connect to my Muse session and give me Muse things… we already have our own subscription things, and they have their own subscription, so make sure we're satisfying both."

And the same day: Muse is "100% personal stuff" (CLAUDE.md, Voices bullet): its threads route to the personal Archive.

A Muse subscription runs only through Meta's own Muse Code CLI (`muse`). The Model API key (`MODEL_API_KEY`, `LLM_…`, already in the core registry's `meta` provider) is separate pay-as-you-go billing. So this needs a native worker like Claude Code and Codex, not an API provider.

## Satisfying both subscription models

**Ours** (CLAUDE.md, "Subscription-only execution", "Kingdom holds subscription logins"):
- Inference always runs in the real harness on the user's machine.
- One isolated profile directory per integration.
- A login is a personal-owner subscription Integration.
- There is a per-project choice between the local login and the Kingdom pool.

**Meta's:**
- Bill through the saved `muse` login.
- Strip `META_API_KEY` from the child's environment, because Muse would give it priority over the saved login (T3 `sdk.ts` `makeMuseEnvironment`).
- Set `MUSE_NO_AUTO_UPDATE=1`.
- Never use the login outside `muse`.
- Pin the SDK to the installed CLI's version: the SDK version must equal the CLI version.

## Shape

### 1. agent-session: `MuseSession` (new `src/muse-session.ts`, implements `HarnessSession`)

**Process and protocol:**
- Uses Meta's `@muse-code/sdk` (MIT, no dependencies, exact pin) through its `MuseClient` facade.
- Spawns `muse serve --trust-workspace`, plus `--disable-sandbox` only under full access, like T3 `museServeArgs`.
- Initializes with `requestedCapabilities: ['sessionMcp']`, so Foundry's MCP bridge can be offered.

**Send:**
- `send` calls `session.sendUserTurn` and folds the turn's items into `SessionEvent`s.
- `agentMessage` maps to `text` / `text_delta`, `reasoning` to `thinking`, and `toolCall`, `userShell` and `webSearch` to `tool_use` / `tool_result`.
- `subagent` maps to `subagent`, `compaction` to `session_compact`, and `session/tokenUsage` to `usage`.
- Unknown kinds go to `native_status`.
- Admission and attempt evidence follow the Codex session (`prewrite-v1`).

**Tool gate:**
- `session.onApproval` maps to `onToolRequest` at stage `permission`.
- Supervised mode uses `promptUnmatched` with `:ask-me`, chosen explicitly, because "Muse defaults may let an AI reviewer decide approvals" (T3).
- Full access uses `allowAll` with `:unrestricted`.
- There is no pre-use stage, so, as with Codex, the adapter refuses to start a thread that has structural deny or prompt rules (`structuralRulesAtLaunch`).

**Controls:**
- `resume` uses `session/resume` by session id. A missing session raises `NativeBindingMissingError`; its `runtime` union gains `'muse'`.
- `interruptNative` uses `turn/interrupt`, steering uses `turn/steer` (CORE-001), and `fork` uses `session/fork`.
- `readLimits` uses `usage/read`, if it reports plan windows.

**Release:** the version goes out through the config release train (`train --lane=agentic`).

### 2. Foundry

**Runtime and registry:**
- `MuseSessionAdapter` sits beside the Claude and Codex adapters (`providers/session-adapter.ts`).
- Runtime `'muse'` is added to `NativeAuthenticationSource` (native-profile; the default profile is the user's own Muse login).
- `SUBSCRIPTION_WORKERS` gains `muse: 'muse'` (`models/registry.ts`).
- The core registry's `meta` vendor goes from `subscription: { comingSoon: true }` to `{ provider: 'muse' }`.
- Setup and doctor learn `muse --version` and the login check.

**Harness settings:** the #223/#231 `harness` launch argument applies, so a main thread loads the user's own Muse config. The allowlist and guard are decided once the CLI is installed and its config is known (see Unknowns).

**Personal only:**
- A Muse main thread is allowed only where the thread's owner is personal: a project with no Kingdom owner, or one whose owner is a User.
- Archive capture tags it with provider `muse`, so routing (Archive `docs/ROUTING.md`) sends it to the personal Archive.

### 3. Not in this ticket

- **Kingdom pool for Muse.** The login's storage isn't known yet; it follows once `muse` is installed, as a separate ticket.
- **More than one subscription worker at once** (inixiative-da's request, so a Muse or Codex member can sit beside a Claude host). Today `subscription-policy.ts` runs every main thread on one worker; that is the next ticket, FEAT-007.

## Review findings (adversarial review, 2026-11-01), folded into the plan

1. **FEAT-007 comes first.** `resolveSubscriptionPolicy` runs one worker per instance, taken from `defaults.provider`. Kingdom bindings accept only `claude-code` and `codex`, and can't be mixed with local native sources. A Muse worker today would turn every thread into Muse. Worker choice per project (and thread) is the prerequisite.
2. **The SDK facade and the raw connection.** `MuseClient` handles start, resume, turns, approvals and questions. It doesn't do `turn/interrupt`, `turn/steer`, `session/fork` or `session/setApprovalMode`, and it can't carry session `config`, so `sessionMcp` is out of v1. Those calls go through `connection.command`, as T3 does.
3. **Questions.** Muse sends `userInput/request`. These go to Foundry's queue as a question the user answers. A question nobody can answer gets `userInput/cancel` with a reason, so the turn never hangs.
4. **"Personal only" needs data.** Archive's collector reads only Claude and Codex, so Muse is never captured. Add a Muse source (`<museHome>/sessions/*/session.jsonl`) and a hard routing rule: provider `muse` goes to the personal Archive and is never split. That work is in Archive. In Foundry the rule is which projects may use the Muse worker (via FEAT-007); there is no owner check, because there's no owner to read.
5. **Resume and fork.** Approval handlers go on `resumeSession` itself. Re-send `session/setApprovalMode` after every resume and fork, with `requirePermissionProfile: true`, so a silent fall back to Muse's AI judge is caught.
6. **Host death and limits.** Read `sessionDurability`. A dead ephemeral host also seeds from the journal. `turn/retryScheduled` and `usage/changed` map to `rate_limit`. The new runtime is added to agent-session's `TRANSPORTS`, `TransportKind` and `LimitRuntime`.
7. **Billing evidence.** Proof is the `tier` from `usage/read`. Status shows no login signal, and cached models are served while logged out. Extend the existing `withoutCompetingCredentials` with `META_`, `LLM_` and `MODEL_API_KEY`, rather than adding a second stripper. Read Meta's billing page before building (it returned 404).
8. **Structural rules are refused, like Codex.** Muse has a `preToolUse` hook, but it is a vendor hook, and middleware never runs in vendor hooks. Gate allow is approve-once; deny is abort.
9. **First slice: text only.** It is the same `MuseSession`, launched with `muse serve --disable-shell --disable-write` and declared `textOnly`. It covers resume, interrupt, usage and questions. Write mode, steer, fork and `sessionMcp` come later as options on the same class.
10. **Versions.** Compare `muse --version` with the pinned SDK at every launch and refuse a mismatch. Keep the `schema.version === 1` check. The SDK is a developer preview.

## Existing machinery to use

| Concern | Primitive |
|---|---|
| Native session contract | agent-session `HarnessSession`, `SessionAttempt`, `NativeBindingMissingError` (`harness-session.ts`) |
| Process and protocol | `@muse-code/sdk` `MuseClient` (no hand-rolled MSP) |
| Login isolation | `NativeAuthentication` native-profile sources, `withoutCompetingCredentials`, `assertProfile` |
| Tool gate | `turns/tool-gate.ts` via `onToolRequest`; structural rules refused like Codex |
| Thread recovery | `turns/journal-history.ts` seeding on `NativeBindingMissingError` |
| Tests | VCR cassettes (`packages/foundry/src/vcr`), recorded live with `test:live` |
| Reference | T3 `packages/provider-muse` (PR #17082), `docs/user/providers-muse.md` |

## Unknowns, to settle once `muse` is installed

- Which env var or flag moves the Muse home (`initializeResult.museHome`), and where the login lives. This is needed for one directory per integration and for a Kingdom pool.
- Whether Aron's Muse app login carries over to the CLI (`muse` signs in through dev.meta.ai).
- What `usage/read` reports (plan windows or tokens).
- What the user's Muse config holds, and which of it is safe to load.

## Acceptance

- [x] A Foundry thread on the `muse` provider holds a multi-turn conversation on Aron's Muse login. `META_API_KEY` is set in the parent environment and is not used (cassette `muse/serve.two-turns.json`; the launch env carries no `META_API_KEY`; usage moved on the subscription window).
- [x] Resume after a daemon restart continues the native session (binding test). A deleted native session starts fresh from the journal (generic `NativeBindingMissingError` path; not exercised live).
- [x] An approval in supervised mode reaches Foundry's queue (gated launch → `promptUnmatched`/`:ask-me`, gate registered; the approval round trip is agent-session's recorded fixture). Full access runs without asking.
- [x] ~~A Muse thread in a project owned by an organization is refused~~: dropped (Aron 2026-11-01: Muse may run in any project; Archive keeps it personal).
- [x] Every Muse thread Foundry captures into Archive carries `runtime: { provider: 'meta', accessPath: 'subscription' }`. That is what Archive's `alwaysPersonal` gate keys on (Archive #47, inixiative-ec): Muse never reaches an org.
- [ ] Cassettes are recorded live (Muse: done). `bun run check` green in Foundry needs the agentic train to adopt agent-session 0.8.0 (every older cassette re-recorded).
