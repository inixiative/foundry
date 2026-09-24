# Independent G4 Failure Evidence QA

Supervisor-owned evidence for Astra's first provisional lead slice. Native lead:
`01a07901-d93d-7903-9c9d-09e5e7136573`, active implementation turn
`01a07906-30e8-7542-8d96-54444721c1e1`. Implementation and final review are
still in progress; these checks do not constitute whole-slice acceptance.

Update: Astra's native task completed at 23:33:45.475Z. Fable's read-only review
is now running in primary Foundry turn
`turn_67b752d3-2c68-41c1-8f71-fd8da2b3b69b`. Acceptance remains pending that review.

## Production Acceptance

`acceptance/failure-evidence.test.ts` uses real buildAgents/ThreadFactory,
createViewer, Harness, SQLite and the frontend SSE reader. Only the LLM and
injected faults are deterministic. Three independent cases, 43 assertions:

- Middleware rejects before provider execution: no provider call or fictional
  provider input; original request and error trace survive reconstruction.
- Two overlapping failed streams: each turn retains only its own partial text,
  provider input and error trace after reconstruction; retry IDs cannot reexecute.
- Real SQLite trigger rejects the trace transaction: original provider error and
  persistence error remain explicit, no partial agent-row commit, recovery marks
  the unresolved turn interrupted/unknown, and retry cannot replay execution.

All three pass with typecheck/diff checks in
`.foundry/qa/2026-09-06T23-28-27.541Z-G4/report.json`.
Test setup correction: the exclusive store lock correctly refused trigger creation
through a second connection. The fixture now closes bootstrap storage, installs the
fault, then opens the viewer. That setup failure was not a production regression.
The explicit `./fixtures/...` test path is needed by Bun; the bare path was treated
as a filter and did not execute tests.

## Browser And Hard Restart

Extended the existing lifecycle fixture with optional `LIFECYCLE_QA_FAILURE=1`.
Normal fixtures are unchanged. FAIL streams a sentinel, then fails; FAIL_PREP
rejects before the executor provider. Fixture URL:
`http://localhost:4408/#project=lifecycle-qa&thread=lifecycle-a-failure`.
Directory `.foundry/qa/recovery/failure-2026-09-06`; no native probes or model calls.

Sent FAIL through the visible browser. Owning turn:
`turn_b9c85508-b66e-474b-b4ea-905db3c22f80`; trace:
`trace_01a0790b-3eef-770f-b215-447124096d91`.
Journaled partial output:
`RECOVERABLE-PARTIAL: the fixture emitted this before failing.`

The initial UI displayed only FIXTURE-PROVIDER-FAILURE, while the journal contained
partial text. Independent `scripts/check-failure-viewer.mjs` reproduced this from
a fresh browser: `.foundry/qa/failure-viewer/2026-09-06T23-27-52.006Z/report.json`.
Historical trace inspection already worked; partial presentation did not.

After verifying a committed failed row and no live fixture buffers, killed only
the owned fixture PID49568 with SIGKILL (process exit137). Restarted the same fixture
and SQLite path at 23:29:09Z, PID52051. The original turn/trace IDs, exact partial
text and trace root error status survived, with no replay. Primary Fable4400 and
Astra4407 were never restarted or interrupted.

Astra's concurrent UI correction then made the unchanged browser assertion pass:
`.foundry/qa/failure-viewer/2026-09-06T23-29-35.974Z/report.json`.
Fresh browser contexts at 390 and1440px recover and expose partial text, open the
correct historical trace, and reach Turn Context without page errors. Screenshots
390-partial.png and1440-context.png reviewed: partial output is marked unconfirmed;
provider-boundary input is distinguished from delivery acknowledgment.

## Limits And Review Notes

- This proves committed failed-turn recovery, not crash-before-capture input
  persistence, replay of pending learning, native cancellation, account identity
  or native terminal reconciliation.
- The deterministic failure fixture is not proof of native stream/tool parity.
- The browser test checks recovered history and partial visibility, not every
  interactive artifact, transport disconnect, concurrent UI state or corruption.
- Source was changing under the native lead during browser QA. Rerun final gates
  and scenarios against its completed source fingerprint before acceptance.
- Review text contrast in failure metadata and the trace badge wrapping at narrow
  inspector widths. Screenshots show no overlapping primary content, but these
  details remain less readable than the main error and partial output.
- Lead owns implementation. Supervisor owns the independent acceptance fixture,
  lifecycle QA mode and browser checker; do not weaken these to obtain a pass.

## Completed-Source Rerun

- After Astra's verified completion, the independent three cases plus its two
  focused failure-evidence files pass with typecheck/diff:
  `.foundry/qa/2026-09-06T23-35-22.583Z-G4/report.json`.
- Independently reran full baseline, including unchanged gates and canonical
  fixture: `.foundry/qa/2026-09-06T23-36-07.898Z-baseline/report.json`, passed.
- Stopped only the idle fixture PID52051 cleanly, then restarted the same directory
  against completed source at 23:35:44.685Z, PID55592. The lead and primary review
  instances remain untouched and are not yet claimed rolled out.
