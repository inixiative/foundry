# T2 disposal subscriptions and actual close accounting

Continue in the same Fable Foundry/native session. Your actual native sample
review ended08:00:21.384Z; supervisor read it fully and accepts its bounded MCP
evidence verdict and Claude failure diagnosis, not a full goal/count advance.
Same full CORE-002/003/004/005 and AS-001..005 goal. Astra currently corrects the
sentinel guard and prepares a new candidate; do not edit those modules/artifacts.

Supervisor independently reproduced both residual source concerns from the last
QA entry as actual failures using production createFoundryMcp/createLiveBridge and
SDK connect-only proxy calls (no model or native CLI subprocess). New unchanged
tests: fixtures/harness-qa/acceptance/native-bridge-disposal-accounting.test.ts.
Report .foundry/qa/2026-09-07T08-00-14.450Z-4e63aa14-969d-40bb-bb03-ffb9bb7f2847-G5/report.json:
1 positive,2 failures,11assertions. Explicit strict test/source types pass.

1. Medium: three sequential SDK sessions, each terminated with no backend work,
   then await bridge.close(). serversClosed equals serversCreated, but two
   authority disposal subscriptions remain attached to the still-live Thread.
   Instrumentation wraps only public onDispose registration/disposer callbacks;
   no private runtime inspection. An unused bridge releases its single hook.
   SDK churn must not accumulate hooks on a daily long-lived thread. Give every
   owned subscription an explicit cleanup lifecycle, without an unbounded list
   of closed authorities. Detach observers separately from authority revocation:
   preserve valid late reads after SDK DELETE while bridge remains open, and
   preserve all-session revocation/late-record retention after bridge close.
   Still refuse actual thread disposal/replacement/generation/project changes.
2. Low: a rejected foreign factory allocation calls server.close() without awaiting
   or retaining its promise, immediately incrementing serversClosed. With that
   close intentionally held, actual completed closes=1 but stats claims2.
   Retain ownership of pending cleanup and account completed/failed cleanup
   truthfully; never report a request as completed close. Close must not lose or
   orphan an allocated server/promise. Cover delayed and rejected close paths;
   do not wait forever on backend reads or label tool/native work cancelled.

Keep the independent tests and all existing63 MCP cases unchanged. Add any
necessary focused cleanup-failure/late-read/disposal positives, run both sets,
strict types and diff, retaining RED/stale evidence and boundary fingerprints.
Append Correction5 to docs/T2-live-transport-handoff.md with exact ownership,
counts and remaining limits. Do not self-accept. Then Astra opposite rereview
precedes T3 implementation; avoid another architecture-only phase.

Scope MCP authority/server/transport/index and tests as needed, no sibling,
provider/factory/runtime/journal/inspector/staging/sample/startup edits. No new
model probes, accounts/config/credential/binding changes, native replay, installs,
server restarts, publication, commits or additional agents. Preserve both actual
native samples and every frozen candidate. Supervisor owns subsequent captures.
