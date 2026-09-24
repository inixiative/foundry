# Historical Memory Refusal Inspection

Supervisor extended scripts/check-memory-selection-viewer.ts to cover a successful
selection followed by an oversized mandatory rule under explicit block policy.
The fixture uses production memory, resolver, factory/runtime, executor, viewer
and local journal with a controlled provider. No native calls or live-server changes.

Final checker run:
.foundry/qa/memory-selection-visual/2026-09-07T02-51-00.052Z/report.json.
Six browser cases pass: success and refusal at333/390/1440px, fresh pages and reload.
The checker passes standalone strict TypeScript and retains page/detail screenshots,
provider-input.json, blocked-trace.json, and the fixture journal/full memory files.
Earlier same-behavior run02:49:38.337Z also passes; its333-blocked.png was visually
reviewed. A subsequent loop-layout cleanup was rerun in the final run above.

Observed: one successful provider call; the second admitted turn is refused before
the provider, journal status failed, trace root error with the matching turn ID,
inputEvidence prepared-only and no providerMessages invented. A duplicate POST
returns409 and does not execute. Both audit snapshots are unchanged by selection
or refusal. The first historical Selection still reports32 records and excludes
the later requirement; the failed turn reports33 and names mandatory-approval /
required-context-blocked. Actual DOM text and screenshots show the conflict and
omissions without horizontal overflow. No page/module/message/trace errors;
fixture-only analytics400s are explicitly recorded.

Scope: browser reload and journal inspection, not process-crash/native-retention
proof. The provider count proves the controlled execution boundary; the separate
native-facade acceptance test proves refusal before native session creation.
The primary memory rollout still awaits Astra's final review. Lead count4 is
unchanged; no native probe authorization or whole-goal acceptance follows this.
