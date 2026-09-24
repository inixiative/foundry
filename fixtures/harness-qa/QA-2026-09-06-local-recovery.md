# Local Recovery QA

## Scope

Production viewer, routes, factory/runtime, SQLite journal and inspector. Only the
fixture LLM is deterministic. This verifies accepted-turn/artifact durability and
metadata recovery, not native continuation, cache reconstruction or fork parity.

Command (run again against the same directory to recover):

```sh
LIFECYCLE_QA_PORT=4404 LIFECYCLE_QA_RUN_ID=recovery \
LIFECYCLE_QA_DIR="$PWD/.foundry/qa/recovery/2026-09-06-2133" \
bun scripts/lifecycle-fixture.ts
```

The live store holds an exclusive file lock. Stop its owner before starting a new
viewer against the same directory; a competing opener is rejected. Do not copy a
live SQLite file alone and assume its WAL has been included. The implementation
uses Bun's existing SQLite dependency and transactions, with FULL synchronization.
References: [Bun SQLite](https://bun.sh/docs/runtime/sqlite),
[SQLite locking mode](https://www.sqlite.org/pragma.html#pragma_locking_mode).

## Observed Sequence

1. Opened the visible fixture browser, thread `lifecycle-a-recovery`.
2. Sent a normal message through the composer. Observed the deterministic response,
   layer chips and trace button. Renamed the thread to `Recovery A preserved title`.
3. Captured serialized artifact and trace hashes through the actual HTTP APIs.
4. Sent `HOLD` through the browser. Verified a live buffer for
   `turn_01a078a3-3221-7598-8f07-03bcea7409af` and the fixture owner PID 15549.
5. Sent SIGKILL to that exact fixture PID; process exit was 137. Primary Foundry
   on port 4400 was not restarted or interrupted.
6. Restarted the same command/directory. Four messages were returned from disk:
   the prior input/response and HOLD/interruption record. The thread was waiting,
   with its human title preserved. No native success was inferred.
7. Fixed a browser recovery defect: the message endpoint now attaches the persisted
   trace summary, and a trace ID alone is sufficient to render its inspector button.
   Restarted the fixture and opened its historical trace and Turn Context panel.
   Visually verified the recovered conversation and interruption warning.

## Exact Evidence

- Completed turn: `turn_01a078a2-921d-78f3-a05e-0aad4d5076f6`.
- Trace: `trace_01a078a2-9222-7dee-8484-2886283083de`.
- Serialized injection Bun.hash before/after: `4828754341207583251`.
- Serialized trace Bun.hash before/after: `9627835854504694107`.
- Journal: `.foundry/qa/recovery/2026-09-06-2133/sessions.sqlite`.
- Focused G4 evidence: `.foundry/qa/2026-09-06T21-38-20.226Z-G4/report.json`.

Ten focused cases cover reopen, exact artifacts, project scope, duplicate IDs,
transaction rollback on serialization failure, interrupted outcome/idempotence,
single-writer ownership, normal/SSE HTTP persistence, projectless metadata/archive
restoration and refusing unsupported native-history changes. The three initial
route cases failed before integration; later trace-summary, interruption-state,
second-writer and fork/rewind assertions also failed before their fixes.

## Open Work

- Persist and restore validated domain knowledge and cache/librarian state with
  project ownership and causal revisions. Metadata recovery is not cache recovery.
- Migrate/preserve old browser-only, checkpoint and optional Postgres history before
  primary rollout. Existing native tapes and sessions.json remain untouched.
- Recover native ongoing/completed outcomes after interruption and expose native
  events/cancellation. A journal interruption is an observation gap, not proof a
  native process was killed.
- Implement native fork/rewind before enabling durable-history mutation. Returning
  unsupported is temporary and does not satisfy the final goal.
- Add durable partial streaming, pagination beyond the latest history window,
  failed-turn trace artifacts, database schema migrations and export/backup tooling.
- Inspector narrow-width layout and archived-state controls remain G6 work.
