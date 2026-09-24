# Primary Recovery Rollout

Only the original primary port4400 instance was restarted. Astra's active S0
lead instance at4407 and native binding were not touched. The accepted G4 failure,
completed-unsaved and browser-storage corrections are now loaded in primary.
This is not acceptance of full G4, native parity or performance.

## Before Restart

- Checkpoint: .foundry/qa/checkpoints/2026-09-07T00-32-07.792Z.json.
  Two idle threads,16 recorded messages in the Fable work/review thread,15 traces,
  no active stream buffers. All native bindings captured.
- Rechecked the review thread's live buffers immediately before stopping: zero.
  Latest actual native assistant event was end_turn2026-09-07T00:27:33.978Z,
  model claude-fable-5-1, native session da000690-899a-4128-a868-b9a024aeeaa0.
- Sent SIGINT to owned primary exec4579. Shutdown closed the local store and
  exited0. Copied the closed journal to
  .foundry/qa/checkpoints/2026-09-07T00-32-07.792Z-sessions.sqlite.
  No checkpoint import, journal replacement, metadata rewrite or replay.

## After Restart

- Started `env FOUNDRY_MODE=unattended VIEWER_PORT=4400 bun run start`, exec68494.
  Server ready2026-09-07T00:33:13.624Z, local SQLite enabled. Startup auxiliary
  provider self-test reported PASSED; no extra work-thread smoke was sent.
- Checkpoint: .foundry/qa/checkpoints/2026-09-07T00-33-30.227Z.json.
  Two idle threads,16 recorded messages,15 traces, no active buffers.
- Structural assertion: complete messages arrays are identical before/after for
  both threads. All15 prior trace message endpoints return the same trace IDs.
  Native binding map is structurally identical, including the original Fable ID.
- Both thread-owned conventions/memory content hashes match before/after. Main's
  two uninitialized knowledge layers remain cold; Fable's two owned layers remain
  warm with unchanged contents. Broader transient cache restoration is not claimed.
- Headless historical inspection/layout passes at333/390/768/1440:
  .foundry/qa/layout/2026-09-07T00-34-13.737Z/report.json. The390px inspector
  screenshot was reviewed: historical turn ID, stage summary and Turn Context
  control are visible, without overlapping primary content. No page errors.

## Limits

The Mac remained locked, so no visible-browser control or restoration of its
browser-only history is claimed. Its existing storage was not modified by these
fresh headless contexts. Reload the visible page to load current UI modules.
Same-binding native Fable continuation will be checked at the next actual review,
not inferred from metadata or the separate startup self-test. Unknown native
outcomes, live unsaved reconciliation, raw memory amplification, full artifact/
layer/tag inspection, streaming and native capability parity remain open.
