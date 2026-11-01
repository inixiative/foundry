# FEAT-007: Each thread picks its subscription worker

**Status**: 🔨 Planned and reviewed (2026-11-01); being built.
**Assignee**: inixiative-b9
**Priority**: High: FEAT-006 (Muse) needs it, and inixiative-da's shared-thread local members need it.
**Created**: 2026-11-01

---

## Why

Aron, 2026-11-01, chose "Project default + per thread". A project has a default worker (Claude Code, Codex, later Muse). Any thread can start on another worker the user has a login for, so a Codex or Muse member can sit beside a Claude host (CLAUDE.md, "Each thread picks its subscription worker").

Today `resolveSubscriptionPolicy` takes one worker from `config.defaults.provider` and refuses any project or executor on another (`subscription-policy.ts:172-188`, `:260-266`). `start.ts` builds one session adapter for it (`createProvider`, `:347-524`).

## How a thread's worker is chosen today

1. `start.ts:187` → `resolveSubscriptionPolicy`: one `workerProvider` and one login.
2. `check(view)` refuses any view whose `defaults.provider` differs (`:260-266`), applied to every project view (`:314-316`).
3. `createProvider` builds one `SubscriptionAuthentication` (locked to one runtime, `subscription-authentication.ts:50`), wrapped by `projectCapacityAuthentication` (`start.ts:316-345`), then one adapter and one provider (`:422-467`).
4. That provider goes into the factory's `providers` map (`start.ts:690`). The adapter goes to `runtimeManager` (`:671`) and `factory.attachSessionAdapter` (`:738`). It also feeds subagent and task sources and the in-session `threadSetup` (`:929-947`).
5. Per thread: `ThreadFactory.create` resolves the project view (`thread-factory.ts:499-505`), then `buildAgents` picks `agentCfg.provider || defaults.provider` (`:241-243`). `reconfigure` and `ThreadRuntimeManager.attach`/`reconfigure` do the same (`thread-runtime.ts:726-731`, `:812-816`).
6. A thread record is `ThreadMeta` (`core/src/thread.ts:101-161`). Saving it already refuses a changed `projectId` (`local-session-store.ts:1372-1381`).

## Plan

### Records and resolution

- **`core/src/thread.ts`:** `worker?: string` goes on `ThreadMeta` and `ThreadConfig`, set at creation and never changed. A saved record whose worker changed is refused, like `projectId`. A record with no worker (a thread from before this change) reads as its project's default worker. It is never rewritten.
- **`core/src/model-registry.ts`:** `SUBSCRIPTION_WORKER_MODELS`, the default main-thread model per worker, sits beside `SUBSCRIPTION_DECISION_MODELS`. The registry has no per-provider default, and this mirrors the decision map.
- **`viewer/config-resolve.ts`:** new `resolveThreadView(config, meta)` = `resolveProjectView`, plus the thread's worker when it differs from the project default.
  - The default provider and model become the worker's.
  - Executors point at it.
  - A pinned executor model is kept only if the worker runs it. When it isn't, that shows in the launch view.
  - It is used everywhere the project view is used for a thread (`thread-factory.ts:397,499`, `thread-runtime.ts:726,812`, `launchView`).

### Policy