- A new visible FAIL request preserves partial output after the error event:
  turn `turn_0c739a19-2328-4e27-a310-3478362cfd65`, trace
  `trace_01a07914-2c39-7424-b596-cd4cd2a20cde`. Fresh-browser checks pass at
  390/1440px in `.foundry/qa/failure-viewer/2026-09-06T23-36-29.244Z/report.json`.
- A visible FAIL_PREP request shows FIXTURE-PREPARATION-FAILURE, explicitly
  unavailable input and delivery acknowledgment, and a trace link. It does not
  show another turn's partial output or context chips as this turn's input.

## Reopened After Review

Fable completed review at 23:39:56.140Z. Its blocking finding is independently
reproduced: successful execution followed by completion-journal failure drops the
HTTP output and mislabels SSE output as partial execution failure. The same
acceptance file now has five cases: three pass and two new cases fail, evidence
`.foundry/qa/2026-09-06T23-41-54.959Z-G4/report.json`.

The earlier passing evidence remains valid for its tested behavior, but does not
accept the full bounded slice. Corrective work is assigned to Astra under
`turn_2e186906-d481-48cf-968d-408861bb10d0`. Preserve execution completion and
output separately from persistence failure; do not invent native terminal proof
from a successful Harness trace or replay work to repair a failed commit.

## Independent Completed-But-Unsaved Recovery

- Astra correction completed at 23:58:58.556Z in native turn
  `01a0791c-8f68-7181-89fb-44ec1d0f87e5`, same binding. Independent unchanged
  five-case acceptance plus focused completion/failure tests pass with typecheck
  and diff check: `.foundry/qa/2026-09-06T23-58-06.324Z-G4/report.json`.
  Full baseline passes: `2026-09-06T23-58-24.638Z-baseline`; twelve G3 cases
  pass: `2026-09-06T23-59-14.879Z-G3`. All three report stable fingerprints.
- Added optional SQL-trigger rejection to the production lifecycle fixture and
  independent `scripts/check-unsaved-viewer.mjs`. Initial real-composer check
  reproduced completed output labeled partial:
  `.foundry/qa/unsaved-viewer/2026-09-06T23-49-15.398Z/report.json`.
- Restarted only the owned idle port4409 fixture against corrected source at
  23:57:11.476Z, PID66377. The unchanged browser assertion now passes, including
  browser reload: `unsaved-viewer/2026-09-06T23-57-12.989Z/report.json`.
  Turn `turn_0e3b0a7f-47e5-4a45-a284-fe5a93f0bdcd` retains completed output,
  explicit unsaved warning and browser-only evidence. No saved success row exists.
- SIGKILL of that owned fixture exited137; restarted the same persistent directory
  at 23:57:33.365Z, PID66882. Restored only this controlled fixture's browser
  storage in a fresh headless context, without sending another message. Output
  survives another reload: `unsaved-viewer/2026-09-06T23-57-34.677Z/report.json`.
  Screenshot reviewed: completed browser output and journal interruption are
  explicitly separate, not relabeled execution failure or partial output.
- This proves surviving browser evidence reconciles with a real restarted journal,
  not that unsaved output becomes durable server state. No native probe, replay,
  account identity claim, primary/lead restart or visible-browser control while
  the Mac is locked. Metadata contrast remains a G6 readability follow-up.
- Fable re-review is required before accepting this bounded slice. The larger
  G4 and native-capability release criteria remain open.

## Browser Storage Rejection Follow-Up

Fable re-review completed2026-09-07T00:04:31.727Z and accepts the correction,
with silent localStorage failures tracked before rollout. Supervisor accepts one
bounded lead slice, not full G4. Verbatim review is
QA-2026-09-07-fable-G4-rereview.md.

Independent scripts/check-browser-storage-failure.mjs now reproduces both
QuotaExceededError and SecurityError against the real composer. It rejects only
the controlled thread's message key, waits seven seconds beyond a transient
notification, re-renders at a new viewport and requires persistent tab-only
evidence status on the completed result. Both fail before the correction:
.foundry/qa/browser-storage-failure/2026-09-07T00-06-41.585Z/report.json.

Astra is correcting this in native turn01a07930-1afb-7d82-9f37-b280ec15394a,
actual task_started00:06:30.913Z, Foundry turn
turn_08be568d-f7ad-42f9-9d39-785ce056b080. Do not duplicate active work or
roll out before the independent cases pass and the follow-up is reviewed.

Storage correction completed2026-09-07T00:22:06.479Z in that same native turn.
Independent focused/G4 acceptance/typecheck/diff passes in
.foundry/qa/2026-09-07T00-21-39.598Z-G4/report.json; full1046 baseline passes in
2026-09-07T00-21-54.995Z-baseline; all12 G3 cases pass in00-22-55.865Z-G3.
All report stable source fingerprints. Independent browser assertions passed in
browser-storage-failure/2026-09-07T00-17-31.365Z, but its screenshot missed the
target below the viewport. The checker now scrolls the owned result/warning into
view, requires visibility and captures again:00-18-27.255Z, both cases pass.
Final quota screenshot reviewed: completed text and persistent tab-only warning
are visible and legible without primary-content overlap. Supersedes the earlier
visual evidence, not its valid DOM assertions. Fable review remains required.
