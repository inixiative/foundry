# Independent Post-Correction Checks

Both native corrective turns actually completed: Fable memory at02:01:18.840Z,
Astra S1 at02:05:43.102Z. Matching Foundry responses were inspected. Neither
implementation is accepted from its own handoff; accepted lead count stays3.

## Supervisor Verification

- Six unchanged memory acceptance cases, Foundry typecheck and diff pass:
  .foundry/qa/2026-09-07T02-10-00.881Z-G3/report.json.
- Full Foundry baseline passes:
  .foundry/qa/2026-09-07T02-10-20.487Z-baseline/report.json.
- Both retain before/after Foundry hash
  8dc19dc42cbc6767a791fa6567c8ef6e4098b83756da7223cf349139d0b781c0.
- Sibling suite/source/script typechecks pass:
  ../agent-session/.qa/s0-2026-09-07T02-10-29.700Z/report.json.
- All11 independent terminal/admission/recorder cases pass, explicitly selected
  by cross-check, with stable sibling and Foundry manifests:
  ../agent-session/.qa/s0-cross-2026-09-07T02-10-52.858Z/report.json and
  .foundry/qa/2026-09-07T02-10-52.874Z-G5/report.json.

## Actual Historical Inspector

Supervisor added scripts/check-memory-selection-viewer.ts: a disposable controlled
provider, real production memory/resolver/factory/runtime/Harness/viewer/journal,
one dispatch, historical right-panel Selection expansion at333/390/1440px.
The checker retains exact provider input, journal/state, page/detail screenshots
and DOM assertions. Provider gets old relevant tail evidence and convention;
all32 records remain unchanged. Inspection causes no second dispatch.

Report .foundry/qa/memory-selection-visual/2026-09-07T02-10-31.231Z/report.json
passes all widths; 333px selection screenshot visually reviewed. Earlier run's
1440px screenshot was also reviewed. Selected2/32, omitted30 audit records,
616/6000 selected chars, retained26626 chars, excerpt range2272-2572 visible.
No page/module/turn/trace HTTP errors or overflow. Fixture-only analytics400s
are explicitly recorded. Server, browser, runtimes and store close in finally.
The unused invalid maxTokens field in this supervisor fixture was removed;
explicit standalone strict TypeScript check then passed. Independent assertions
were not weakened. No production restart, native call or binding change.

This closes the bounded actual Selection rendering gap in Fable's module-only
browser proof, not all G6 or native retention/latency. Source fingerprints above
span separate runners, not a claimed combined visual-run manifest. No source
edits occurred during the visual run; this QA record/review briefs follow it.

## Pending Review

Opposite-model read-only briefs prepared: G3-memory-selection-astra-review-request.md
and S1-fable-review-request.md. Native terminal/dispatch IDs belong in CORE-005.
The memory browser test's cleanup?.() call is not the fixture's close() method;
this is flagged for review, not silently accepted as repeatable cleanup.
Primary and lead still use their existing backends; sibling source is not
integrated. Central Claude maxTurns25, native retention and full capacity/latency
remain explicit open gates. No goal/slice acceptance or leadership count increment.
