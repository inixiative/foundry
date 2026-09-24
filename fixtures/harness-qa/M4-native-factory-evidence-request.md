# Implement the ordinary native factory to expert-review evidence path

Your cb8cab05 journal review completed native end_turn16:49:26.200Z, matching
durable completed row and empty live buffers. Parent read the full review, matched
hashes and independently ran59PASS/920assertions plus strict types on stable
d843a54cf70691715b27462e231a0f92a75625b484bfead066c6c7d111e6f104:
.foundry/qa/2026-09-07T16-49-46.723Z-0378155d-fb9a-45b3-8e1f-7f21679f9986-G3/report.json.
The bounded journal source correction is accepted; no need to redo that work.

Now implement the concrete production gap, not another general review. Read
docs/M4-B-parent-production-gaps.md and parent regression
fixtures/harness-qa/acceptance/native-factory-review-evidence.test.ts. On the exact
same source, ordinary factory RED0/1/3 (journal has native tool result, both reviews
run but neither receives it) while runner-specific10/74 passes. The runner added
its own event projection, which is not sufficient for ordinary Foundry sessions.

You own the narrow packages/foundry/src/agents/thread-factory.ts integration,
one focused helper if justified, and new focused tests plus
docs/M4-native-factory-evidence-handoff.md. Parent's regression is acceptance
evidence; do not weaken/delete/rewrite it. Reuse existing NativeObservation,
meta.observeTool, ToolCallObservation, native ownership/correlation helpers and
runtime post-hook wiring. Keep every expert's isolated state and historical input
semantics. Do not create a second event journal or middleware architecture.

Requirements: an exact owned native registration/begin/result can supply observed
public tool output to both post hooks before normal completion review and then
their updated knowledge reaches Continue. Preserve native call vs item identity,
server/tool identity, unknown/error/omitted output truth, duplicate and late event
handling, and unknown original work ownership. Foreign/mismatched/unregistered
events must not become current dispatch learning. Check dispatch/thread/generation
and admission, avoid duplicate native vs existing MCP/tool-loop observations.
Raw owned journal must retain evidence independently of its learning projection;
do not transform non-text omissions into success or include raw hidden payloads.
Cover complete/stream/tool-loop native paths as applicable, and tests scaled to
the shared factory boundary. No blanket timeout/effort reduction or seeded memory.

Do NOT edit scripts/domain-loop-composition.ts, native-domain-loop.ts,
check-native-domain-loop.ts or native-domain-loop.test.ts: Astra still owns those
in original8cb40057. Parent will dispatch its integration correction AFTER that
turn settles, including removal of its duplicate runner projection, V1/V2 browser
and actionable errors, and exact delivered revision evidence. Temporary runner
integration failure while the source paths converge must be reported, not hidden
by preserving divergent implementations. Do not edit the accepted store/M0/runtime
or provider transport unless you identify an unavoidable narrow dependency and
record it for coordination. Existing source tests may inspect the new factory.

Source and controlled tests only. No native sample/model execution, candidate
creation/install, live state/server restart, credentials/bindings/account or
shared-browser-storage changes, commits. CountTEN/full goal unchanged. Finish
with exact final source hashes, retained RED/GREEN commands and a handoff for
Astra/parent opposite review. The next goal remains a visible native expert loop.
