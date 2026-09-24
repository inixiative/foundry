# Conversation Correlation And Recovery QA

Date: 2026-09-06. Production factory/runtime/viewer, deterministic provider.
This is not native Astra/Fable parity evidence.

## Automated Checks

`bun scripts/harness-check.ts G6 packages/foundry/tests/conversation-state.test.ts packages/foundry/tests/local-recovery.test.ts packages/foundry/tests/local-session-store.test.ts`

18 pass, typecheck/diff check pass with stable source fingerprint:
`.foundry/qa/2026-09-06T22-01-42.638Z-G6/report.json`.

Conversation cases cover interleaved turn-specific updates, legacy preservation,
stable identity reconciliation without text guessing, repeat reconciliation,
request-response grouping across reverse completion, unconfirmed recovered partials,
split CRLF SSE frames, terminal errors, malformed data and premature EOF.
The new module was initially missing; the grouping regression was additionally
observed failing on actual output order before the grouping correction.

## Browser Exercise

Started `LIFECYCLE_QA_PORT=4405 LIFECYCLE_QA_RUN_ID=conversation bun scripts/lifecycle-fixture.ts`.
The fixture adds a five-second SLOW request and echoes the request in its response.
Used the visible composer to submit SLOW and FAST consecutively at 21:59:33 UTC.

- Thread: `lifecycle-a-conversation`.
- SLOW: `turn_11b470e3-ec26-401b-8882-632503a878fb`.
- FAST: `turn_8c8a374d-9385-44c0-8ce1-3d99549d1ddd`.
- FAST finished at 1788731973706; SLOW finished at 1788731978698.
- The visible responses matched their own requests and both had trace controls.
- Screenshot inspection showed both pairs without crossed content.
- Opening a fresh tab on the same URL recovered exactly two pairs in original
  request order, without duplicate server/browser rows.
- SLOW's trace button opened turn `turn_11b470e3-ec26-401b-8882-632503a878fb`,
  duration 5007ms, trace `trace_01a078bb-e03a-7857-9947-b1bc75376a0e`.
- FAST's durable trace is `trace_01a078bb-e048-7111-b417-2315882a8435`.

Fixture journal:
`/var/folders/yx/jwkxhh5x74q93m8x0mwdbfl00000gn/T/foundry-lifecycle-qa-ppQ4mi/sessions.sqlite`.

## Limits And Follow-up

Browser-only historical rows are preserved and labeled; a one-time localStorage
backup precedes reconciliation. They are not imported into the SQLite journal.
Browser storage quota can still prevent a backup, which now produces a warning.
Unidentified legacy rows are intentionally not deduplicated by text.

The journal retains acceptance/completion order; the UI groups each response with
its identified request. Completion timestamps are unchanged. Primary 4400 has not
been restarted or migrated, and its currently loaded UI retains its old code until
reload. Native tool events, cancellation, fork/rewind, knowledge/cache restoration
and partial-output journal persistence remain outside this slice.

Existing narrow-sidebar labels and long right-panel path clipping remain G6 layout
issues; no responsive-layout correction is claimed by this functional QA.
