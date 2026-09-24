# T2 implementation: live authenticated transport and stdio proxy

Continue in the SAME Fable Foundry/native session after actual public end_turn
06:30:36.013Z for turn_0522fef2-4c66-497b-8c59-7142bbd985b6. Supervisor has read
all T1 source/corrections and independently verified31 SDK cases/types/diff on
stable25f64499d5721d440bd8640d5d386252557d17f299600b2e7147848f83f47234:
.foundry/qa/2026-09-07T06-31-48.479Z-53e69a17-7de5-4ade-a87d-9eeda2530917-G5/report.json.
All13 independent scope/invocation cases pass. No new blocker found in this
bounded supervisory correction review. Separate native Astra opposite review
and integration acceptance remain pending. This authorizes disjoint TRANSPORT
IMPLEMENTATION with local SDK/proxy subprocess tests, NOT native activation or
model probes and not self-acceptance of T1/T2. Do not wait idle for Astra's current
integration to finish before implementing the transport it will need.

Implement the T2 contract in docs/I-native-integration-review-and-plan.md using
the installed MCP SDK, existing createFoundryMcp authority, live runtime and tool
registry. Own mcp modules/new transport and proxy files, focused package tests and
docs/T2-live-transport-handoff.md. Astra actively owns core/provider/adapter,
factory/runtime/journal/UI/sibling and staging; do not edit those. Expose a typed
integration factory/launch descriptor for its later consumption instead of
overwriting its work. Current root dependency/live startup remain unchanged.

Required usable path:

- Owning-process loopback server bound to127.0.0.1 on an allocated port, using the
  installed WebStandardStreamableHTTPServerTransport where appropriate. Exactly
  one pinned live runtime/generation and explicit read-only grant per bridge;
  no reconstruction of a Thread in the proxy, no alternate session engine.
- Cryptographically random bridge-specific capability in a newly owned0600 launch
  file under a0700 directory; argv carries only that file's path. Header-carried
  capability, never URLs/cookies/prompts/diagnostics/tool records. Validate every
  HTTP method/request including initialize/call/GET/DELETE and transport session.
  Reject browser Origin (including null), invalid Host/foreign session/wrong or
  absent capability before any runtime/backend work. Do not reflect credentials.
- Thin STDIO MCP proxy mode in the existing CLI or a separate narrow entry point.
  Use SDK protocol/transport APIs rather than hand-rolling JSON-RPC framing. Read
  the protected launch file without following symlinks; validate mode/shape and
  loopback endpoint. Do not forward capability on redirects or accept arbitrary
  remote destinations from that file. Preserve tool content/isError/results and
  SDK correlation across concurrent calls; do not invent native IDs.
- Owner disposal/replacement/project change revokes authority immediately; explicit
  owned bridge close/deployment invalidates capability/session and cleans only its
  launch artifacts/transports. Browser/network disconnect is NOT native cancel or
  proof of idle/replacement eligibility. Do not kill an unknown native worker.
- Explicit bounded body/connections/cleanup behavior, partial setup cleanup and
  failure reporting. No inherited broad network listener, logging raw auth values
  or external network calls. Same-OS-user access is not an OS security boundary;
  describe that limitation honestly. Preserve current mandatory-context refusal
  until actual native retrieval and policy are separately proven.

Expose exact command/args/env or config data needed for central Claude and Codex
launch, without applying it to any live session or editing provider/sibling source.
Use installed local CLI help/schema only for offline validation where useful, not
guessed hot configuration or persistent `mcp add`. Existing native tools/model/
effort/settings must not be replaced by a strict empty configuration; auxiliary
profiles remain restricted. If launch hooks depend on Astra's I1 interface, return
the concrete contract and next patch scope; do not leave the proxy unexecutable.

Test actual loopback HTTP SDK initialize/listTools/callTool and a REAL owned Bun
stdio proxy subprocess talking to that server (not a model). Retrieve an omitted
owned record and same-project publication, reject foreign records and identities,
see fresh committed thread knowledge, preserve immutable results/digests and
concurrent request correlation. Negative cases: missing/wrong/expired capability,
browser Origin, invalid Host, forged SDK session, every supported HTTP method,
revocation during a held backend read, symlink/bad-mode/malformed/remote launch
file, redirect refusal, partial launch failure, disconnect/cleanup. Prove wrong
auth triggers zero backend calls. Keep tokens and raw launch contents out of test
reports/output; opaque generated test credentials may exist only in owned temp files.

Run unchanged13 independent tool cases, existing MCP/scope regressions, focused
HTTP/proxy tests and explicit source/test/script types/diff sequentially, with
unique artifact paths and per-boundary fingerprints. Concurrent source movement
is not a stable release run. Write a concise implementation handoff with exact
interfaces, commands, evidence, remaining I1 launch/journal/native correlation
work and the executable both-engine real-tool sample ready for separate review.

No native model calls, new agents, primary/lead restart, credentials/account/binding
changes, root install/dependency edits, publication or commits. Full goal remains:
actual native tools/learning/events/artifacts/tags/right-panel/lineage/subsessions,
verified models/efforts, meaningful capacity/latency parity and subscription-
independent continuity. Count6-next8 and Astra provisional leadership unchanged.
