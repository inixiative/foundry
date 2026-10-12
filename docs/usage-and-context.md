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

`composition.nodes` registers more nodes, merged over the preset by id (a
preset id replaces that node; `enabled: false` removes it; `preset: "none"`
starts empty). Example: computer personal, the inixiative org and its personal
file, a project and its personal file.

```json
"composition": {
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
owns its path (as spelled or where its symlinks lead), whether a node found it
or a file imported it (a
`CLAUDE.local.md` imported by `CLAUDE.md`, or matched by a shared node's glob,
stays personal). A configured path or a walked file, like an import, never reads
a dotfile, key or credential file, judged on where its symlinks lead, and a
walked file is held to its node's import boundary on where it resolves: a
committed `CLAUDE.md` symlinked out of the repository is refused (one pointing
inside it, like Kingdom's `CLAUDE.md -> AI/ENTRYPOINT.md`, loads). A personal
node's file (`CLAUDE.local.md` pointing at private notes) may point anywhere: it
reaches no shared audience. Refused files are listed in the Selection panel.
A repository inside a credential directory (`~/.config/nvim`) has its
instruction files refused too. The role's
`composition.roles.<role>.audience` (default `personal_private`) filters by tier through the corpus
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
- **Identical sections**: the same heading path (every enclosing heading,
  the document title included, so `Testing > Rules` never matches
  `Deploy > Rules`), heading and body with its subsections. Blank lines
  and spacing inside a line do not count; indentation does. Headings in code
  fences and frontmatter are not sections. The section is cut from the more
  general file, nothing else in it changes, and a file left empty is dropped.

`composition.dedupe` (`content`, `sections`, both default true; per role `composition.roles.<role>.dedupe`) turns the last
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
`.aws`, `.config`, `.local`, `.git`, ...) never import, unlike Claude Code, and a
node's configured or walked files never read them either. The harness homes
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, as written and where their symlinks lead)
are judged only below themselves, so one under `~/.config` still loads. `claudemdSource` (a `markdown`
source naming one file) imports only within that file's directory.

Not composed: subdirectory files and path-scoped rules, which Claude Code loads
on demand as it touches files.

**One injection path.** `composition.harnessLoading` decides whether the
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

## Composition view

Aron, 2026-10-12: "It's the same composition where you have five or six
different things and they should all be at each level... Each of these
compositions is, by default, all on but you should be able to opt out of
certain things that really need to be separated. That view needs to be
formalized because that's how the whole system is working."

**The model: roles × slots × ladder nodes.** One ladder (the nodes above:
computer, org, org personal, project, project personal) composes every slot of
every role.

- **Roles.** `main` is the thread's executor. Every model-backed middleware
  role is its agent id: each Warden (`flowRole: "domain-advising"`) and the
  Cartographer (its agent id, or `cartographer`). The Librarian makes no model
  call and has nothing to compose. Classifier and router agents still use their
  settings prompt and visible layers.
- **Slots.** `instructions` is the system prompt. `domainKnowledge` is the
  context the role primes with. Thread knowledge is not a slot: each Warden
  computes it per call, from its own review history.
- **Nodes.** A node and each of its sources may name `when.roles` and
  `when.slots`, and paths take `{role}` and `{slot}`. A source that names no
  slot (on itself, its walk or its node), such as CLAUDE.md, composes the
  `instructions` slot. A source that names no role serves every role. The
  `claude-code` preset adds a role file at every rung, for every role and
  both slots:

| Rung | Role file | Tier |
|---|---|---|
| computer | `~/.foundry/roles/<role>/<slot>.md` | personal_private |
| org | `.foundry/roles/<role>/<slot>.md` in a directory above the repository | org |
| project | `.foundry/roles/<role>/<slot>.md` in the repository, root to cwd | team |
| org or project personal | `.foundry/roles/<role>/<slot>.local.md` in any of those directories | personal_private |

  So "the org's Warden instructions for this project" is a file, for example
  `~/code/inixiative/.foundry/roles/librarian-convention/instructions.md`.
  A registered node with `"when": {"roles": [...], "slots": [...]}` can
  read from anywhere else.

**What a role reads.** Each slot is the role's settings part, then its ladder
part:

| Slot | Settings part | Ladder part |
|---|---|---|
| instructions | the agent's `prompt` (a project `extends` entry appends its own under a heading, or `override`s it) | every file that applies, CLAUDE.md included |
| domainKnowledge | each source in the agent's `domainKnowledge` (source ids, any type; a project extension appends, or `override`s), under the source's label | the role's slotted files, plus the general files of any node the role names in `general` |

The main thread's `instructions` source (type `instructions`; `slot` picks the
slot, default `instructions`) is the `main` role's ladder part. Its own agent
prompt stays the executor's `agent` part.

**Selection.** Everything that applies is on. `composition.roles.<role>` opts
out, per slot:

```jsonc
"composition": {
  "roles": {
    "<role>": {
      "instructions": { "exclude": ["<node id>"], "general": "all" },  // or false: no ladder part
      "domainKnowledge": { "general": ["<node id>"], "exclude": ["<node id>"] },
      "audience": "personal_private",                     // who the composition is for
      "dedupe": { "content": true, "sections": true },    // overrides composition.dedupe
      "budget": 80000                                     // characters, instructions + domain knowledge
    }
  }
}
```

`exclude` leaves a node out of that slot whole, its role files included.
`general` names the nodes whose general files (unslotted: CLAUDE.md, AGENTS.md,
rules, auto memory) compose into the slot. The default is `"all"` for
instructions and none for domain knowledge, and role files compose either way.
So a narrow Warden sets `"instructions": {"general": ["global"]}`: it keeps its
role files at every rung and reads only the personal global CLAUDE.md, not the
whole org and project stack. The Convention Warden sets `"domainKnowledge":
{"general": ["org", "project"]}`, so the org and project CLAUDE.md are its
domain knowledge.

**Tiers, per role.** A file reaches a role only if its tier is visible to the
role's `audience`, in both slots, whether it was found, imported or opted in.
So a personal node never reaches a `team` or `org` audience. A middleware
role's output reaches the main thread (a Warden chiming in), so a role's
audience is never wider in what it reads than `main`'s. If main is `team`,
every role is at least `team`. Instruction files reach a Warden only through
its own role: a Warden's `domainKnowledge` sources may not be `instructions`
sources (use `general`). They must also be enabled. Role files under
`~/.foundry` belong to the personal computer node wherever a symlink places
them.

**Dedupe, per role.** After the audience filter, the slots the role receives
dedupe together in slot order (instructions, then domain knowledge), keeping
the later copy. A file a role pulls into domain knowledge therefore leaves its
instructions: a role never reads the same text twice. Every removal is
reported, with `duplicateOf` naming the slot that kept it. A slot the role does
not receive is not composed, so dedupe never moves text into it:

- the Cartographer receives instructions only, since its domain knowledge is
  the map it builds;
- the main thread receives the slots its enabled `instructions` sources name.

**Budgets, per role.** `budget` bounds instructions plus domain knowledge, in
characters. The default is none for `main` and 80,000 for middleware roles. A
decision call refuses more than 100,000 serialized characters
(`DECISION_INPUT_CAP`), so the default leaves room for thread knowledge,
thread state and the turn, and an overflow is reported as this budget's named
error. Aron's stacks compose to 30,000–56,000 characters per role. Over budget, the phase does
not run and nothing is truncated:

- advice reports `error`;
- guard reports `not-admitted`;
- review records `error` instead of being admitted, and the review lane stays open;
- routing reports `error`.

The message names the role, the sizes, the setting and the three largest
files, and marks those a role opted in. For example: "conventions Warden (role
librarian-convention): instructions 4010 + domain knowledge 86182 = 90192 chars exceed its
budget of 80000 (composition.roles.librarian-convention.budget); largest:
.../CLAUDE.md (domainKnowledge, 50000 chars, opted in)".

**Where the slots live.** A middleware role's slots are private layers,
`role:<role>:instructions` and `role:<role>:domainKnowledge`. They are bound to
the thread's cwd and project and are never on the thread's stack, so the
executor never receives them. Each records its selection report. Advice,
guard and review record the exact composed text as the participant's
`segments`, which grows each turn's journal by roughly one composed role per
Warden. Every composed slot, the main thread's `instructions` layer included,
re-reads:

- before the next turn whenever a file it consulted changed: an edited
  `CLAUDE.md`, rule, role file or `MEMORY.md`, a new file where discovery looked
  (a new `CLAUDE.local.md`, a new rule in any rules subdirectory), a re-pointed
  symlink, or the thread moving to another cwd or project. The check is one stat
  per consulted path (about 0.5 to 0.8 ms for 50 paths); a re-read takes 15 to
  40 ms warm, about 200 ms cold. The main
  thread receives the change as a delta (FLOW.md, "Delivery"); a Warden whose
  slot changed re-primes;
- after 60 seconds;
- at once after a settings edit, including a `composition` edit;
- on `invalidateComposition()`, for a writer that wants the next turn to re-read
  without relying on file times. A stale slot keeps its last content until it
  re-reads; it never drops out. A Warden owns no
configured layer. Its only written layer is its generated
`thread-knowledge:<domain>`, owned by the thread, its project and the domain,
and written by its post-work review. The Librarian alone writes thread-state.
`ownedLayers` on a Warden is refused.

**Priming.** Wardens are fresh each call, never a continuing conversation. A
Warden's primed decision session is its composed instructions (system) plus its
composed domain knowledge (the leading `## Domain cache` part of the message,
`stablePrefix`). Advice and guard share that primed prefix. Review leads with
the same composed parts under its own header, on its own session key, so it
primes its own session. Each call forks the primed session, so every cycle
starts from that state. The
per-call input is the Warden's own thread knowledge, the thread state and the
turn. A changed composition is a new prime hash, and the next call re-primes
(agent-session `ClaudePrimedSessions`).

