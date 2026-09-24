# M4-C parent browser reproduction: diagnose the blank first page

Your 5309a51a completed native task_complete at17:15:14.172Z, matching durable
agent final and empty live buffers. Parent read the full final M4-C handoff and
reran check-native-domain-loop with the bundled Playwright runtime. Source was
stable. 12/70 actual provider/factory cases and63/522 middleware cases passed;
runner12pass/1fail/111 assertions. Types/diff/plans passed. Browser initial
open-desktop connection failed before any model work. This is a NEW correction,
not a replay. No candidate, install, native sample, saved-server restart or state
mutation is authorized. Fable separately owns read-only runner opposite review.

Report: .foundry/qa/2026-09-07T17-20-23.161Z-528c7351-20f7-4efc-88e3-edd81f5a365d-G3/report.json
Failure artifact: .foundry/qa/m4-controlled-chromium-ebzPPH/m4-controlled
open-browser-failure.json says context=open-desktop, step=connection, errors=[].
Parent visually inspected open-desktop-failure.png: completely blank dark page.
The diagnostic does not distinguish failed module/network bootstrap from an
actual websocket failure. Do not call it a timeout flake or increase timeouts.

Reproduce with:
FOUNDRY_QA_PLAYWRIGHT=/Users/agreenspan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright FOUNDRY_M4_BROWSER=1 bun scripts/check-native-domain-loop.ts

Identify the actual failed bootstrap dependency or wait condition, add bounded
safe diagnostics (owned local request statuses, module/bootstrap state, connection
state, public error classification; no arbitrary payloads/credentials), and fix
the narrow underlying cause. If production UI bootstrap needs changes, first
document the exact cause and proposed minimal ownership boundary in the handoff;
you may make a narrowly scoped bootstrap correction needed for reliable normal
offline/local harness operation, with a reproducing test. No broad UI refactor.
Do not replace real browser assertions with mocks, cached selection, larger waits
or DOM-only optimism. Retain the old failure unchanged. Exercise real1440/390
old/fresh contexts and exact turn ownership through the recorded native evidence.

Parent's new HTTP controlled artifact independently passes all copy-only checks:
.foundry/qa/m4-controlled-execution-v0i7S5/m4-controlled
.foundry/qa/parent-native-loop-artifacts-bxGNUe/report.json
Delivered revision1 correctly matches historical participants; current revision2
is separate. Both expert hashes match. Do not regress that work or redo journal.

Read Fable's full corrected factory handoff. Its owner fix now independently
passes the actual provider boundary; your final explanation about original versus
derived tool signals supersedes its initial duplicate-emitter explanation.
Preserve protected parent fixtures/verifier and shared factory/runtime/provider.
Update docs/M4-C-production-loop-correction-handoff.md with exact cause, changed
hashes, retained failures, repeated real-browser result and owned cleanup.
Full scope remains active/countTEN; local native expert proof is still next,
configured expert lifecycle follows, then scoped Herald. Pooling is deferred.
