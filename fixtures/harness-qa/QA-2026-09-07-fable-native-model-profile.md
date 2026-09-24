# Fable handoff: native model propagation and immutable warm profile (2026-09-07, ~03:22-03:28Z)

Status: bounded Foundry provider correction complete and self-verified.
NOT self-accepted. Returned for Astra read-only review and supervisor acceptance.
Astra remains provisional lead (count 4, next checkpoint 6). This slice is not
native or speed parity and does not integrate the sibling package.

## Defect (supervisor reproduction)
`SessionBackedProvider.complete` accepted `opts.model` but never passed it to
`createSession`; both adapters spawned with their constructor default while the
result echoed the requested model. The warm profile keyed only textOnly/maxTurns,
so a changed model reused the existing process silently.
RED reproduced before edits: `native-model-profile.test.ts` 3 fail / 1 pass at
~03:22Z, matching `.foundry/qa/2026-09-07T03-19-43.544Z-G5/report.json`.

## Changes (Foundry only)
- `providers/session-adapter.ts`: `CreateSessionOpts.model?: string` (documented
  as requested configuration, not acknowledgment). `ClaudeCodeSessionAdapter`
  passes it into `ClaudeCodeSession` config, which emits `--model <value>` on
  spawn; absent falls back to `defaults.model`. `CodexSessionAdapter` passes it
  into `CodexSession` config, which sends `model` in the first native `codex`
  tools/call arguments; absent falls back to `defaults.model`. Text-only refusal
  on Codex, restricted Claude spawn flags, permissionMode, maxTurns, resume
  binding and signal bridging are unchanged.
- `providers/session-backed.ts`: effective model = `opts.model ?? defaultModel`
  is passed to `createSession` and recorded in an immutable
  `NativeSessionProfile { requestedModel, textOnly, maxTurns, resumedBinding,
  persistedModelIdentity }`, exposed read-only via `warmProfile(threadId, cwd)`.
  A request whose requestedModel/textOnly/maxTurns differs from the warm profile
  is rejected before send with the exact differences and an actionable message
  (nothing sent, binding not replaced, end the thread's native session or use a
  thread owning the requested profile). Identical explicit or default profiles
  reuse the warm session. The slot is reserved synchronously so a concurrent
  different-profile request is refused, not raced. Result `model` is the
  requested model; `raw.nativeModel` is set only from an engine-emitted `model`
  label on retained events; `raw.profile` carries the warm profile.
  `persistedModelIdentity: "unknown"` when a persisted binding was resumed,
  because the binding store never recorded the model. Timeouts (0 central,
  15s auxiliary), tools=false enforcement, DECISION_CONTEXT and terminal-error
  precedence are unchanged. No saved classifier/router settings were touched.
- Existing `tests/session-backed-provider.test.ts`: one assertion updated to
  expect the propagated `model` field.
- New `tests/native-model-profile.test.ts` (6 offline cases, fake subprocesses):
  Claude explicit `--model haiku` with restricted flags and `--max-turns 1`,
  fallback `--model fable`; Codex explicit and fallback model in the first
  `codex` call arguments plus text-only refusal; provider over the real Claude
  adapter refuses a changed model with one spawn and two turns written, reuses
  identical profiles, exposes a frozen profile; resumed binding reports unknown
  model identity; engine-emitted model on a retained event surfaces as
  `nativeModel`; concurrent different-profile request refused during creation.

## Evidence (after the last source edit)
- Supervisor file via G5: `.foundry/qa/2026-09-07T03-27-16.803Z-G5/report.json` PASS (4 cases), typecheck, diff.
- Both model-profile files together: 10 pass.
- Existing provider/adapter/providers/agent-selection/provider-failure/session suites: 81 pass.
- Full baseline: `.foundry/qa/2026-09-07T03-26-59.905Z-baseline/report.json` PASS.
- Foundry and core typecheck exit 0.
- An earlier baseline at 03:25:47 FAILED on my own then-incorrect acknowledgment
  test; it is retained as `.foundry/qa/2026-09-07T03-25-47.580Z-baseline/report.json`.

