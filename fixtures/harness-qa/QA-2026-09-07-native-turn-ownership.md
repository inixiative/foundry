# Native Turn Ownership: Independent Red Baseline

Supervisor-owned acceptance file:
fixtures/harness-qa/acceptance/native-turn-ownership.test.ts.

Run `bun scripts/harness-check.ts G5 fixtures/harness-qa/acceptance/native-turn-ownership.test.ts`
from Foundry. Report:
.foundry/qa/2026-09-07T01-27-17.725Z-G5/report.json; detailed assertions in1.log.
All four cases fail: Claude and MCP each write a second native turn after either
local timeout or interrupt request without observing any native terminal. Expected
one turn write, observed two. These are ordinary failing assertions, not expected
failure passes, and no native process or credential is involved.

The test accepts either explicit rejection or safe queueing of the second send;
it does not force a particular new public interface. A fake transport acknowledges
only MCP handshake requests and never acknowledges a turn terminal/cancellation.
Every fake process is closed and pending promise observed in finally. Therefore
this proves an admission bug, not real cancellation behavior or native parity.
The correction still needs additional terminal correlation/late-event tests.

Foundry source fingerprint was stable during this run. The generic Foundry runner
does not fingerprint sibling dependencies. Immediately afterward the three sibling
source SHA256 values were:

- src/harness-session.ts:7861a2031eb56f5250433a49bc828c853bd685efa3db61354140e10b2ec552b2
- src/claude-code-session.ts:3f28ca748a522dd3ed854c0ad8eb60679d7cc33e620a6b5995d7f733677de406
- src/codex-session.ts:feb1e41d8a25baace4bfcd559de2cd77bd6517ed6ec60398b424363e0e7be7f6

These post-run hashes are not a before/after cross-repository stability claim.
Final S1 acceptance must fingerprint both repositories around the unchanged
independent cases and await completed implementation before running a baseline.
S1 already explicitly owns this hazard; no duplicate native assignment was sent.

## Completed S1 Implementation: Independent Checks

Astra's S1 native task_complete was observed2026-09-07T01:49:00.259Z for native
turn01a07978-e812-73f0-bae6-96f2ab1998cd. Foundry's matching lead response is on
turn_7ead687e-16f2-40c2-92f0-c419626c810c. Handoff:
../agent-session/docs/S1-identity-outcome-handoff.md. No runtime integration or
native disposable probes were done by the implementer.

Supervisor independently reran sibling check:83 ordinary checks plus2 expected
S4 failures, typechecks/diff pass in
../agent-session/.qa/s0-2026-09-07T01-50-31.596Z/report.json.
The FOUR unchanged admission cases now pass together with THREE unchanged recorder
safety cases, Foundry typecheck and diff in
.foundry/qa/2026-09-07T01-50-34.404Z-G5/report.json.

cross-repository.json beside that report verifies the sibling fingerprint from
the completed preceding suite remains unchanged through the independent Foundry
run and the subsequent snapshot, with Foundry also stable during its own checks.
Sibling hash7f38f18236223dab1b96d47284f3b4a96c1d2e256dd5c46a95c4a7e3dfb21235.
This is stronger than the original red run's post-only dependency fingerprint.

S1 is submitted, not accepted: independent source review and opposite-model review
remain, plus separately authorized real continuation/terminal verification.
Native MCP failure acknowledgment, cancellation, usage, durable reconciliation,
Foundry integration and capacity parity remain explicit gaps. Fable is occupied
with its memory continuation; do not dispatch S1 review into active work or let
passing source-only tests advance the lead count from3.
