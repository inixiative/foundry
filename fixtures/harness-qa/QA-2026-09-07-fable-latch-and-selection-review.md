Privately: nothing further is needed for either task. Task A is verified with stable fingerprints and the handoff is updated. Task B has Astra's handoff, the selector exclusion, the bound-owner check, the executor guard, the focus identity handling and the supervisor's cited evidence in hand. No reads, edits or runs remain, so the report follows with the two verdicts kept separate.

## Task A: recorder deadline latch, complete, not self-approved

| Check | Result |
|---|---|
| Supervisor ordering file before edits | 2 pass, 1 fail |
| Supervisor ordering file after edits, unchanged | 3 pass |
| My ordering tests plus all existing sibling offline suites | 158 pass |
| Sibling check runner: suite, both typechecks, diff, fingerprint | pass, 172 across 8 files (170 ordinary + 2 expected S4), before equals after |
| Explicit five-file cross-check, 17 independent cases | pass, sibling manifest and Foundry source fingerprints stable within the run |

Reports: sibling `.qa/s0-2026-09-07T03-50-56.609Z/report.json` and `.qa/s0-cross-2026-09-07T03-51-03.108Z/report.json`; Foundry `.foundry/qa/2026-09-07T03-51-03.122Z-G5/report.json`. Handoff: `../agent-session/docs/S1-continuation-ordering-correction.md`, "Correction 2" section.

What changed, recorder scripts and offline tests only:

- **Irreversible latch.** When the owned-outcome wait ends with anything other than a known outcome, the closed state and stop reason are set synchronously before any await, checkpoint or trailing pause. The loop returns unconditionally afterwards. Late completion enriches evidence and permits owned cleanup, but the stop reason stays `native-deadline` and no second send can occur.
- **Deadline edge.** The wait loop now checks the remaining deadline before looking for a known terminal, so a terminal visible at or after expiration is classified as deadline, never success.
- **Lifecycle allowlist.** The two lifecycle kinds I introduced in the first correction were being recorded as unknown by the typed allowlist. Both are now allowlisted with enum-restricted fields.
- Untouched: production engine sources, the 13 recordings, the version pin, single-turn behavior, independent tests, shared ledgers. Edits used the harness Edit and Write tools.

Limitation: the Foundry fingerprint differs from the first correction because Astra's concurrent Foundry work landed between runs. It is stable within this run. Source tests are not native acceptance; capture remains unauthorized.

## Task B: read-only review of Astra's current-message audit exclusion

Findings first, most severe first. None blocking.

1. **Low. Legacy-owner audit records slip past the exclusion.** The exclusion requires the record's stored owner to match the request owner. Audit records written before ownership existed, or read through an explicit unowned opt-in, have no owner and stay eligible under normal relevance even when their JSON carries the current message id. The handoff states this limit honestly; noting it here because the pre-rollout primary log contains exactly such history, so the first turns after rollout may still self-select older unowned audit.
2. **Low. Nested identity is deliberately ignored.** Only a top-level JSON message id counts. Dispatch and classification signals write their payload as a JSON object with a top-level message id, so the common case is covered. Any writer that nests the id one level down will not be excluded. Acceptable and documented, but worth a writer-side convention note.
3. **Low, wording.** The executor guard's error says memory selection "changed before provider execution". It is accurate, but the operator-facing message does not say which request displaced which. Including both message ids would make the refusal actionable without changing behavior.

Verified in source:

- **Scope collisions and publications.** The bound source only honors a load hint whose identity matches its own bound owner, and the selector requires stored-owner equality per record. A same-named thread in another project cannot claim or exclude this thread's audit; project publications are never audit kinds and are unaffected.
- **Mandatory records.** Pinned records are taken before the exclusion pass, so a pinned record can never be dropped as current audit.
- **Direct and background calls without a message id.** Identity is only constructed when both message id and thread id are present; otherwise no exclusion runs and no identity is stamped, and the executor guard treats unidentified loads as ineligible to replace identified work only when a flow plan exists.
- **Repeated text with different ids and mutable options.** Exclusion is id-based, never text-based, and identities are frozen copies taken at dispatch and at focus time.
- **Refire, refresh, failure and overlap.** Refire reuses the frozen plan identity. Focus equality includes identity, so an identical message with a new id invalidates warm content, and the existing bounded reload and stale-on-failure rules carry the identity with the content. The overlap guard refuses the displaced executor before its provider call and records the prepared evidence.
- **Historical provenance.** Snapshots carry the selection's identity and each exclusion's record id, reason and scoped identity; historical artifacts keep their original selection.

On the overlap guard: it is a safety mitigation, not concurrent same-thread capability. When two requests on one thread race a coalesced load, one request is refused and does not complete. Completing both truthfully needs per-request preparation isolation or a queue that serializes preparation per thread with its own identity, which this slice does not provide and does not claim.

Verdict: accept the bounded correction. The three findings are non-blocking follow-ups. Broader gates stay open as stated: no rollout, no native retention or retrieval claim, the causal-learning latency investigation, the queue or isolation need above, and the unchanged full goal. Astra remains provisional lead at count 4, next checkpoint 6, and the supervisor decides acceptance for both items.
