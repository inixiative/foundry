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
composes them for the thread's location (its cwd, worktree or project, and the
project's Kingdom owner) on each warm. What it reads is a **registered
hierarchy**: a ladder or tree of nodes, each a level (`computer`, `org`,
`project`, or any other name), shared or personal, with its files and corpus
tier. Core's `discoverHierarchy` / `dedupeHierarchy`
(`adapters/markdown-hierarchy.ts`) are the generic composer; Foundry's presets,
settings and prompt format are `prompts/instruction-settings.ts` and
`prompts/instruction-stack.ts`. `@path` imports are resolved by core's
`readInstructionFile`, which `claudemdSource` also uses.

### The default ladder

With nothing configured, the ladder is the `claude-code` preset: Claude Code's
own discovery, unchanged.

| Node | Files | Tier |
|---|---|---|
| managed | `/Library/Application Support/ClaudeCode/CLAUDE.md` (`/etc/claude-code/` on Linux) | org |
| global | Claude: `~/.claude/CLAUDE.md` and path-free `~/.claude/rules/**`. Codex: `$CODEX_HOME/AGENTS.override.md`, else `AGENTS.md`. Also the home directory's own `CLAUDE.md` / `AGENTS.md` | personal_private |
| org | the files below, in directories above the repository (e.g. `~/code/inixiative/CLAUDE.md`) | org |
| project | per directory from the repository root to the cwd: `CLAUDE.md`, `.claude/CLAUDE.md`, path-free `.claude/rules/**`, `AGENTS.md`, `.claude/AGENTS.md` | team |
| local | `CLAUDE.local.md` in any of those directories | personal_private |
| memory | `~/.claude/projects/<repo>/memory/MEMORY.md`, first 200 lines or 25KB | personal_private |

The order matches what Claude Code 2.1.296 loads (checked live): managed, global,
then the root-to-cwd walk, then auto memory, each file followed by its imports.
A worktree's main checkout counts as the same repository, and auto memory is
keyed by it. The home directory's own files are personal (global level), and its
`.claude` is read only as the running harness's global level.

### Registering levels

`instructions.nodes` registers more nodes, merged over the preset by id (a
preset id replaces that node; `enabled: false` removes it; `preset: "none"`
starts empty). Example: computer personal, the inixiative org and its personal
file, a project and its personal file.

```json
"instructions": {
  "nodes": {
    "inixiative": {
      "scope": "org", "personal": false,
      "when": { "paths": ["~/code/inixiative"] },
      "sources": [{ "path": "{anchor}/docs/org/*.md" }]
    },
    "inixiative-personal": {
      "scope": "org", "personal": true, "parent": "inixiative",
      "sources": [{ "path": "~/.foundry/instructions/inixiative.md" }]
    },
    "foundry": {
      "scope": "project", "personal": false, "parent": "inixiative",
      "when": { "projects": ["foundry"] }, "anchor": "{projectPath}",
      "sources": [{ "path": "docs/claude/*.md" }]
    },
    "foundry-personal": {
      "scope": "project", "personal": true, "parent": "foundry",
      "sources": [{ "path": "~/.foundry/instructions/foundry.md" }]
    }
  }
}
```

The preset's `global` node is the computer-personal level, and its `org`,
`project` and `local` nodes still read every `CLAUDE.md` / `CLAUDE.local.md` on
the walk. A node's fields:

- `scope`, `personal`; `tier` defaults to personal_private when personal, team
  for a shared project node, org otherwise. A personal node's tier is always
  personal.
- `when`: applies when the cwd is inside one of `paths`, the thread's project is
  one of `projects`, the project's Kingdom owner key (`defaults.kingdomOwnerKey`,
  per project or global) is one of `owners`, and the harness is one of
  `harness`; every key listed must hold. `parent`: a child applies only where its
  parent applies.
