# Devices and linked project checkouts

Status: local device identity/enrollment and the viewer inventory are implemented September 11, 2026. The guarded native `foundry_device` tool is also implemented. Cross-machine project links, remote enrollment/inventory and handoff remain unimplemented.

The viewer's Projects panel now registers this user's local device and lists only
configured, enabled projects. The default identity is a random UUID stored in
`~/.foundry/device.json` with mode 0600, shared by the user's Foundry installations.
An isolated profile may supply `deviceIdentityPath` to the viewer. Enrollment is
idempotent, publishes the identity atomically without replacing an existing ID,
and preserves invalid existing files for repair. Checkout IDs bind device ID,
existing project ID and registered path. No Git remotes, hardware identifiers,
filesystem discovery, branch observations or provider capabilities are inferred.

The routes `/api/devices` and `/api/devices/local` use the viewer's existing
operator authentication boundary. This is a local installation identity, **not**
Kingdom device authorization or a cross-organization enrollment credential.
Controlled browser verification used a disposable profile and the four sibling
paths; it did not enroll this machine into a remote account.

Foundry should expose the user's devices and the projects on each device, with an explicit relationship between checkouts of the same project. A project view should answer: where is this checked out, what differs, and where is my session running?

## Identity and ownership

- A device receives a random stable ID when enrolled, a display name, its owner and allowed Kastle scope. Hostnames and hardware serial numbers are not identities.
- An existing Foundry project keeps its ID. A separate project-link record relates existing project IDs across devices; linking never rewrites grant allowlists, session ownership or history.
- A checkout identifies one device-local repository/worktree. Its path, branch, commit, dirty state and observation time belong to that checkout, not the shared project.
- Matching normalized Git remotes can suggest links. Explicit linking establishes the relationship. Repository URL alone cannot establish identity: this handoff deliberately contains four separate histories in one private repository.
- Personal, inixiative and UserEvidence inventories remain separately authorized. Linking projects cannot grant another organization access to files, sessions or credentials.

## Native surface

The viewer offers Devices and Projects views. Devices show last contact, available native runtimes and explicitly enrolled checkout paths. Projects show their linked checkouts with branch/commit, unsaved changes, observation freshness and running sessions. Selecting a checkout opens it on the named device; unavailable devices remain visible as offline.

Expose the same authorized inventory through the existing native bridge. Derive caller scope from the admitted session. Inventory descriptions are observations, not executable instructions. Native agents must be able to report the active device and checkout without guessing from an absolute path.

Start with local inventory and manually linked enrollment. Do not crawl entire home directories, publish raw remote URLs containing credentials, or start background network discovery implicitly. Report unavailable runtime capability separately from installed capability; the macOS-blocked Codex CLI is an example.

## Access, capacity and handoff

Reuse Kingdom's credential encryption manager for server-held credential envelopes and versioned rotation. Keep device private keys in a device-local protected store. Enrollment/revocation should bind device identity to existing Kastle authorization. Discovery never exports upstream credentials or implies deployment permission.

Keep capacity admission and usage settlement in their existing owners. Device presence is not capacity; an online device may have no valid provider access or available allowance. A lost heartbeat cannot release an unsettled run's reservation.

Opening another checkout is distinct from moving work. A later handoff must explicitly select destination and source state, preserve uncommitted changes in a reviewable transfer, validate destination capabilities/access, and use the existing session lifecycle for interruption and resume. Never silently merge or overwrite divergent checkouts. Retain source and destination evidence with stable project/device/checkout identifiers.

## Delivery and verification

1. Local device/checkout inventory and explicit project links, preserving existing project IDs and grants.
2. Authenticated device enrollment, scoped remote inventory and revocation through Kingdom.
3. Viewer and native bridge access to the same inventory, including offline/stale observations.
4. Explicit session handoff using existing admission, archive and unknown-settlement semantics.

Acceptance includes identical repositories at different paths, separate histories sharing one remote, forks suggesting but not asserting identity, dirty/divergent branches, duplicate enrollment, device revocation, cross-organization denial, offline devices, and an in-flight run whose usage is unknown after disconnect. Controlled tests establish these mechanisms; real two-device operation remains a separate live acceptance check.


## Native device context

`foundry_device` is a read-only MCP tool on the existing live native bridge. It
uses the enrolled local identity and the bound thread's project/cwd; tool
arguments cannot select another project or identity file. Missing enrollment or
project/cwd reports unavailable. A changed cwd requires reconnecting; changed
project/runtime ownership is refused by the existing authority guard. The result
labels its checkout observation `session-bound`: it is not a Git/physical-disk
verification. Only that project is exposed, even when the viewer lists others.
Viewer profile identity paths propagate through runtime routes and the native
bridge. Calls retain the existing invocation/journal provenance.

Validation includes SDK in-memory transport, a real local stdio proxy and journal
roundtrip with a controlled runtime, and the full Foundry suite. It does not prove
live model use or two-device/remote enrollment. No model request is necessary for
enrollment or device inventory retrieval.
