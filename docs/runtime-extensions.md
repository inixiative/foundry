# Application-owned runtime handlers

Import enrolled runtime extension contracts from `@inixiative/foundry/runtime`. Applications own their payload schemas, domain state, authority checks and results. Foundry owns the generic polling, private job directory, per-job lock and enrolled runtime connection.

```ts
import { z } from "zod";
import {
  RuntimeJobRegistry, KingdomRuntimeConnection,
  type RuntimeJobHandler, type KingdomRuntimeSettings,
} from "@inixiative/foundry/runtime";

const handler: RuntimeJobHandler<{ label: string }> = {
  kind: "example",
  payload: z.looseObject({
    payload: z.object({ label: z.string() }).strict(),
  }).transform(job => job.payload),
  async run(job, payload, context) {
    if (context.stopped()) throw Error("Runtime stopped");
    // Application-owned validation and work belong here. Registration alone
    // does not grant source, tool, model, evaluation or delivery authority.
  },
};

export function connection(settings: KingdomRuntimeSettings) {
  const registry = new RuntimeJobRegistry().register(handler);
  return new KingdomRuntimeConnection(settings, () => 0, fetch, registry);
}
// An explicit connection.start() begins network activity; import/construction do not.
```

The entrypoint exports `RuntimeJobRegistry`, `RuntimeJobWorker`, `KingdomRuntimeConnection`, `SignetClient`, `SignetHttpError`, the generic `runtimeJobSchema`/`kingdomRuntimeSchema`, and their handler/context/request/identity/job/settings types. The worker and connection accept the registry through their existing constructors. Unknown job kinds throw before handler execution; duplicate registrations throw. The framework's `connectionCheck` handler remains registered by default.

`SignetClient` is for an already enrolled credential and preserves its existing audience, expiry, DPoP and renewal checks. The runtime handler's enrolled `context.request` and Signet operations are different authority paths; applications must use the appropriate one and obtain server-side authorization. Neither the export nor a TypeScript interface grants authority.

No application handlers are registered by this entrypoint. The existing internal job-record format is not exported as a generic application state store. Applications should use their own domain storage and depend on supported entrypoints, not `@inixiative/foundry/src/...` internals. This seam does not add native subscription identity verification, worker containment or project consent.

See [installed consumer verification](../scripts/runtime-package/README.md) for packing and testing outside the repository.
