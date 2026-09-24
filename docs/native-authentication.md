# Native runtime authentication

Foundry binds Claude Code and Codex sessions to credential sources at its existing native process launch boundary. No extra agent or daemon is needed. The runtime still consumes its normal configuration directory, environment or credential helper.

This implements local launch binding, profile ownership, source-specific session history and pre-dispatch checks. The native Kastle integration now resolves capacities, obtains per-run gateway credentials and renews them through the included helper. Follow [the Kastle–Foundry setup guide](../../kingdom/docs/foundry-integration.md) for `kastles`, defaults and per-thread assignments. The manually configured sources below remain useful for other gateways or existing native profiles; do not combine them with Kastle assignments. Native subscription enrollment and OAuth refresh custody are not implemented by this launcher.

## Configure a source

Merge these fields into `.foundry/settings.json`; retain the rest of your existing configuration. The endpoint and UUIDs below are examples. The endpoint must implement the runtime's native inference protocol; Kingdom's existing operation/access route is not a drop-in inference endpoint.

```json
{
  "nativeAuthentication": [
    {
      "id": "a0566af5-80b6-4238-85f3-333841bc5a3e",
      "connectionId": "2617c05a-f3c2-4f7d-9b29-603d1666908a",
      "runtime": "claude",
      "mode": "gateway",
      "baseUrl": "https://gateway.example",
      "credential": {
        "type": "environment",
        "variable": "INITIATIVE_GATEWAY_TOKEN"
      }
    }
  ],
  "defaults": {
    "provider": "claude-code",
    "model": "fable",
    "nativeAuthenticationId": "a0566af5-80b6-4238-85f3-333841bc5a3e"
  },
  "nativeAuthenticationSelections": {
    "357a825b-c5c3-4268-b3de-b47c2670e2a1": "a0566af5-80b6-4238-85f3-333841bc5a3e"
  }
}
```

Supply the named environment variable to the Foundry process through your existing secret mechanism. Settings store the reference only. Unknown inline secret fields are rejected. URLs cannot contain credentials, query strings or fragments; remote endpoints require HTTPS. Loopback HTTP is accepted for local probes.

For Codex use runtime `codex`, provider `codex`, your selected Codex model, and a Responses-compatible base URL (usually ending in `/v1`). Source selection is per thread within the configured native runtime. A wrong-runtime or missing source fails closed. A configured default applies to all otherwise unassigned threads, including auxiliary work. Configuration edits take effect on restart; no live selection/revocation UI has been added.

## Credential delivery and renewal

| Mode | Native presentation | Renewal owner |
| --- | --- | --- |
| Gateway, environment | Codex provider `env_key`; Claude `ANTHROPIC_AUTH_TOKEN` | Operator supplies the token before launch; a running child does not observe later parent environment changes |
| Gateway, command | Codex provider auth command; Claude `apiKeyHelper` | Native CLI invokes the configured helper; the helper must obtain an authorized token |
| Native profile | Existing `CODEX_HOME` or `CLAUDE_CONFIG_DIR` | Native CLI maintains its existing login |

A command credential replaces the environment credential object:

```json
{
  "type": "command",
  "command": "/absolute/path/to/kingdom-token-helper",
  "args": ["--connection", "2617c05a-f3c2-4f7d-9b29-603d1666908a"],
  "refreshIntervalMs": 300000
}
```

A custom executable must already exist and print the token expected by the CLI. Kastle configuration uses Foundry's bundled `kastle-token-helper.ts` automatically; manual gateway sources must supply their own helper. Arguments and paths are configuration, not secret storage; never put tokens in arguments. Foundry passes the refresh interval into the native helper configuration. It is a cache/refresh setting, not a guarantee that authentication can renew unattended. A helper must enforce the connection's `autoRenew` policy and report required user interaction. The bundled Kastle helper enforces the server's `autoRenew` policy for subsequent token issuance. Native-profile mode leaves native refresh behavior in the CLI and cannot promise to disable it through Kingdom.

Refresh is distinct from buying capacity, consuming account resets or switching subscriptions. Passkey/MFA user presence cannot be replaced by a saved password bundle.

For an existing native login, use a source with the same UUID fields and runtime, `"mode": "native-profile"`, and `"profileDirectory": "/absolute/path/to/existing/profile"`. Foundry references that directory; it does not copy, export, sign in or refresh credentials itself. Existing profile settings may select another endpoint/account, so the binding describes the chosen profile rather than independently proving provider identity.

## Concurrency, history and revocation

Gateway profiles live under `.foundry/runtime-profiles/<source UUID>/<binding hash>`. Separate threads can run concurrently. A filesystem lock prevents two Foundry processes from owning the same profile simultaneously. Configuration is written only after acquiring ownership. Profile history is retained after exit to support cold resumption; configuration/source changes produce a new history namespace. Retired profiles need explicit lifecycle cleanup after confirming they are unused.

A native profile has one Foundry process owner at a time to avoid multiple refresh writers. Foundry refuses native-profile auxiliary sessions. Startup is subscription-only by default: decisions run through bounded, text-only `codex exec` turns on the Codex login rather than a Codex adapter session, which still refuses text-only sessions. The OpenAI/Luna API decision provider is constructed only with the `apiTokens: true` opt-in. See [subscription decisions](subscription-decisions.md). An external CLI does not honor Foundry's lock; coordinate external use of the same profile as well.

