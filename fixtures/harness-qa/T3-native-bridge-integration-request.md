# T3: native launch, admission ownership and visible tool delivery

PREPARED, NOT dispatched. Dependency-ready only after independent I0/I1 readiness
and corrected T1/T2 handoff review. Do not interrupt either active task or treat
this file as permission to launch native probes, alter live bindings or roll out.
This is the next executable integration slice, not a new architecture exercise.
Use the existing graph, engine classes, provider, factory/runtime, journal and SDK.

## Source-grounded missing path

CreateSessionOpts and both createSession implementations in
packages/foundry/src/providers/session-adapter.ts have no per-owned-session bridge
launch contract. The Claude central trackedSpawn delegates unchanged argv, while
the auxiliary wrapper deliberately uses empty tools/strict MCP. Codex delegates
unchanged argv to the existing injected spawn. T2 exposes launch descriptors but
does not wire either actual central engine to them. Do not mistake SDK success
or an available-tool label for native delivery.

SessionBackedProvider._complete constructs/reuses a warm session BEFORE the
prewrite observation.register callback receives the native admission. Therefore
bridge configuration must live with the owned runtime/native process, while
per-turn observation attaches at prewrite admission. A bridge recreated per user
message would leave the warm native process pointing at an old launch descriptor.
Use a narrow typed factory/lease interface, not globally mutable default spawn
configuration or another session engine. Preserve central model/effort/native
tools and explicit uncapped central work; auxiliaries remain restricted.

The supervisor's startup-only trackSessions helper now forwards the adapter's
optional construction/configuration/idle-release/signal capabilities, preserving
the real method receiver. It replaces the old capability-dropping lead wrapper;
it has not been deployed. Review scripts/owned-session-adapter.ts and
scripts/start-harness-lead.ts plus unchanged lead-adapter-capabilities.test.ts
before including them in a candidate. Do not erase this independent correction.

## Bounded implementation

1. Resolve the actual owned runtime object/thread/project/generation during central
   session construction. Refuse stale/missing/foreign ownership. Instantiate one
   authenticated read-only live bridge for that process binding, using its live
   tools/retained store and committed layers. Never recreate a Thread in the proxy.
   Include bridge generation/configuration identity in warm-profile compatibility;
   an incompatible warm session is a truthful guard, not permission to silently
   replace its native binding, drop history or replay unknown work.
2. Pass generated Claude --mcp-config JSON or Codex -c mcp_servers overrides through
   the existing owned spawn path. Verify exact argv offline against installed CLI
   help/schema and existing adapter tests. Preserve unrelated native tools, allowed
   permissions and existing configuration; do not add strict empty config centrally
   or overwrite an existing same-name MCP entry silently. No persistent mcp add or
   user-settings edits. Auxiliary attempts must never acquire a bridge capability.
3. Associate each bridge operation with a frozen owner/lease captured at its start.
   Register the I1 native admission BEFORE native write. Never assign a late call
   or result to whichever turn happens to be current on completion. Retain SDK
   request/session IDs separately from actual native call/item/admission IDs. Where
   the protocol cannot prove a join, expose unknown or an explicitly inferred
   association, not a fabricated observed native ID. Pre-admission calls cannot
   acquire a later admission retroactively. Preserve T2 late-evidence and exactly-
   once observer behavior through disposal, disconnect and delayed backend reads.
4. Journal public tool arguments/results, selection references, owner/generation,
   start/finish/status/digest and actual native associations through existing I1
   storage/events. Reconcile into the existing inspector for active and historical
   turns without another native send. Never record bridge capability, credential,
   private raw protocol or hidden reasoning. Extend recording sanitization for new
   launch flags/config/paths before recording them. Old evidence remains immutable.
5. Close/revoke only the owned bridge on the proper runtime/process transition;
   separate transport teardown from pending native/tool settlement and retained
   evidence. Unknown native work keeps its identity and cannot be retried or
   replaced. Do not use browser EOF, a local deadline or a kill request as a native
   cancellation ACK. Keep failed setup and failed journal writes inspectable.

## Proof and the next real workflow

Test both actual candidate engine classes with controlled streams/spawn hooks and
the real production provider/factory/HTTP/SSE path: bridge configured once across
two admissions; exact prewrite lease; auxiliary refusal before bridge/native work;
foreign/replaced runtime; explicit warm-profile mismatch without replacement;
partial launch failure; late tool evidence on the original admission; terminal/RPC
split; completed output with failed journal; active/fresh browser inspection.
Drive the real SDK proxy and preserve previous T1/T2 and I1 tests unchanged.

Add an opt-in disposable sample runner ready for a separately supervised native
dispatch, using a NEW isolated reviewed candidate and owned data directory. For
each engine, seed an own omitted rollback fact, a same-project publication and a
foreign private marker. Ask a bounded source/project question that requires real
foundry_memory search/get. Verify actual native tool begin/result, bridge invocation
and exact content digest, and that unauthorized content never appears. Inspect the
tool arguments/results in an existing tab and a fresh browser history read. On a
second independent admission, verify a newly committed owned fact is retrieved
from the SAME runtime/native process; do not claim long-term retention from two
independent tasks. Capture actual tool/model/effort acknowledgments separately from
requests, exact process/admission counts, immutable artifacts, traces and cleanup.

No hidden retry or second dispatch if first ownership/outcome is unresolved. This
sample is not yet authorized to run by the presence of this file. After handoff,
the supervisor should authorize the reviewed bounded real sample promptly, not
continue indefinitely with only component tests. Then advance actual learning,
fork/subsessions/recovery, tool-workbench artifacts, right-panel/tags and measured
latency gates. Mandatory-context refusal remains until native retrieval and the
chosen fulfillment policy are actually demonstrated. Do not remove required
instructions/domain/thread context to make the sample or timings pass.

Owner should be Astra after I0/I1 handoff; Fable supplies opposite review of source
and evidence. Scope files are provider/adapter/factory/runtime/journal/inspector,
typed launch lease integration and bounded sample/test utilities, with narrow MCP
interface additions coordinated after Fable completes T2. Preserve all unrelated
dirty work and frozen artifacts. No root dependency rollout, native probes, account
or binding changes, live restart, publication or commits under this request.
