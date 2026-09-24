# Fable opposite-model re-review: closed-capacity learning correction and R1 configuration collection (2026-09-07, ~05:50-06:00Z)

Read-only. No production, test, assertion, ledger, setting, binding or dependency was
edited; no probe, agent, install, restart, commit or publication. Reviewed the
current tree at Foundry fingerprint
`e4d87fe9df70ee6c74a598faac0a2a93d5ab308e0aff7d765d6e9a3fc2ce9a50` (identical before
and after both runs below). Sources read in full or in the changed regions:
`packages/foundry/src/agents/thread-runtime.ts`, `domain-librarian.ts`
(review/settlement), `learning-config.ts`, `persistence/knowledge-persistence.ts`,
`persistence/local-session-store.ts` (`appendLearning`, `learningCapacity`),
`providers/http-settlement.ts`, `openai.ts` error path, `session-backed.ts`
lifecycle, `session-adapter.ts` R1 getters and `releaseIdleSession`, `start.ts` review
policy; the two handoffs; the independent files named in the request; Astra's
`learning-capacity.test.ts` and the R1 cases in `native-model-profile.test.ts`.
This review does not accept any of my own UI, provider or compaction work.

## Independent runs (exact files, one runner invocation each, sequential)

| Files | Report | Result |
|---|---|---|
| `acceptance/learning-review-input`, `learning-owned-runtime`, `learning-durable-boundary`, `learning-closed-capacity`, `domain-learning`, `native-review-cleanup` (G3) | `.foundry/qa/2026-09-07T05-52-12.726Z-945bb5ce-…-G3/report.json` | **18 pass / 0 fail** (16 learning + 2 cleanup), typecheck and diff pass, `verification: passed`, fingerprint stable |
| `acceptance/native-model-profile`, `native-model-provenance`, `native-model-binding-provenance`, `native-model-evidence-ownership` (G5) | `.foundry/qa/2026-09-07T05-52-15.504Z-dc612c3c-…-G5/report.json` | **15 pass / 0 fail**, typecheck and diff pass, `verification: passed`, fingerprint stable |

No expected-failure relabeling and no source-stale run is counted. No full baseline was
rerun; the supervisor's 33-case stable record at 05:43:48Z stands as the combined
evidence.

## Learning correction: findings first

Each of my earlier blockers, checked against current source:

- **Finding 1 (unbounded queue, misleading `pending`) — closed.** `_onCompletedWork`
  (thread-runtime.ts ~lines 1003-1030) defers immediately with a durable `deferred`
  record when the lease is closed or eight observations already wait; `_closeReview`
  (~871-876) drains every waiting payload into `deferred` records; the barrier
  (~825-834) reports `closed` distinct from `pending`, with `waitedMs: 0` and no
  domain counted pending while its lease is closed. Independent cases 1-3 of
  `learning-closed-capacity` prove non-pending, `queued: 0` and per-message durable
  refusal records.
- **Finding 2 (transient HTTP error closes learning permanently) — closed for
  instrumented providers.** `HttpCompletionSettlement` marks an error only after the
  error body is read (`openai.ts:82-84`, same in Anthropic/Gemini); a copied or foreign
  error stays unknown. Independent case 4 proves the real loopback 503 no longer blocks a
  later distinct review. Physical capacity (`_reviewLease(domain, true)` on settled) is now
  separate from eligibility.
- **Finding 3 (default review on the central native provider; leaked review
  sessions) — closed.** `start.ts:349-350` resolves the default review profile to the
  flow provider policy; explicit providers still fail closed when unavailable. Review
  identities are released after drain or settled disposal via `releaseReviewIdle`, and
  `releaseIdleSession` (session-adapter.ts:525-530) resolves `released` only after the
  owned subprocess exit promise; the persistent resume binding is not cleared.
- **Finding 4 (reconciliation record never journaled) — closed.** `_emitLearning`
  (~1149-1161) journals synchronously through the manager-installed callback before
  any observer await and regardless of disposal; the publication-failure branch
  (~1126-1134) journals `reconciliation-needed` before invoking the disposal callback.
  Astra's focused case covers a hanging observer plus reconstruction.
- **Finding 5 (lease released before CAS, inconsistent occupancy) — closed by
  redefinition.** Capacity release and eligibility are explicitly distinct states;
  `write-failed` and `reconciliation-needed` close admission (`_closeReview`) while
  physical capacity may already be settled. This is coherent and inspectable.
- **Finding 6 (later-created threads not restored) — closed.**
  `manager.setLearningJournal(journal, restore)` runs `restore` from `attach` for every
  future runtime (~336), restoring knowledge and durable `unknown` capacity closures.
- **Finding 7 (dead timeout branch, legacy publish-first path) — cosmetic, unchanged.**

Verified also: hard eligibility is irreversible for the original job (`expire` closes
the lease and defers the queue; the late local result records `capacity-settled` or
`discarded` without publishing, ~1093-1097); SQL deadline crossing still rolls back
(`saveKnowledge` end-of-transaction eligibility check); a rejected candidate quarantines
admission and appends a separate `write-failed` audit only when the audit journal is
writable; `reconcileReviewCapacity` (~856-869) is explicit, no-send, and only for a
hard-expired, locally settled, closed domain with no running worker; deferred evidence
is never requeued automatically; original owner/generation are frozen on every
runtime-owned record and refused by `appendLearning` on mismatch.

### Remaining findings (none blocks this bounded slice)

