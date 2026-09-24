# Parent review of the long-history baseline

Fable actual terminal13:47:08.217Z, matching Foundry final and complete
docs/G6-long-history-browser-baseline.md read. This is controlled product QA,
not a native capability gate. Parent independently inspected report.json,
followup-report.json, run-large-2/report.json and the relevant fixture source.
The five production UI/route/journal hashes still match the baseline source map.

Parent viewed1440-oldest-rendered-turn-context.png,390-oldest-rendered-turn-context.png
and run-large-2/1440-completed-unsaved.png. The first shows historical turn111;
the mobile screenshot shows112, not the actual oldest seeded turn1. Both have
readable contribution sections and no artifact links. The large screenshot shows
the completed-unsaved output still visible with an explicit tab-only/loss-on-close
warning, surrounded by repeated optional-cache warnings for durable rows.

Confirmed observations: a real journal contains320main messages and120side messages;
the default route returns100, no paging indication and no UI older control. Explicit
limit1000 retrieves320main rows. Payloads are2,526,934bytes small and27,726,934bytes
large, from direct HTTP reads. Large browser response-byte observer recorded0 due
its asynchronous collection, NOT zero downloaded bytes; use direct HTTP evidence.
Small fixture has0quota notices; large fixture100. This is a fixture size comparison,
not matched model speed or native latency evidence.

The large run fails waiting for the browser-only result after reload and stops
before writing browser.unsaved or executing the later quota/offline/mobile scenarios.
Do not imply those later large-history scenarios passed. The failure plus the
warning/source path supports the cache flaw: writing a mixed snapshot that includes
all durable detail prevents the unsaved result's small browser copy from being
saved. This is not proof that previously stored durable records consumed the quota;
the attempted combined write itself exceeds it. Quota-denied storage generally
cannot guarantee reload recovery; the UI must remain honest about that limitation.

Small-history follow-up confirms historical snapshot text differs from current
layer cache, and exact per-row quota wording. It identifies analytics400routes in
that follow-up, not every generic console message from every run. Some original
errors are intentional offline ERR_FAILED; do not call all console errors analytics.

Evidence errata: actual recursive inventory contains18PNG screenshots, matching
Fable's final message, not22 as the handoff introduction says. The large run never
reaches its report.controlled assignment or second quota send; don't assign its
small run's two completed-handler count. The fixture source uses controlled
provider callbacks and no native adapter/model connection. Existing reports and
failed assertions remain unchanged. These bookkeeping limits do not erase the
measured missing history, absent artifact links or cache-loss failure.

Next delivery is G6-history-index-and-inspection-request.md after the native
candidate freeze: actual paginated lightweight index, lazy immutable detail and
artifact navigation, priority preservation of legacy/transient/unsaved evidence,
bounded optional durable cache and coherent status. Reuse identical seeded rows
for before/after; run the formerly unreached large-history scenarios too. Do not
remove configured message decoration, context or tools to improve payload size.
