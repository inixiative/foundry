# VIEWER-006: Shared theme from @inixiative/config

**Status**: 🆕 Not Started
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-11-01
**Updated**: 2026-11-01

---

## Overview

Kingdom and Foundry read one theme from `@inixiative/config` instead of Foundry carrying a copy (`packages/foundry/src/viewer/ui/tokens.css`, copied from Kingdom's `apps/web/app/styles/app-theme.css` in redesign S1, #125).

- `theme/public`: Kingdom's brand tokens (the `--app-*` layer laid out like template's `packages/shared/styles/theme.css`), type, and the fonts.
- `theme/agentic`: the status layer (`--status-working | attention | problem | queued | done | idle | archived`) and the badge layer.

## Why (Aron, 2026-11-01)

"The config package can have a theme inside of it: public themes, theme/agentic for this stuff." The two apps should read as one product and stay in sync as decisions are made.

## The delivery question (open)

`@inixiative/config` is a devDependency, so Foundry's published package can't import a theme file from it at runtime. Options:

- **(a) Recommended: config `sync` writes the theme files into each consuming repo, and `check` fails on drift.** This is the machinery config already has for tsconfig, biome and lefthook (sync writes, check holds every repo to it in CI). The runtime still serves a local file, so there is no new runtime dependency, and drift is caught the same way toolchain drift is.
- (b) Make config a runtime dependency of `@inixiative/foundry` and serve the file with `import.meta.resolve` (the `/ui/delivery-evidence.js` pattern, `packages/foundry/src/viewer/server.ts`). This puts a toolchain package, and its biome/lefthook/typescript peers, into every Foundry install.
- (c) A Foundry build step copies the file in. Same result as (a), but only for Foundry; Kingdom would need its own.

## Also

- **Kingdom names its fonts but never loads them** (Bricolage Grotesque, Instrument Sans, JetBrains Mono in `app-theme.css`; nothing imports a webfont), so Kingdom renders in system-ui unless they're installed. Foundry vendors the woff2 files (`ui/vendor/fonts/`, hashed in `ui/vendor/manifest.json`). `theme/public` should ship the fonts and Kingdom should load them.
- Whether the status layer also goes into template's token set (so Tribe and every template app share the status meanings) is a template PR for Aron's review.

## Acceptance

- Config ships `theme/public` and `theme/agentic` through the release train.
- Foundry's `tokens.css` and Kingdom's theme come from it; `check` fails when either drifts.
- `packages/foundry/tests/viewer-tokens.test.ts` still passes (every `var(--x)` defined, no stray hex).
