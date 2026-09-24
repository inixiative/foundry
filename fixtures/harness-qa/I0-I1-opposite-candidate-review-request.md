# Opposite review: I0/I1 installed candidate and first native sample readiness

Continue in the SAME Fable Foundry/native session after your actual public
end_turn07:26:49.955Z for turn_6c861748-499d-44ea-a09b-563139284c8b. Astra actually
completed I0/I1 at07:28:46.476Z, native task01a07a79-b506-7a52-a600-485bfbef9760.
Supervisor read the entire102-line docs/I0-I1-native-integration-handoff.md.
This is independent READ-ONLY review before native use; no self-acceptance.

Review that full handoff and its exact immutable candidate:
.foundry/qa/adoption-aade3e37-8caf-4454-8321-93ce1f1080db/foundry.
Native manifest: .foundry/qa/native-f2c2f8f274f1-dbaa744e-e2cd-4058-93f1-2cff2e7ecbe3/manifest.json.
Review code inside that candidate and its copied sibling source; do not confuse
later root MCP/startup edits with the frozen candidate. All production imports
must resolve via the actual installed tarball, not a sibling path alias. Verify
the reported scope/source digests before trusting test claims. No actual native
calls have run in it. Parent independently reverified7files/prewrite-v1.

Highest-risk boundaries: new sibling prewrite callback before stdin write; failed
registration means zero write; interrupt/exit during registration cannot leak
admission; exact-owner inspectAttempt and immutable late ownership; foreground
provider/factory/Harness/HTTP/SSE/native journal registration before process start
and atomically before write; restart with unresolved occupancy refuses even a new
spawn; native/local/RPC/transport/SQL outcome separation; completed output survives
later failures without replay; central unbounded default versus explicit/auxiliary
limits; frozen public tool inputs without hidden/raw/secret payloads. Distinguish
native terminal from physical/RPC idle in learning cleanup and provider reuse.

Inspect callback-capability gating, all wrapper forwarding, per-thread project/
generation ownership, borrowed/default provider behavior, persisted lookup versus
actual construction provenance, and late journal appends. Native review evidence
and not-admitted cleanup refusal must stay truthful. Learning lease reconciliation
is still I2; direct/background/naming callers outside foreground/review are openly
unfinished. Do not accept the full goal or label those implemented.

Run appropriate unchanged acceptance/candidate actual-class route tests, native
source/script types and relevant immutable recording checks, without printing or
reading hidden reasoning/native tapes. Handoff reports122 integration,44 memory/
learning,16 browser/failure and21 independent native checks; verify actual coverage
and risk-focused reruns, not merely totals. Preserve failed/stale reports. Review
the installed candidate full baseline's missing Git HEAD and excluded selected-
terminal fixture as known test prerequisites, not silent waivers. Astra separately
owns fixing those prerequisites and freezing a NEW candidate; do not edit yours.

First native sample readiness: inspect actual runSample, not only NativeSampleGuard.
It must never send a second request after unresolved/failed first work or a latched
deadline; command/input/owner/native joins and unchanged project artifacts must be
checked; cleanup must stay attached to unresolved owned work and never infer
cancellation from timeouts. Parent already ran the ACTUAL candidate runner for
both engines with missing Playwright and a process-local Bun.spawn refusal guard:
zero subprocess attempts/writes/spawns, empty cleanup failures, unchanged artifacts,
passed=false and closed guard. Runner hash matches reviewed root source:
7a5442654669f1b83d00620b529c0a9e2c2d96c0ca00658730244c3b9680bca4.
Reports under candidate .foundry/qa/i1-offline-claude-ebd3b2fb-3015-4834-b1a3-7d0ea10bc53a/
and i1-offline-mcp-7b0d6234-129f-4ff2-8c6a-0b325cec81a9/. This proves one actual
setup-failure cleanup path, not native execution or every runner failure boundary.

Deliver docs/I0-I1-opposite-candidate-review.md: findings first with source/line
references and reproducible evidence, then bounded accept/reopen decisions for
sibling ownership, packaged integration and permission to run the first bounded
sentinel sample. State exactly what remains before actual both-engine execution;
do not invent a demand for a general architecture/security rewrite. If the reviewed
sample is ready, say so explicitly so the supervisor can dispatch promptly after
the fresh full-baseline candidate check. Keep framework QA and actual model parity
separate. No model calls, new agents, implementation edits, root install/live
restart, account/credential/binding changes, publication or commits. Same goal,
count6-next8, Astra provisional lead; this review does not self-increment acceptance.
