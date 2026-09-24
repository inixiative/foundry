# T2 correction: owned transport lifecycle

Continue in the SAME Fable Foundry/native session after the verified public
end_turn at 2026-09-07T06:43:53.720Z for
turn_0d793c4f-a026-4013-b7ee-52a3909c6638. The supervisor read your complete
T2 handoff and transport/proxy source. This is a bounded corrective implementation,
not T2 acceptance, native activation, or a new model probe.

Independent actual loopback HTTP/SDK tests are unchanged acceptance inputs:
fixtures/harness-qa/acceptance/native-bridge-lifecycle.test.ts.
Report: .foundry/qa/2026-09-07T06-53-37.984Z-83ef9ee9-40a7-4996-8128-fafc5433eb70-G5/report.json.
Four cases: missing capability passes; three lifecycle cases fail. Explicit strict
test types subsequently passed. These are not mocked native execution results.

1. Reserve pending initialization capacity before asynchronous connection. With
   maxSessions=1 and the first connection held, the second initialize returns200
   instead of429. Failed reservations must release exactly once; success must not
   double-count. Cover connect rejection, bridge close and owner revocation during
   an outstanding initialize as well as ordinary concurrent admission.
2. runProxy(connectOnly) must explicitly terminate its own HTTP SDK session before
   closing its client. It currently leaves sessions=1 and exhausts a one-session
   bridge after a single verification. Apply the same owned cleanup discipline to
   normal proxy close and partial startup failure. Use installed SDK APIs, not
   hand-rolled protocol. Disconnect is not native cancel, native idle evidence or
   permission to replay work. Do not kill/rebind any native process.
3. Failed initialize must close its allocated server/transport. Invalid params
   correctly returns an error and sessions=0, but created=1/closedServers=0.
   The current pool also retains all created servers until whole-bridge close.
   Separate retained immutable invocation evidence from live resource ownership;
   do not discard existing tool records to solve resource retention. Verify
   repeated failed and explicitly terminated sessions do not accumulate live
   servers. Clean all owned resources on partial bridge/proxy setup failure.

Recheck closed/authority status at asynchronous admission boundaries. Source
currently checks before reading the body and connecting; use controlled tests to
establish any further race rather than claiming it has already been reproduced.
Keep cleanup idempotent and awaitable. Never allow a late initialization to escape
a completed bridge close. Preserve capability redaction, read-only scope, immutable
tool records and correlation, existing T1 diagnostic safety and owner revocation.

Own only MCP transport/proxy modules, focused tests and your T2 handoff. Astra is
actively changing core/provider/adapter/runtime/journal/UI and sibling staging;
do not overwrite that work or modify supervisor acceptance tests. Run these four
unchanged cases, existing13 independent scope/invocation cases, MCP/scope/transport
regressions, explicit source/test types and diff checks. Include real stdio proxy
shutdown coverage. Record exact reports and remaining limitations in
docs/T2-live-transport-handoff.md before a public terminal handoff. No self-acceptance.

No native model calls, detached agents, root installs/dependency edits, live
restart, account/binding changes, credential reads/copies, publication or commits.
Same long-term CORE-003/004 goal and provisional Astra lead remain. Lead count6,
checkpoint8 or serious regression. Actual central-native bridge wiring and paired
tool/artifact/latency acceptance remain a later explicitly supervised gate.
