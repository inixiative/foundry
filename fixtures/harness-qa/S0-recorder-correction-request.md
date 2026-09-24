Your S0 first pass completed at2026-09-07T00:49:14.838Z, native turn
01a07946-46fb-70c1-830b-ff27190df0dd. Continue as provisional lead in this same
Astra session. S0 is not accepted; lead slice count remains2. The full native,
decoration, recovery, inspection and subscription-continuity goal is unchanged.

Supervisor independently ran your sibling check runner: it passes at
../agent-session/.qa/s0-2026-09-07T00-47-54.543Z/report.json, with six explicitly
expected capability failures. But three additional independent safety/framing
cases fail in fixtures/harness-qa/acceptance/native-recording-safety.test.ts.
Read fixtures/harness-qa/QA-2026-09-07-native-recording-safety.md and run unchanged:
bun scripts/harness-check.ts G5 fixtures/harness-qa/acceptance/native-recording-safety.test.ts
from Foundry. Failing report00-39-17.892Z-G5. Do not edit independent assertions.

Fix these in your existing sibling recorder/sanitizer surface:
- Only explicitly typed numeric protocol fields may retain numeric values;
  arbitrary numeric payloads inside content arrays must not survive sanitization.
  Valid usage counts must remain intact.
- Drop analysis-phase payloads even when the envelope lacks type/kind. This is
  synthetic adversarial evidence, not a claim that real secrets were exposed.
- Make firstChunk point to the actual starting chunk after an exact newline
  boundary. Earlier records' conservative bounds must remain labeled historical,
  not silently rewritten into invented exact provenance.
- Review cleanup's noTurn inference: absent observed outbound frames is not proof
  no request was sent if an observer failed. Track explicit send admission and
  retain unknown outcomes conservatively. Add deterministic observer-failure
  coverage; no native timeout/cancel probe is needed for this correction.

Strengthen capture of native item identities needed for S1. Your declared item-ID
omission is honest but leaves an intended protocol contract unproven. Use current
installed schema/type evidence and explicit allowlists/pseudonymization, not a
generic raw-field passthrough. Preserve stable session/turn/item/call relationships
where actually emitted; if missing on the actual wire, distinguish that from a
sanitizer omission. Keep all reasoning, arbitrary private content, credentials and
environment values out of fixture files and tool output.

Preserve initial recordings and their hashes/source provenance. After offline
sanitizer/framing/observer tests AND the three independent cases pass, you may
perform at most one NEW bounded corrective capture for each active engine (Claude
and MCP) in distinct controlled directories and a new explicit recording run ID.
This is separate authorization after verified terminal/owned-process exit of all
three original attempts, not auto-replay of ambiguous work. Never overwrite old
recordings or manufacture corrected raw frames from lossy sanitized content.
The app-server no-turn failure need not be repeated; retain its limited evidence.
Use the same read-only sentinel task. No unrelated probes, production src changes,
engine-default switch, dependency/lockfile changes, detached agents or publication.

Keep work inside sibling scripts/tests/fixtures/docs and CORE-004, preserving all
other changes. Re-run sibling full tests, explicit script/source typechecks, diff
checks, corrected-recording integrity/replay tests and the independent cases.
Foundry's runner fingerprints only Foundry: explicitly record sibling source
hashes before/after the independent test for a stable cross-repository check.
Retain six desired capability regressions as unresolved, not green parity claims.
Target20 minutes, then return exact results/limitations for Fable read-only review
and supervisor artifact verification before S1. Do not self-accept S0.

Operational update: primary4400 was cleanly restarted at00:33:13.624Z onto the
accepted recovery/storage fixes while idle. Messages/traces/bindings and owned
knowledge match before/after; four-width historical inspection passes. See
QA-2026-09-07-primary-recovery-rollout.md. Your active lead4407 was not restarted.
Fable's next actual review will verify same-native-session continuation there.
