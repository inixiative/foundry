# Context Inspection Fixture

Run from the Foundry root: `bun run scripts/inspector-fixture.ts`.
Set `INSPECTOR_QA_PORT` if port 4401 is occupied.

This starts the actual viewer and harness with a deterministic executor. It does
not call Fable or Astra and is not a native runtime parity test. Settings are
isolated in a temporary directory; the primary Foundry process is unaffected.

1. Open the printed URL. Thread A's domain cache starts at version A.
2. Send one message. Open its trace, then Turn Context, then Layer snapshots.
   The included domain snapshot must still contain version A.
3. Open Initial provider messages. It must contain version A, the user message,
   and `Fixture provider suffix`.
4. Click the domain layer. Its current cached content must show version B.
5. Select Isolated Thread B. Its domain cache must still contain version A.
6. Open Thread Activity in A and inspect the writeback signal payload. B must
   not show that event. Global Runtime Activity may show all events.
7. Click a pipeline stage. It must open the corresponding span, not a no-op.

The fixture deliberately creates isolated stacks directly. Production
ThreadFactory still shares instances; CORE-002 tracks that architecture gap.
Restart resets fixture data. Historical persistence is a separate acceptance gate.