1. **Medium, behavior, reproducible.** A completion refused while owned cleanup is
   unresolved (`session-backed.ts:124-128`) is marked settled, so it does not close the
   lease (good), but the librarian returns `error` and the runtime records that turn as
   `error`, not `deferred`; the review for that completed turn is skipped with no
   evidence link naming it as refused-for-cleanup. Reproduce: session-backed review
   provider; dispatch, let the domain drain and start `releaseIdle`, dispatch again
   before the exit promise resolves (Astra's "pending owned exit" case asserts the
   rejection at the provider). Recommendation: in `_reviewWith`, treat a refusal
   carrying settled capacity as `deferred` with that reason, or bound the wait on the
   pending release before sending. This is a deterministic behavior gap from eager
   release, not an unmeasured performance question.
2. **Medium, rollout limitation, by design.** With a native review provider, only a
   legacy Claude `result` terminal naming its own binding proves settlement
   (`session-backed.ts:173-178`); MCP/Codex and any other outcome stay `unknown`, so
   a successful learn or abstain closes the domain ("native capacity remains
   unacknowledged", ~1140) and the durable `unknown` marker re-closes it after restart
   (`knowledge-persistence.ts:20-24`). `reconcileReviewCapacity` cannot reopen these
   (status is not `expired`). Learning is effectively one review per thread and domain
   until I2. The new flow-provider default avoids this only when Gemini is configured;
   when flow falls back to a Codex central provider it does not. Rollout requirement:
   configure an HTTP review provider (or Gemini flow) explicitly until I2 lands. This
   is the conservative unknown guard working as specified; it must not be read as
   native parity, and it is not a defect of the slice.
3. **Low.** `start.ts:350` hard-codes the Gemini default model string a second time;
   derive it from the flow provider's default to avoid drift in phase inspection.
4. **Low.** `providers/claude-code.ts` (legacy `ClaudeCodeProvider`) has no
   `completionLifecycle`; it is imported by `start.ts` but not constructed on the
   native startup paths, so a rejected call would fall to `unknown` only if some other
   caller selects it (research runner). Note for cleanup, not a blocker.
5. **Cleanup.** `_awaitPendingLearning` never returns `timeout`; the warning branch in
   the flow middleware is dead. `learningState.domains[d].queued` is now always `0`
   after closure, so the UI's queued count mostly reflects the hot window; deferred
   links are visible only through history, as the handoff states.

**Verdict (learning): accept, bounded.** All six substantive blockers from my prior
review are closed in source and proven by the unchanged independent cases and stable
runs above. Finding 1 should be corrected in the next learning slice before rollout
with a native review provider; Finding 2 is an explicit I2 dependency and rollout
configuration requirement, not a reopen. No native, account, capacity-measurement or
crash-before-capture claim is accepted.

## R1: configuration collection ownership

Verified in `session-adapter.ts`: both `observedConfiguration` getters (lines 520-522
Claude, 630-632 Codex) return `Object.freeze([...facts])` when the adapter owns the
session's collection and `undefined` otherwise; the internal collector (`_configurations`
WeakMap, appended by the first-boundary evidence wrapper) is unchanged, so later
legitimate own-binding facts appear only in later snapshots; fact objects remain
deeply frozen; the interface comment (255-261) states the snapshot contract. The
provider (`session-backed.ts:161-163`) reads a fresh snapshot per completion, so a
pushed, spliced or index-replaced older snapshot cannot forge or drop a fact;
`undefined` (no ownership) still falls back to this turn's returned events, and an
owned empty array does not. Lifecycle, detachment, outcome propagation and binding
persistence are untouched. Independent `native-model-evidence-ownership` case 3 (the
supervisor's RED) plus the other 14 model cases pass; Astra's ten new focused cases
cover both engines, three mutation forms, observer mutation before a read, retained
historical arrays, foreign-binding facts and later own-binding facts. Native model and
effort remain acknowledged only by supported own-binding envelopes; requested values
are never presented as acknowledgment.

**Verdict (R1): accept, bounded.** No finding. Cost is one small array copy per
lookup. This closes the exposed configuration-array defect from the I/T plan; it does
not adopt the sibling, prove native configuration delivery, or close typed-outcome
loss and tool-scope blockers.

## Count 6 leadership and scope checkpoint (recommendation only)

Both bounded slices close. Planning-to-delivery behavior in this round: Astra
reproduced the supervisor's RED cases before editing, kept ownership disjoint,
reported a genuine self-found defect (cleanup reporting `released` after `kill()`),
declined to relabel failures, recorded concurrency limits honestly, and left the
independent assertions and my UI files alone. Delivery matched the plan's scope
without silent cuts; the one behavior gap (Finding 1) is an interaction of two
correct pieces, not a shortcut. I recommend keeping the provisional Astra lead at
count 6, with these conditions attached to the next slice: fix Finding 1 with a
focused test; make Finding 2 an explicit configuration check at startup (warn or fail
closed when the review provider has no settlement proof) until I2; and require an
HTTP review provider in any rollout profile. The 25-turn native cap that ended my own
admission is a harness limit and says nothing about model quality either way.

Justified sequencing for the next product steps, none a scope cut: I0/I1 with real
packaged Foundry sample runners first (typed native outcomes through the production
path), disjoint T1 scoped retrieval bound to the live runtime, then T2 and I2 real
both-engine work (which also lifts Finding 2), then rollout preserving journals,
bindings, deferred and audit records. Inspection, tags, artifacts, subsessions,
lineage, model/effort and subscription continuity requirements stay on the graph.
The supervisor decides the count and any deployment.
