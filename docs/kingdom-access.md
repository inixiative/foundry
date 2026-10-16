# Kingdom integration access in Foundry

Foundry can discover and read resources through Kingdom's existing access routes. The adapter works with Slack, Teams, Linear, Notion, Jira, Drive and Confluence using the operations the server currently advertises. It does not copy their provider credentials into native profiles. Inference capacity continues through the separate Kingdom run-binding gateway.

## Configure a project grant

In the viewer, open **Settings → Kingdom** (Resource grants) globally, or a project's **Integrations** settings. Add or edit a grant, choose allowed projects, and select the **Signet credential file** this Foundry holds. The browser receives the path and local file status, never the file's contents. **Check access** explicitly fetches the saved grant's currently permitted operations/resources, access-token expiry and remaining Signet requests; it does not execute a resource read or renew credentials. Authentication rejection appears separately from a successful access check. Conflicting saved revisions are refused until reloaded.

Saved changes apply after restart. Removing a local grant does not revoke its Signet in Kingdom. The panel makes this distinction explicit. Narrow settings layouts provide a separate assistant view so the editor remains usable.

A Signet is presented only through an enrolled key; Kingdom issues no bearer token for it. In Kingdom, add the Integration (its Credential holds the provider login) and register its resources. Then grant a Signet with the required read operations, resources and allowance to this Foundry's integration (recipient: **An integration I manage, such as a Foundry**). The Signet supplies the recipient and the authoritative usage project and tags. Pool membership alone grants nothing.

This Foundry must be paired with that Kingdom first (`bun run kingdom pair`). Its Installation connection sees the new Signet, enrolls it with the Installation key, and writes the credential to `<config-dir>/kingdom/<kingdom host>/signet-<signetId>.json`. The file is owner-only (mode `0600`) and holds the renewal credential, the current five-minute DPoP access token and the path of the private key. Point `credentialFile` at it. A bare `{"secret":"kingdom_..."}` file and the native installation, refresh and inference token formats are rejected. Foundry reads the file for each request and renews the access token through it, so settings never embed secrets.

Merge this into the Foundry instance's settings, replacing the illustrative IDs and paths:

```json
{
  "kingdomAccess": [{
    "id": "62c70ab2-76bc-4727-9eb5-bbf62c5cf4be",
    "name": "Team Linear issues",
    "url": "https://kingdom.example",
    "credentialFile": "/absolute/path/.foundry/kingdom/kingdom.example/signet-2a4f86c4-bede-49b5-a8c0-ef6b53cc216d.json",
    "integrationId": "2617c05a-f3c2-4f7d-9b29-603d1666908a",
    "signetId": "2a4f86c4-bede-49b5-a8c0-ef6b53cc216d",
    "projectIds": ["661d4d35-22f0-472d-a660-c573a90761eb"]
  }]
}
```

The access source has a UUID `id`. Integration, Signet and resource references are Kingdom UUIDs. `projectIds` reference existing Foundry projects exactly, including IDs from older installations; no project is renamed or aliased. An optional nonempty `threadIds` list further restricts the grant. These local allowlists reduce access; Kingdom still enforces the current server grant. Unknown or disabled project references fail configuration validation.

Run `bun run doctor` to check local configuration and file permissions, then restart the intended Foundry instance to apply source/allowlist changes. Doctor performs no remote authorization or renewal. Removing a local setting takes effect after restart; revoke the Signet or its enrollment in Kingdom for immediate rejection of subsequent requests. Already dispatched reads may finish.

## Use from a native session

When access is configured, the existing Foundry native bridge exposes `foundry_access` to Claude/Codex:

1. `{"action":"integrations"}` lists this task's configured sources without network calls. This is not a claim that their Signets remain valid.
2. `{"action":"describe","accessId":"SOURCE_UUID"}` fetches currently available read operations and resource UUIDs. A credential belonging to a different Integration or Signet is rejected.
3. `{"action":"read","accessId":"SOURCE_UUID","operation":"issues.read","resourceId":"RESOURCE_UUID","limit":20}` reads one resource. Limits are 1–50, with any tighter provider limit enforced by Kingdom.

Native reads require an active registered admission. Caller project/thread ownership comes from the pinned bridge, never tool arguments. Each invocation uses the existing journal path. If the thread moves projects or its runtime is replaced while a read is pending, the stale bridge refuses result delivery.

Foundry's API-backed tool loop reaches the same adapter as `kingdom_request`: use `url` equal to `integrations`, `describe`, `read` or `close`, `method: "POST"`, and the corresponding fields in `body` (without `action`). Arbitrary URLs, caller headers, credential overrides, writes and inference operations are rejected. Core only adds an optional scope-binding primitive for API tools; Kingdom behavior remains in Foundry.

The existing bridge is the tool transport. It does not become the credential proxy: Kingdom retains that role, and native inference still uses its provider-compatible endpoint.

## Attribution and failure handling

Successful reads return the provider result and UUID `executionId`, `requestId` and `runId`. The run UUID groups one Foundry project/thread during this process lifetime; distinct threads get different UUIDs. It is independent of an inference RunBinding and is not an authorization credential. A restart starts a new grouping. Native journal ownership links the returned references to the original admission and dispatch; Kingdom records its Signet, enrollment and access-token attribution.

Discovery happens before each read, followed by the server's transactional authorization and allowance check. Discovery cannot reserve access or promise that execution will succeed. The client never retries, follows redirects or rotates accounts after an uncertain response. A failure after execute dispatch preserves request/run references for investigation; a pre-dispatch failure says that execution did not start. Error bodies and local credential paths are not published to the model. Responses are bounded to 1 MiB.

Provider OAuth renewal remains Kingdom's responsibility under the Integration's `autoRenew` policy. This adapter renews the Signet's access token through its enrollment but does not mint replacement Signets, purchase capacity, or implement upstream subscription/passkey enrollment. Returned content is external data and can contain untrusted instructions.

## Verification

Controlled tests cover project/thread isolation, credential schema/permissions, fresh revocation, wrong grants/resources, concurrent attribution, redirects, oversized responses, and uncertain executions without retries. An actual SDK subprocess uses the production native bridge and persists the original admission's execution reference. The Kingdom test additionally runs the real access routes and PostgreSQL locks: two concurrent Foundry reads sharing one remaining request result in one provider dispatch, followed by denial after token revocation.

All provider content in these checks is synthetic. Grant editing and access inspection are available in the viewer. Live accounts, capacity/spread controls and the bounded native domain-learning pilot remain separate rollout work.

MCP and a future CLI wrapper should use the same Kingdom authorization layer. They present an enrolled Signet rather than an upstream password. Each enrollment is Signet-scoped; discovery across all permitted Integrations remains a separate authorization change, not something the frontend silently assumes.

## Integration identity contract

Kingdom access sources and Signet proposals use `integrationId`; inference selections use `integrationIds`, and run envelopes return `integrationId`. Replace the former remote `connectionId`/`connectionIds` settings with the reviewed Integration IDs before using the updated server. Ambiguous or legacy source configurations are rejected; credentials and existing authority are not silently migrated. Pending old Signet proposals should be reviewed and recreated with the correct Integration identity.

Foundry's local native profiles carry the same name: `integrationId`. A resolved Kingdom gateway maps the selected envelope's `integrationId` into the profile; this does not establish subscription-account ownership.
