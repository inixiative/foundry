# Prepared next correction: distinguish settled reviews from unresolved work

NEW correction after Astra610de657 native task_complete18:07:02.474Z,
matching durable final and empty live buffers. Parent read the full final handoff.
Independent offline browser gate18:12:02.580Z-8dbb2aa3-G3 passes94tests/909assertions,
36 source hashes stable, aggregate e466282dbbe5f50b5e13a01b262010562a9637e935ca1b721ecc94d0fc0ab44d.
This verifies the explicitly isolated refusal cases, not the unresolved mixed
browser-fault lifecycle. Original empty psHtK1 failure remains unexplained and
must remain open. Fable separately reviews final bootstrap changes read-only;
do not broaden this assignment into another browser rewrite. Preserve those
bytes except where genuinely necessary for the settled-review fix, and report
any such change. No candidate/install/native sample is authorized here.

Read FULL docs/M4-C-production-loop-opposite-review.md, especially F1/F6.
Parent independently reproduced both reviewer probes at17:37:57.682Z-c3b92e8f-G3,
2pass/38assertions, stable c978e36c65e3e257516538610d2ee84cdd89151ba3a469a6cf01988c745c4902.
R2 asserts the defect exists, not corrected acceptance: both experts have settled
on abstain with released capacity near95ms, but runDomainLoop loops to the full
1500ms admission window and reports an unclassified deadline failure. Native
default is15minutes. Do not mitigate by reducing the native admission window,
forcing expert learning, seeding memory or replaying central/reviewer work.

Use the existing runtime's actual final review/job and ownership/capacity state
to distinguish genuinely pending/unknown original work from settled outcomes
that cannot produce the missing committed revisions. Stop the latter wait with
a known actionable outcome/code, retaining domain decisions and owned cleanup.
Already committed knowledge can still be delivered even when a later review
abstains; queued eligible jobs must not be declared finished just because a
prior job ended. Unknown/native-local unsettled work keeps its original handle.
Do not insert a blocking learning barrier into the normal message path.

Add runner-level tests covering both final abstentions, one learned/one abstained,
valid old committed knowledge with a later abstention, genuinely pending/queued
reviews, and the real A3 fallback after A2 used the earlier revision. Include a
controlled deadline case that stays attached to unresolved original work, with
eventual exact terminal cleanup rather than killing/replaying it. Keep scope
proportionate and reuse existing controlled runner fixtures/production state.
Keep reviewer R2 historical proof distinguishable from corrected acceptance;
coordinate its stale expected-defect assertion after the correction.

Reissue final handoff with full hash/test/artifact evidence, preserving browser
correction, original signal inventory, historical revisions, and protected parent
fixtures/verifier. Count remainsTEN until parent acceptance. Actual native expert
judgment, installed execution, configured experts, Herald, recovery/lineage and
matched latency remain open.
