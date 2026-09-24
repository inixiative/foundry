# Subscription-only Foundry

Foundry runs subscription-only by default. A fresh install, with no settings at all, runs the Claude Code worker and Foundry's decisions from the logins already on the machine:

- **Worker:** Claude Code, using the default Claude login (`~/.claude`, selected by leaving `CLAUDE_CONFIG_DIR` unset).
- **Decisions:** GPT-6 Luna through the Codex CLI's ChatGPT login (`~/.codex`). Classifiers, routers, the Cartographer, the Librarian, Wardens (advise, guard and review) and configured experts all use this decision profile.

No API provider is constructed in this mode. There is no paid fallback, no automatic retry and no model substitution. API-key providers need an explicit opt-in.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `apiTokens` | absent (`false`) | `true` opts in to API-key providers (Anthropic, OpenAI, Gemini, gateways, Kastle bindings) and the OpenAI/Luna API decision provider, which requires `OPENAI_API_KEY`. It cannot be combined with `subscriptionOnly`. |
| `defaults.provider` | `claude-code` | The subscription worker must be `claude-code`. Any other worker requires `apiTokens: true`. |
| `defaults.nativeAuthenticationId` | absent: `~/.claude` | Optional explicit Claude `native-profile` source for the worker. |
| `defaults.classifierProvider` / `classifierModel` | `subscription-decisions` / `gpt-6-luna` | New configurations record the decision profile here. With a Codex decision profile, `classifierModel` selects its model. |
| `subscriptionOnly.decisionSourceId` | absent: `~/.codex` | Optional explicit `native-profile` source for decisions: Codex, or a *separate* Claude profile. |
| `subscriptionOnly.model` | `gpt-6-luna` for Codex | Decision model. Required for a Claude decision profile. |
| `subscriptionOnly.expectedObservedModel` | the requested model | Claude decision profiles only. Codex exec does not acknowledge an observed model. |
| `subscriptionOnly.directory` | `<project>/.foundry/decision-receipts` | Private (0700) receipt directory. The default is created at startup; an explicit directory must already exist and be private. |
| `subscriptionOnly.maxCalls` | `10000` | Finite decision attempt budget for this Foundry process, including failed admitted attempts. It does not renew automatically. |
| `subscriptionOnly.maxConcurrent` | `8` for Codex, `1` for Claude | Decisions running at once across all threads: concurrent turns on the one warm Codex process, or processes for a Claude profile (limited to 1). |
| `subscriptionOnly.maxQueued` | `256` | Waiting decisions across all threads (up to 1024). |
| `subscriptionOnly.maxQueuedPerThread` | `32` | Waiting decisions per logical thread. |
| `subscriptionOnly.callTimeoutMs` | `30000` | Per-decision deadline including queue and preflight time (100 to 30000). |

Explicit profile sources are credential references in `nativeAuthentication`, never tokens:

```json
{
  "nativeAuthentication": [
    { "id": "22222222-2222-4222-8222-222222222222", "connectionId": "44444444-4444-4444-8444-444444444444",
      "runtime": "codex", "mode": "native-profile", "profileDirectory": "/private/path/decisions" }
  ],
  "subscriptionOnly": { "decisionSourceId": "22222222-2222-4222-8222-222222222222" }
}
```

An explicit profile directory must be an owned private (0700) directory with private files. The default login locations are referenced in place: they must be owned, real directories whose credential files (`auth.json`, `.credentials.json`) are private, but Foundry does not require or change their mode. Worker and decision profiles must resolve to different directories; a Claude worker with Codex decisions satisfies this. Profile directories, gateways, Kastle bindings and per-thread authentication selections cannot be mixed into subscription mode.

## Existing settings

Subscription mode runs every enabled non-executor agent on the decision profile. An agent saved with another provider or model (for example a classifier on `gemini` or a Librarian on `claude-code`) is routed to `subscription-decisions` at startup; the startup log lists each routed agent. The saved settings file is not rewritten. Settings that cannot be enforced are refused rather than routed: a non-Claude worker, an executor on another provider or model, decision agents with tools, thinking, cache or non-zero temperature overrides, and `learning.review` provider/model overrides.

## Sharing the user's own logins

Foundry adds processes to the logins the user already uses interactively, like another terminal session would. It does not change their files or settings:

