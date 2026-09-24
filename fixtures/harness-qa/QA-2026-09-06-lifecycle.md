# Production Lifecycle QA: 2026-09-06

Build graph: `tickets/CORE-003-improvement-graph.md`.

## Verified

- Native Fable implemented G1, G2a and G2b inside the visible primary Foundry session.
- Codex independent tests found and then verified fixes for seven lifecycle/route
  defects. Gate tests were not rewritten to accept the implementation.
- Full stable check: 855 tests pass, typecheck passes, diff check passes.
  Evidence: `.foundry/qa/2026-09-06T20-12-59.135Z-baseline/report.json`.
- Production factory/runtime viewer fixture on 4402, not a manually assembled
  Thread fixture: create via plus button, select, send, inspect thread-state.
  Cwd now matches the sample project. Current state contains one message and three
  dispatch observations, and events are attributed to this thread.
- New browser-created fixture thread:
  `thread_01a0785d-8ebd-7931-a855-0fb8c1143fc7`.
  Its turn input contains revision A; current cache contains revision B and its own
  private marker. Another thread retains revision A with an empty conversation.
- Primary restored thread keeps native id `da000690-899a-4128-a868-b9a024aeeaa0`.
  Native smoke result begins `FOUNDRY_G2_OK` and recalls the remaining source defect.
  Trace: `trace_01a0785d-1f96-7d1f-bb2e-d04312f493a9`.
- Old server-owned child processes exited on shutdown; no surviving children were
  found for the two recorded PIDs. This is not a stress test of cancellation.

## Still Open

- Shared file-memory source and tool privacy, project-specific configuration/atlas
  scope, direct-dispatch observations, disposed runtime reuse, naming session scope.
- Automatic recovery of messages/cache/traces. Metadata restoration was manual,
  browser fallback is incomplete, and checkpoints are best-effort API reads.
- Three-part parallel decoration, exact native-wire provenance, ledger correctness,
  post-tool guards and knowledge writeback, native Astra live acceptance.
- Model/capability parity, cancellation, native tools/subsessions and durable artifacts.
- No meaningful slowdown is not achieved. Cold post-rollout smoke took 49.422s;
  the earlier pre-lifecycle smoke took 18.563s. Controlled timing is still required.
- Inspector still calls a current thread-state layer GLOBAL because it conflates
  definition scope with runtime ownership. Current/at-turn scope labels need G6 cleanup.
- Desktop visual inspection done; mobile and full workflow stress remain untested.

## Evidence

- `.foundry/qa/checkpoints/2026-09-06T20-13-00.417Z.json`: primary before restart.
- `.foundry/qa/checkpoints/2026-09-06T20-17-19.358Z.json`: primary after native smoke.
- `.foundry/qa/checkpoints/2026-09-06T20-17-19.632Z.json`: production fixture after UI QA.
- `scripts/checkpoint-harness.ts`: repeatable operational capture, not automatic restore.
- `scripts/lifecycle-fixture.ts`: repeatable browser fixture.
