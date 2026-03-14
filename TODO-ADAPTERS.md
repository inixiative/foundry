# Adapter Primitive: Swappable Infrastructure

> "Opinionated architecture, swappable infrastructure."

The template should define a consistent adapter pattern across all external infrastructure. You pick defaults during `init`, and swap providers later without touching application code.

---

## The Adapter Primitive

Every external dependency gets:

1. **An interface** — what the application expects (e.g., `EmailClient.send()`)
2. **Adapter implementations** — one per provider, all conforming to the interface
3. **A factory** — reads config, returns the right adapter
4. **Init script integration** — `init` asks which provider, sets env vars, installs dependencies

```
Application Code → Interface → Factory → Adapter → Provider SDK
```

Application code never imports a provider SDK directly. It imports the interface.

---

## Current State

| System | Has Interface? | Has Adapter Pattern? | Hard-coded To | Init Script? |
|--------|---------------|---------------------|---------------|-------------|
| Email | **Yes** (`EmailClient`) | **Yes** (Resend, Console) | — | No |
| Logger | No | No | Consola | No |
| File Storage | No | No | AWS S3 | No |
| Payments | No | No | Stripe | No |
| Error Monitoring | No | No | Sentry | No |
| Auth | Partial (better-auth) | Partial (env-based) | better-auth | Partial |
| Secrets | N/A (deployment tool) | N/A | Infisical | Yes |
| Cache/Redis | No | No | ioredis | No |
| Database/ORM | No | No | Prisma + PostgreSQL | Yes |

**Hard-locked (not candidates for adapters):**
- **Prisma + PostgreSQL** — too deeply integrated (transaction merging, hooks, branded IDs, extensions). Swapping the ORM means rewriting the template.
- **Redis** — BullMQ, pub/sub, caching, rate limiting all depend on Redis semantics. The client (ioredis) could be swapped, but Redis itself is load-bearing.
- **better-auth** — deeply integrated with session management, OAuth flow, token plugins. Could abstract but the value is low — it's already flexible.

---

## Adapter Roadmap

### Tier 1 — High Value, Low Effort
Already have a working pattern (email) to follow.

#### Logger
**Interface:** `Logger` with standard methods + scope support + ALS context injection
**Adapters:**
- `consola` (default — best DX, great for development)
- `pino` (production — async worker thread, JSON output, Datadog/ELK ready)
- `winston` (legacy — for teams already using it)

**Why:** Most debated choice in the template. Making it swappable ends the conversation.

**Effort:** Medium. The proxy-based scope injection and ALS context pattern need to work with all backends. The 12 scopes and request ID correlation are the hard part — already done.

#### Error Monitoring
**Interface:** `ErrorReporter` with `captureException(error, context)` and `captureMessage(message, level)`
**Adapters:**
- `sentry` (default)
- `bugsnag`
- `datadog`
- `console` (development — just logs errors)

**Why:** Currently 2 lines of Sentry in the error middleware. Tiny surface area, easy to abstract.

**Effort:** Low. Sentry is only called in `errorHandlerMiddleware.ts`.

---

### Tier 2 — High Value, Medium Effort
Require defining meaningful interfaces.

#### File Storage
**Interface:** `FileStorage` with `generateUploadUrl()`, `generateDownloadUrl()`, `delete()`
**Adapters:**
- `s3` (default — AWS)
- `r2` (Cloudflare — S3-compatible, cheaper)
- `gcs` (Google Cloud Storage)
- `minio` (self-hosted, S3-compatible)
- `local` (development — filesystem)

**Why:** S3 lock-in is unnecessary. R2 and MinIO are S3-compatible, meaning the adapter is mostly config. A local filesystem adapter for development removes the AWS dependency entirely.

**Effort:** Medium. Presigned URL generation differs across providers. CDN URL construction varies.

#### Payments
**Interface:** `PaymentProvider` with `createCheckout()`, `createSubscription()`, `handleWebhook()`, `refund()`
**Adapters:**
- `stripe` (default)
- `square` (physical + digital)
- `lemon-squeezy` (merchant of record — handles tax/compliance)
- `btcpay` (self-hosted crypto)
- `adyen` (enterprise, 250+ payment methods)

**Why:** Stripe-or-nothing is the #1 complaint about SaaS templates. A payment adapter pattern would be genuinely novel.

**Effort:** High for full implementation. Start with checkout + subscription + webhook. Each provider has very different APIs.

---

### Tier 3 — Nice to Have
Lower priority or already partially flexible.

#### Email (already done — enhance)
**Current adapters:** Resend, Console
**Add:**
- `sendgrid`
- `postmark`
- `ses` (AWS SES)
- `mailgun`

**Effort:** Low per adapter. Interface already exists.

#### Secrets Management
**Current:** Infisical via deployment scripts
**Already swappable** — application reads env vars, doesn't care where they came from. Just need init script options:
- `infisical` (default)
- `doppler`
- `vault` (HashiCorp)
- `aws-secrets-manager`
- `manual` (plain .env files)

**Effort:** Low. Just init script work.

#### Cache Client
**Interface:** `CacheClient` with `get()`, `set()`, `delete()`, `scan()`
**Adapters:**
- `ioredis` (default)
- `valkey` (Redis fork, API-compatible)
- `dragonfly` (Redis-compatible, higher throughput)

**Why:** Low priority because Valkey and DragonflyDB are Redis-compatible — ioredis works with all of them. The adapter is config, not code.

**Effort:** Low. Mostly about documenting that it already works with Redis-compatible alternatives.

---

## Init Script Integration

The init script (`scripts/init/`) should present adapter choices during setup:

```
┌─────────────────────────────────────────┐
│  Infrastructure Configuration           │
│                                         │
│  Logger:    ● Consola  ○ Pino           │
│  Email:     ● Resend   ○ Postmark       │
│  Storage:   ● S3       ○ R2   ○ Local   │
│  Payments:  ● Stripe   ○ Square  ○ None │
│  Errors:    ● Sentry   ○ Bugsnag        │
│  Secrets:   ● Infisical ○ Doppler       │
│                                         │
│  [ Configure ]                          │
└─────────────────────────────────────────┘
```

The init script then:
1. Installs the chosen provider's SDK
2. Sets env vars for the factory
3. Removes unused provider packages
4. Updates the config file

---

## Implementation Order

1. **Define the adapter primitive** — a base pattern (interface + factory + config) that all adapters follow
2. **Error monitoring** — smallest surface area, proves the pattern
3. **Logger** — highest-value swap, most debated choice
4. **File storage** — removes AWS dependency for development
5. **Email additions** — interface exists, just add providers
6. **Payments** — biggest effort, biggest differentiator
7. **Init script integration** — ties it all together

---

## Design Principles

- **Zero-cost abstraction in practice** — the adapter layer should add no measurable overhead. Factory runs once at startup, returns the concrete implementation.
- **Type-safe** — each adapter interface is fully typed. Swapping providers is a config change, not a type error hunt.
- **Testable** — every system gets a `console`/`local`/`mock` adapter for development and testing. No external dependencies required to run tests.
- **Progressive** — start with one adapter per system. Add more as demand appears. The interface is the investment, not the adapter count.
- **Init script is the UX** — developers shouldn't read docs to swap a provider. The init script asks, configures, done.
