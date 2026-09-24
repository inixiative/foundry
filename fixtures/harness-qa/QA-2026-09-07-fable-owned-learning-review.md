# Fable opposite-model review: owned causal learning (2026-09-07, ~04:40-04:50Z)

Read-only. Reviewed the current revision, Foundry source fingerprint
`ef5230ee96b79a2dcf08d914570f5ca3ee18a58dd144f8395e6a0eb11d2bb29d`, identical before
and after every check below. No implementation, independent test, ledger, dependency
or live setting was edited. No native capture. Astra provisional lead count 5,
checkpoint 6. Supervisor decides acceptance after independent browser/native checks.
This review does not accept my own earlier provider or compaction changes.

Files reviewed in full: `packages/foundry/src/agents/learning-config.ts`,
`domain-librarian.ts` (ThreadKnowledge, ReviewJob, review), `thread-runtime.ts`
(manager leases, admission, expiry, commit, publication, disposal, delivery
metadata), `packages/foundry/src/persistence/knowledge-persistence.ts`,
`local-session-store.ts`, startup and viewer wiring, Astra's `owned-learning.test.ts`,
and the four independent acceptance files.

## Findings (most severe first)

1. **Medium, capacity and misleading state, CONFIRMED by a controlled probe.**
   `packages/foundry/src/agents/thread-runtime.ts` lines ~930-940 push every completed
   dispatch onto `_queuedEvidence` for each domain, and `_reviewWith` (line ~960,
   `if (lease.closed) return;`) drops out silently once the domain lease is closed.
   The lease closes permanently on hard expiry, on any local reviewer error
   (line ~1008 `lease.closed = true`), on blocked previous occupancy and on
   write failure, and nothing ever reopens it in this process. Result: after one
   closure, the queue grows without bound (each item holds up to 3,000 chars of
   request/result text plus up to 20 tool observations), no per-evidence record is
   written to history or journal, and `_awaitPendingLearning` reports
   `learningBarrier.outcome: "pending"` with that domain listed as stale on every
   later turn forever. Probe (controlled reviewer throwing once, then five more
   dispatches): review calls 1, status `error`, queued 5, history decisions
   `["error"]`, last barrier `{outcome:"pending", pending:[{security, reviews:4}]}`.
   This is exactly the "misleading pending state plus silent background loss" the
   assignment forbids. Fix before rollout: when the lease is closed, record each
   new evidence item as an explicit non-admitted decision (durable through the
   signal sink), do not retain the payload, and report a distinct barrier outcome
   such as `closed`, never `pending`.

2. **Medium, lifecycle.** The same line ~1008 treats every local `error` as unknown
   native occupancy, including stateless HTTP providers (Gemini/OpenAI/Anthropic
   API) where a rejected promise is a finished call. One transient 5xx therefore
   disables learning for that thread and domain until process restart, with no
   operator path to reopen. Astra's test "a local reviewer failure ... blocks
   automatic replacement calls" encodes this deliberately. Recommendation: decide
   closure by provider kind (session-backed native facades stay closed pending
   reconciliation; API providers release the lease and record `error`), or add an
   explicit, journaled operator reopen. Native terminal reconciliation itself
   remains an I dependency, not something this slice should implement.

3. **Medium, capacity, rollout.** `start.ts:349` resolves the default review
   provider to `rawProvider`, the configured central provider. For claude-code or
   codex configurations that is the session-backed native facade. Review identities
   are `thread:aux:review:<generation>:domain:<d>`, so each runtime generation opens
   a new text-only native session per domain (five by default) and
   `ThreadRuntimeImpl.dispose()` never calls the adapter's `clearSession`; the
   provider's `_sessions` map never evicts. Every restore/dispose cycle leaks
   warm native processes. This also runs background review on the most expensive
   model by default, against the project's cheap-models-for-decisions rule. Rollout
   requirement: default review to the flow provider or require explicit
   `learning.review.provider`, and release auxiliary sessions on disposal.

4. **Low, inspection.** In `_reviewWith`'s publication-failure branch the runtime
   calls `_publicationFailure` first; `KnowledgePersistence` disposes the runtime,
   and the following `_emitLearning("reconciliation-needed")` returns early because
   `_disposed` is set (line ~1046). The reconciliation record therefore never reaches
   the journal; it lives only in the persistence class's in-memory map. After a
   restart `inspect` reports `durable` and history lacks the failure. Data is
   correct (journal is authoritative), but the audit trail of the event is lost.
   Emit or journal the record before disposing.

5. **Low, occupancy consistency.** Line ~1000 releases the manager lease
   (`_reviewLease(domain, true)`) before eligibility, CAS and publication. On
   write-failed the runtime sets its local `lease.closed` while the manager owner
   entry is already gone, so runtime and manager disagree about occupancy. Today
   quarantine disposes the thread and the create route refuses existing ids, so
   the practical exposure is small.

6. **Low, thread id reuse.** `KnowledgePersistence` restores knowledge only for
   threads present at construction. Threads created later through the viewer create
   or fork routes (`routes/runtime.ts:681, 797`) are not restored. A reused id with
   journaled knowledge would fail its first commit with "revision cannot move
   backwards" and be quarantined: loud, not silent, but worth a startup or create-
   time check.

