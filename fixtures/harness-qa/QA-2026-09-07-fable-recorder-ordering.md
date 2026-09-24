Privately: nothing further is needed. Every requested run has completed after the last edit, the fingerprints are stable, the handoff is written with exact counts, and no follow-up reads or edits are pending. Report follows.

The recorder ordering correction is complete and verified. Not self-approved; Astra reviews read-only after its current slice, and the supervisor decides acceptance. No native capture was run.

## Verification

| Check | Result |
|---|---|
| Supervisor ordering file before edits | 0 pass, 2 fail |
| Supervisor ordering file after edits, unchanged | 2 pass |
| My offline ordering tests | 8 pass |
| Existing sibling offline suites | 149 pass |
| Sibling check runner: suite, typechecks, diff, fingerprint | pass, 171 across 8 files (169 ordinary + 2 expected S4), before equals after |
| Explicit five-file cross-check, 16 independent cases | pass, sibling manifest and Foundry source fingerprints unchanged |
| Plan mode for both engines | exit 0, no run directory created |

Reports: sibling `.qa/s0-2026-09-07T03-42-55.069Z/report.json` and `.qa/s0-cross-2026-09-07T03-42-58.769Z/report.json`; Foundry `.foundry/qa/2026-09-07T03-42-58.783Z-G5/report.json`. Handoff: `../agent-session/docs/S1-continuation-ordering-correction.md`.

## What changed

- **One monotonic admission deadline.** Each admission records its deadline at admission time. After local settlement the recorder waits, bounded by that same deadline, for the current admission's own native outcome or owned process exit. The settle interval now only lets trailing frames land and is capped by the remaining deadline. No phase gets a fresh timeout.
- **Honest stop after the deadline.** A new `native-deadline` stop records that the owned outcome is still unknown. Admission stops permanently, ownership is retained, cleanup is refused until the same late terminal or process exit, and run cannot be resumed. A late matching terminal reconciles the original admission only. Foreign and duplicate terminals never satisfy the wait.
- **Explicit version pin.** The Bun version pin is now an exported constant stated in the plan, provenance and preflight. A mismatch records a preflight failure with the reason and never starts a model process. Portability is stated as a limitation, not claimed.
- **Cross-check allowlist** gained the fifth file; the original four are unchanged.
- **Immutable local results.** The local settlement returned by send stays as recorded; the current native evidence is reported separately.

## Limitations

- The ordering evidence is synthetic through the production MCP engine over a controlled transport. It proves recorder contracts, not native continuation, retention, cancellation or capacity.
- The experiment is pinned to Bun 1.3.14 and the sanitizer literals. Other versions are unsupported for this capture.
- A raw typecheck of the scripts config without the existing typeRoots workaround cannot find Bun types. The check runner's configured typecheck passes; this is a known environment limit.
- Sibling production engine sources, the 13 recordings, Foundry production, independent tests, shared ledgers and dependency files were not touched. Edits used the harness Edit and Write tools rather than scripted file rewriting.