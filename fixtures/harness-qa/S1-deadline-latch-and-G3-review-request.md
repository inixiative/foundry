Continue the SAME Fable native session after end_turn03:44:34.775Z. Supervisor
retained your matching reply as QA-2026-09-07-fable-recorder-ordering.md. The first
two independent ordering cases passed with all16 independent native cases through
../agent-session/.qa/s0-cross-2026-09-07T03-45-38.601Z/report.json. A new boundary
case reopens the correction; no capture is authorized.

Task A: close the irreversible-deadline race in sibling recorder code/tests only.
native-continuation-ordering.test.ts now has THREE cases: two pass, the third
fails at .foundry/qa/2026-09-07T03-46-20.261Z-G5/report.json. It injects a controlled
matching transport terminal after awaitOwnedOutcome returns deadline but before
final verification. Your pause(0)/verify path observes that late completion and
sends task two anyway. The test changes timing only, not engine evidence. Actual
result: two sends instead of one. Do not edit independent assertions.

Latch the decision to stop admission when its deadline is observed, before any
await/checkpoint/trailing-frame opportunity. Later native completion may enrich
evidence and permit owned cleanup but can never turn the run back into success
or authorize task two. Audit the other deadline edges, including a terminal
becoming visible at/after expiration before the wait loop's next check. Preserve
full local/native result distinctions and original tool/identity/transport guards.
Keep a clear permanent recorder stop reason even after native outcome becomes
known. No native parser edits, retries, resume/fork or fresh identities.

Run all THREE ordering cases, all FIVE independent native files (17 total),
sibling suite/types/diff and cross-repository fingerprints. Original13 recordings,
version pin and single-turn behavior stay unchanged. Update your correction
handoff. Source tests are not native acceptance. No real --capture until separate
supervisor authorization and opposite-model review of your correction.

Task B, after correction: READ-ONLY review of Astra's completed current-message
audit exclusion. Astra native task_complete03:43:15.131Z is verified, matching
response QA-2026-09-07-astra-current-admission.md. Read docs/G3-current-admission-
handoff.md plus current core/context/dispatch/memory, flow/runtime and inspector
changes. Supervisor all26 independent memory cases pass at03:40:35.364Z-G3;
combined full baseline passes03:44:13.017Z-baseline. Historical Selection/refusal
UI passes six cases at333/390/1440 in
.foundry/qa/memory-selection-visual/2026-09-07T03-41-33.139Z/report.json. Both
record IDs/reasons/scoped message identities are visible; current audit text is
absent from provider input, history remains distinct after a later blocked turn,
audit stays intact and duplicate failed turn returns409 without another call.
The initial browser failure was a heading assertion affected by CSS uppercase;
the assertion now compares heading case-insensitively, without relaxing behavior.

Review scope collisions/publications, mandatory records, direct/background calls
without messageId, repeated text with different IDs, mutable options, refire,
refresh/failure/overlap and historical provenance. The overlap guard refuses a
displaced executor before its provider call; that is a safety mitigation, not
full concurrent same-thread capability. State the remaining queue/isolation need
without falsely claiming both requests complete. Give a separate accept/reopen
verdict for this bounded correction, with findings first. No Foundry edits.

Astra is assigned READ-ONLY provider review and causal-learning investigation;
do not modify provider files, shared graphs, his selection files or independent
tests. Use apply_patch for manual edits. No new agents, native probes, credentials,
bindings, settings changes, server restarts, dependencies, commits or publication.
Count4/next6 and the entire original goal remain. No self-approval. After these
reviews the next real step is bounded native continuation then I/T integration,
not an offline-only substitute for the intended harness.
