# Continue unfinished history UI work after native turn cap

Your prior turn_d82c2f55-40d5-48c4-afbd-244d87fc4a0a terminated with the actual
native result subtype error_max_turns, persisted as failed in Foundry. This is a
new bounded continuation on the SAME preserved session, NOT replay of the task.
Parent read the entire current G6-history-index-and-inspection-handoff.md: it is
the initial API/cache contract, not a final verified delivery. Preserve all WIP.

Parent checked the installed Claude engine: native result calls _resolveTurn,
resolves the owned send and clears _inflight synchronously before provider error
handling. The provider's Native terminal error text comes from that returned
result, not an observer timeout. Last public test result14:19:27 completed, its
report records cleanupFailures=[], no test child remained under native95751,
and Foundry live buffers are empty. Persistent native95751 and its MCP service
remain alive; don't restart or replace them. Generic nativeOutcome=unknown in
the legacy failure message remains an inspection limitation, not a success claim.

Focus this bounded continuation on completing the SMALL-row UI after-run and its
focused API/cache tests. The complete original G6 delivery contract still applies;
large-row/mobile/quota/offline/race/artifact coverage remains required afterward,
not cut from scope. Stop with a coherent handoff before the next turn cap.

Read the actual failed report and source:
.foundry/qa/g6-history-after-2026-09-07T14-19-09.675Z-r400/report.json
packages/foundry/tests/browser/long-history.test.ts
The report has8positive/1negative assertions before abort, NOT an overall pass.
Initial50-row index33536B, legacy100-row full response2527634B, all320 rows
reachable in7 API pages/214423B; these have different row counts, so also measure
equivalent rows for performance claims. Browser first older-page anchor shifted
from134px to-73px, a207px regression. Test then timed out at line169 while reading
the tenth .detail-section-header after earlier clicks changed the rendered list.
Determine product versus observer defects from source and controlled evidence;
fix scroll anchoring rather than weakening its8px tolerance. Use stable section
identity/locators for inspector interaction, not a stale index list; retain
assertions of actual visible historical data and artifact navigation.

Preserve the original failed report/screenshots/test evidence. Use fresh unique
output directories. Add deterministic regressions and finish the small after-run
including its existing offline, quota, inactive-thread and mobile stages. Do not
hide console errors as analytics without source attribution, suppress assertions,
increase timeouts to manufacture a pass, or count an aborted matrix as completed.
Use apply_patch for manual edits. Existing ROOT UI/history/journal ownership only;
Astra owns G5 native-candidate test/fixture diagnosis in disjoint files. No adapters,
providers, core lifecycle, configuration segment, staging, sample runner, sibling,
frozen candidate, account/binding edits, root installs, live restarts or model probes.

Append an honest progress/final section to the same handoff with exact hashes,
commands/results, payloads, screenshots, failure causes and remaining contract.
Only mark a scenario complete when it actually finishes with cleanup. Parent
retains independent browser/adversarial acceptance and full goal; no self-acceptance.