- `sources`: `{ "path": ... }` is a file, a glob (expanded in path order) or a
  list whose first existing file loads; `{ "walk": [...], "span": {...} }` looks
  the files up in each directory from the filesystem root to the cwd, limited by
  `span` (`within`, `outside`, `only`, `except`). `rules: true` is rule-file
  handling (frontmatter stripped, `paths:` rules skipped); `raw` reads a file
  as is (no comment stripping, no imports) and `maxLines` / `maxBytes` cut a raw
  file. Glob characters count only in the configured pattern, never in a
  directory a variable names (`app/[slug]` is literal).
- Paths take `~/` and variables: `{home}`, `{cwd}`, `{project}` (the working
  tree root), `{repository}` (the main checkout), `{projectId}`, `{projectPath}`
  (the configured project), `{claudeConfigDir}`, `{codexHome}`, `{managed}`,
  `{claudeProjectKey}`, `{anchor}`, and `{dir}` inside a walk. A path naming an
  absent variable is skipped, a span exclusion (`outside`, `except`) naming one
  leaves the walk empty, and an `anchor` naming one keeps the node out: unknown
  places fail closed. Relative paths resolve against the anchor.
- `anchor`: the directory the node is about, which places it in the order.
  Default: the matched `when.paths` entry, else the parent's anchor; none means
  computer level.
- `imports` (`"anywhere"` or a list of roots, `{dir}` for the importing file's
  directory; default the repository or the file's own directory) and `owns`
  (`names`, `within`, `dirs`: paths that keep this node's tier when another
  file imports them).

**Order.** Computer-level nodes first, then each directory from the filesystem
root down to the cwd (a node sits at its anchor; walk files at their
directory); at one place, shared nodes before personal ones, each in ladder
order (a depth-first walk of the tree, preset first); within a node, its sources
in order. So: computer personal, org, org personal, project, project personal.

### Tiers and dedupe

Each file keeps the narrower of its node's tier and the tier of any node that
owns its path, whether a node found it or a file imported it (a
`CLAUDE.local.md` imported by `CLAUDE.md`, or matched by a shared node's glob,
stays personal). A configured path, like an import, never reads a dotfile, key
or credential file, judged on where its symlinks lead. The source's
`audience` (default `personal_private`) filters by tier through the corpus
`VISIBLE_TO` rules, so personal files never reach a `team` or `org` audience.

Then repeats are removed, keeping the most specific copy (the later one in the
order). Dedupe runs after the audience filter, so a personal copy never hides
the shared one from a team.

- **Same file** (real path): a second reach, a symlink, a file imported twice.
  It loads once, where first reached, as Claude Code does. A later reach that
  would give it a wider tier widens it, so a shared file imported first by a
  personal one still reaches the team (its own imports keep their tiers).
- **Identical content** (the same normalization, hashed): e.g. a worktree's
  `CLAUDE.md` and its main checkout's. The worktree's copy is kept.
- **Identical sections**: the same heading path (enclosing headings, not the
  document's lone title), heading and body with its subsections. Blank lines
  and spacing inside a line do not count; indentation does. Headings in code
  fences and frontmatter are not sections. The section is cut from the more
  general file, nothing else in it changes, and a file left empty is dropped.

`instructions.dedupe` (`content`, `sections`, both default true) turns the last
two off. Every removal is reported with the copy kept in its place: the layer's
**Selection** panel in the viewer lists the composed files, the files hidden from
the audience, and each duplicate with where it was kept.

Imports follow Claude Code: `@path` at a line start or after whitespace, relative
to the importing file, `~/` for home, absolute paths allowed, `\ ` for a space,
four hops at most, not inside code spans or fenced blocks, text files only.
Block-level HTML comments are stripped. Claude Code asks once before loading a
project file's import from outside the project. Foundry has no dialog, so a
project, org or local file imports only inside the repository or its own
directory tree, checked on the symlink target too; managed and global files
(`imports: "anywhere"`) import from anywhere, and a registered node sets its own
`imports`. Dotfiles (`.env`), key files and credential directories (`.ssh`,
`.aws`, ...) never import, unlike Claude Code, and a node's configured paths
never read them either. `claudemdSource` (a `markdown`
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
