# T2 correction: retain late owned tool evidence

Continue in the SAME Fable session after verified actual native end_turn
2026-09-07T07:05:44.266Z for turn_817cda84-8d4a-4786-a220-70a3c8fe60ce.
Supervisor read the full correction handoff and current transport/proxy source.
All49 independent/focused MCP cases, source types and diff independently pass,
304 assertions, stablef09d37e8acf5c3e418e0abdc01de9d7e9f080fc9d91bea2b7155d065cb5c7a2e:
.foundry/qa/2026-09-07T07-07-37.134Z-18c239b1-8227-4be8-84ed-ef3f56dc3aec-G5/report.json.
The three earlier lifecycle defects are corrected. Preserve these fixes.

New independent actual HTTP/SDK tests reproduce TWO lost-evidence failures:
fixtures/harness-qa/acceptance/native-bridge-late-evidence.test.ts.
.foundry/qa/2026-09-07T07-08-46.629Z-816af97f-d104-4924-99d1-d2823c66556b-G5/report.json.
Explicit strict test types pass. Tests hold an owned memory read, explicitly
terminate its SDK session or close the bridge, then release the held read. The
existing onInvocation callback observes the completed record (ok after DELETE,
refused/revoked after bridge close), but bridge.invocations() is empty in BOTH
cases. This is produced owned evidence lost by the bridge, not a timeout guess,
not proof that the native caller received a result, and not native execution.

release() snapshots mcp.invocations() before asynchronous tools finish and drops
the server from the only later query path. Preserve late immutable records with
their original owner, SDK session/request and actual outcome. Keep old returned
snapshots immutable, preserve exact-once records and the nativeCorrelation=unknown
boundary when no protocol-native join exists. Closing a transport must not erase
evidence or label work cancelled/completed merely because the client disappeared.

Separate live transport cleanup from in-flight owned operation settlement and
durable record delivery. Use an explicit bounded ownership/observation interface
if needed; do not simply retain every closed server forever, duplicate records,
block bridge.close forever on a backend that may never settle, discard late
refusals, or change tests to release the backend before the close being tested.
Keep authority revocation immediate and cleanup state truthful. Extend focused
coverage for late completion/refusal, concurrent calls, observer failure and
retained records without resource accumulation. No fabricated native cancellation.

Own MCP modules and focused tests/handoff only; a narrow additive server record
observation interface is allowed if needed, but preserve T1 observer exception,
immutable ownership and diagnostic redaction contracts. Astra remains active on
core/provider/runtime/journal/UI/sibling/staging. Do not edit those files or the
supervisor acceptance tests. Run the new two unchanged cases plus previous49,
source/strict types and diff. Update docs/T2-live-transport-handoff.md with exact
evidence and limitations before a public terminal handoff; no self-acceptance.

No new models/agents, native activation, account/credential/binding changes,
root installs, live restarts, publication or commits. Same long-term goal and
provisional Astra lead, count6-next8. After independent review, promptly advance
the existing native bridge integration and actual both-engine tool/artifact
scenarios rather than expanding into a separate architecture project.
