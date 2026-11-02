# FEAT-006: Muse Code worker: Aron's Muse subscription in Foundry threads

**Status**: 📝 Design, reviewed 2026-11-01 (findings below). Not built. Blocked on FEAT-007 and on `muse` being installed and signed in.
**Assignee**: inixiative-b9 (handed over by inixiative-da, 2026-11-01)
**Priority**: High (Aron asked for it, 2026-11-01)
**Created**: 2026-11-01

---

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

- [ ] A Foundry thread on the `muse` provider holds a multi-turn conversation on Aron's Muse login. `META_API_KEY` is set in the parent environment and is not used, as recorded in the transcript's billing or usage.
- [ ] Resume after a daemon restart continues the native session. A deleted native session starts fresh from the journal.
- [ ] An approval in supervised mode reaches Foundry's queue. Full access runs without asking.
- [ ] A Muse thread in a project owned by an organization is refused, with the reason.
- [ ] Every Muse thread Foundry captures into Archive carries `runtime: { provider: 'meta', accessPath: 'subscription' }`. That is what Archive's `alwaysPersonal` gate keys on (Archive #47, inixiative-ec): Muse never reaches an org.
- [ ] Cassettes are recorded live. `bun run check` is green in agent-session and Foundry.
