# Fable handoff: bounded G3/G7 memory selection (2026-09-07)

Implementer: Fable, central native session da000690-899a-4128-a868-b9a024aeeaa0.
Status: implementation complete and self-verified. NOT self-approved. Requires
independent supervisor QA and Astra (opposite-model) review before acceptance.
Accepted-slice count stays at 3.

## What changed and why

Problem: the file-memory source injected every visible owned record, so the
signal-writer audit log (dispatch, classification, context_loaded, compaction
signals) dominated provider input (measured 137,748 raw chars, 93.7% of the
system section, character counts not tokens). See
QA-2026-09-07-memory-amplification.md.

Decision: keep the complete owned audit log intact and searchable; inject a
deterministic bounded selection whose provenance rides on the layer snapshot
into the injection artifact, and is readable in the right panel.

### Core (`packages/core`)
- `src/adapters/file-memory.ts`: `selectMemory(visible, policy, focus)` pure
  selector; `MemorySelectionPolicy` + `DEFAULT_MEMORY_SELECTION`
  (budgetChars 6000, maxEntryChars 1200, recentLimit 8, retrievalLimit 6,
  auditRelevanceTerms 2, pinnedHardCapChars 24000, pinnedKinds, auditOnlyKinds).
  `FileMemory.asSource({ selection })` is `focusable` and exposes `report()`.
  Legacy full dump remains only when `selection: false`.
- Selection order: (1) pinned kinds (instruction, pin, pinned, convention,
  correction, decision, requirement) always, in full, never excerpted; a pinned
  record over `pinnedHardCapChars` is NAMED in the text as "NOT INJECTED ... read
  with the memory tool" and recorded as omitted `oversized-pinned` + conflict
  `pinned-oversized`; pinned records that push past the budget are still
  injected in full with conflict `pinned-over-budget`. (2) relevant records via
  deterministic focus terms (>=4 chars, stopwords removed; audit kinds need >=2
  matches); long records are excerpted in windows around the matched terms with
  explicit `[excerpt: chars a-b of N; full record id via memory tool]` and
  `ranges` on the report. (3) recent non-audit records newest-first within
  `recentLimit`, prefix excerpt with ranges. (4) "## Not injected" summary in the
  injected text so the model and the operator see the same account.
- Every considered record ends in exactly one of `selected`/`omitted`; a
  fallback selection clears an earlier omission (Map keyed by id).
- `src/context-layer.ts`: `SourceLoadHint`, `SourceSelectionReport`
  (+`ranges`), `LayerSelectionState`; `ContextLayer.setFocus/focus/selection`;
  `_doWarm` captures the focus per load, labels the selection with THAT focus,
  and if a focusable source's focus moved during the load, reloads (bounded to 3
  attempts) or leaves the layer visibly `stale`; `restoreInstance` marks a
  restored warm snapshot `stale` when its recorded focus hash differs from the
  layer's current focus (focusable sources only); `set()`/`clear()` drop
  selection provenance. Snapshot/restore/clone carry `selection`.
- `src/index.ts` exports the new types and helpers.

### Foundry (`packages/foundry`)
- `src/viewer/config.ts`: `DataSourceConfig.selection?: false | Partial<MemorySelectionPolicy>`.
- `src/agents/thread-factory.ts`: file sources get bounded selection by default;
  `selection: false` opts out.
- `src/agents/flow-orchestrator.ts` (`hydrateDelta`): sets the message as focus
  on all layers before warming; warms focusable layers that went stale.
- `src/viewer/ui/inspector-data.js`: `selectionSummary(layer)` groups omissions
  by reason, lists selected ids with reason/detail (kind, matched terms, excerpt
  ranges, chars), budget, retained, focus, conflicts, and a notice that says
  "prepared", never "delivered"; `null` for non-selecting layers; excluded
  layers say "not included".
- `src/viewer/ui/detail-drawer.js`: `LayerSnapshot` gains a collapsed
  "Selection" section rendered from `selectionSummary`, using existing
  `Section`/`def-field` controls. No other UI changes.