## Limitations, stated plainly
- Requested is not acknowledged. Installed agent-session 0.1.0 does not classify
  the Claude `system/init` line into a retained event, so the model label the
  engine prints at start is not observable through this provider today;
  `raw.nativeModel` stays undefined on real Claude runs until the sibling S1
  unattributed-event retention is integrated. Codex acknowledgment is likewise
  unobserved. Tests prove argv and first-call configuration only.
- The persisted binding stores no model; a resumed session's original model is
  reported as unknown, not inferred. No binding was started fresh or replaced.
- The profile-change error requires an explicit operator action; no automatic
  session replacement was added, by design.
- Not in this slice: model catalog, central execution-budget UI, start.ts
  rawProvider fallback for domain/cartographer work, stale generated knowledge,
  self-referential current-turn audit selection. The last two remain explicit
  open gaps from the memory handoff; no read-only cause investigation was done
  within this turn budget.

## TDD order
Supervisor's 3 RED cases first. My six offline cases were written with the fix;
one initially encoded a wrong assumption (init label retained) and was corrected
to assert the installed engine's real behavior after inspecting its source.

---

## Correction 2 (2026-09-07, ~03:31-03:34Z): acknowledgment provenance and lookup honesty

Status: complete and self-verified. NOT self-accepted. Supervisor decides.

### Defects (supervisor reproduction, native-model-provenance.test.ts)
RED before edits: 4 fail / 1 pass at ~03:31Z, matching
`.foundry/qa/2026-09-07T03-29-12.460Z-G5/report.json` plus the fifth pending-lookup case.
1. Any `raw.model` on any event (tool, unknown) was labelled native acknowledgment.
2. An init envelope for a foreign native binding was attributed to this session.
3. A failed binding lookup was swallowed and reported as `fresh-session`.
4. The synchronously reserved profile said `fresh-session` before the lookup settled.

### Changes (`providers/session-backed.ts`, own tests only)
- Acknowledgment comes only from supported configuration envelopes that name THIS
  session's binding (`result.externalSessionId`): Claude `system`/`init` with
  matching `session_id`, or Codex `session_configured` with matching
  `thread_id`/`session_id`. Tool, unknown, foreign or unbound events are not
  evidence; `raw.nativeModel` stays undefined. The positive capability is kept.
- `NativeSessionProfile` gains `bindingLookup: "pending" | "resolved" | "failed"`
  and `bindingLookupError`. The synchronous reservation is `pending`/`unknown`;
  a resolved lookup yields `fresh-session` or `unknown` (resumed); a rejected
  lookup is retained as `failed`/`unknown` with its message, never rewritten as
  fresh. Creation still proceeds after a failed lookup only because the real
  adapters perform their own store load and fail closed there; the provider no
  longer manufactures provenance. Profile-mismatch refusal before send, including
  concurrent creation, is unchanged.
- Own tests: the earlier "arbitrary raw.model on a result" case was replaced by a
  SYNTHETIC supported-envelope case (own binding acknowledged; same label on a
  tool event or foreign binding not; Codex session_configured equivalent), plus
  a pending/failed lookup case. Installed agent-session 0.1.0 still does not
  retain the real Claude init line; nothing here claims it does.

### Evidence (after the last source edit)
- Both independent files via G5, 9 cases (4 + 5):
  `.foundry/qa/2026-09-07T03-33-54.637Z-G5/report.json` PASS, typecheck, diff.
- Independent files plus my offline tests together: 16 pass.
- Existing provider/adapter/providers/agent-selection/failure/session suites: 81 pass.
- Full baseline: `.foundry/qa/2026-09-07T03-33-06.909Z-baseline/report.json` PASS.
- Foundry typecheck exit 0. Concurrent edits by Astra in other areas can make the
  baseline stale after this timestamp; rerun before acceptance.
- Files changed: `packages/foundry/src/providers/session-backed.ts`,
  `packages/foundry/tests/native-model-profile.test.ts`. Nothing else.

---

## Correction 3, S5 (2026-09-07, ~03:59-04:04Z): authoritative construction binding provenance

Status: complete and self-verified. NOT self-accepted. Supervisor decides after
Astra's opposite-model re-review.