**Chiming in.** A Warden's advice is appended to the end of the user's message:
`The <domain> Warden chimed in:` followed by its points. It is placed after the
message (`PromptBlock.placement: "after-message"`), not in the context. Routing
stays in the per-turn context, and a contribution of layers only adds context.

**Aron's setup.** Main plus the Convention Warden, across computer, org, org
personal, project and project personal:

```jsonc
"agents": {
  "librarian-convention": {
    "id": "librarian-convention", "kind": "domain-librarian",
    "flowRole": "domain-advising", "domain": "conventions",
    "prompt": "...", "visibleLayers": [], "peers": [], "maxDepth": 1, "enabled": true
    // no ownedLayers; no domainKnowledge sources: its knowledge is the ladder's
  }
},
"composition": {
  "harnessLoading": "suppress",
  "roles": {
    "librarian-convention": { "domainKnowledge": { "general": ["org", "project"] } }
  }
}
```

| Rung | main: instructions | Convention Warden: instructions | Convention Warden: domain knowledge |
|---|---|---|---|
| computer | `~/.claude/CLAUDE.md` (+ rules, `RTK.md`), `~/.foundry/roles/main/instructions.md` | `~/.claude/CLAUDE.md`, `~/.foundry/roles/librarian-convention/instructions.md` | `~/.foundry/roles/librarian-convention/domainKnowledge.md` |
| org | `~/code/inixiative/CLAUDE.md`, `.foundry/roles/main/instructions.md` there | its own role file there (the org CLAUDE.md moved to domain knowledge) | `~/code/inixiative/CLAUDE.md`, `.foundry/roles/librarian-convention/domainKnowledge.md` there |
| org personal | `~/code/inixiative/CLAUDE.local.md` | the same | `.foundry/roles/librarian-convention/domainKnowledge.local.md` there |
| project | `<repo>/CLAUDE.md`, `AGENTS.md`, `.claude/rules` | role file only (project CLAUDE.md moved to domain knowledge) | `<repo>/CLAUDE.md` and the rest of the project node |
| project personal | `<repo>/CLAUDE.local.md`, auto memory | the same | `.foundry/roles/librarian-convention/domainKnowledge.local.md` |

**Test cases** (`tests/composition-view.test.ts`, core
`markdown-hierarchy.test.ts`):

- per-role selection, with defaults on and opt-outs;
- role and slot templating;
- dedupe across one role's slots;
- a personal node never reaching a team audience;
- a budget overflow reported in every phase, Cartographer included;
- re-priming only on a composition change;
- the chimed-in append;
- the Convention Warden's knowledge unchanged under the default config.