## Supervisor cases (files unchanged, both now pass)
- fixtures/harness-qa/acceptance/memory-selection.test.ts (4 cases) and
  memory-selection-provenance.test.ts (2 cases), RED confirmed at 01:5x before
  edits on the four newer cases, GREEN after:
  `.foundry/qa/2026-09-07T01-58-11.179Z-G3/report.json` (tests, typecheck, diff check PASS).
- Earlier G3 acceptance unchanged (message-decoration, decoration-deadline,
  domain-learning, tool-evidence): `.foundry/qa/2026-09-07T01-58-14.221Z-G3/report.json`.
- Full baseline (typecheck, `bun run test`, gates + sample project, diff check):
  `.foundry/qa/2026-09-07T01-58-16.923Z-baseline/report.json`.
- Browser (opt-in, headless Chrome via FOUNDRY_QA_PLAYWRIGHT, ephemeral port-0
  server owned and stopped by the test, Mac lock untouched):
  `.foundry/qa/2026-09-07T02-00-02.280Z-G4/report.json` and
  `.foundry/qa/memory-selection-browser-2026-09-07T02-00-02.479Z/{report.json,page.png}`.
  Proves: viewer page loads with the edited drawer module, `selectionSummary`
  runs in-browser on an artifact-shaped layer with the intended wording, no page
  errors. Three console lines of fixture noise (no websocket endpoint, 400 polls)
  are recorded as `ignoredFixtureNoise`, same class the storage browser test ignores.
  Does NOT prove: visual placement of the Selection section for a real turn.
- No source edits happened while those runs executed; the browser test file
  (tests-only) was adjusted between its two runs, then everything above was
  re-run or already complete.

## Focused tests (owned)
- core: tests/memory-selection.test.ts (12), tests/layer-focus.test.ts (6):
  learned convention survives hundreds of audit signals; older relevant record
  retrieved; pinned over budget injected in full; pinned over hard cap named not
  injected; relevant excerpt windowed with ranges; selected/omitted disjoint and
  sum to considered; focus reload during load; restore mismatch -> stale; set
  drops provenance; failed refresh keeps last selection labelled stale.
- foundry: tests/memory-selection.test.ts (8) through the production
  factory/runtime/executor with a capturing provider: bounded input + intact
  searchable audit log, focus retrieval, full pinned rule at the provider
  boundary, hard-cap notice at the boundary with record retained, same-named
  threads across projects, project publication, hidden unowned, failed refresh,
  restart recovery (same content hash, same file count), fork isolation.
  tests/memory-selection-inspector.test.ts (2). tests/browser/memory-selection-inspector.test.ts (1, opt-in).
- Honesty note on TDD order: the four supervisor cases and the inspector helper
  test were RED before implementation. The three new layer-focus cases
  (restore mismatch, set, failed refresh) were written after the corresponding
  code and passed first run; they are regression coverage, not RED-first proof.

## Known limitations
- Character budgets, not tokenizer counts; no latency causality measured.
- Native context retention (S6) remains unverified; nothing here uses the
  delivery ledger as a shortcut. Provenance describes prepared input.
- Focus terms are lexical (substring match on >=4-char terms); no embeddings.
- `pinnedHardCapChars` default 24000 is a judgment; an operator can raise it
  per source. Oversized pinned records are named, never paraphrased.
- The restore->stale rule triggers one extra warm after restart for focusable
  layers whose recorded focus differs from the new message; intended.
- Selection section shows in `LayerSnapshot` only where the artifact carries
  `selection`; historical artifacts created before this change show nothing new.
- Browser evidence is module-level plus helper output; a right-panel screenshot
  of a live turn's Selection section was not captured within this turn budget.

## Proposed controlled rollout / native follow-up
1. Supervisor independent QA on the reports above; Astra read-only review.
2. Measure before/after on the existing checkpoint with the supervisor's
   scripts/measure-memory-injection.ts (unchanged) to record the bounded size.
