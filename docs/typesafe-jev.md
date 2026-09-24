# TypeSafe / Jev decisions

Foundry exposes `TypeSafeDecisionClient` and `createTypeSafeMiddleware` through
`@inixiative/foundry/providers`. Register the middleware explicitly for the
dispatches that need it. Starting Foundry does not enable Jev or replace the
native coding harness or its configured decision provider.

Jev is in `MODEL_REGISTRY` as the `typesafe` provider (`jev-latest`,
`runtimeKind: "typed-decision"`, capability `judgment`, disabled by default).
The registry entry describes it; it does not construct it. `TypeSafeDecisionClient`
is not an `LLMProvider` — `evaluate` takes typed questions and returns typed
answers, not chat completions — so it cannot back a chat agent, and
`createRegisteredProvider` refuses it.

Jev is useful for bounded judgments: choosing a domain, scoring urgency, or
detecting a topic change. It accepts typed questions rather than chat prompts.
Batch independent questions about the same state, then combine their answers
in code. Choice and Score supply a confidence value; Noul supplies a yes
probability. Confidence thresholds need evaluation against your own examples.
See [primitives](https://docs.typesafe.ai/primitives) and
[confidence](https://docs.typesafe.ai/confidence).

## Account setup

Create a service API key in the [TypeSafe console](https://console.typesafe.ai/home)
and supply it to the Foundry process as `TYPESAFE_API_KEY` through your local
secret environment. Settings and code contain only its environment variable
name. Different account contexts can use separate names, such as
`INIXIATIVE_TYPESAFE_API_KEY` and `UE_TYPESAFE_API_KEY`, with separate client
instances. This is TypeSafe's service credential; Google identity, ChatGPT,
and Claude subscriptions do not supply it. Account entitlements/billing have
not been verified and no live requests have been made.

The client uses the documented
[HTTP API](https://docs.typesafe.ai/api): `POST https://api.typesafe.ai/v1/systemone`
with bearer authorization. The default model is `jev-latest`; set `model` to a
versioned ID when reproducing evaluations. The response retains the actual
model ID and token usage. An official [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
also exists; this small integration uses Bun's fetch and existing Zod validation
without adding a runtime dependency.

## Explicit middleware integration

```ts
import { ActionQueue, CapabilityGate, MiddlewareChain } from "@inixiative/foundry-core";
import { TypeSafeDecisionClient, createTypeSafeMiddleware } from "@inixiative/foundry/providers";

const gate = new CapabilityGate({
  defaults: "deny",
  capabilities: { "net:api": "allow", "llm:call": "allow" },
}, new ActionQueue());
const jev = new TypeSafeDecisionClient({ gate, apiKeyEnv: "TYPESAFE_API_KEY" });
const middleware = new MiddlewareChain();
middleware.use("jev-domain", createTypeSafeMiddleware({
  client: jev,
  state: ctx => ({ message: String(ctx.payload) }),
  questions: {
    domain: {
      type: "choice",
      instructions: "Which domain best matches `message`?",
      criteria: { auth: "Login and identity", storage: "Persistent data", other: "Anything else" },
    },
  },
  onDecision(result, ctx) {
    const answer = result.answers.domain;
    ctx.annotations.domain = answer.confidence >= 0.9 ? answer.choice : "review";
  },
}));
// Execute this chain around the intended handler with the real thread identity.
// The handler can read annotations.domain and apply its configured review path.
```

The middleware stores the validated response in `context.annotations.typesafe`
(or `annotationKey`) before invoking `onDecision` and the next handler. It
requires a thread ID and checks the existing `net:api` and `llm:call` capabilities.
It never grants account access or picks a tenant/credential based on a model
answer: choose the account client from trusted project configuration first.
The state selector controls what leaves the process. Keep credentials and
unrelated account context out of it.

Missing keys, denied capabilities, malformed answers, and failed service calls
stop the chain. There is no implicit fallback to another provider. Callers own
their low-confidence/review policy. Direct callers may pass an AbortSignal to
`evaluate`; each call also has a 10-second transport deadline. Only HTTP 429 and
529 are retried, twice by default, with backoff and Retry-After handling within
the deadline. Error messages omit provider response bodies and transport details.

## Verification and remaining end-to-end work

Run `bun test packages/foundry/tests/typesafe.test.ts`. Tests use an injected
transport and exercise the real middleware chain without network calls.

To enable a real project: provision its key, register a selected middleware in
that project's composition, run a small non-sensitive fixture set, and record
model ID, confidence, usage, latency, and expected routing results. Compare
against the current decision path before expanding coverage. No viewer account
connection, Kingdom key storage, or automatic startup registration is included.

## Two-stage shadow experiment

`TypeSafeShadowRunner` accepts a trusted `catalog(context)` function that returns
the routes currently available for this thread/project and selected learnings.
Callers can derive that snapshot from their codebase or a reviewed manifest.
The runner does not crawl the repository or automatically trust learned text
to add routes. Each invocation snapshots and validates at most 64 candidates
(ID and description only) and 16 learnings (up to 2,000 characters each).
The observation is snapshotted before catalog lookup, must be JSON content,
and is limited to 64 KiB serialized UTF-8; select relevant excerpts instead of
passing an entire repository. Both stages consume that same snapshot.

1. Noul asks whether an available intervention would help now. A yes probability
   at least 0.8 proceeds; at most 0.2 returns `no-intervention`; the middle returns
   `review`. Thresholds are configurable experiment parameters.
2. Only a yes invokes Choice over the supplied candidate IDs plus a none option.
   Confidence below 0.8 or none returns `review`; otherwise the result names a
   candidate. Empty catalogs skip both calls. No action is ever executed.

Choice confidence describes its distribution, not a guarantee of correctness.
The two requests are an experimental execution policy that avoids asking Choice
on no/uncertain inputs, not an API requirement or a claim of lower latency/cost.
Because both questions can use the same original state, a later experiment
should compare batching both questions in one request and ignoring the choice
when the gate says no. See [parallel questions](https://docs.typesafe.ai/primitives)
and [confidence](https://docs.typesafe.ai/confidence).

```ts
import { TypeSafeShadowRunner } from "@inixiative/foundry/providers";
const experiment = new TypeSafeShadowRunner({
  client: jev,
  catalog: async context => ({
    revision: "auth-routes-v1",
    candidates: [{ id: "hydrate-auth", description: "Provide login callback conventions" }],
    learnings: [{ id: "callback-origin", text: "Callback origin must match configured web origin" }],
  }),
});
const observation = await experiment.run({ message: "Login callback broke" }, {
  agentId: "shadow-warden", threadId: "real-thread-id",
});
// Record observation. Do not execute candidateId in this experiment.
```

Run the local fixture experiment without a key or network requests:

```sh
bun scripts/typesafe-shadow.ts
bun test packages/foundry/tests/typesafe.test.ts packages/foundry/tests/typesafe-shadow.test.ts
```

`fixtures/typesafe-shadow.json` contains the inputs, candidate snapshots, expected
outcomes, and explicit offline answers. Dry-run output says `offline-fixture`;
its zero token usage is simulated, not a measured provider result. These fixtures
verify control flow, not Jev accuracy. Their probabilities/confidence are
independently scripted synthetic values, not model-derived distributions.
Edit or add entries in that JSON file to try different selected code excerpts,
candidate routes, learnings, and expected outcomes. For live application state,
use the callback above to select a catalog from the current project's reviewed
route manifest and its relevant learnings; only include actions already allowed
for that project/thread. With a provisioned `TYPESAFE_API_KEY`, opt in
to actual TypeSafe requests using `bun scripts/typesafe-shadow.ts --live`.
Live mode uses only fixture inputs/catalogs and ignores their offline answers.
It may incur TypeSafe usage; it still never executes selected actions.

The JSON report includes actual resolved models, Noul yes probabilities, Choice
confidence, per-stage and total elapsed time/token usage, catalog revision and
selected learning IDs, and comparison against expected outcomes. It omits keys
and raw prompts. There is no automatic enablement in production middleware.

## Refreshable Atlas catalog

The local experiment joins a real Atlas graph with an explicit profile manifest.
From the Foundry repository:

```sh
bun scripts/jev-catalog.ts \
  --atlas-root ../kingdom --source-root . \
  --manifest examples/jev-development.manifest.json \
  --out .foundry/experiments/jev-catalog.json \
  --cases fixtures/jev-development-cases.json
```

Omit `--cases` to generate only. Replace it with `--watch` to reconcile every
five seconds without inference. Only explicit `--live` with `--cases` invokes
TypeSafe; `--key-env NAME` selects its credential environment variable.

`packages/foundry/src/decisions/catalog.ts` validates profiles, configured
candidates, concept requirements and source evidence. Evidence uses a relative
path, source reference, SHA-256 and excerpt under the explicit source root;
changed, missing, superseded or escaping sources are omitted with reasons.
Atlas supplies structure, not executable permissions. Choice IDs stay explicitly
configured and the experiment never executes them.

The snapshot revision hashes content independently of refresh time. Each profile
has a procedure, questions and bounded candidates/context; both Jev stages use
the same snapshot. Case runs refresh before use. Atomic replacement avoids
partial files. A refresh error rejects that run, but may leave the previous disk
snapshot for inspection. Reading that file alone does not establish freshness
or permission to act; callers must refresh and recheck authority at execution.

The shipped profiles are generic problem framing and architectural placement.
Their only selected policy evidence is the current Foundry core/framework
boundary. The three synthetic cases have scripted answers and verify plumbing,
not judgment accuracy. No live source connectors, production registration or
automatic policy learning are included.

Historical PR reviews, later corrections and accepted solutions belong to
Oracle's evaluator side. Do not put them into runtime manifests, idea caches
or subject retrieval for the same evaluation families. Use Oracle's existing
criteria and Lab's independent comparisons, with physically isolated subjects
and family-level holdouts. See the workspace
the Oracle architecture notes in the private `inixiative/oracle` repository.
