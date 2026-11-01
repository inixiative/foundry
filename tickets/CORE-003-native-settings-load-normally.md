# CORE-003: Main threads load the harness's own settings, commands and skills

**Status**: 🔨 Built for Claude (#223) and Codex (2026-11-01, Aron: "let's build Codex").
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-11-01
**Updated**: 2026-11-01

---

## Overview

Foundry launches Claude with no settings loaded (`--setting-sources ''`) on its subscription paths:
- `packages/foundry/src/providers/kingdom-subscription-authentication.ts:157` (Kingdom pool);
- `subscription-authentication.ts:72` (the subscription worker).

That turns off the user's commands, skills, hooks, MCP config and permissions, so a Foundry thread doesn't behave like their own Claude. Aron, 2026-11-01: "We shouldn't just turn off all their stuff in all their project settings. It should probably be normally located… or just leave it default on." Earlier the same day: "We should also respect the set commands you've set up on the harness for whatever model you're running."

**Proposal:**
- **Main threads load settings normally** (`user,project,local`), on by default.
- **Foundry stops composing whatever Claude already loads.** When Foundry's composition is on, it composes the CLAUDE.md ladder itself and tells Claude to skip those same files with `claudeMdExcludes`. Claude loads everything else (commands, skills, hooks, MCP, permissions). Foundry adds what Claude can't load: the org level and Warden output.
- **Wardens and other decision sessions stay isolated** (`primed-decisions.ts:268`, `native-launch.ts` isolated launch). The user's hooks must not fire on a Warden call.
- **Commands over ACP:** advertise Foundry's own commands (`/feedback`, `/correction`, `/btw`), which Foundry handles before the turn, alongside the harness's loaded commands and skills, which pass through untouched. Ours win a name clash only where Foundry must own the behaviour (`/btw`, ATTENTION-BOARD §4.5).

**Verified live** (Claude 2.1.316, 2026-11-01, a scratch repo with a CLAUDE.md marker and `.claude/commands/ping.md`):

| Launch | CLAUDE.md seen | `/ping` |
|---|---|---|
| `--setting-sources ''` | no | not available |
| `--setting-sources project` | yes | available |
| `--setting-sources project` + `claudeMdExcludes: [<that CLAUDE.md>]` | **no** | **ran** |

So commands load without CLAUDE.md, and nothing loads twice.

## What the live probes found (Claude 2.1.316, 2026-11-01)

| Concern | Result | What the build does |
|---|---|---|
| CLAUDE.md with settings on | `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` hides it; `/ping` still runs | Keeps the existing switch (`composition.harnessLoading`), not `claudeMdExcludes` |
| `disableAllHooks: true` | Foundry's control-protocol PreToolUse callback still fires | Nothing needed |
| User `permissions.allow` | Skips the runtime's `can_use_tool` ask; the PreToolUse callback still sees and journals the call; a gate deny beats the allow | Nothing needed: the user's own allow is honoured, structural rules hold at pre-use |
| Settings `defaultMode: bypassPermissions` | The launch's `--permission-mode` wins | Nothing needed |
| `apiKeyHelper` / `env.ANTHROPIC_API_KEY` in settings | **Replace the subscription login** ("Invalid API key"), even from an untrusted project | `--settings` blanks them (flag settings outrank user/project/local) |
| `env.ANTHROPIC_BASE_URL` in settings | **Sends the login's token to that endpoint** | Blanked the same way |
| Project hooks in an untrusted folder | **Run** in headless Claude | Project sources load only inside a registered project; `user` elsewhere |

## Problems to settle (as first written)

1. **Pool launches use a private config directory per login** (`CLAUDE_CONFIG_DIR = home`). `user` settings there are the login's empty home, not `~/.claude`, so the user's own commands, skills and agents wouldn't load even with `user` on. The candidates are: link `~/.claude/{commands,skills,agents}` into the login's home, or pass them with `--plugin-dir` / `--add-dir`. The token must stay in memory, so `~/.claude/settings.json` can't be copied blind (it may hold an `apiKeyHelper` or env).
2. **The launch guards refuse settings overrides** (`/^(--settings|--setting-sources|--fallback-model)/` in both files). They exist so a subscription launch can't be redirected to an API key. The new launch must keep that guarantee: no `apiKeyHelper`, `ANTHROPIC_API_KEY` or `env` from loaded settings may override the subscription token.
3. **User hooks run in Foundry threads.** That is what the user expects of their own Claude, and a hook can block a tool call Foundry's gate allowed. That's acceptable, since access follows the host and the user's own setup, but it should be visible in the thread's Context tab.
4. **Loaded permissions could bypass Foundry's gate.** User settings bring `permissions.allow`, `defaultMode` and `disableAllHooks`. Foundry's tool gate is the SDK's `canUseTool` plus a PreToolUse hook (agent-session `src/claude-agent-sdk-session.ts:182`), and an allow rule skips `canUseTool`. The launch must keep the gate and the guard on every tool call, for example with `--settings` that override `disableAllHooks` and drop allow rules that would bypass `canUseTool`. Without that, Wardens' guard and the journal miss calls.
5. **What the excludes cover.** The live test checked one project CLAUDE.md. Check `CLAUDE.local.md`, `@path` imports, `.claude/rules/` and the user-level `~/.claude/CLAUDE.md`.
6. **Codex** has no equivalent switch in our launch today. Check what `CODEX_HOME` per login drops (prompts, `AGENTS.md`, MCP) before claiming parity.

## Existing machinery to use

| Concern | Primitive |
|---|---|
| The CLAUDE.md ladder | the composition view (`composition`, foundry-core's hierarchy composer), "a setting decides whether the harness's own loading of those files is suppressed" (CLAUDE.md, Foundry composes context) |
| Launch arguments | `kingdom-subscription-authentication.ts`, `subscription-authentication.ts`, `native-authentication.ts` (gateway mode already uses `user`) |
| Host MCP forwarding | `native-launch.ts:184` |
| ACP commands | `packages/acp/src/agent.ts:92-104` (`available_commands_update`) |

## Acceptance

- [ ] A pool-launched main thread runs a project command and a user skill. The composed CLAUDE.md content appears once in its context, from Foundry.
- [ ] A Warden call in the same project loads no user hook, command or CLAUDE.md.
- [ ] With a user `permissions.allow` rule and `disableAllHooks: true` in loaded settings, every tool call still reaches Foundry's gate and is journalled.
- [ ] A loaded `apiKeyHelper` or `ANTHROPIC_API_KEY` cannot replace the subscription token; the launch refuses or strips it, with a test.
- [ ] Over ACP, the host's command list shows Foundry's commands plus the loaded native ones, with no duplicate names.

## Related

Oracle `docs/foundry/reference/COMPARISON.md` §0.3 Q4 (resolved 2026-11-01); Oracle ATTENTION-BOARD §4.5 (`/btw`).
