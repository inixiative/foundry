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
| `subscriptionOnly.maxConcurrent` | `8` for Codex, `1` for Claude | Decisions running at once across all threads, each its own process. A Claude decision profile is limited to 1. |
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

- **Profile locks.** The Claude worker takes the exclusive `.foundry-auth-lock` inside its profile while its process runs, giving one Foundry process ownership across checkouts. Codex decision processes share their login instead: each registers `.foundry-auth-shared/<owner>.json` in `~/.codex` for its lifetime, and the last one removes the directory. Shared holders and an exclusive holder refuse each other. Every lock is released when its process exits, including on a clean shutdown, which stops live processes first. Interactive `claude` and `codex` sessions ignore these locks. After a hard crash, remove a lock only after confirming the recorded Foundry owner and its children are dead.
- **User settings.** The Claude worker launches with `--setting-sources ""`, so the user's hooks, permissions and plugins in `~/.claude/settings.json` do not apply to Foundry's worker. Decisions launch Codex with `--ignore-user-config` and `--ignore-rules`; authentication still comes from `~/.codex`.
- **History.** Codex decisions use `--ephemeral`, so they add no sessions to the user's Codex history or resume picker.
- **Credentials.** Child environments drop API keys and competing profile overrides (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_*` credentials, inherited `CLAUDE_CONFIG_DIR` and `CODEX_HOME`). Nothing is copied or moved.

## Codex decisions

Each decision is one `codex exec --json --ephemeral` turn in a private empty directory with a read-only sandbox, `approval_policy="never"`, web search disabled and tool features (shell, unified exec, apps, plugins, browser and computer use, image generation, memories, multi-agent, hooks and similar) disabled. The prompt travels on stdin, never argv. `codex login status` must report `Logged in using ChatGPT` before each call; an API-key login is refused. Any JSON event other than thread/turn lifecycle, reasoning and agent-message items (a command, file change, tool call, web search or error item) fails the decision, and a failed or unknown exit closes further decision admission. Receipts record ownership, model and settlement evidence without prompt or answer text.

Codex exec does not report which model served the turn. The requested model is enforced at launch with `--model` and user configuration ignored; there is no observed-model acknowledgement as there is for Claude.

## Scheduling

One process-wide scheduler serves every thread's decisions, with up to `maxConcurrent` processes at once:

- **Priority.** Calls carry `CompletionOpts.priority`: pre-message decisions (classifier, router, Cartographer, expert advice) run before post-action guards, which run before learning review. Guards may hold at most three quarters of the slots and reviews at most half, so a turn waiting to start always finds capacity.
- **Fairness.** Within a priority, the thread served longest ago goes next, so one busy thread cannot starve another.
- **Shedding.** A full queue (per thread, then global) sheds its oldest lowest-priority wait to admit a more urgent call; only a call that cannot displace anything is refused. Shed guards report as unchecked, never as all-clear.
- **Rate limits.** A Codex usage or rate limit fails that decision without retry, pauses new starts with exponential backoff (5 s to 60 s) and is logged and pushed to the viewer's event stream. It does not close admission.
- **Failures.** A refusal before any native launch (expired deadline, revoked preflight) leaves nothing owned and does not close admission. Unknown exit or an unproven native result still closes further admission.

The flow already fires domain assessments concurrently (up to `maxAdviseParallel`, default 5) alongside routing, each with its own 10 s deadline; a late answer is recorded as a timeout and not used. Advice is composed in configured order once every participant has answered or timed out.

## Ownership and bounds

Decisions are bounded per call and per process. Guards retain their existing post-action semantics. The deadline includes queue and preflight time; cleanup has its own bounded wait. Revocation closes waiting admission, rejects an active result and leaves its process owned until cleanup or deadline. Unknown exit closes further admission rather than treating a kill request as released capacity. A worker authentication check with unknown exit likewise blocks further checks for that authentication instance.

Logical thread/generation/dispatch/review-job ownership is preserved while physical native session identities remain private. Inspection and release require the exact owner and admission ID. Learning cannot inspect accepted answer content until model, tool, ownership, receipt and process-release checks pass.

A Claude decision profile uses the bounded native text provider instead: one turn, tools disabled, strict empty MCP configuration, explicit model acknowledgement and confirmed status and process exit.

## Integration limits

Local profile references are not Kingdom capacity grants. A project execution contract must independently authorize worker and decision roles, purposes, model identities, aggregate budgets, deadlines and generation revocation. Startup makes no model calls unless `FOUNDRY_STARTUP_SELF_TEST=1` is set; in subscription mode that self-test consumes a decision allowance.

## Validation

Run `bun run test` and `bun run typecheck`. Focused tests are `packages/foundry/tests/subscription-default.test.ts`, `subscription-policy.test.ts` and `subscription-decisions.test.ts`; they use controlled child processes and a temporary `HOME`. The startup tests deny external requests and set synthetic API keys to verify they are never used.
