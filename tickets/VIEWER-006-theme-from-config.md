# VIEWER-006: Shared theme from @inixiative/config

**Status**: 🆕 Not Started (decided, ready to build)
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-11-01
**Updated**: 2026-11-01

---

## Decision (Aron, 2026-11-01)

**Runtime dependency.** Foundry and Kingdom depend on `@inixiative/config` at runtime and load `theme/public` and `theme/agentic` CSS straight from the package. Not a `sync` copy, not a build step copy.

Why: one source the two apps read live, with nothing to keep in step by hand; a decision about the look lands in both with the next config release.

## Overview

Kingdom and Foundry read one theme from `@inixiative/config` instead of Foundry carrying a copy (`packages/foundry/src/viewer/ui/tokens.css`, copied from Kingdom's `apps/web/app/styles/app-theme.css` in redesign S1, #125).

- `theme/public`: Kingdom's brand tokens (the `--app-*` layer laid out like template's `packages/shared/styles/theme.css`), type, and the fonts.
- `theme/agentic`: the status layer (`--status-working | attention | problem | queued | done | idle | archived`) and the badge layer.

Aron, 2026-11-01: "The config package can have a theme inside of it: public themes, theme/agentic for this stuff."

## Implementation sketch

**Config** (`~/code/inixiative/config`):
- Add `theme/public.css`, `theme/agentic.css`, and the fonts under `theme/fonts/` (Bricolage Grotesque, Instrument Sans, JetBrains Mono woff2, SIL OFL; `public.css` loads them with `@font-face` and relative URLs).
- Add `theme` to `files`, and to `exports`: `"./theme/public.css"`, `"./theme/agentic.css"`, `"./theme/fonts/*"`.
- Seed both files from Foundry's `ui/tokens.css` (it already has the layers split: base / app theme / UI / type = public; status / badge = agentic) and the vendored fonts in `ui/vendor/fonts/`.
- Release through `train` (`bunx @inixiative/config train`), never a raw `npm publish`.

**Foundry**:
- `@inixiative/config` moves into `dependencies` of the published package, `packages/foundry/package.json` (it stays at the root as the toolchain devDependency too). Config is an ecosystem package, not a toolchain pin (`versions.json` `toolchain` is biome, typescript, tsup, @types/bun, lefthook), so a workspace member may declare it; `check` holds its range to the blessed version (`src/lib.ts`, ecosystem ranges).
- The viewer server serves `/ui/theme/*` from the package with `import.meta.resolve('@inixiative/config/theme/…')`, the same way it serves `/ui/delivery-evidence.js` from foundry-core (`packages/foundry/src/viewer/server.ts`).
- `ui/index.html` and `ui/kingdom.html` link `/ui/theme/public.css` and `/ui/theme/agentic.css` before `styles.css`.
- Delete `ui/tokens.css` and the vendored fonts (`ui/vendor/fonts/`, their `manifest.json` / `licenses.json` entries).
- `packages/foundry/tests/viewer-tokens.test.ts` reads the theme from the package instead (every `var(--x)` used in `styles.css` / `gloss.css` is defined; no stray hex).

**Kingdom**:
- `apps/web` imports `@inixiative/config/theme/public.css` and `@inixiative/config/theme/agentic.css` (config moves to `dependencies` of the web app), replacing the hand-kept values in `apps/web/app/styles/app-theme.css`; template's `packages/shared/styles/theme.css` layers stay underneath.
- This also fixes a gap: **Kingdom names its fonts but never loads them** (nothing in `apps/web` imports a webfont), so it renders in system-ui today. `theme/public.css` ships the fonts.

## Known cost to watch: config's peers in Foundry's install

Config declares three peers, `@biomejs/biome >=2.5.0`, `tsup >=8.5.0`, `typescript >=6.0.0`, **all optional** (`peerDependenciesMeta.*.optional: true`), and has no runtime `dependencies` of its own (checked on config main, 0.5.162).

- **What happens:** npm 7+ auto-installs required peers but never optional ones, and bun does the same, so installing `@inixiative/foundry` pulls in only config's own files (its `dist/` CLI, presets and the theme), not biome, tsup or TypeScript. Config's `bin` (`inixiative-config`) is linked into the consumer's `node_modules/.bin`; that's harmless. Its `prepare` script doesn't run for a dependency.
- **The one risk:** an optional peer is still range-checked when the consumer already has that package. A project with TypeScript 5 (or biome < 2.5, tsup < 8.5) installing Foundry locally gets a peer conflict; npm reports it as `ERESOLVE` and needs `--legacy-peer-deps`. A global install (`bun add -g`, `npm i -g`) is isolated and unaffected.
- **What to do:** keep every config peer optional and keep config free of runtime dependencies (a `check` rule in config could enforce both, so a future edit can't make Foundry's install heavy). After the first release, test a clean `npm i @inixiative/foundry` and a `bun add` in an empty dir and in a TypeScript 5 project, and record the result here. If the conflict shows up in practice, the fallback is to move the theme into its own package with no peers (`@inixiative/theme`), keeping the same paths. Don't do that preemptively.

## Also

- Whether the status layer also goes into template's token set (so Tribe and every template app share the status meanings) is a template PR for Aron's review.

## Acceptance

- Config ships `theme/public.css`, `theme/agentic.css` and `theme/fonts/*` through the release train.
- Foundry serves the theme from the package at `/ui/theme/*`; `ui/tokens.css` and `ui/vendor/fonts/` are gone; `viewer-tokens.test.ts` passes against the package.
- Kingdom web loads the theme and its fonts from the package.
- The install check above is run and recorded.
