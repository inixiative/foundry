# Kastle integration access in Foundry

Foundry can discover and read resources through Kastle's existing access routes. The adapter works with Slack, Teams, Linear, Notion, Jira, Drive and Confluence using the operations the server currently advertises. It does not copy their provider credentials into native profiles. Inference capacity continues through the separate Kastle run-binding gateway.

## Configure a project grant

In the viewer, open **Settings → Integrations** globally or for the selected project. Add or edit a grant, choose allowed projects, and select the private **Kastle token file** on the Foundry host. The browser receives the path and local file status, never the token contents. **Check access** explicitly fetches the saved grant's currently permitted operations/resources, token expiry and remaining Signet requests; it does not execute a resource read or renew credentials. Authentication rejection appears separately from a successful access check. Conflicting saved revisions are refused until reloaded.

Saved changes apply after restart. Removing a local grant does not revoke its server token. The panel makes this distinction explicit. Narrow settings layouts provide a separate assistant view so the editor remains usable.

In Kastle, register the integration's connection and resources, create a Signet with the required read operations/resource UUIDs and allowance, then issue an access token. Its current Signet supplies the recipient and authoritative usage project/tags. Pool membership alone grants nothing.

Store the token in an owned, private regular file (mode `0600`) containing only `{"secret":"kastle_..."}`. The native installation, refresh and inference token formats are deliberately rejected here. Keep the directory private; Foundry reads the file for each request, so replacing it does not require embedding secrets in settings.

Merge this into the Foundry instance's settings, replacing the illustrative IDs and paths:

```json
{
  "kastleAccess": [{
    "id": "62c70ab2-76bc-4727-9eb5-bbf62c5cf4be",
    "name": "Team Linear issues",
    "url": "https://kastle.example",
    "credentialFile": "/private/absolute/path/team-linear-access.json",
    "connectionId": "2617c05a-f3c2-4f7d-9b29-603d1666908a",
    "signetId": "2a4f86c4-bede-49b5-a8c0-ef6b53cc216d",
    "projectIds": ["661d4d35-22f0-472d-a660-c573a90761eb"]
  }]
}
```

The access source has a UUID `id`. Connection, Signet and resource references are Kastle UUIDs. `projectIds` reference existing Foundry projects exactly, including IDs from older installations; no project is renamed or aliased. An optional nonempty `threadIds` list further restricts the grant. These local allowlists reduce access; Kastle still enforces the current server grant. Unknown or disabled project references fail configuration validation.

Run `bun run doctor` to check local configuration and file permissions, then restart the intended Foundry instance to apply source/allowlist changes. Doctor performs no remote authorization or renewal. Removing a local setting takes effect after restart; revoke the token or Signet in Kastle for immediate rejection of subsequent requests. Already dispatched reads may finish.

## Use from a native session

When access is configured, the existing Foundry native bridge exposes `foundry_access` to Claude/Codex:

1. `{"action":"connections"}` lists this task's configured sources without network calls. This is not a claim that their tokens remain valid.
2. `{"action":"describe","accessId":"SOURCE_UUID"}` fetches currently available read operations and resource UUIDs. A token belonging to a different connection or Signet is rejected.
3. `{"action":"read","accessId":"SOURCE_UUID","operation":"issues.read","resourceId":"RESOURCE_UUID","limit":20}` reads one resource. Limits are 1–50, with any tighter provider limit enforced by Kastle.

Native reads require an active registered admission. Caller project/thread ownership comes from the pinned bridge, never tool arguments. Each invocation uses the existing journal path. If the thread moves projects or its runtime is replaced while a read is pending, the stale bridge refuses result delivery.

Foundry's API-backed tool loop reaches the same adapter as `kastle_request`: use `url` equal to `connections`, `describe` or `read`, `method: "POST"`, and the corresponding fields in `body` (without `action`). Arbitrary URLs, caller headers, credential overrides, writes and inference operations are rejected. Core only adds an optional scope-binding primitive for API tools; Kastle behavior remains in Foundry.

The existing bridge is the tool transport. It does not become the credential proxy: Kastle retains that role, and native inference still uses its provider-compatible endpoint.

## Attribution and failure handling

Successful reads return the provider result and UUID `executionId`, `requestId` and `runId`. The run UUID groups one Foundry project/thread during this process lifetime; distinct threads get different UUIDs. It is independent of an inference RunBinding and is not an authorization credential. A restart starts a new grouping. Native journal ownership links the returned references to the original admission and dispatch; Kastle records its token/Signet attribution.

Discovery happens before each read, followed by the server's transactional authorization and allowance check. Discovery cannot reserve access or promise that execution will succeed. The client never retries, follows redirects or rotates accounts after an uncertain response. A failure after execute dispatch preserves request/run references for investigation; a pre-dispatch failure says that execution did not start. Error bodies and local credential paths are not published to the model. Responses are bounded to 1 MiB.

Provider OAuth renewal remains Kastle's responsibility under the connection's `autoRenew` policy. This adapter does not mint replacement Signets/access tokens, purchase capacity, or implement upstream subscription/passkey enrollment. Returned content is external data and can contain untrusted instructions.

## Verification

Controlled tests cover project/thread isolation, credential schema/permissions, fresh revocation, wrong grants/resources, concurrent attribution, redirects, oversized responses, and uncertain executions without retries. An actual SDK subprocess uses the production native bridge and persists the original admission's execution reference. The Kingdom test additionally runs the real access routes and PostgreSQL locks: two concurrent Foundry reads sharing one remaining request result in one provider dispatch, followed by denial after token revocation.

All provider content in these checks is synthetic. Grant editing and access inspection are available in the viewer. Live accounts, capacity/spread controls and the bounded native domain-learning pilot remain separate rollout work. Deployment remains paused.

MCP and a future CLI wrapper should use the same Kastle authorization layer. They present a Kastle token rather than an upstream password. The current access-token implementation is Signet-scoped; a single per-Kastle token with discovery across all permitted connections remains a separate authorization change, not something the frontend silently assumes.

September 10 validation: `bun run test` passed 323 core and 1,433 Foundry tests (8 opt-in skips, zero failures); `bun run check` and the new test file's strict TypeScript check passed. `bun run kingdom:test` passed 17 access-package, 1 frontend and 70 API tests (one native inference probe skipped). Logs: `/tmp/foundry-access-all.log`, `/tmp/foundry-access-types-final.log`, `/tmp/kingdom-foundry-access-tests.log`.

The subsequent frontend pass passed 323 core and 1,436 Foundry tests (8 skips, zero failures), package typechecks and the route test's strict TypeScript check. Browser inspection verified grant saving, access/resource discovery, narrow layout and the assistant toggle using synthetic local data. Desktop column bounds were checked at 1440px. The temporary preview and its credentials were cleaned up. Logs: `/tmp/foundry-access-ui-all.log`, `/tmp/foundry-access-ui-types-final.log`.