- **Profile locks.** The Claude worker takes the exclusive `.foundry-auth-lock` inside its profile while its process runs, giving one Foundry process ownership across checkouts. The warm Codex decision process shares the login instead: it registers `.foundry-auth-shared/<owner>.json` in `~/.codex` for its lifetime, and the last holder removes the directory. Shared holders and an exclusive holder refuse each other. Every lock is released when its process exits, including on a clean shutdown, which stops live processes first. Interactive `claude` and `codex` sessions ignore these locks. After a hard crash, remove a lock only after confirming the recorded Foundry owner and its children are dead.
- **User settings.** The Claude worker launches with `--setting-sources ""`, so the user's hooks, permissions and plugins in `~/.claude/settings.json` do not apply to Foundry's worker. The decision app-server disables tool, plugin and app features at launch, and each decision thread overrides the user's notify hook, MCP servers, project docs, skills and tool/environment instructions; authentication still comes from `~/.codex`.
- **History.** Each role's primed thread is persisted while it lives (Codex can only fork persisted threads) under a private working directory, and deleted when the role is evicted or Foundry shuts down; threads a crashed Foundry left there are deleted at the next start. Decision forks are ephemeral and add nothing to the user's Codex history.
- **Credentials.** Child environments drop API keys and competing profile overrides (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_*` credentials, inherited `CLAUDE_CONFIG_DIR` and `CODEX_HOME`). Nothing is copied or moved.

## Codex decisions

Decisions run on one warm `codex app-server` process per decision profile, through agent-session's `CodexPrimedSessions`. Every middleware role keeps its own live, primed session on that process: the Cartographer, each classifier and router, and each domain's advice, guard and review. A role is keyed by its auxiliary session id (`<thread>:aux:<role>`) plus a hash of its instructions, so a domain's advice and guard stay separate.

- **Prime once.** A role's session is a thread started with the role instructions as developer instructions and Foundry's decision base (no tools, task data is not authorization) as base instructions, plus one primer turn carrying the stable context: the domain cache, or the topology map and atlas. Agents declare that context with `CompletionOpts.stablePrefix`; the messages sent to API providers are unchanged.
- **Reset per cycle.** Each decision forks the primed thread (ephemeral, through the primer turn, same instructions) and sends only the per-cycle part: thread state, the message or tool observation and the response protocol. The primed thread never receives a decision, so one cycle never sees another's turns. The fork shares the primed prefix, which the provider can serve from its prompt cache.
- **Re-prime** only when the stable context or instructions change, after idle eviction (30 min), or after the process is lost. Those are the only cold paths.

The process launches with `approval_policy="never"`, web search disabled and tool features (shell, unified exec, apps, plugins, browser and computer use, image generation, memories, multi-agent, hooks and similar) disabled; threads run in a read-only sandbox in a private empty directory, with MCP servers, the notify hook, project docs, skills and tool/environment instructions disabled per thread. The account must be a ChatGPT login (`account/read`) before any decision; an API-key login is refused. Any non-text item, MCP server start or runtime request on a decision thread is a violation: the turn is interrupted, the process recycled and further admission closed. The app-server reports the model serving each session, and a substituted model is refused. Receipts (`decisions.jsonl` beside `host.json`) record ownership, model, priming and settlement evidence without prompt or answer text.

A Claude decision profile keeps the bounded one-turn text provider.

## Scheduling

One process-wide scheduler serves every thread's decisions, with up to `maxConcurrent` processes at once:

- **Priority.** Calls carry `CompletionOpts.priority`: pre-message decisions (classifier, router, Cartographer, expert advice) run before post-action guards, which run before learning review. Guards may hold at most three quarters of the slots and reviews at most half, so a turn waiting to start always finds capacity.
- **Fairness.** Within a priority, the thread served longest ago goes next, so one busy thread cannot starve another.
- **Shedding.** A full queue (per thread, then global) sheds its oldest lowest-priority wait to admit a more urgent call; only a call that cannot displace anything is refused. Shed guards report as unchecked, never as all-clear.
- **Rate limits.** A Codex usage or rate limit fails that decision without retry, pauses new starts with exponential backoff (5 s to 60 s) and is logged and pushed to the viewer's event stream. It does not close admission. While the account reports usage blocked, the warm host refuses decisions before sending anything and re-reads limits at most once a minute.
- **Failures.** A refusal before any native write (expired deadline, revoked preflight or registration) leaves nothing owned and does not close admission. A turn the runtime settled (a native failure, or a deadline whose interrupt was acknowledged or whose process exit was observed) leaves nothing owned either and does not close admission. A violation, a substituted model or an unproven result still closes further admission.

The flow already fires domain assessments concurrently (up to `maxAdviseParallel`, default 5) alongside routing, each with its own 10 s deadline; a late answer is recorded as a timeout and not used. Advice is composed in configured order once every participant has answered or timed out.

## Ownership and bounds

Decisions are bounded per call and per process. Guards retain their existing post-action semantics. The deadline includes queue, preflight and priming time; cleanup has its own bounded wait. Revocation or shutdown closes waiting admission and cancels active decisions: refused before dispatch, or interrupted with the interrupt's acknowledgment (or the process exit) as settlement. A worker authentication check with unknown exit likewise blocks further checks for that authentication instance.

Logical thread/generation/dispatch/review-job ownership is preserved while physical native session identities remain private. Inspection and release require the exact owner and admission ID. Learning cannot inspect accepted answer content until model, tool, ownership, receipt and process-release checks pass.

A Claude decision profile uses the bounded native text provider instead: one turn, tools disabled, strict empty MCP configuration, explicit model acknowledgement and confirmed status and process exit.

## Integration limits

Local profile references are not Kingdom capacity grants. A project execution contract must independently authorize worker and decision roles, purposes, model identities, aggregate budgets, deadlines and generation revocation. Startup makes no model calls unless `FOUNDRY_STARTUP_SELF_TEST=1` is set; in subscription mode that self-test consumes a decision allowance.

## Validation

Run `bun run test` and `bun run typecheck`. Focused tests are `packages/foundry/tests/subscription-default.test.ts`, `subscription-scheduling.test.ts`, `primed-decisions.test.ts`, `subscription-policy.test.ts` and `subscription-decisions.test.ts`; they use a controlled app-server double and a temporary `HOME`. The startup tests deny external requests and set synthetic API keys to verify they are never used.
