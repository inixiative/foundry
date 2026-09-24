# App-server recovery boundary

## Missing Idle Status11:15Z

Parent reviewed final R0 source788be251bf652bde03021721bacab5e7471232b3b1d31f850163a9c41771a662.
Installed Thread schema requires status (as well as other fields); ThreadStatus
distinguishes idle/active/notLoaded/systemError. R0 rejects explicit non-idle
status but permits absent status and still writes turn/start. Missing status is
not authoritative idle capacity, even if diagnostics keep it absent.

Parent fixtures now provide explicit idle status and empty turns on normal
thread responses; wire fixtures also return a valid owned turn/start Turn rather
than an empty object. Existing assertions unchanged, with two added cases for
missing status and explicit active status. Outcome fixture setup also declares
idle state, preserving its original five assertions. These strengthen incomplete
setup; earlier ten positive reports remain bounded historical results.

Combined12cases11pass/1fail37assertions, strict types pass:
.foundry/qa/2026-09-07T11-15-31.400Z-834e02e8-5297-4661-a9bd-59c2822c95f1-G5/report.json.
Codex788be... equal before/after. Only missing-status case fails: one turn/start
sent where zero was required. Active-state refusal and original10 controls pass.
Astra bounded correction and Fable opposite review dispatched after actual R0
terminal11:14:19.969Z; see canonical readiness QA. No R0 source acceptance yet.

## Added Outcome Checks11:04Z

Parent native-app-server-outcomes.test.ts adds five controlled production-class
cases: native completed identity/RPC evidence, explicit native failed evidence,
foreign thread/turn terminal refusal, native turn effort, and refused durable
admission with zero work writes. Installed Turn/TurnCompletedNotification/
TurnStartResponse/TurnStatus shapes were parsed directly, not inferred from the
legacy MCP event contract. The original five wire tests remain unchanged.

Current outcome fixture1pass/4fail11assertions, strict types pass:
.foundry/qa/2026-09-07T11-04-19.740Z-6022ae1c-72a3-47bc-90d2-39c90d7943fe-G5/report.json.
Stable rootcfd3085cf6056cb1387905311945e43cc1954047ad37c9d21794e482c578f922.
Sibling Codex e2ec810d88f5390f5ae76820cd84bb75c75af8cb678ae5679e9829d2535f4109
and installed schema d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a
verified equal before/after. All model/native processes are controlled streams.
Initial11:02:15 and11:03:48 reports retained. The failed-native assertion was
refined from requiring rejection to allowing either typed failed result or
typed rejected attempt: native failure is independent of local settlement.
The same production case remains RED (native outcome unknown), not a green
obtained by accepting ambiguous failure. Other four assertions unchanged.
On baseline, foreign terminal settles work, failed status looks like local
success with unknown native outcome, and effort is absent from turn/start.
These are current WIP negatives, not a verdict on Astra's unfinished correction.

Parent independent controlled tests, not native session acceptance. Existing
sibling CodexAppServerSession is not ready to replace the live MCP adapter.

## Evidence

Installed0.153.4 schema
.foundry/qa/mcp-schema-MRgYa5/codex_app_server_protocol.v2.schemas.json
SHA256 d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a:
ThreadResumeParams requires threadId, allows config, and has no client rollout
path parameter. ClientRequest names mcpServerStatus/list, not mcp/serverStatus.
TurnStartParams requires input array; text items require type and text, with
optional text_elements. Parent parsed the schema directly.

[Official app-server documentation](https://learn.chatgpt.com/docs/app-server)
independently documents stdio as the default transport, typed turn input,
thread/resume by stored ID, and mcpServerStatus/list. These current docs are
corroboration, not a substitute for the installed-version schema. No model or
server process was launched for this check.

Actual sibling src/codex-session.ts inspected: the existing class selects a WS
listener while using the base stdio loop; sends input as a string; and skips
thread initialization entirely if externalSessionId exists. Its completion
normalizer and shared ownership integration also need review before adoption.

New parent fixtures/harness-qa/acceptance/native-app-server-recovery.test.ts
uses that production class over controlled pipes, with permissive replies so
each assertion isolates one wire defect. Initial4cases all fail at10:51:37.
Added a positive initialize/create/one-turn/teardown control; allowed optional
text-item metadata instead of requiring its absence. Final5cases1pass/4fail,
9assertions, strict types pass:
.foundry/qa/2026-09-07T10-52-39.777Z-fa6251f1-ed54-42e2-b8dc-98e8b50cf5d9-G5/report.json.
Root stable debacad7d90f5cbd83052dad4c719867a12c2236dde0dee532f7f3e1af1ca4d4.
Sibling codex source and installed schema hashes checked before/after, equal.
Codex source e2ec810d88f5390f5ae76820cd84bb75c75af8cb678ae5679e9829d2535f4109.

Failures: mismatched selected transport; untyped turn input; no cold resume;
therefore no fail-closed resume branch before turn dispatch. The positive is a
controlled wiring check, not genuine native completion, retained history or
known physical capacity. Original frozen candidates/captures stay immutable.

## Required Next Step

Lead should decide the shortest existing-engine path to full native recovery,
not only a fresh legacy MCP tool fix. No client-side rollout scanner is justified
by the schema. Explicit engine choice, exact binding/account ownership, original
unknown outcomes, tool configuration and native turn identity remain mandatory.
Never activate this class on a live binding merely because these five tests pass.
Require native completion/failure/foreign-event/usage/cancel tests, existing MCP
regressions, opposite review and separately authorized native create/resume/restart
evidence. Keep artifacts/fork/subsessions/inspection/performance in the full graph.
