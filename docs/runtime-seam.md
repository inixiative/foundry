# The supported seam for a paired Foundry

`@inixiative/foundry/runtime` is the only entrypoint an outside consumer should import. It exposes the connection a paired Foundry holds to a Kingdom, and the client that presents its Signet:

```ts
import {
  KingdomRuntimeConnection,
  SignetClient,
  SignetHttpError,
  kingdomRuntimeSchema,
  type KingdomInstallation,
  type KingdomRuntimeSettings,
  type RuntimeIdentity,
  type RuntimeOwner,
} from '@inixiative/foundry/runtime';
```

Construction does no network. An explicit `connection.start()` begins activity.

## What the seam is, and is not

A Foundry registers with a Kingdom as an **Installation**, identified by its own key. The owner approves that registration through an Inquiry, and Kingdom mints the Integration and the Signet it holds. `KingdomRuntimeConnection` is that paired relationship; `SignetClient` presents the Signet, with its audience, expiry, DPoP and renewal checks intact.

**Importing this does not grant authority.** A Signet names the resources, operations, lens and limits its holder may use; the export is a client, not a permission. Nothing here widens the Signet action set, and server-side authorization is still what decides.

Depend on this entrypoint, never on `@inixiative/foundry/src/...`. Internals move; this does not.

## Naming

The entrypoint is still called `runtime` and its types still read `KingdomRuntime*`. That vocabulary predates Installations and goes when Kingdom's `RuntimeInstallation` is deleted. The seam itself is unaffected by the rename.

## Verifying it from outside

A seam you only ever import from inside the repo is not a seam. [`scripts/runtime-package/`](../scripts/runtime-package/README.md) packs the package and imports it as an installed consumer would, which is the only way to catch an export that works in-repo and breaks once published.
