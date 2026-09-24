Privately: nothing further is needed. The load fix is verified with all six independent files at 19 cases, the handoff is updated, and the sibling re-review has the source, tests and handoff in hand. Report follows.

## Task 1: load boundary, complete and verified

`ConfigStore.load` now builds the merged candidate, runs the shared validator, and only then assigns live state and the loaded flag. An invalid persisted policy throws with the file path and validator message, keeps the last working live configuration or in-memory defaults on a fresh store, and leaves the file untouched. Legacy files without a selection field and files with `selection: false` load unchanged, as does the normal default and provider merge. No second validator.

| Check | Result |
|---|---|
| Supervisor load-boundary file before edit | 2 fail, 1 pass |
| All six independent memory files via G3, unchanged | 19 pass, typecheck, diff check |
| Full baseline | pass |
| Focused config suites | 13 pass |
| Both typechecks | exit 0 |

Reports: `.foundry/qa/2026-09-07T02-40-13.626Z-G3/report.json` and `.foundry/qa/2026-09-07T02-40-16.265Z-baseline/report.json`. Handoff: `fixtures/harness-qa/QA-2026-09-07-fable-memory-selection.md`, new "Correction 3" section, which also retracts my earlier "API-only" claim. The guard blocks the production factory, executor and real SessionBackedProvider path before native session creation with an inspectable conflict. It refuses; it does not retrieve, and it proves no native bridge or rollout. Only config.ts and one test file changed. Not self-approved.

## Task 2: read-only re-review of Astra's S1 historical correction

Both prior Medium findings are resolved in source and covered by tests.

- **Transport attribution.** Both engines set transport failure only on the still-open owned admission and record idle end-of-stream as a session-level `session_end` with a transport outcome. The sibling tests assert the first completed attempt stays open after a later failure, in both buffered-terminal variants, and that a timed-out attempt keeps its timeout snapshot.
- **Unowned and foreign evidence.** Both engines retain such lines as frozen `native_status` events with `correlation: "unknown"`, no admission id and an explicit reason among no-admission, foreign session or turn, duplicate terminal, after-terminal and unrecognized event. Tests confirm no identity adoption, the active attempt's content stays empty, the resume binding is unchanged, and results exclude unattributed events. Raw envelopes stay separate from user-facing content because they never pass through the attempt's record path.
- **Observer diagnostics.** Counters only, frozen, no exception payload, original error preserved. The unrecognized Claude terminal now carries its own local failure reason.
- **Privacy.** The sanitizer allowlists the new reason enum, the diagnostics container and its two numeric fields only. Unattributed raw envelopes go through the existing raw-event sanitization.

Remaining, none blocking: refusal retention stays uncapped, measured and deferred to a separate retention node with a reasonable plan. Verdict: accept the bounded source slice, with my two reopen items closed. Broader gates stay open as the handoff states. I relied on the supervisor's cross-check and suite reports rather than rerunning the sibling suite.

## Leadership and scope checkpoint, conditional on supervisor acceptance

Astra's two corrections were precise, test-backed and did not overreach. If the supervisor accepts both this memory slice and the S1 source slice, advancing to count 4 with Astra continuing as lead is warranted. The code-only S1 slice does not satisfy native S1 or G5. Still explicit and open: the two-admission disposable continuation recording, Foundry integration of the sibling, scoped native tools, streaming, cancellation acknowledgment, usage accounting, attachments, tags and artifact inspection, fork, rewind and subsessions, latest model and effort selection, three-part decoration under native delivery, and subscription-independent continuity. Count remains 3 until the supervisor decides.