### Defects (supervisor reproduction, native-model-binding-provenance.test.ts)
RED before edits: 1 pass / 2 fail at ~03:59Z, matching
`.foundry/qa/2026-09-07T03-57-07.053Z-G5/report.json`.
1. An auxiliary whose thread key held only preserved legacy coding history was
   constructed fresh under the text-only-v1 key, but the profile claimed it resumed
   the legacy binding: the provider's diagnostic `getExternalSessionId` falls back
   to the thread key while `createSession` never does.
2. A store change between the provider's preliminary lookup and the adapter's own
   load let the profile say fresh while the engine actually resumed a binding.

### Changes (provider and adapter files plus own tests only)
- `providers/session-adapter.ts`: narrow adapter contract. New
  `ConstructionBinding { bindingId, resumedBinding }` and optional
  `SessionAdapter.describeConstruction(session)`. Both production adapters record,
  per created session in a WeakMap, the exact store key they consulted and the
  persisted id they passed to the engine (null when fresh), frozen. The Claude
  diagnostic lookup is documented as diagnostic; its fallback is unchanged for
  other callers. No options-object callback: independent fixtures clone options.
- `providers/session-backed.ts`: the preliminary lookup remains only as the
  pending/failed gate and is recorded as `preliminaryLookup`. After creation and
  before `start()`, the profile is derived from the authoritative snapshot:
  `bindingSource: "construction"` from `describeConstruction`, else from the
  session's constructed `externalSessionId` when the session exposes that
  property, else `"unavailable"` with `persistedModelIdentity: "unknown"`.
  `fresh-session` is asserted only when construction is known and resumed nothing.
  Pending and failed lookups remain unknown. `bindingId` is exposed when reported.
  Warm-profile refusal, concurrent-creation reservation, requested-versus-acknowledged
  model, text-only enforcement and terminal-error precedence are unchanged. No
  binding is cleared or replaced.
- `tests/native-model-profile.test.ts`: two expectations updated for the new
  fields (a controlled adapter that neither describes construction nor exposes a
  binding is now `unavailable`/`unknown`, not fresh). Three new cases with the real
  adapters over an in-memory store and replaced start/send only: Claude auxiliary
  with legacy history constructs fresh under the text-only key and the history is
  untouched; Codex resumed and fresh threads report construction truth; a store
  that changes between lookup and construction yields construction truth with the
  stale preliminary lookup visible.

### Evidence
- Three independent model files via G5, 12 cases (4 + 5 + 3), unchanged:
  `.foundry/qa/2026-09-07T04-03-20.148Z-G5/report.json` verification passed,
  `sourceChangedDuringChecks: false`, source before = after
  `3861d054f1b57c4188265e79c2cf60797a9493d1c3bfe474cbfecb7bc83d1117`.
  An earlier run at 04:02:40 passed every check but was marked stale because
  concurrent source edits (Astra's) landed during it; retained, not relied on.
- Full baseline: `.foundry/qa/2026-09-07T04-03-22.766Z-baseline/report.json`
  passed with the same stable fingerprint.
- Own offline tests: 10 pass. Existing provider/adapter/providers/agent-selection/
  failure/session suites: 81 pass. Foundry typecheck exit 0. Strict standalone
  compilation of the three independent files and my test file: exit 0.

### Limitations
- Construction truth is what the adapter constructed the engine with. Whether the
  native runtime actually honored the resume is still only observable through
  native acknowledgment envelopes, which the installed engine does not retain for
  Claude init; `nativeModel`/binding acknowledgment stay separate and often undefined.
- Adapters not implementing `describeConstruction` and sessions not exposing a
  constructed binding are reported `unavailable`/`unknown`, never fresh.
- The Claude auxiliary text-only key remains a distinct binding namespace by
  design; legacy coding history is preserved and never resumed as middleware.
- Files changed: `packages/foundry/src/providers/session-adapter.ts`,
  `packages/foundry/src/providers/session-backed.ts`,
  `packages/foundry/tests/native-model-profile.test.ts`. Nothing else.

---

## Correction 4, S5 (2026-09-07, ~04:06-04:12Z): immutable native model evidence

Status: complete and self-verified for the provider slice. NOT self-accepted.
Awaits Astra re-review and supervisor acceptance.

### Defects (Astra's second Medium finding; supervisor reproduction,
native-model-evidence-ownership.test.ts, real provider + Claude adapter + installed
parser over synthetic streams, no processes)
RED before edits: 0 pass / 2 fail at ~04:06Z, matching
`.foundry/qa/2026-09-07T04-02-43.392Z-G5/report.json`.
1. A caller mutated a returned result's nested `raw` into a fake own-binding
   system/init; the next completion reported a fabricated model from mutable
   session history.
