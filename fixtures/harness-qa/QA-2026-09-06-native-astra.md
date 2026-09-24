# Astra Native QA: 2026-09-06

## Observed Run

- Runtime: local authenticated Codex CLI 0.153.4, native MCP session adapter.
- Model: `gpt-6-astra`, requested effort `high` (not a maximum-capacity test).
- Foundry thread: `native-qa_01a07866-5b58-7145-ac94-5894ebb932ad`.
- Native session: `01a07866-b032-7e10-8e67-20aeb4e84951`.
- Project: `.foundry/qa/projects/release-notes-BzXxt2`.
- Evidence: `.foundry/qa/native/native-qa_01a07866-5b58-7145-ac94-5894ebb932ad/turn-1.json`.
- Native elapsed: 102482ms; viewer reported 102491ms ingress.

The task was entered through the visible Foundry browser on port 4403. Astra
implemented optional `--group`, preserving source order within added/fixed groups
and byte-identical default output. It changed notes.ts, notes.test.ts, README.md
and generated release.md in the disposable project. Codex independently read the
implementation and tests, reran `bun test notes.test.ts` (10 pass, 0 fail, 113
assertions), and inspected the actual generated release.md. Canonical fixtures
remain unchanged. The native report's intermediate failing tests are not counted
as independently reproduced regression evidence.

## Inspection Gaps

- The viewer shows the final answer as plain text, including literal Markdown
  `[release.md](release.md)`, not a navigable Foundry artifact. Browser accessibility
  inspection found text only, no file link control.
- Available native events contain 14 tool-use records and 7 tool-result records.
  Current normalization duplicates shell begin/end as tool-use events, so this is
  not a reliable count of distinct calls. Other native event types may be dropped.
- Usage is missing in the normalized result. No token/capacity claim is supported.
- The browser did not expose native tool progress during execution. Native tools
  did execute and produce disk artifacts; execution and inspection parity differ.
- One executor with deterministic flow deliberately excludes classifier/router
  and decoration costs. This run supplies no direct-native latency comparison.
- Source was changing in the separate memory implementation slice during this
  probe. This is exploratory evidence, not a stable-build release gate.

G5 remains open for proper streaming, cancellation, attachment/artifact linking,
model/effort controls, tool call identity, fork/resume and subsession behavior.
