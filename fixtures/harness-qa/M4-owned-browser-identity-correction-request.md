# Correct process identity and uncertain liveness before helper acceptance

Your77f64ab1 ended native end_turn18:37:54.162Z, matching durable final1788806274248
and empty live buffers. Parent read your FULL handoff and211-line implementation.
Real graceful-close evidence is useful, but the fallback ownership guarantee is
not established by a remembered numeric PID. Your known-limit note correctly
admits that PID reuse is undetected; it cannot be waived for code sending SIGKILL.

Independent parent controlled regression, with NO real signal/Chrome/model:
fixtures/harness-qa/acceptance/owned-browser-identity.test.ts
.foundry/qa/2026-09-07T18-37-15.503Z-23bb3cd2-de0d-43e3-bac1-7edd4254eb4c-G3/report.json
Stable source,0pass/2fail/4assertions against helpere5958941c9139b1ba65b0ea45ba76ca1523c2e8b810ac2fb1b639a61a71de1ba.
1. Original browser exits during graceful close; its PID is reused in the fake
process table. The helper then attempts terminate on that unrelated replacement.
2. process.kill(pid,0) throws controlled EINVAL; alive() returns false. Only a
genuine process-absence outcome can prove exit; an unexpected probe failure must
remain an error/unknown, not exitConfirmed=true through waitGone.

You retain ownership of owned-browser.ts, owned-browser.test.ts and your handoff.
Correct these two conditions without weakening or editing the parent regressions.
Prefer a true acquired process handle with authoritative exit tracking for fallback.
If the supported runtime cannot provide identity-safe termination, explicitly
refuse that fallback and report exit/cleanup unconfirmed; do not signal a bare PID
and call it safe, or claim such refusal establishes full cleanup reliability.
No process-name scans, arbitrary PID signals, shared Chrome profile operations,
private model handles or package install. A start-time comparison followed by
ordinary kill still has a check/use race: don't present it as a stable handle.
Keep the existing default launch/readiness budgets and core browser capabilities.

Preserve late promise ownership and idempotence. Callback/OS errors cannot invent
an exit or silently discard the original acquired handle. Retain original errors
and failing artifacts; no unhandled rejection or late duplicate release. If the
interface genuinely needs to change, report the minimal parent-fixture adaptation
needed without changing the safety requirement yourself. Distinguish graceful
proof, controlled fallback proof, unavailable fallback, and actual process exit.

Astra9adab6e2 is active on runner report/lifecycle integration. Do not edit its
runner/diagnostics/checker/proof or any parent file. Its request requires full
terminal/handoff dependency verification; append this correction and its hashes
to your handoff and clearly supersede the unsafe initial integration contract.
Keep interface changes proportionate and document them for the lead. No duplicate
new session or message to Astra. Parent coordinates final acceptance.

Run focused controlled source tests plus the parent regression, strict types,
and one isolated real graceful browser check after your changes. All real process
actions must stay within exact acquired resources; do not run a real PID reuse
experiment. Keep original F1/F2/mixed-driver and native local-expert gaps explicit.
No native model/sample, install, candidate, saved-server/account/binding mutation
or commit. Helper acceptance remains open, full goal and countTEN unchanged.