7. **Cleanup.** `_awaitPendingLearning` can no longer return `timeout`; the warning
   branch at line ~528 is dead. The `learned`-without-job path in
   `saveKnowledge` is unreachable from production (no `learn()` callers in `src`);
   fine to keep for tests, but note it is publication-first.

Verified correct, no finding: all three reviewer segments are frozen in the job
and sent unclipped (thread knowledge up to its cap, mandatory over-bound context
refuses the call); owner, dispatch evidence, generation, epoch and base
revision/hash are frozen per admission and checked in `reviewEligible` and again
inside the SQL transaction, including the end-of-transaction deadline check that
rolls back a crossing commit; per-phase provider/options are separate from
advise/guard with `tools:false, maxTurns:1, timeout:0`; soft expiry only records
`delayed`; stale, duplicate, foreign and disposed work cannot publish; durable CAS
precedes layer publication; layer-mutation failure after durable commit is routed
to reconciliation before signal observers; foreign dispatch payloads are not
admitted; invalid outputs never mutate knowledge; `learningState` exposes only
evidence identities, not payloads.

## User behaviors

Supported by passing tests on this revision: an immediate request does not wait
and uses the last committed revision with `learningBarrier.outcome: "pending"`,
the first request after commit receives the new fact without repetition, facts
survive real journal reconstruction, a SQL failure preserves the completed reply
and prior revision, invalid or oversized reviewer output changes nothing, and a
replacement runtime cannot start a second review while an old one is occupied.

Missing: recovery of learning after any lease closure without restarting the
process; visibility of never-admitted evidence; a durable reconciliation record
(Finding 4); auxiliary session release; occupancy tracking across restarts and
native terminal reconciliation (explicit I dependency).

## Contract recommendation for `fixtures/harness-qa/acceptance/domain-learning.test.ts`

The case "the next production dispatch sees prior learning without a test-only
settling call" encodes the removed serial 25ms barrier and fails on this revision
(1 fail, 2 pass; run unchanged, not classified as expected). Replace it with two
cases, keeping the concurrency and ownership cases as they are:

- **Immediate request uses the committed revision and reports pending.** Hold the
  reviewer; dispatch again immediately; assert the second provider input lacks the
  fact, `result.meta.delivery.learningBarrier` is `{outcome:"pending", waitedMs:0}`,
  and the dispatch resolved before the reviewer was released.
- **First request after commit receives the fact without repetition.** Release the
  reviewer and wait on a production signal, not a test helper: subscribe to the
  thread bus for `domain_learning` with `decision:"learned"` (or poll the HTTP
  knowledge inspection for revision 1). Then dispatch once and assert that input
  contains the fact and the earlier inputs still do not.

Do not keep the old assertion as an expected failure; delete it when the
replacements land, with the supervisor's approval.

## Exact evidence (sequential runs, one harness-check per command)

| Files | Report | Result |
|---|---|---|
| `acceptance/learning-review-input.test.ts` | `.foundry/qa/2026-09-07T04-42-04.603Z-G3` | 4 pass / 0 fail, verification passed |
| `acceptance/learning-owned-runtime.test.ts` | `.foundry/qa/2026-09-07T04-42-10.086Z-G3` | 2 pass / 0 fail, passed |
| `acceptance/learning-durable-boundary.test.ts` | `.foundry/qa/2026-09-07T04-42-13.468Z-G3` | 2 pass / 0 fail, passed (real SQLite and HTTP) |
| `acceptance/domain-learning.test.ts` (historical) | `.foundry/qa/2026-09-07T04-42-15.895Z-G3` | 2 pass / 1 fail (the barrier case above), verification failed |
| Six focused files: owned-learning, thread-runtime, local-session-store, knowledge-recovery, knowledge-store, domain-learning | `.foundry/qa/2026-09-07T04-42-16.070Z-G3` | 80 pass / 0 fail, passed |

All five reports: `sourceChangedDuringChecks: false`, before/after
`ef5230ee…bb29d`. The controlled-reviewer probe for Finding 1 was a throwaway
script under `/tmp`, run once and deleted; it used only production runtime code and
mocks. Nothing here is a native measurement: mock latency and mock providers
prove ordering and state transitions, not native timing, capacity or retention.

## Verdict

**Reopen, bounded.** The correctness core (frozen input, CAS before publication,
deadline in SQL, stale/duplicate/foreign refusal, truthful SQL failure) holds and
the supervisor's six cases plus the two durable-boundary cases pass on this
revision. Findings 1 and 2 are blockers for rollout, not for the design: a single
closure turns "no added wait" into permanently lost learning with a misleading
`pending` label and unbounded retention. Finding 3 is a rollout requirement.
Findings 4 to 7 are non-blocking. Because a blocker remains, no sixth-slice
leadership/scope checkpoint recommendation is made here; re-review after
Findings 1 and 2 are corrected with focused tests that assert a closed barrier
outcome, bounded or empty retention and a journaled non-admitted record.

## Rollout requirements (in addition to the fixes above)

Explicit `learning.review.provider` or flow-provider default; auxiliary review
sessions released on runtime disposal; independent browser check that a stale tab
and a committed snapshot are distinguished; disposable-fixture exercise of SQL
rollback and reconciliation inspection; no unknown occupied review work on the
affected runtime at deploy time; rollback preserves the journal, bindings and all
newly journaled learning records rather than restoring an older snapshot.
