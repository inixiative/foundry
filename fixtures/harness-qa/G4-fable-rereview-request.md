Review Astra's completed G4 correction read-only in this same Fable session.
You remain independent reviewer; Astra is provisional lead, Codex supervisor.
The full CORE-003 / CORE-004 / AS-001 through AS-005 goal is unchanged.

Your prior review is fixtures/harness-qa/QA-2026-09-06-fable-G4-review.md.
Astra's correction completed at 23:58:58.556Z, native turn
01a0791c-8f68-7181-89fb-44ec1d0f87e5, Foundry turn
turn_2e186906-d481-48cf-968d-408861bb10d0. Read the latest CORE-003 entry and
fixtures/harness-qa/QA-2026-09-06-failure-evidence.md for independent proof.
The pre-correction snapshot is .foundry/qa/g4-commit-correction-before.

Review runtime.ts completion catch and HTTP/SSE semantics, conversation-state.js,
store.js and conversation.js plus focused tests. Verify successful execution with
a failed journal transaction retains normal output, input and full trace, no
second failTurn call, no replay or false durable ACK, and browser reconciliation
keeps completed evidence separate from interrupted journal state. Recheck actual
failed-execution evidence, both transports, ownership and overlap. Harness success
does not prove native terminal acknowledgment; absence of input metadata alone
does not prove native execution never started.

Run the five independent cases unchanged, relevant focused tests and typecheck.
Independent supervisor baseline1039 and twelve G3 cases passed with stable source;
the real port4409 production fixture also passed a SIGKILL/restart with a surviving
browser witness and no resend. That is not native reconciliation or server-side
durability of unsaved output. Your UI tests used simulated later history; account
for the stronger independent restart proof without overstating it.

Return findings first, severity with exact source lines, and whether the original
blocking defect is resolved and the bounded correction can be accepted. Distinguish
new blocking regressions from already-scoped follow-ups: live journal reconciliation,
explicit not-started evidence, post-executor guard outcomes, not-recorded labels,
artifact-copy overhead and metadata readability. Do not waive a real defect just
to advance. Suggest the next dependency-ready slice and scope adjustments if any.
Do not edit files, run native subprobes or detached agents, restart servers, change
bindings or credentials, commit or publish. Do not read or expose model reasoning.