**`subscription-policy.ts`:** `workers: Partial<Record<SubscriptionWorker, NativeProfileSource>>` replaces `workerProvider`/`worker`.
- Each worker's login is `defaults.nativeAuthenticationId` when that source's runtime matches, otherwise its runtime's default profile.
- At startup, every enabled project's default worker must have a login.
- `check(view)` validates each view against its own worker's models.
- `threadWorkerRequirement` is used at thread creation. It checks: a subscription worker, its vendor's subscription mode on, and a login present (local, or listed by the project's Kingdom pool). There is never a fallback and never an API provider.
- Decisions are untouched.
- `claude-in-session` needs only a usable Claude login. Threads on other workers get primed Wardens (the decision host's existing path, `in-session-wardens.ts:39-43`) and no setup step. That is said once at startup.

### Start-up and lifecycle

**`start.ts`:**
- A memoized `startWorker(worker)` builds one `SubscriptionAuthentication` per worker, wrapped in `projectCapacityAuthentication`. One `KingdomSubscriptionAuthentication` is shared; it is already keyed by runtime and thread. So is the one `FileExternalSessionStore`, also keyed by runtime.
- Workers start lazily, on first use.
- `runtimeManager` gets `sessionAdapterFor(threadId)`.
- Shutdown releases every started adapter.
- Subagent and task sources take every started provider.
- The in-session `threadSetup` applies only to Claude threads.
- The Kingdom capacity callback uses the thread's own model and effort.

**Kingdom (`kingdom-subscription-authentication.ts:253-288`):** `usesKingdom(threadId, runtime)`. A Kingdom-capacity project uses the pool for the workers in `kingdomCapacity.workers`, and the local login for the rest. In `viewer/config.ts`, the capacity check uses the project's default worker, not the global one.

### Choosing a worker

- **API:** `POST /api/threads` takes `worker`, checked by `threadWorkerRequirement`; a refusal is a 400 with the reason. `PATCH /api/threads/:id` takes `worker` only before the thread's first turn starts (409 after). That serves the ACP hosts that can't send `_meta`. The launch view returns `worker`, that worker's models, and `options.workers`.
- **Viewer:** the command palette gets "New <worker> thread in this scope" per other usable worker. The thread row's existing tag shows the worker. No new UI system.
- **ACP:** `session/new` reads `_meta.foundry.worker`. A `worker` config option maps to the PATCH.
- **Readiness and accounts** (`provider-accounts.ts`, `readiness.ts`) loop over the workers in use.

## Review changes (adversarial review, 2026-11-01), these override the plan above

1. **Every usable worker's adapter is built at daemon start, not lazily.** Building one spawns nothing; processes start per thread. The viewer subscribes to subagent and task sources once (`viewer/server.ts:404-411`), and the providers map is copied three times (`start.ts:641,646,688`). So use one shared map, passed by reference, and no lazy-start machinery.
2. **`worker` is required on every thread record.** There is no read-time default: that is a compatibility shim, and it broke resume. If the default went Claude → Codex → Claude, the old Claude binding would be resumed without the Codex-era turns. A one-off throwaway script stamps existing records from the runtime bucket that holds their binding.
3. **No `kingdomCapacity.workers`; no local fallback.** A Kingdom-capacity project runs every worker on its pool. `resolveRun` already sends the runtime, and Kingdom refuses a pool with no login for it ("No authorized capacity matches"). The thread is refused with that reason and never billed to the machine's login.
4. **Muse in any project** (Aron, 2026-11-01: "Always personal Archive… Muse may run in any project"). So there is no per-project allowance. Archive's `alwaysPersonal` gate does the enforcing (Archive #47).
5. **A thread's worker can change only while the thread has no native binding and no open in-session host.** The save check allows exactly that case. A changed worker closes the in-session host.
6. **Fork and observed subagent children carry their parent's worker** (`routes/runtime.ts:1012-1018`, `turns/subagents.ts`).
7. **One named login per runtime.** It comes from `nativeAuthentication`, the default profile only when none is named, and is refused when ambiguous. It never silently falls to `~/.claude` because another runtime's source was configured. `check()` stops forcing every project onto the global login.
8. **In-session guards are turned on per thread, by worker** (`server.ts:351,375`). Codex threads under claude-in-session send no in-session signals.
9. **The launch PATCH model check and readiness** (`routes/runtime.ts:670,708-712`, `readiness.ts:492`) read the thread's worker.
10. **Under `apiTokens: true`, any worker other than the default is refused.**
11. **`threadWorkerRequirement` lives in `ThreadFactory.create`,** so restore and reopen are re-checked after a vendor is turned off.
12. **Runtime unions are ready for Muse** (`kingdom-subscription-authentication.ts:45`, `kingdom-client.ts:20,59,72`). They are widened when FEAT-006 lands, not now.
13. **`compositionSource`'s harness choice follows the thread's worker** (`instruction-stack.ts:622`), with a test.

## Tests

**Change:**
- `subscription-policy.test.ts`: a Codex source is the Codex worker's login; resolution moves to `workers`; per-project models.
- `helpers/routed-agents.ts`
- `kingdom-subscription.test.ts`
- `thread-factory.test.ts`
- `subscription-default.test.ts`
- ACP conformance and turnpath

**New:**
- Codex-default and Claude-default projects resolve together. A default with no login is refused at startup.
- A `worker: 'codex'` thread in a Claude project runs on the Codex adapter and model, and keeps its worker across restart, reopen and project-default edits. A changed worker is refused on save.
- No login, or vendor off: a 400, no fallback, no API provider.
- Only workers in use start. A new worker starts lazily.
- In a Kingdom project, a Codex thread whose pool has no Codex login is refused with Kingdom's reason, and never billed locally.
- Under `claude-in-session`, Codex threads never show as "setting up".
- A Codex local member joins a Claude host.
- ACP `_meta` and the option before the first turn, and 409 after.
- Live: Claude and Codex threads side by side.

## Risks

- Places that assume one adapter beyond those found; the in-session setup routing is the likely one.
- Two native CLIs and their status checks running at once.
- A Claude-pinned executor model gives way silently on a Codex thread. The launch view shows it.

## Open

- Should the per-worker default model be a setting rather than a core map?

Neither blocks: settings for now, and the map is what the decision side already does.
