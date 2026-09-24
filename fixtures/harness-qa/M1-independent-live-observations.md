# Independent live inspection observations

For review after Fable's active M1 turn1a9a4615, not an instruction to interrupt it.
The source may already change during the planned expert-panel implementation;
recheck current behavior before treating this as a remaining defect.

Parent's read-only fresh browser observation at15:30:31:
`.foundry/qa/live-observer/2026-09-07T15-30-31.306Z/report.json`.
Current Astra8991b702 and Fable1a9a4615 requests are visible at1440/390. Both older
knowledge APIs omit learning. Both desktop screenshots now correctly render
`.knowledge-live-state[data-state=not-reported]`, with durable snapshot/history
preserved. This independently supports the revised live-runtime label. No existing
tab/profile was touched, no model submission or server restart occurred.

Remaining visible inconsistency on4407: beneath the truthful not-reported label,
the empty domain list says "No domain has committed or pending knowledge for this
thread." A missing live-state field does not establish absence of pending work.
The response has status=empty, snapshot=null, and retained history, so only lack of
a durable knowledge snapshot is established. Separate that fact from unavailable
live/pending state. When actual current learning data explicitly reports an empty
domain list, the stronger empty-runtime statement may be supported. Verify both
cases in the new expert-panel scenario rather than merely changing generic copy.

Additional acceptance check for the new M1/M2 experience: initial expert inspection
before any message/job should show configured instructions and domain knowledge
and explicit empty owned thread understanding where available from the actual
factory/configuration; do not use a missing prior review job as proof no expert
exists. Historical view must keep its recorded segments and input revision after
later learning or configuration changes. No historical recomputation from cache.