3. Roll to a disposable fixture server first (not primary4400/lead4407): send
   one message, open the memory layer in the right panel, confirm the Selection
   section, confirm "## Not injected" appears in the provider-input artifact,
   and confirm `memory-file_search` still finds an omitted audit record.
4. Only then restart the primary while idle, preserving the native session id;
   first continuation smoke should report the memory layer selection budget.
5. Native follow-up check: with S6 still unverified, do not claim the model
   retained earlier selections; compare two consecutive turns' artifacts to show
   selection changes with focus while the audit log grows unchanged.

## Ownership
Foundry source/tests only. Not touched: ../agent-session, independent
acceptance files, shared graph files, scripts/measure-memory-injection.ts,
live process config, bindings, credentials. No commits, no restarts, no new agents.

---

## Correction 2 (2026-09-07, ~02:25-02:32Z): Astra review findings, four reopened items

Status: correction complete and self-verified. NOT self-approved. Returned for
independent supervisor QA and Astra read-only review. Accepted count stays at 3.
Astra's review: QA-2026-09-07-astra-memory-review.md. Supervisor detail:
QA-2026-09-07-required-memory-retrieval.md.

### RED before edits
Both new supervisor files run unchanged before any source change: 7 fail / 0 pass
(1 required-retrieval, 2 failed-refresh focus races, 3 invalid runtime policies,
1 invalid config patch). Reproduced at ~02:24Z in this session prior to edits.

### Behavior changes

