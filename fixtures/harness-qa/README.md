# Harness QA Scenarios

Start a disposable project with:

```sh
bun scripts/prepare-harness-project.ts release-notes
bun scripts/prepare-harness-project.ts documentation
bun scripts/prepare-harness-project.ts tool-workbench
bun scripts/prepare-harness-project.ts contact-migration
```

Each invocation prints a fresh local git repository path under `.foundry/qa/projects`.
No commits, network calls or edits to canonical fixtures are made. Open the printed
path as a Foundry project when the relevant gate is ready for native acceptance.

| Scenario | Gates | Evidence required |
| --- | --- | --- |
| Production factory A/B isolation | G1 | Independent sentinel tests, including concurrent dispatch |
| Lifecycle, duplicate initialization, cleanup | G2 | Production runtime tests; correctly scoped event payloads |
| CLI feature and artifact | G5-G7 | Native tool records, before/after diff, test output, release.md artifact |
| Source revision and learned convention | G3/G6 | Exact old/new contributions, cache revisions, immutable old turn |
| Private thread knowledge and fork | G1/G4/G6 | Distinct input snapshots and explicit inherited lineage |
| Restart during work, resume | G4/G5 | Pre-restart checkpoint, same native binding, recovered artifacts |
| Tool failure and cancellation | G5/G7 | Terminal error/cancel event, no orphan work, successful next turn |
| Timing and repeatability | G7 | Direct native baseline, stage timings, three consecutive scenario passes |
| Contact migration and expert memory | CORE-006 | Real legacy SQLite upgrade, separate expert interpretations, next-turn input and restart provenance |

Contact-migration is the executable starter for the prioritized domain-expert
loop. Its baseline passes; its opt-in migration checker deliberately fails until
the native agent implements the requested feature. Failed and successful checker
attempts retain separate databases and reports. Local results are not native or
middleware acceptance; see the sample README for the actual loop protocol.

The release-notes and tool-workbench projects have executable baselines;
documentation has a manual source-revision exercise. Tool-workbench supplies an
intentional exit7, correlated job/artifact output and a120-second cancellable tool
for native failure, stop, same-binding continuation, fork and child-session QA.
Its four local tests do not establish those Foundry/native capabilities. The
existing context-inspection fixture remains useful
for browser checks but does not establish production lifecycle or native parity.
`bun scripts/lifecycle-fixture.ts` starts the production factory/runtime/browser
path on port 4402 with a deterministic provider and temporary configuration. It is
separate from the primary work session. Send a message in A, inspect revision A in
the turn artifact and revision B in current state, then inspect B for a private
marker leak. Create another thread through the UI and check it has thread-state,
middleware effects and its own event attribution. This still does not prove native
provider parity, durable recovery, or complete message decoration.
Record model/runtime versions, source fingerprint, turn IDs, commands and artifact
paths for every native run. An assistant saying it passed is not acceptance evidence.

For an isolated real native probe, run:

```sh
bun scripts/native-qa-fixture.ts codex <prepared-project-path>
```

Use `claude-code` for Fable; set `NATIVE_QA_PORT` for a separate port (default 4403).
The printed browser URL uses the production factory/runtime with one native
executor and a deterministic no-op flow. Completed-turn evidence goes beneath
`.foundry/qa/native/`, including actual native input and available tool events;
thinking events are deliberately omitted. This tests native execution, not full
decoration or capacity/latency parity. See `QA-2026-09-06-native-astra.md`.

`bun scripts/decision-qa.ts` runs two real Fable classification requests that try
to redirect the decision session into writing a harmless sentinel file. Acceptance
requires valid decision JSON, no native tool calls and no file creation. It writes
evidence under `.foundry/qa/decision/` and terminates its native process afterward.
`bun scripts/native-model-catalog.ts` performs read-only Codex app-server discovery
without creating a thread or model turn; evidence goes under `.foundry/qa/native-catalog/`.

Decoration acceptance is explicitly executable (the default baseline omits these):

```sh
bun scripts/harness-check.ts G3 fixtures/harness-qa/acceptance/message-decoration.test.ts fixtures/harness-qa/acceptance/decoration-deadline.test.ts fixtures/harness-qa/acceptance/domain-learning.test.ts fixtures/harness-qa/acceptance/tool-evidence.test.ts
```

All twelve cases pass in `.foundry/qa/2026-09-06T23-59-14.879Z-G3/report.json`.
This is bounded composition/deadline/causal-learning/tool-evidence proof, not full
G3 acceptance: selected delivery, native retained context and native tool event
bridging still need proof. CORE-003/004 contain the authoritative gate ledger.

## Recovery Checks

```sh
bun scripts/harness-check.ts G4 fixtures/harness-qa/acceptance/failure-evidence.test.ts
```

Five independent production factory/viewer/SQLite cases cover preparation failure,
overlapping partial failures, rejected failure commits, and successful execution
followed by rejected completion commits over both HTTP and SSE. The baseline does
not include these cases. See QA-2026-09-06-failure-evidence.md for exact passing
reports, earlier failures, real fixture SIGKILL/restart proof and remaining limits.

- `scripts/check-failure-viewer.mjs`: committed failed output/trace inspection at
  390/1440px against port4408 by default.
- `scripts/check-unsaved-viewer.mjs`: actual composer, rejected completion commit,
  browser reload and separate journal/browser evidence at port4409. Its
  `QA_RESTORE_REPORT` mode restores only the controlled fixture's browser state
  after an independently performed server restart and sends no new request.
- `scripts/check-browser-storage-failure.mjs`: rejects the message-storage key with
  quota/security errors; requires persistent tab-only evidence status after the
  notification expires. Both cases initially failed in
  `.foundry/qa/browser-storage-failure/2026-09-07T00-06-41.585Z/report.json`, then
  passed in `2026-09-07T00-18-27.255Z/report.json` under the same parent directory.
  Final captures scroll the tested warning into view and were visually inspected;
  the first passing DOM-only capture was insufficient visual proof.
  Astra's correction is complete and awaiting independent review, not rolled out.

Browser scripts use Playwright via Node's `NODE_PATH`; the bundled runtime location
is recorded in current work logs rather than installed as a project dependency.
All accept `QA_URL` for an isolated fixture URL. They are controlled-provider QA,
not native cancellation, artifact or account-continuity evidence. Do not run their
failure probes against the primary work or review thread.

The lifecycle fixture's `LIFECYCLE_QA_FAILURE=1` enables preparation/provider failure
sentinels. `LIFECYCLE_QA_COMMIT_FAILURE=1` installs a persistent SQL trigger rejecting
trace commits. Use a separate `LIFECYCLE_QA_DIR` and port; this deliberately makes
results unsavable and is never a production configuration. Restart only an owned,
verified-idle fixture and retain its journal/browser evidence.

## Remaining Native Matrix

The prepared CLI and documentation projects are available; a successful Astra CLI
edit has recorded evidence. Do not imply equivalent Fable or three-run release
coverage. Fork/rewind/worktree lineage, child sessions, interrupted native tools,
attachments, artifact opening, tags, latest model/effort acknowledgment, account
continuity and direct-vs-harness performance still require their native scenarios.
CORE-004 S0 first captures current real protocols in the sibling agent-session
checkout; sibling changes are not running in Foundry until explicitly integrated.
