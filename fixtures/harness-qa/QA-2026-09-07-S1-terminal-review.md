# S1 Terminal Review: Corrections Required

The completed S1 implementation passes the supervisor's sibling suite and seven
unchanged independent recorder/admission tests. See the native-turn-ownership QA
record. It is not accepted: the following new ordinary tests fail.

File: fixtures/harness-qa/acceptance/native-terminal-evidence.test.ts.
Report: .foundry/qa/2026-09-07T01-56-18.851Z-G5/report.json (1pass,3fail).

## Findings

1. ClaudeCodeSession._processLine uses is_error and subtype, but ignores explicit
   api_error_status and terminal_reason. A result with success subtype and429 API
   error is marked completed if is_error is absent or false. Foundry's existing
   SessionBackedProvider already treats that API status as failure. Both layers
   must agree before the new nativeOutcome becomes authoritative in persistence.
   The retained REAL claude-limit-terminal fixture has is_error true and PASSES.
   The two contradictory/missing-flag cases are deliberately SYNTHETIC mutations
   of that envelope, not claims that those precise shapes were recorded natively.
   Explicit failure evidence must not be erased by an optimistic success label.
2. TurnState.snapshot copies its events array but shares mutable event objects/raw
   payloads with result, other snapshots and internal evidence. Modifying a
   returned result event changes the supposedly retained snapshot. The test
   permits rejection of mutation or detached copies; it forbids rewriting prior
   evidence. Check event observers and both engines too, not only this one getter.
   Preserve efficient live/late reconciliation by admission ID; deep-copying an
   entire ever-growing transcript on every event is not an acceptable shortcut.

Tests never start a native process, read credentials or mutate the real fixture.
The controlled fake transport exits in finally. Original independent admission
and recorder assertions remain unchanged. These corrections belong to the same
S1 identity/outcome boundary, not a new feature gate. Keep S4/S2 and actual native
failure/continuation evidence explicitly open; do not call source tests parity.
