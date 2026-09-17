# Gloss in Foundry

Foundry integrates [inixiative/gloss](https://github.com/inixiative/gloss), using
the pinned `@inixiative/gloss` 0.0.4 library. Gloss owns the mirrored Markdown
format, marker-to-symbol resolution, harvesting, repairs and Git-derived history.
Foundry owns project controls and presentation. No changes to core or agent routing.

## Viewing

Select a project and open **Gloss** in the header, or **Settings > Project > Gloss**.
The file picker lists `.gloss/` sidecars. A source path can also be entered directly,
including a file with no gloss yet. Supported source types match Gloss:
`.ts`, `.tsx`, `.mts`, `.cts`.

- Side column: select a symbol or its gutter marker to pin its commentary.
- Hover: focus or hover a gutter marker for a preview; click to pin the full note.
- Inline: expand the selected symbol's note below its marker.
- File preambles, unbound sections, binding errors, history and unavailable
  freshness are represented explicitly. Notes are advisory, never correctness rules.
- Mobile uses a stacked source/margin layout. Escape closes the view and restores
  focus. Source and commentary are rendered as text, not executable HTML.

This is a **read-only working-tree viewer**, not a historical PR diff viewer or
editor. Git freshness concerns committed history; uncommitted changes are called
out separately. No stored line-number bindings or second annotation database.
Line positions are resolved from the current source with Gloss's parser.
History requests carry the displayed source/sidecar fingerprint; if either changed,
the viewer requests a refresh instead of attaching current history to an older view.

## Setup and maintenance

Project settings persist `{ gloss: { enabled, display } }`. Maintenance is off
by default. Viewing and checking existing notes still work when disabled.
Enabling maintenance only changes Foundry settings. Each write requires a separate
confirmation describing its effects; none runs automatically on project open.

| Action | Effect |
| --- | --- |
| Install dependency | Add exact version 0.0.4 as a project dev dependency using Bun or npm, with lifecycle scripts disabled. Other package managers require manual installation. |
| Set up / update | Run Gloss setup: create its README and install/update its CLAUDE.md instruction block. |
| Harvest comments | Initial migration of comments to sidecars, preserving `why:` and configured machine directives. Does not stage or commit files. |
| Check bindings | Read-only bidirectional marker/section audit. |
| Repair bindings | Delegate rename/move/header repairs to Gloss. Never delete notes to make a check pass. |

Installation does not silently run setup or harvest. There is no database schema
migration: Gloss stores plain Markdown. Existing package configuration and excludes
are consumed by the upstream library. A declared dependency version is not presented
as proof that the target project's package is installed; the viewer always runs its
own pinned adapter, never imports executable code from a project installation.

Stop editors/agents modifying a project before harvesting or repairing. Review the
resulting Git diff. These writes are not transactional, and a timeout can leave
partial changes; inspect rather than blindly retry. The default ongoing workflow
remains Gloss's `harvest --staged` pre-commit hook. This PR does not rewrite existing
Git hooks, run a watcher, start agents, or introduce an automatic maintenance loop.
Hook wiring remains under the repository's existing hook manager.

## Boundaries

All API requests resolve a registered project ID, never a client-supplied root.
Reading is limited to TypeScript source and corresponding sidecars, with traversal,
hidden source paths, dependency paths, symlinks and oversized files rejected.
Repo-wide maintenance fails closed for linked trees (excluding `.git` and
`node_modules`). This is conservative: use Gloss directly for an intentionally
symlinked repository. It is not a sandbox against concurrent filesystem changes.

Gloss calls run in separate bounded child processes: one project's custom directive
configuration cannot affect another, and synchronous AST/Git work does not block
the viewer event loop. Maintenance is exclusive per canonical project root; reads
are bounded to four concurrent workers per root. Workers have output limits and
timeouts; on Unix their process groups are terminated on timeout. Browser writes
require same-origin JSON plus explicit confirmation. Existing viewer/tunnel access
controls still apply; only trusted operators should register or mutate projects.

## Verification

```sh
bun install --ignore-scripts
bunx --no-install prisma generate
bun run typecheck
bun test packages/core/tests packages/foundry/tests/config.test.ts packages/foundry/tests/gloss.test.ts
# With Playwright installed locally, or PLAYWRIGHT_MODULE pointing at its index.mjs:
bun scripts/gloss-browser-qa.ts
# Optional installed browser: PLAYWRIGHT_CHANNEL=chrome
bun scripts/gloss-preview.ts
```

The preview uses a disposable sample project and no model providers. The browser
suite starts and closes its own viewer and browser, exercises desktop/mobile modes
and explicit maintenance, and writes screenshots/results to `.foundry/gloss-qa/`.
No dependency installation is performed in a real target project by this suite.

Historical base/head diff annotations, syntax highlighting, rich Markdown
rendering, automatic hook installation and agent read-context integration are
separate follow-ups, not claimed by this first integration.
