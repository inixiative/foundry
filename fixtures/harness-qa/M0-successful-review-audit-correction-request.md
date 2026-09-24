# Retain the supplied successful-review rationale in owned audit only

Continuation after Astra ce6da7f7's native task_complete15:11:31.409Z, matching
durable final, empty live buffers and full M0 handoff read. Parent source and
independent regression still show the omission, not already fixed work.
This is a narrow completion of the existing inspection contract before live adoption,
not an additional middleware architecture or expansion into subscription pooling.

Parent independently extended acceptance/domain-expert-message-loop.test.ts. The
abstention rationale case now PASSES against the transient shared-state projection:
both experts retain their own learned state, shared outcomes remain visible,
private reasons remain on the owned original signal bus, and neither pre-hook nor
central next input receives those reasons. Original learning/isolation and invalid
review controls also PASS. The projection is therefore independently supported.

A SEPARATE successful-review audit gap is RED. The controlled reviewer returns
{decision:"learn",knowledge:<owned interpretation>,facts:[<actual output>],
reason:"PRIVATE_REVIEW_RATIONALE_<domain>"}. parseReviewAnswer accepts the reason,
but thread-runtime.ts constructs the learned LearningRecord without outcome.reason
(currently around1259), before either commit or original-signal publication. Thus
the original owned audit signal never contains the supplied rationale. This is not
evidence that the new shared-state projection leaked or removed a field it received.
Non-learn decisions already use record(outcome.decision,outcome.reason).

Retain the bounded supplied reason in the existing owned LearningRecord/journal,
without broadcasting it through shared Librarian state. Do not invent a rationale
when none was supplied, and do not persist raw native reasoning or provider internals.
This is explicit structured task-review output, not hidden chain-of-thought. Keep
the original immutable owner/evidence/base/revision and post-hook validation bounds.
Add durable commit/reconstruction assertions and preserve the passing abstention
privacy case. No second audit store, text filtering, or changed expert instructions.

Exact original parent RED report (2PASS/1FAIL/58assertions):
.foundry/qa/2026-09-07T15-08-12.987Z-d3001b09-67da-4093-8bfa-e9f6b83cd859-G3/report.json.
Expanded report with separate abstention control:3PASS/1FAIL/69assertions,
.foundry/qa/2026-09-07T15-09-27.311Z-0f935522-1ed1-4059-9f0e-6b751d17f6a5-G3/report.json,
stable426cb8a6d42550b1f13d78477aeba3924f1c39846e79a55c6f33596fe523f7c0.
Fixture518eb99208a8516bef7a666cad8b96eb12c959b598e53e3ae906e639804001db;
runtimec9e1ef85f910e70585d28a8918fd300e9475396db0fb28f6ab59485386bb53b6.
Strict ES2023/ESNext/bundler/Bun types passed. Do not edit the parent fixture.

Existing runtime-only ownership. Fable owns UI/journal code; only read its APIs.
Append an exact checkpoint/results section to M0 handoff. Run existing scenario,
independent four cases and focused lifecycle/privacy regressions, types and source
fingerprints. No install/restart/probe/candidate/binding/account changes.

After checkpointing the correction and exact tests, continue IN THIS SAME TURN
with the READ-ONLY preparation in M4-live-domain-loop-adoption-request.md. This
authorizes that plan concurrently with parent's independent M0 artifact review,
not installation, activation, new candidate creation or native captures. Keep
separate M0 correction and M4 preparation handoffs. CORE-006's current order is
live local-expert loop verification BEFORE Herald implementation, superseding your
handoff's proposed immediate M5/M6. Actual existing post-hook timeouts and stale
knowledge make live adoption the next concrete dependency.