Session history keys include source UUID and source configuration hash. A warm session cannot silently change sources, and legacy ambient history is not automatically resumed. Checks run before send and again immediately before the substrate writes queued work, including after asynchronous admission checks. A revoked source stops subsequent launches and sends. An already admitted turn or active stream requires separate cancellation.

The exported `NativeAuthentication` manager exposes `select(threadId, sourceId)` and `revoke(sourceId)`. Supply it as `authentication` to `ClaudeCodeSessionAdapter` or `CodexSessionAdapter`, then use the existing `SessionBackedProvider`. Release the old settled session through the provider's existing owned-admission release path before creating a replacement after selection changes; central sessions do not have an unrestricted hot-switch/release API. In-memory revocation lasts for that manager's lifetime; durable policy enforcement belongs at Kingdom's request boundary.

A Kingdom token is independently revocable only where a gateway checks Kingdom's current authorization. Handing out an upstream token gives the recipient upstream authority until the provider expires or revokes it. Launch checks cannot claw that token back. Separate config directories prevent accidental credential mixing; they are not an OS security boundary against another process running as the same user.

## Ownership recovery

Normal child exit releases `.foundry-auth-lock`. Cleanup errors remain visible as an unknown release result; Foundry does not report successful release when it cannot verify ownership. After a hard crash, verify that the recorded Foundry owner **and its native children** are dead before removing only that stale lock. Never delete a live owner's lock or a whole native credential directory. Automatic stale-lock recovery is intentionally absent.

## Package and validation

Foundry depends on the published `@inixiative/agent-session` (`^0.2.0`), released through the inixiative release train's agentic lane. Version 0.2.0 carries the `prewrite-v1` admission contract and the `optional-max-turns-v1` turn-budget protocol; 0.1.0 lacked both. Its `src/` files are byte-identical to the source snapshot reviewed at agent-session `dbdb923`, which Foundry previously vendored.

Install integrity comes from the committed `bun.lock`, which records the exact resolved version and the registry's `sha512` integrity. `bun install --frozen-lockfile` refuses a tarball that does not match, so a new agent-session version reaches Foundry only through a reviewed lockfile change. The lockfile does not bind the tarball to a git revision; to re-verify an installed tree file by file, regenerate the private Lab's reviewed manifest from the installed package and run its `check-native-adoption.ts` against it.

```sh
bun install --frozen-lockfile --ignore-scripts
bun test packages/foundry/tests/native-authentication.test.ts packages/foundry/tests/session-adapter.test.ts packages/foundry/tests/session-backed-provider.test.ts
bun run typecheck
```

Controlled tests cover child environment isolation, lock contention, queued revocation, source-scoped resumption, cleanup failures and conflicting CLI overrides. Unit checks use controlled processes and synthetic tokens. The subsequent Kastle integration additionally runs the installed Claude/Codex CLIs and actual helper through localhost HTTP and disposable PostgreSQL with synthetic provider responses. This validates local transport/configuration and cap enforcement; a bounded live-source pilot and subscription-specific enrollment remain separate.

See [runtime credential research](../../kingdom/docs/runtime-credential-research.md) for the official runtime contracts and local profile probes.


### Initial launch-binding validation recorded 2026-09-10

- Focused authentication/adapter/provider tests: 51 passed, 174 assertions.
- Typecheck: both packages passed.
- Installed package check: all 7 files match the complete snapshot manifest; prewrite and default/bounded/unbounded turn-budget contracts passed with controlled spawns.
- Full Foundry suite after snapshot installation: 1,404 passed, 8 skipped, 3 failed. Remaining failures are the message-delivery exact-object expectation, an owned-host exit-confirmation test, and the viewer's closed-local-import-graph assertion. The full suite is not green. Earlier diagnostic subprocess timeouts did not reproduce in this run.
- Fable 5.1 review: fixed the Codex attached-argument bypass and deferred profile creation until launch. Retained profile history for resumption instead of deleting it on release. Retained explicit cleanup failure reporting instead of silently accepting missing/changed lock ownership; a controlled regression verifies the unknown release result.

No actual credentials were imported and no deployment occurred. The Kastle integration exercises its actual helper against a local HTTP server with synthetic provider credentials and responses. Live provider inference remains untested. See the Kastle setup guide for the implemented gateway and remaining rollout limits.

### Kastle integration validation — 2026-09-10

- Focused Foundry authentication, adapter and provider tests: 55 passed. Foundry typechecks passed.
- Kingdom package tests: 17 passed; Kastle frontend client test: 1 passed; API integration tests: 70 passed against disposable PostgreSQL.
- Opt-in native CLI proof passed for installed Claude Code 2.1.258 and Codex 0.153.4. Both returned synthetic provider output through the actual token helper and local Kastle gateway. Model-discovery probes are not implemented; unknown fixture models use the CLI's fallback metadata.
- Kingdom monorepo typechecks, post-Biome lint checks and CI rules passed. Canonical `kingdom:check` remains blocked by two formatting errors in concurrent archive work (`KastlePage.tsx` and `scripts/kingdom/test.ts`); it did not reach its full backend/frontend suites.
- The final broader Foundry run recorded 1,413 passes, 8 skips and the same three failures listed above. It is not a fully green repository-wide result.
- Adversarial review addressed missing final usage, credential replacement races, exhausted preferred capacities, binding retry identity, token lifetime, beta pricing headers and terminal-stream cancellation. Automatic renewal disabled plus a lost first token response requires a new-run recovery.
