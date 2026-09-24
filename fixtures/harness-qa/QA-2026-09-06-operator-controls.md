# Operator Control QA

Production viewer, factory, runtime and action handler; only the fixture LLM is
deterministic. Fresh `bun scripts/lifecycle-fixture.ts` on port 4402 at 21:12 UTC.
Primary native work on port 4400 was not restarted or archived.

Fixture run: `qa_01a07890-b31c-7f2b-848b-9a26fc7e9add`.

## Browser Actions And Evidence

- Selected Lifecycle B from the sidebar, opened its overflow menu, clicked pause.
  Toast identifies B and explicitly says current work is not interrupted.
  `GET /api/threads?project=lifecycle-qa`: A idle, B waiting, both have two layers.
- Reopened B menu: resume replaces pause. Clicked resume and observed B-specific
  success. Reopened menu: pause is available again.
- Archived B through its overflow menu. Toast identifies B. API independently
  confirms A remains idle with two layers; B archived with one layer, as its
  owned runtime removed thread-state during disposal.

## Regression Coverage

`packages/foundry/tests/operator-actions.test.ts`: selected archive, missing and
conflicting targets, inspect/snapshot, pause/resume, terminal disposed state,
selected layer warm/invalidate, source failure, dynamic thread lookup and the
production HTTP action route preserving thread scope. Eight behavioral tests
failed before the fix; a ninth route test was added after it. All pass.

`packages/foundry/tests/thread-naming.test.ts`: six regressions first failed,
then passed. Existing human titles survive; untitled threads get text-only scoped
auxiliary calls; late results cannot overwrite a rename/disposed thread; retries
and recreated thread objects work. Primary rollout remains pending.

Stable baseline after these fixes and native G3a:
`.foundry/qa/2026-09-06T21-11-54.226Z-baseline/report.json`:
278 core + 631 Foundry + 22 gates + 4 canonical fixtures = 935 passing tests,
typecheck and diff check. Explicit initial G3 acceptance separately passed:
`.foundry/qa/2026-09-06T21-12-25.256Z-G3/report.json` (5 tests).

## Remaining Gaps

- This fixture is not proof of native pause/cancellation. Pause stops cache
  lifecycle only. Unsupported runtime commands now fail instead of falsely
  acknowledging dispatch.
- Historical decoration inspection, domain learning and durable artifacts remain
  separate open gates. Newly added router deadline acceptance still fails.
- An archived thread can still show editor/definition controls; disabled/read-only
  archived UI needs a separate coherent-state pass.
- Warm is tested through the production action route, not a visible warm button;
  the current layer detail panel exposes inspection but no warm command.
