Nothing further is needed. The default test globs stop at the top-level test directory, so the browser test is opt-in and did not affect the baseline. Report follows.

## Verification

| Check | Result |
|---|---|
| five independent acceptance cases, unchanged | 5 pass |
| focused core failure-evidence | 5 pass |
| focused foundry failure-evidence | 10 pass |
| focused completion-persistence, both transports | 2 pass |
| typecheck, both packages | exit 0 |
| my throwaway success-then-journal-failure reproduction, rerun against corrected source | HTTP 500 with full output, SSE `done` with full output, status `completed-unsaved`, trace root `ok`, turn row still `active`, no agent row, no second failure write |
| browser test under tests/browser | not runnable here, the QA browser runtime is not a project dependency; it is outside the default test glob, so the supervisor's baseline of 1,039 is unaffected |

Attribution is consistent: the correction snapshot covers six files and all six carry post-snapshot times. The two new acceptance cases are supervisor-owned.

## Findings, most severe first

**1. Medium, new. Browser-only completed evidence can be lost silently when local storage rejects the write.** The store's local persistence helper swallows every exception with a comment about quota. The correction now attaches a full serialized trace snapshot, including complete provider messages, to each unsaved completion and stores it in the same key. One such snapshot for a turn carrying the known 17k-token context is tens of kilobytes, so a few unsaved completions can exceed the browser quota. When that happens the only copy of the completed output disappears with no toast or flag, while the message still tells the operator the evidence is browser-only. The legacy backup path a few lines later does raise a toast on the same failure, so the fix is small. Not blocking the semantics of the correction. Should land before primary rollout.

**2. Low, known limit, sharpened. A reader that disconnects mid-turn and reconnects after a completed-but-unsaved result has no way to obtain it.** The stream handler drops the live buffer in its finally block, the journal has no agent row, and the terminal frame never reached that browser. The trace with its completion annotation survives only in Harness memory until process exit. Pre-correction behavior was no better, so this is not a regression. Suggested follow-up: keep unsaved completions in a server-side in-memory registry exposed like live buffers until the process exits or an operator resolves the row.

**3. Low. Journal content is now the harness output rather than the accumulated stream text.** For the factory streaming executor these are identical, so nothing changes today. An executor that streams deltas but returns a null output would now journal "null" instead of the streamed text. Note for the S3 identity-bearing stream work.

**4. Low. Without a local store, a successful turn is labeled completed-unsaved and browser-only with a "not saved to local journal" notice.** Truthful, but noisy for store-less deployments. Cosmetic.

**Already-scoped follow-ups, unchanged by this correction:** live journal reconciliation of rows left active after a failed commit, explicit not-started evidence when the provider was never called, post-executor guard failures, precise not-recorded labels, artifact-copy overhead, and metadata readability. None are worsened here.

## Judgment

The original blocking defect is resolved. Completion persistence has its own catch in a helper shared by both transports. A failed commit returns the normal output, the initial input, the trace summary, and a full snapshot, with execution marked completed and persistence marked failed. No second failure write occurs, no replay is possible because the turn row stays active and returns 409, and `done` is documented as execution return rather than a durable acknowledgment. Provider and native outcomes stay unknown, which is correct: harness success is not native terminal proof, and unavailable input metadata is not proof that native execution never started. Browser reconciliation keeps the completed copy and the interrupted journal row as separate objects, drops the stale trace link, and preserves the snapshot.

The supervisor's real fixture on port 4409 adds what my simulated-history tests could not: a real SIGKILL and restart with a surviving browser witness and no resend. That proves browser evidence reconciles with a genuinely restarted journal. It does not make unsaved output server-durable and it says nothing about native reconciliation.

The bounded correction can be accepted with finding 1 tracked as a pre-rollout fix. G4 as a whole and native parity remain open.

## Next dependency-ready slice

Finding 1 first as a one-line change plus a regression, then CORE-004 S0 recorded native protocol fixtures in the sibling package, as already queued. The live-reconciliation follow-up should be scheduled before any primary rollout that relies on the journal for recovery, because a stuck active row today blocks the thread until restart.
