# Committed Knowledge Recovery QA

Date: 2026-09-06. This exercises the production factory, runtime, journal, viewer
and browser with a deterministic provider. It is not Astra/Fable parity evidence.

## Tests

`bun scripts/harness-check.ts G4 packages/foundry/tests/knowledge-store.test.ts packages/foundry/tests/knowledge-recovery.test.ts packages/foundry/tests/local-session-store.test.ts packages/foundry/tests/local-recovery.test.ts`

19 tests pass, typecheck/diff check and stable source fingerprint:
`.foundry/qa/2026-09-06T22-16-28.550Z-G4/report.json`.

New coverage: persisted knowledge used by the next production provider after viewer
reconstruction; another thread excludes that knowledge; newly created viewer threads
are subscribed/restored; disk-write failure quarantines the owner; checksum corruption
and semantic child-owner corruption refuse execution; per-domain transactional
snapshots do not capture unrelated pending updates; duplicate events, revision
rollback, immutable exports, non-learning decisions and immutable project ownership.

## Real Process Restart

Command:
`LIFECYCLE_QA_PORT=4406 LIFECYCLE_QA_LEARNING=1 LIFECYCLE_QA_RUN_ID=knowledge LIFECYCLE_QA_DIR=.foundry/qa/recovery/knowledge-2026-09-06 bun scripts/lifecycle-fixture.ts`

Used the visible composer in `lifecycle-a-knowledge` to ask:
"Learn a fact from this work before restart."

- Turn: `turn_3897e915-999c-41fb-83c6-dce03a7f8126`.
- Learned content: `LEARNED:lifecycle-a-knowledge:aux:domain:system`.
- Owner: project `lifecycle-qa`, thread `lifecycle-a-knowledge`.
- Domain revision: 1. Content hash: `aca7716ffc499cc7`.
- Evidence: `sig-dispatch_01a078cb-972c-7b41-92cd-dd69b2259b8a`, linked to that turn.
- Journal event: `sig-learn_01a078cb-972d-7f0f-9e9a-7d03b1911c9f`.

After `/api/threads/lifecycle-a-knowledge/knowledge` reported the committed snapshot,
sent SIGKILL to the verified fixture PID53182. Exit137 was observed. Restarted the
same command at 22:17:05 UTC, PID53452. No graceful shutdown flush was available.

Before and after serialized hashes, computed using Bun.hash:

| Record | Before | After |
| --- | --- | --- |
| Stored knowledge snapshot | 16376378884049514184 | 16376378884049514184 |
| Stored learning history | 1458625296543142905 | 1458625296543142905 |

The browser reconnected and displayed the prior conversation and the warm generated
knowledge layer. Submitted "Continue after restart without repeating the learned fact."

- New turn: `turn_6d2706dc-50f8-471a-bc31-4ace27095591`.
- Trace: `trace_01a078cc-27f0-7887-9865-9a2b71fea389`.
- Provider response reports learned knowledge present; its actual saved injection
  includes `thread-knowledge:system`, the exact recovered content/hash above,
  `included: true`, and owning thread `lifecycle-a-knowledge`.
- Screenshot inspection showed the initial response with learned knowledge absent
  and the post-restart response with learned knowledge present. This is provider-
  input evidence, not just the model claiming to remember something.

Journal: `.foundry/qa/recovery/knowledge-2026-09-06/sessions.sqlite`.

## Limits

Schema 2 adds learning events and generated knowledge to the existing journal; it
does not migrate legacy browser-only conversations or reconstruct native history.
The kill happened after a learned revision committed. A process lost during a
pending review still needs explicit replay/recovery work. Other caches and Librarian
state are not restored. Quarantine closes the Foundry Thread object, not its native
process; actual cancellation is G5. Changing/removing stored domain ownership or
configuration requires an explicit migration.

The knowledge endpoint exposes committed snapshots and bounded history reads; the
full event history remains on disk. A dedicated knowledge-history inspector, cursor
pagination, export/backup and broader cache recovery are not implemented here.
