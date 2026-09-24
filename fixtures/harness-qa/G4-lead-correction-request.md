Fable's independent review has completed, actual native end_turn23:39:56.140Z,
primary Foundry turn turn_67b752d3-2c68-41c1-8f71-fd8da2b3b69b. Your prior
implementation's actual native task_complete23:33:45.475Z is verified. The G4
slice is reopened, not accepted. Continue as provisional lead in this same native
Astra session; the overall goal and reviewer roles are unchanged.

Read the latest CORE-003 entry and the verbatim review at
fixtures/harness-qa/QA-2026-09-06-fable-G4-review.md. Supervisor independently
reproduced the blocker in fixtures/harness-qa/acceptance/failure-evidence.test.ts:
three existing tests pass, both new HTTP/SSE cases fail. Evidence:
.foundry/qa/2026-09-06T23-41-54.959Z-G4/report.json. Run this file unchanged.

Blocking defect: execution succeeds, but completeTurn fails to commit. Both routes
catch that as an execution failure. HTTP drops completed output; SSE exposes the
completed result as unconfirmed partial output. Separate execution outcome from
persistence outcome. Preserve actual completed output, trace and initial input;
report persistence failed/unsaved explicitly. Do not return a false durable ACK,
call completed output partial, replay native work, or hide the original commit
error with a second failTurn attempt. Keep output under the normal output field
and explicit persistence metadata in both transports. Choose coherent status and
event semantics and test actual UI handling, not just the HTTP payload.

Preserve completed-but-unsaved browser evidence through reload/reconciliation,
separate from the journal's unresolved turn, without implying that local browser
storage is durable server state. Add regression coverage for both routes, real
SQL-trigger failure after successful execution, no duplicate execution, and
browser reconciliation. Previously failed-execution evidence and its partial
output handling must remain correct. Do not weaken or edit independent acceptance.

Review suggestions need judgment: a successful Harness trace proves executor
completion, NOT necessarily an actual native terminal acknowledgment. Missing
provider-input metadata does not by itself prove no native operation started.
Do not replace unknown with fabricated completed/not-started native status. Keep
attempt, provider, native and journal outcomes distinct. Report the follow-ups
for live reconciliation without restart, explicit not-started evidence, guard
failures after execution, not-recorded UI labels, artifact copy overhead and
readability. Do not broaden this corrective slice into a new session protocol or
automatic recovery/retry system.

You own runtime routes, existing local evidence/state interfaces and conversation
UI as narrowly needed, plus focused tests and your CORE-003 work-log entry.
Preserve all other dirty changes. No engine/provider/dependency edits, acceptance
fixture/gate edits, server restarts, detached agents, native subprobes, commits,
publication or credentials. Primary Fable4400 and Astra4407 remain on their prior
server builds; only disposable failure fixture4408 was restarted for QA.

Independent supervisor browser/storage QA is in
fixtures/harness-qa/QA-2026-09-06-failure-evidence.md: partial output and failed
trace survived SIGKILL/restart, then passed visible/fresh-browser checks after
your UI fix. Those checks do not cover successful-execution commit failure yet.
The Mac is locked; this assignment is sent through Foundry's local stream API,
not by changing your native binding. Visible browser control can resume on unlock.

Implement the correction now, run unchanged five G4 acceptance cases, focused
tests, full baseline/typecheck and all twelve G3 acceptance cases. Record evidence
and remaining limitations, then return the implementation report for Fable's
read-only re-review. Do not self-accept G4 or advance to S0 before review.