2. An external session observer mutated the next result's `raw` before the
   provider read it; the installed parser shares that object with its own
   dispatch, lost the completion and hit the 100 ms deadline.

### Changes (provider and adapter files plus own tests only)
- `providers/session-adapter.ts`: `attachEvidenceOwnership(session)`, applied by
  both production adapters after id persistence:
  1. the adapter subscribes first and copies each supported configuration
     envelope (Claude system/init with session_id and model; Codex
     session_configured with thread_id or session_id and model) into a frozen
     `ConfigurationEvidence` fact, once, at the first event boundary;
  2. `session.onEvent` is wrapped so later subscribers receive one detached,
     deeply frozen clone per event (cached per event, shared), so an observer can
     neither corrupt the engine's parsing nor another observer's view;
  3. `session.send` results carry detached frozen clones of that turn's events.
  No accumulated history is copied; each event is cloned at most once. New
  optional `SessionAdapter.observedConfiguration(session)` exposes the facts.
- `providers/session-backed.ts`: acknowledgment reads the adapter's owned facts
  for this session's binding when the adapter provides them; mutable engine
  history (`session.events`) is no longer consulted at all. Adapters without the
  contract fall back to this turn's returned events only, and their results are
  cloned before return. Requested model stays `model`; acknowledgment stays
  `raw.nativeModel`; foreign, unknown and tool envelopes remain non-evidence.
- `tests/native-model-profile.test.ts`: three cases. Claude over a controlled
  transport: returned event and raw are frozen and reject mutation; a later
  observer's forgery neither breaks completion nor produces an acknowledgment;
  observed facts stay empty because the installed engine never surfaces the init
  as an event. Codex: same discipline for session_configured. Controlled adapter
  providing owned facts: owned facts win over a forged returned envelope.

### Evidence
- FOUR independent model files via G5, 14 cases (4 + 5 + 3 + 2), unchanged:
  `.foundry/qa/2026-09-07T04-10-29.020Z-G5/report.json` verification passed,
  `sourceChangedDuringChecks: false`, source before = after
  `ce973e30e5cd0f2011c5077fb40a6fc0c219ed093efd6ada41f59415bae1c05d`.
- Own offline tests: 13 pass. Existing provider/adapter/providers/agent-selection/
  failure/session suites: 81 pass. Foundry typecheck exit 0. Strict standalone
  compile of the four independent files and my test file: exit 0.
- Full baseline: NOT stable for this slice at time of writing.
  `.foundry/qa/2026-09-07T04-10-40.821Z-baseline/report.json` passed every check
  but was marked stale (Astra's concurrent edit landed mid-run, fingerprint moved
  from `ce973e30…` to `7e4f8997…`). The rerun
  `.foundry/qa/2026-09-07T04-10-59.489Z-baseline/report.json` on the new revision
  has 4 failures, all in Astra's in-progress causal-learning review tests (delayed
  owned review commit, review freezes three segments, invalid reviewer output ×2);
  core 313 pass; my focused provider/adapter suites pass 94/94 on that same
  revision. This is Astra's active work, not this slice; a combined baseline must
  be rerun by the supervisor once that work settles.

### Limitations
- Owned evidence can only capture what the engine surfaces as events. Installed
  agent-session 0.1.0 surfaces neither the Claude first init nor the Codex
  session_configured notification, so real acknowledgment remains unobservable
  today; the positive path is proven through a controlled adapter only. No
  acknowledgment is manufactured from our request.
- The compatibility boundary wraps the engine's subscription and send surfaces
  from the adapter, pending I adoption of the sibling's own immutability. It does
  not change the engine or add a dependency.
- Files changed: `packages/foundry/src/providers/session-adapter.ts`,
  `packages/foundry/src/providers/session-backed.ts`,
  `packages/foundry/tests/native-model-profile.test.ts`. Nothing else.
