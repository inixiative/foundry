# Complete actual native MCP tool evidence before both-engine retrieval acceptance

Dispatch-ready09:11Z after verified T3 native task_complete09:07:06.266Z and
supervisor reading the complete docs/T3-native-bridge-integration-handoff.md.
Both findings remain open. Continue implementation in the same lead session.
Same full goal/count6-next8; Fable separately reviews the immutable T3 candidate.

Update09:05Z: Fable's derived candidate and actual Claude sample review are now
complete; bounded Claude evidence is accepted. Fable is available for opposite
review after your current T3 terminal. Supervisor also reproduced one NEW T3
late-settlement defect; include this small provider correction before a new
candidate, without weakening the bridge's exact-owner check:

- acceptance/native-bridge-late-settlement.test.ts drives the production provider
  and actual nativeBridgeSource with a controlled session boundary. After local
  timeout, the registered late terminal reaches the observation with the correct
  owner but the bridge still rejects the next admission as unresolved. Foreign
  admission positive remains refused. Result1pass/1fail/7assertions, stable
  25d4ea2769c154634afccf4bc30564cc6d73f7fec38a79ebb95ba95fc3021a44:
  .foundry/qa/2026-09-07T09-03-50.597Z-6f858dd0-1f53-41e0-9213-fd4855a48e67-G5/report.json.
  Explicit strict types pass; no model/native process or retry occurred.
- session-backed.ts currently invokes bridge.observe(projectNative(event))
  BEFORE retrieving the registered observation and attaching its owner. The
  bridge's new exact ownerFields check correctly rejects that unowned projection.
  Resolve the event's original registered admission first, then use that frozen
  owner for bridge settlement and observation. Never use the current/new turn's
  owner or trust a foreign event. Preserve duplicate/unknown/late ownership guards.
- Test both real installed engine classes over controlled late terminal streams
  as well as the unchanged two independent cases. This is lease reconciliation
  after actual known terminal, not permission to replay possibly running work.
  Do not silently claim full I2 review settlement or cancellation support.

Supervisor independently read the separate new adapter cleanup correction and
ran18 focused cleanup/SDK/admission checks90assertions/types/diff, stable
3ec3ec94689de33bb46f197d886658e5f5e921cd7a5cadbfe004d43ac681060b:
.foundry/qa/2026-09-07T09-01-52.783Z-fb17b237-1e55-4fae-bb5d-9cbf20c6a381-G5/report.json.
That bounded positive does not excuse the new late-settlement failure below the
provider callback or establish full native retrieval acceptance.

Supervisor source review found classifyCodexEvent in ../agent-session/src/
codex-session.ts handles command execution but no MCP tool invocation. Current
T3 candidate test explicitly omits controlled MCP tool begin/results and checks
separate SDK persistence. That does not prove native MCP result visibility.
scripts/native-retrieval-guard.ts correctly requires native tool begin/result;
do not weaken it to accept SDK records or matching final text alone.

Independent new fixture native-mcp-tool-normalization.test.ts under acceptance:
1 shell positive passes,3 MCP cases fail (missing tool begin/results for success,
tool-level error and transport error despite a completed native turn). Report:
.foundry/qa/2026-09-07T08-44-38.628Z-663fcea0-c5e6-4848-8b7b-071e18e0f72c-G5/report.json.
Explicit strict ES2023/bundler/Bun types pass. No real native process or model
call occurred. This is a SYNTHETIC upstream-schema-derived regression, not a
claim about a new captured wire event from the installed CLI.

Schema evidence: installed codex app-server generate-json-schema --out completed
without a model session into .foundry/qa/mcp-schema-MRgYa5. It exposes mcpToolCall
ThreadItem but does NOT establish the legacy MCP notification wire shape. Upstream
primary source inspected2026-09-07:
https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
McpInvocation, McpToolCallBeginEvent, McpToolCallEndEvent specify call_id,
invocation {server,tool,arguments}, duration, and Result<CallToolResult,String>.
https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/thread_history.rs
consumes the same event types into MCP tool history. Do not conflate upstream main,
installed app-server schema and actual installed legacy MCP wire observations.

After the T3 handoff, own the smallest existing-engine normalization/projection
correction with source-grounded serialization and controlled tests, plus exact new
immutable package/candidate manifests. No new engine or installed-code edits.
Keep real observed call ID, server/tool identity and public arguments/results;
distinguish tool failure from native turn completion, native IDs from SDK IDs,
and unknown/foreign/malformed/duplicate/late notifications from owned work.
No arbitrary protocol, private reasoning, credential or launch-config copying.
Preserve immutable evidence and existing admission/terminal/late/argv/budget tests.

Extend actual-class production HTTP/SSE tests so MCP tool evidence is asserted,
not omitted with a comment. Map names through a documented adapter contract;
the independent test intentionally requires the callable tool suffix but does
not force an invented display convention. Check retrieval guard compatibility
without accepting different servers, missing original arguments or forged joins.
Preserve the full public result needed for digest/record joins without duplicating
hidden payloads. Add error, foreign ownership, duplicate and non-text variants.

Run the independent four cases unchanged RED then GREEN, sibling regressions,
source/script types, relevant installed candidate paths and explicit before/after
cross-repository hashes. Update T3 handoff with exact remaining unknowns. The
supervisor then promptly performs separately authorized both-engine real retrieval
in a reviewed new candidate, retaining actual event schemas safely. Do not claim
live support solely from upstream-derived fixtures. Native models/retrieval are
not authorized by this prepared file; preserve old reports and unknown leases.

No primary/lead restart, binding/account/credential change, root install, agents,
publication or commits. The independent Claude sentinel has passed in Fable's
derived policy candidate; do not repeat it as a substitute for actual retrieval.
Actual learning, native lifecycle/lineage/subsessions/artifacts/inspection/models/
efforts/pooling and measured parity remain the full objective, not future waivers.
