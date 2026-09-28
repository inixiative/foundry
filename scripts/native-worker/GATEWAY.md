# Controlled worker gateway policy

This is a non-network policy prototype. `worker_gateway_policy.py` has no listener, DNS implementation, dialer, MCP transport, native CLI, credential reader, worker registration or readiness signer. Its callbacks are controlled test seams. Nothing imports it from production Foundry. The results are labeled `controlled-gateway`; they establish neither execution authority nor online VM containment.

Run the negative and lifecycle tests without accounts or networking:

```sh
python3 -B scripts/native-worker/test-worker-gateway.py
python3 -B scripts/native-worker/test-offline-verification.py
```

The policy copies the supplied collections and binds them to one immutable worker, peer, installation, role, admission and boundary digest. The public identity, policy and digest references are read-only. Frames use exact keys, bounded UTF-8 JSON, unique invocation IDs and replay limits. HTTPS routing permits only explicitly selected candidate authorities on port 443; resolution rejects mixed public/private responses and unsupported IPv6. A routing result is not a connection, and requires a future address-pinned dialer with its own current authorization check.

Only the primary role can call explicitly approved fixture tools. The default test policy permits only `fixture_read`. There is no automatic command inheritance or mapping from `workspace.applyPatch`; these are distinct contracts. Guest input cannot choose a broker URL, authorization header, role, owner, profile or environment. Host/Origin checks on the existing MCP bridge remain unchanged.

Authority is checked inside the queued operation immediately before entering an adapter, after its result and through a supplied synchronous guard. Adapters must call that guard after internal awaits, immediately before every side effect. The guard enforces the absolute monotonic operation deadline as well as gateway lifetime and current authority; a delayed event-loop timer cannot extend admission. An arbitrary adapter can ignore a callback, so this contract requires review and race tests at the concrete dial/write implementation. Trusted Python internals are not a guest sandbox.

Timeout, cancellation and failure close admission. Unfinished underlying tasks remain counted until they actually settle, and late output cannot be delivered. This accounting does not prove process cleanup. An external supervisor must bound blocking adapters and confirm worker/stream shutdown; a synchronous adapter can block this prototype's event loop. Response size is checked after serialization, so hostile output allocation still needs an externally bounded streaming transport.

## Regression evidence

Thirteen tests cover scheduling-boundary revocation/close with zero adapter calls; revocation after adapter-internal waits; absolute deadlines despite delayed timers; timeout/cancellation with pending work retained; identity/policy replacement; replay/overlap; tool/role separation; DNS and authority rejection; frame/path bounds; expiry/call/output caps; and withholding results after revocation. All adapters are synthetic. The old private sketch reproduced a dispatch after revocation; the fixed port rejects it before adapter invocation.

## Current repository and integration boundary

Inventoried public `inixiative/foundry` main at `133d382` on September 28. The offline worker is present through port `d92f7e3` and the controlled fixture bridge through `be74c14`. The gateway sketch was not previously in public source. Historical private Kingdom PR51 is not this repository's current head.

Public Foundry now defaults to a Claude Code worker and Codex GPT-6 Luna subscription decisions, without a paid API fallback. This prototype changes no provider/model selection. Its initial candidate HTTPS routes concern Claude only: it cannot carry Codex decision traffic. A supported Codex route/policy and model-evidence contract need separate investigation and acceptance. No decision tool channel is enabled. Refer to [current subscription defaults](../../docs/subscription-decisions.md); do not reuse the historical two-Claude assumption automatically.

Native source IDs in `NativeAuthenticationSource` are explicitly local identities; they are not verified subscription-account or quota-owner IDs. Public source has the generic runtime-job registry/handler and Signet client internally, but no Oracle project consent/descriptor/worker-registry implementation. At the inventoried head those generic job/client contracts are not exported through the package's supported entrypoints, and the Oracle-named CLI script entries have no corresponding Oracle profile implementation. Private Oracle integration needs a reviewed public extension/client API with package-consumer tests, then explicit handler registration; it must not deep-import Foundry internals or assume old Kingdom contracts were ported. Unknown job kinds must continue to fail closed.

## Remaining online acceptance

The offline zero-socket VM evidence does not cover a socket-enabled VM. Before live use, implement actual per-VZ-device connection identity, fixed service ports, a no-NIC guest shim, external address-pinned HTTPS streaming with byte/connection/time bounds, and an admitted fixed MCP adapter. Test cross-role and host denial, delayed/revoked writes, resource saturation and externally observed shutdown. Keep subscription ownership, worker readiness and project disclosure separate. A source-owned quota ledger must survive worker/profile aliases.

No login is needed for the remaining controlled tests. Later the operator must authenticate through supported flows directly inside the finished private role workers and approve the account/model/capacity delegation. Supported stable authenticated identity still needs verification; if unavailable, an operator-verified alternative needs distinct documented assurance. No credential export, paid fallback or inferred readiness is permitted. Production/phone acceptance belongs to a separate delivery audit, not these tests.
