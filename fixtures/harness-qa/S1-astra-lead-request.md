Continue as provisional lead in this same native Astra session. Read the latest
CORE-003/004/005 entries and QA-2026-09-07-fable-S0-review.md first. Fable's S0
review completed2026-09-07T01:17:20.788Z. Supervisor accepts bounded recorded
evidence (count3), not native capability; argv sanitization must be fixed before
any further recording. The next leadership checkpoint is count4 or a serious
regression. Both original and corrected native recordings remain immutable.

Own the next bounded S1 implementation in ../agent-session. Do not edit Foundry
production code: Fable is separately implementing G3/G7 memory selection there.
You remain overall lead; report architecture/interface decisions and integration
requirements. The supervisor owns shared graph updates and independent acceptance.
Use a sibling handoff document for your progress so concurrent graph edits do not
conflict. No new subagents or native probes in this assignment.

First fix recorder argv persistence with explicit executable/flag/value allowlists
and stable pseudonymous identifiers; reject or redact unknown option values and
base-context text, including equals syntax. Add adversarial offline tests. Audit
other persisted lifecycle fields for the same issue. No arbitrary strings, numeric
content, credentials, usable native handles or reasoning in recordings. Do not
rewrite old artifacts or pretend their historical sources used the new policy.

Then implement truthful additive session/event/result identities and native
outcomes on the existing Claude and MCP engines. Inspect actual recorded envelopes,
not remembered protocol shapes. Keep logical admission identity distinct from
native session/thread/turn/item/call IDs; missing native IDs stay unknown. Preserve
existing consumers while exposing enough typed information for Foundry to adopt
without heuristics. Native completed, failed and unresolved must be distinguishable
from a local send/RPC resolution, timeout, process exit or browser disconnect.
Normalize the observed Claude user-envelope tool results and MCP terminal/call
relationships as needed for S1; do not require unrecorded payloads or invent types.

The current BaseCodexSession dispatch can clear _inflight on timeout while native
work continues, admit a new send, and put late events onto a later turn. Fix this
ownership hazard rather than merely adding result fields. Test both engines:
late completion after local timeout, queued and newly arriving sends while the
outcome is unknown, wrong-turn/duplicate terminals, transport failure, callback
observer exceptions, native success followed by local infrastructure failure,
and preservation of the original resume binding. Unknown work must not silently
replay, release execution capacity, create a fresh session or be called cancelled.
Preserve evidence when terminal and transport failure race. Keep native cancellation
acknowledgment itself in S2 unless needed to make S1 truthful; explicitly state
unsupported behavior instead of implying an interrupt request confirms stopping.

Use real sanitized fixtures through production classes plus deterministic negative
tests. Promote only expected-failure tests genuinely fixed; tool streaming/UI and
cached accounting remain separately tracked S3/S4 unless a small inseparable
change fixes them. Keep accounting unknown instead of zero when unavailable.
Inspect schema only for app-server; no default switch or broader app-server repair
in this slice. The schema-verified stdio/input repair and real probe require a
separate reviewed assignment. No dependency install/integration, node_modules
edits, lockfile churn, publication, commits, credential changes or server restarts.

Run sibling check/cross-check and source/script typechecks. Foundry's current
independent three safety cases must stay unchanged. Provide stable before/after
fingerprints, precise test counts distinguishing expected failures, explicit
limitations, public interface examples and the proposed bounded native continuation
probe for later authorization. A source-only S1 pass does not establish native
continuity or mean Foundry uses the sibling package. Finish this bounded slice
and hand back for independent QA and Fable review before the next assignment.

Supervisor follow-up artifact while implementation is active: four ordinary
independent admission cases now reproduce the timeout/interrupt overlap defect in
both engines. Read QA-2026-09-07-native-turn-ownership.md and run its unchanged
acceptance file when ready. It is not included by the older S0 cross-check runner;
include it explicitly in final cross-repository evidence. No additional native
request or altered scope is implied by this test-first evidence.
