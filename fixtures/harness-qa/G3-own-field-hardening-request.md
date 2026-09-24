In this same Fable session, close Astra's nonblocking final memory-review finding:
validateMemorySelection looks up NUMERIC_BOUNDS through inherited object names.
Supervisor fixture acceptance/memory-policy-own-fields.test.ts has four RED
unknown-option cases (constructor/toString/hasOwnProperty/__proto__) and one GREEN
declared-option control. Report .foundry/qa/2026-09-07T02-55-35.377Z-G3/report.json.
These paths are relative to fixtures/harness-qa where appropriate.

Use an own-property lookup for the numeric allowlist; do not change valid policy
semantics. Reproduce RED, fix with focused owned coverage, run all SEVEN independent
memory files explicitly (the prior19 cases plus these5 =24), types and baseline.
Update the dedicated memory handoff with exact evidence. Leave independent tests,
supervisor scripts, shared ledgers and sibling source unchanged. No server restart,
native probes, credentials/bindings, dependency changes, agents or commits.
Astra is finishing separate OFFLINE recorder preparation; do not interrupt it.
The same full long-term goal and review/rollout gates remain. This is a small
hardening correction, not native tool-bridge or capacity acceptance. Keep it bounded.
