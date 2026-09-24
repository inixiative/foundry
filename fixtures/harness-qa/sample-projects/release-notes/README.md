# Release Notes QA Project

Baseline: `bun test notes.test.ts` and `bun notes.ts changes.json`.
No install step, credentials, network service, or production data is needed.

Native task: add an optional `--group` flag that groups Added before Fixed while
preserving input order within each group. Keep the default output unchanged. Add
regression tests including an empty group, bad flag, invalid input, and CLI output.
Produce a `release.md` artifact from the sample input and report actual test results.

QA observes native read/edit/shell tools, test failure then correction, exact diff,
linked output artifact, cancellation and continuation. Run in a fresh prepared copy
for each model. Do not alter the canonical fixture to manufacture a passing result.