1. **Required context is supplied intact or execution is refused; no tool is
   ever named.** `MemorySelectionPolicy.oversizedPinned: "inject" | "block"`,
   default `"inject"`: a pinned record above `pinnedHardCapChars` is injected in
   full with conflict `pinned-oversized` ("injected in full because no scoped
   retrieval is available"). `"block"` (explicit opt-in) records the record as
   omitted with reason `required-context-blocked`, adds the same-kind conflict
   and a BLOCKED line, and core `Executor.execute` refuses before any provider
   call with an error naming layer, source and record ids; the recorded
   injection artifact keeps the conflict inspectable. The constant
   `REQUIRED_CONTEXT_BLOCKED` lives in core `context-layer.ts` so the executor
   does not import an adapter. The injected text no longer mentions a "memory
   tool" anywhere (summary and excerpt markers reworded). The "NOT INJECTED /
   read with the memory tool" path is gone. A real native scoped-retrieval
   bridge remains a separate integration node; nothing here claims it.
2. **Failed refresh keeps truthful focus provenance.** `ContextLayer._doWarm`
   catch: the reverted state becomes `stale` when the layer's recorded selection
   focus (or its absence) differs from the current focus, for both a failed
   initial refresh and a failed focus-triggered retry. Content and selection
   stay those of the last good load; `focus` reports the new message. An
   unchanged-focus failure keeps `warm` on the last good content. Restore, set
   and clear already handled provenance (correction 1) and are re-tested.
3. **Runtime policy validation, one shared validator.** Core
   `validateMemorySelection(input)` rejects non-objects, unknown fields,
   non-integer or out-of-bounds numbers (bounds documented in code), non-string
   or duplicate kind lists, invalid `oversizedPinned`, and
   `maxEntryChars > budgetChars`; returns a defensive copy. Applied at:
   `FileMemory.asSource` (source creation); `ConfigStore.save` and
   `ConfigStore.patch` via exported `validateConfig` (global sources and every
   project's sources; `selection: false` and absent remain valid). `patch` now
   builds a candidate copy and assigns only after validation, so live settings
   and the persisted file are unchanged on rejection. Routes: `PUT /api/settings`
   and `PATCH /api/settings/:section` return 400 with the message;
   `PATCH /api/projects/:id/settings/:section` mutates a `structuredClone` of the
   project and returns 400 on rejection, so a bad body no longer poisons the
   live project object before store validation.
4. **Browser test cleanup.** New `tests/helpers/release-all.ts` releases every
   owned handle in order, skips absent handles from partial setup, records
   failures and never throws; the browser test uses it with typed
   `fixture.close()`, `server.stop(true)`, `browser.close()`, writes `released`
   and `cleanupFailures` into its report and fails on cleanup failures. A second
   opt-in case forces a browser launch failure (nonexistent channel) and proves
   server and fixture were still released with no cleanup failures.

### Evidence (all after the last source edit at ~02:30Z)
- Four independent memory files, unchanged, via G3 (13 cases: 4 + 2 + 1 + 6):
  `.foundry/qa/2026-09-07T02-30-55.781Z-G3/report.json` PASS, typecheck, diff.
- Earlier four G3 acceptance files: `.foundry/qa/2026-09-07T02-30-59.571Z-G3/report.json` PASS.
- Full baseline: `.foundry/qa/2026-09-07T02-31-03.716Z-baseline/report.json` PASS.
- Browser pair via G4 (opt-in, headless Chrome, ephemeral port-0 server owned
  and stopped by the test): `.foundry/qa/2026-09-07T02-31-29.300Z-G4/report.json`
  PASS; `.foundry/qa/memory-selection-browser-2026-09-07T02-31-29.*` and
  `.foundry/qa/memory-selection-browser-launch-failure-2026-09-07T02-31-30.897Z/report.json`
  (passed=false by design, released browser=false server=true fixture=true, cleanupFailures=[]).
- Focused: core memory-selection 14 + layer-focus 8 + neighbours = 101 pass;
  foundry memory-selection 10, memory-selection-config 3, inspector 2,
  release-all 1 + neighbours = 51 pass. Both typechecks exit 0.
- Supervisor's `scripts/check-memory-selection-viewer.ts` not edited or run here.

### Owned files changed in this correction
core: `src/adapters/file-memory.ts`, `src/context-layer.ts`, `src/executor.ts`,
`src/index.ts`; tests `memory-selection.test.ts`, `layer-focus.test.ts`.
foundry: `src/viewer/config.ts`, `src/viewer/routes/control.ts`; tests
`memory-selection.test.ts`, new `memory-selection-config.test.ts`,
new `release-all.test.ts`, new `helpers/release-all.ts`,
`browser/memory-selection-inspector.test.ts`.
Not touched: `../agent-session`, `fixtures/harness-qa/acceptance/*`, shared
ledgers/graphs, supervisor scripts, live process config, bindings, credentials.
No commits, restarts, new agents, dependency changes or native probes.

### TDD order, honestly
The 7 supervisor cases were RED first. My own new cases (block mode, validator
matrix, config rejection at store and route, unchanged-focus failure, launch
failure cleanup) were written after the code and passed first run, except the
two rewritten hard-cap tests which failed once on the leftover "memory tool"
wording and drove the wording removal.

### Known limitations, unchanged or new
- Default `"inject"` means an oversized pinned record can push provider input
  well past the character budget; that is visible as `pinned-oversized` +
  `pinned-over-budget`, and is honest bounded behavior, not a capacity guarantee.
  Operators wanting hard refusal set `oversizedPinned: "block"`.
- Character budgets are not tokens, latency or native retention proof (S6 open).
- No native scoped-tool bridge exists; the executor guard only sees API-path
  artifacts. Native `SessionBackedProvider` turns still bypass `toolUseLoop`.
- `validateConfig` validates memory policies only; other config fields keep
  their existing TypeScript-only protection.
- Operator-facing inspector notice still says the log is "searchable with the
  memory tool" (Foundry's own viewer memory tooling); model-facing text does not.

### Proposed rollout (unchanged sequence)
Independent QA on the reports above → Astra read-only review → disposable
fixture server: one message, confirm Selection section and refusal path with
`oversizedPinned: "block"` → only then primary restart while idle. Memory
rollout remains withheld until then.

---

## Correction 3 (2026-09-07, ~02:38-02:41Z): load boundary and a handoff correction

Status: complete and self-verified. NOT self-approved. Accepted count stays at 3;
the supervisor decides acceptance.

### Handoff correction
Correction 2 claimed the required-context guard "protects the API path only" and
that native turns bypass it. That was unsupported. The supervisor verified, and
`memory-load-native-boundary.test.ts` now asserts, that the production
ThreadFactory -> Executor -> real SessionBackedProvider configuration blocks
before native `createSession` with an inspectable `required-context-blocked`
conflict in the recorded injection artifact and no provider messages. That case
passes without spawning a native process. It does NOT establish a native scoped
retrieval bridge, native retention, or live rollout; the guard refuses, it does
not retrieve.

### Load boundary fix
`ConfigStore.load` previously assigned the merged configuration unchecked.
It now builds the merged candidate (defaults, saved, provider merge, projects),
runs the shared `validateConfig` on it, and only then assigns live state and sets
loaded. On an invalid persisted policy it throws
`settings.json at <path> was not loaded: <validator message>`, keeps the last
working live configuration (or in-memory defaults on a fresh store), and never
rewrites the file. Valid legacy files without `selection`, `selection: false`,
and the normal default/provider merge are unchanged. No second validator.

### RED before edit
`memory-load-native-boundary.test.ts` unchanged: 2 fail (global, project load)
/ 1 pass (native guard) at ~02:38Z in this session, matching
`.foundry/qa/2026-09-07T02-36-00.648Z-G3/report.json`.

### Evidence after the edit (no source change during these runs)
- All SIX independent memory files via G3, 19 cases:
  `.foundry/qa/2026-09-07T02-40-13.626Z-G3/report.json` PASS, typecheck, diff.
- Full baseline: `.foundry/qa/2026-09-07T02-40-16.265Z-baseline/report.json` PASS.
- Focused: load-boundary acceptance + memory-selection-config (5, two new load
  cases) + config suite = 13 pass. Both typechecks exit 0.
- Files changed: `packages/foundry/src/viewer/config.ts` (load only),
  `packages/foundry/tests/memory-selection-config.test.ts` (two cases added).
  Nothing else; sibling, acceptance files, shared graphs untouched.

### TDD order
Supervisor cases RED first. My two load tests were written alongside the fix and
passed first run; they are regression coverage for the fresh-store, repair and
legacy paths, not RED-first proof.

---

## Correction 4 (2026-09-07, ~02:56-02:58Z): own-property lookup in the policy validator

Status: complete and self-verified. NOT self-approved. Accepted count stays at 3;
the supervisor decides acceptance. Small hardening only; no bridge or capacity claim.

### Finding closed
Astra's nonblocking final memory-review finding: `validateMemorySelection`
resolved `NUMERIC_BOUNDS[key]` through the prototype chain, so inherited names
(`constructor`, `toString`, `hasOwnProperty`, `__proto__`) were treated as
numeric fields instead of unknown options. Fix: `Object.hasOwn(NUMERIC_BOUNDS,
key)` guards the lookup; anything not an own key falls through to the existing
`unknown field` rejection. Declared numeric fields, kind lists and
`oversizedPinned` semantics are unchanged.

### RED before edit
`memory-policy-own-fields.test.ts` unchanged: 4 fail (the four inherited names)
/ 1 pass (declared-field control) at ~02:56Z, matching
`.foundry/qa/2026-09-07T02-55-35.377Z-G3/report.json`.

### Evidence after the edit (no source change during these runs)
- All SEVEN independent memory files via G3, 24 cases (19 + 5):
  `.foundry/qa/2026-09-07T02-57-41.563Z-G3/report.json` PASS, typecheck, diff.
- Full baseline: `.foundry/qa/2026-09-07T02-57-48.367Z-baseline/report.json` PASS.
- Focused core: memory-selection + layer-focus = 22 pass, including the four
  inherited names added to the validator rejection matrix. Both typechecks exit 0.
- Files changed: `packages/core/src/adapters/file-memory.ts` (one guarded lookup),
  `packages/core/tests/memory-selection.test.ts` (four matrix entries). Nothing
  else; sibling, acceptance files, supervisor scripts, shared ledgers untouched.

### TDD order
Supervisor cases RED first. The four owned matrix entries were added with the fix
and passed first run; they are regression coverage.
