# Usage telemetry and native context budgets

Foundry preserves Claude's cache telemetry rather than reducing usage to input
and output. The parser lives in `@inixiative/agent-session`
([agent-session PR #4](https://github.com/inixiative/agent-session/pull/4)); Foundry
consumes the published package (`^0.2.0`), pinned to an exact tarball integrity by
the committed `bun.lock`.

## Counters and tags

- `input` excludes Claude's disjoint cache input counters; `output` includes thinking.
- `cacheRead` and `cacheWrite` count reused and newly cached input tokens.
- `cacheWrite5m` / `cacheWrite1h` are subsets of `cacheWrite`.
- `thinking` is a subset of `output`.
- `providerUsage` retains the original usage object, including service tier,
  nested details and unrecognized future tags. It stays on individual records;
  totals aggregate only numeric counters.

Optional counters remain absent when unreported. Old analytics records therefore
show an em dash, not a fabricated cache miss. Total tokens and cumulative token
budgets include `input + output + cacheRead + cacheWrite`; do not add TTL or
thinking breakdowns again. Cost estimates still use the configured input/output
price table and do not account for cache-write premiums or subscription quota.
Use the preserved counters to audit usage; estimated dollars are not an account
usage-limit measurement.

Native result events are whole-turn aggregates. Request `usage` events preserve
message/request IDs, model and tags in their raw envelope, including incomplete
turns. Snapshots can repeat across content blocks: do not sum them with terminal
result totals. Interrupted-turn request evidence is retained, but completed-turn
session totals do not invent missing final usage.

The analytics call log shows cache reads and writes separately from Foundry's
response-cache flag. Hover cache writes for the TTL breakdown and cache reads
for the original usage tags. JSONL appends are serialized so concurrent calls
cannot overwrite each other; a call that crosses a token budget is still saved.

## Native compaction

`ClaudeCodeSessionAdapter` defaults to:

```ts
contextBudget: { maxTokens: 200_000, compactAt: 0.8 }
```

This sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` and
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80` for the child process, including resumed and
forked sessions. Existing native `session_compact` events continue to invalidate
the hydration ledger. Foundry does not send extra model calls or run a separate
summarization loop.

Configure the `providers["claude-code"].contextBudget` field in
`.foundry/settings.json`, or pass it directly to either constructor. `false`
explicitly delegates the policy to the CLI's inherited environment/settings.
An enabled policy overrides inherited compaction-disabling environment flags.
The window must be an integer from 100k to 1M; `compactAt` must be at least 0.01
and below 1 to leave headroom. Restart existing sessions to apply a policy change.

Claude's documented controls set an **auto-compaction target**, not a hard
per-request admission ceiling. At the default, compaction is requested around
160k; large tool responses may overshoot and native runtime/model behavior can
compact earlier. The model's full window still determines the CLI status-line
percentage. Use a current Claude Code version supporting these controls; custom
spawners must pass through the supplied environment.
See [Claude Code environment variables](https://code.claude.com/docs/en/env-vars).

This policy is independent of Foundry's per-layer context caches and its
cumulative token/spend budgets. Compaction can cause a new cache prefix to be
written; the telemetry makes that cost visible rather than promising to eliminate
cache writes.

## Standing instructions

Foundry composes a session's instruction files itself, for any harness: an
`instructions` source (type `instructions`, on the default `instructions` layer)
discovers them for the thread's cwd (its worktree or project) on each warm. The
code is `prompts/instruction-stack.ts`; `@path` imports are resolved by core's
`readInstructionFile`, which `claudemdSource` also uses.

| Level | Files | Tier |
|---|---|---|
| managed | `/Library/Application Support/ClaudeCode/CLAUDE.md` (`/etc/claude-code/` on Linux) | org |
| global | Claude: `~/.claude/CLAUDE.md` and path-free `~/.claude/rules/**`. Codex: `$CODEX_HOME/AGENTS.override.md`, else `AGENTS.md` | personal_private |
| org | the files below, in directories above the repository (e.g. `~/code/inixiative/CLAUDE.md`) | org |
| project | per directory from the repository root to the cwd: `CLAUDE.md`, `.claude/CLAUDE.md`, path-free `.claude/rules/**`, `AGENTS.md`, `.claude/AGENTS.md` | team |
| local | `CLAUDE.local.md` in any of those directories | personal_private |
| memory | `~/.claude/projects/<repo>/memory/MEMORY.md`, first 200 lines or 25KB | personal_private |

The order matches what Claude Code 2.1.296 loads (checked live): managed, global,
then the root-to-cwd walk, then auto memory, each file followed by its imports.
A worktree's main checkout counts as the same repository, and auto memory is
keyed by it. The home directory's own files are personal (global level), and its
`.claude` is read only as the running harness's global level. Each file loads
once however it is reached, and an import keeps the narrower of its importer's
tier and its own location's (a `CLAUDE.local.md` imported by `CLAUDE.md` stays
personal). The source's `audience` (default `personal_private`) filters by tier
through the corpus `VISIBLE_TO` rules, so personal files never reach a `team` or
`org` audience.

Imports follow Claude Code: `@path` at a line start or after whitespace, relative
to the importing file, `~/` for home, absolute paths allowed, `\ ` for a space,
four hops at most, not inside code spans or fenced blocks, text files only.
Block-level HTML comments are stripped. Claude Code asks once before loading a
project file's import from outside the project. Foundry has no dialog, so a
project, org or local file imports only inside the repository or its own
directory tree, checked on the symlink target too; global files import from
anywhere. Dotfiles (`.env`), key files and credential directories (`.ssh`,
`.aws`, ...) never import, unlike Claude Code. `claudemdSource` (a `markdown`
source naming one file) imports only within that file's directory.

Not composed: subdirectory files and path-scoped rules, which Claude Code loads
on demand as it touches files.

**One injection path.** `instructions.harnessLoading` decides whether the
harness loads these files too. Absent, it is `suppress` when every view (global
and each enabled project) has an enabled layer reading an enabled `instructions`
source, and `load` otherwise, so no thread is left with neither. It applies on
restart.

- Claude Code: `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` on the worker. It drops every
  CLAUDE.md, rule, AGENTS.md and auto memory file, at launch and on demand.
  `--setting-sources ''` (the subscription worker's isolation) already drops the
  CLAUDE.md files but not auto memory, so `load` on that worker keeps only memory.
- Codex app-server: thread config `project_doc_max_bytes: 0` drops project
  AGENTS.md files. `$CODEX_HOME/AGENTS.md` is not a thread setting. Subscription
  and native-profile workers run on a Foundry-private CODEX_HOME without one, so
  Foundry composes the user's file; a worker on the user's own CODEX_HOME reads
  it natively, so Foundry leaves that level out. The legacy MCP engine takes no
  thread config, so suppression does not reach it.
- The off switch is kept through every authentication launch (subscription,
  gateway, Kingdom), which otherwise clear `CLAUDE_CODE_*` variables.

A settings file that still lists CLAUDE.md as a `markdown` source next to an
`instructions` source injects that file twice. Remove the `markdown` source.
