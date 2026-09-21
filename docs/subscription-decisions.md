# Subscription-only Foundry startup

Foundry can run its Claude worker and auxiliary decisions from explicitly selected local subscription profiles. This opt-in mode constructs no API decision provider and offers no paid fallback. Existing startup behavior remains the default when `subscriptionOnly` is absent.

This is a source implementation with controlled transport and startup tests. It has not been accepted by a live account/model experiment. It does not enable the blocked Lab comparison or implement Kingdom execution consent.

## Configuration

Use two already authenticated, private Claude profile directories: one for the warm, tool-capable worker and a separate profile for serialized text-only decisions. Each retains the existing native profile lock. The configuration contains references, never copied tokens. Profile paths must resolve to different directories; different source IDs or aliases are insufficient.

Merge the following shape into `.foundry/settings.json`, replacing IDs, paths and model placeholders with supported choices for the selected account. The receipt parent directory must already exist and be private. These illustrative model strings are not model recommendations or supported model claims.

```json
{
  "nativeAuthentication": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "connectionId": "33333333-3333-4333-8333-333333333333",
      "runtime": "claude",
      "mode": "native-profile",
      "profileDirectory": "/private/path/worker"
    },
    {
      "id": "22222222-2222-4222-8222-222222222222",
      "connectionId": "44444444-4444-4444-8444-444444444444",
      "runtime": "claude",
      "mode": "native-profile",
      "profileDirectory": "/private/path/decisions"
    }
  ],
  "defaults": {
    "provider": "claude-code",
    "model": "EXPLICIT-WORKER-MODEL",
    "nativeAuthenticationId": "11111111-1111-4111-8111-111111111111",
    "classifierProvider": "subscription-decisions",
    "classifierModel": "EXPLICIT-DECISION-MODEL"
  },
  "subscriptionOnly": {
    "decisionSourceId": "22222222-2222-4222-8222-222222222222",
    "model": "EXPLICIT-DECISION-MODEL",
    "expectedObservedModel": "CANONICAL-DECISION-MODEL",
    "directory": "/private/path/decision-receipts",
    "maxCalls": 50,
    "maxQueued": 8,
    "callTimeoutMs": 30000
  }
}
```

Every enabled non-executor agent, including configured experts, must explicitly select `subscription-decisions` and the same decision model. Set `tools: false`; omit thinking and cache overrides; temperature may be omitted or zero. Executors must use the configured worker model/provider. Review settings may omit provider/model to inherit the decision profile, or explicitly match it. Project overrides are validated too. API providers, gateway assignments, per-thread authentication overrides and Codex decision profiles are refused in this mode.

Run the normal `bun run start`. Startup remains free of model calls unless `FOUNDRY_STARTUP_SELF_TEST=1` is explicitly set; in this mode that self-test consumes a decision allowance. A read-only Claude subscription status check precedes worker preparation and each native decision. The worker environment excludes competing API credentials and launch disables user/project/local Claude settings. Worker tools remain available. This is not the isolated fixture-tool policy proposed for Lab.

## Ownership and bounds

Each decision uses the existing bounded native text provider: private working directory, one turn, tools disabled, strict empty MCP configuration, explicit model acknowledgement and confirmed status/model process exit. Classifier, router, expert advice, guard and learning calls share a serial scheduler. Guards retain their existing post-action semantics.

`maxCalls` is a finite attempt budget for this Foundry process, including failed admitted attempts; it does not renew automatically. `maxQueued` bounds waiting calls separately from the active call. The deadline includes queue and preflight time; cleanup has its own bounded wait. Revocation closes waiting admission, rejects an active result and leaves its process owned until cleanup/deadline. Unknown exit closes further admission rather than treating a kill request as released capacity. A worker authentication check with unknown exit likewise blocks further checks for that authentication instance.

Logical thread/generation/dispatch/review-job ownership is preserved while physical native session identities remain private. Inspection and release require the exact owner and admission ID. Old admission release cannot terminate newer work. Learning cannot inspect accepted answer content until model, tool, ownership, receipt and process-release checks pass. Final observer notification cannot hold scheduler capacity indefinitely.

Sanitized per-call receipts retain ownership, model and settlement evidence without prompt/answer text or raw protocol. In-memory accepted inspection includes content for the authorized learning owner; it is not a shared knowledge store.

## Integration limits

These local profile references are not Kingdom capacity grants. A project execution contract must independently authorize worker and decision roles, purposes, model identities, aggregate budgets, deadlines and generation revocation. Revalidate that authority in preflight immediately before native write. Background learning needs an explicit bounded phase if the original work phase is already closed.

There is no automatic retry, model substitution, API fallback, onboarding, credential migration, hot profile rebinding or live deployment in this change. Non-model keyword fallbacks already present in classifier/router behavior are unchanged. The standalone native text provider keeps its existing bounded Oracle semantics.

## Validation

Run `bun run test` and `bun run typecheck`. Focused tests are `packages/foundry/tests/subscription-decisions.test.ts` and `packages/foundry/tests/subscription-policy.test.ts`; they use controlled child processes. The full startup test denies external requests and uses synthetic API-key values to verify they are not consumed. Live account/model acceptance remains separate.
