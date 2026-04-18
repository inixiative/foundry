# Distillation — How Raw Capture Becomes Durable Corpus

> **Status: target architecture.** No part of this pipeline is implemented today.
> Capture is real (`ClaudeCodeSession` records every event); what consumes those
> events into durable artifacts is not. This doc specifies the pipeline so the
> capture side does not out-pace the absorption side.
>
> This is the **missing middle** of the corpus story: it sits between the
> fluid/formal/compiled pipeline described in `VISION.md` and `THREE_SYSTEMS.md`
> and the Session substrate described in `HARNESS_LIFECYCLE.md`. It is not a
> parallel pipeline — it is the enrichment layer that decides what fluid entries
> exist in the first place and when they earn promotion to formal.

---

## Why This Exists

Foundry captures everything. Tool calls, reasoning, hooks, results — every emission from every session lands in the archive. That is the right substrate for introspection, fork, replay, and Oracle evaluation.

But capture alone creates two failure modes, and they pull against each other:

- **Context explodes.** If you keep raw events around to ground future sessions, context windows balloon. Cache hits drop. Latency rises. The executor spends tokens re-reading history instead of doing work.
- **Re-alignment tax compounds.** If you don't keep the raw events around and don't durably extract what they taught, every new session starts from the same blank slate. The user corrects the same mistake on Tuesday that was corrected on Monday.

The only escape from this pincer is a **distillation pipeline**: turn raw events into compact, addressable, versioned artifacts with known provenance and snapshot-pinned lineage. It is first-class alongside the Session substrate and the Layer system.

---

## What Muninn Owns vs What Distillation Owns

MuninnDB is already an active cognitive substrate — not a key-value store. Per `VISION.md` (line 132) and `HIVEMIND_V2.md` (line 145), it provides vector + BM25 retrieval, **Hebbian associations** (firing-together strengthening), decay, and activation-based retrieval. Distillation must not reinvent any of this.

| Owned by **Muninn** | Owned by **Distillation** |
|---|---|
| Memory content + embeddings | Cross-store lifecycle orchestration |
| Hebbian associations / firing-together | The promotion ladder (memory → doc → compiled) |
| Native decay of unused entries | Lifecycle-triggered retirement (thread archived, task done, project finished) |
| Activation-based retrieval | Proposal generation and promotion gating |
| Salience / reinforcement scoring | Snapshot pinning for Oracle reproducibility |
| "What's strong right now" | "What was live at snapshot N, and how did it get there" |

**Split summary:**

- **Muninn** — fluid memory dynamics.
- **Distillation** — cross-store lifecycle orchestration and lineage.
- **CorpusCompiler** — immutable snapshot production.
- **Oracle** — scoring snapshot deltas.

Concretely, distillation tables carry **no** `salience`, `reinforcement_count`, `decay_timestamp`, or `last_activated_at` columns. Those are Muninn-side concerns. When distillation needs "is this memory entry still strong?", it queries Muninn's association/activation API — it does not maintain its own scoring.

Memory entries are one `artifact_kind` among many. When Curator promotes a proposal to a memory entry, the write goes to Muninn; our `artifact_version` row holds the Muninn entry ID plus snapshot/lineage metadata. Same pattern for every other kind — content in native store, metadata/provenance in distillation tables.

The one thing distillation **does** keep that Muninn doesn't provide: a tiny append-only cross-store lifecycle audit trail (see `ArtifactEvent` below). Muninn tells us what's strong now. The audit log tells us when a memory was promoted into a doc, which snapshot a version entered, when it was contradicted or reintroduced, and which Oracle run scored it. That's distillation's job, not Muninn's.

---

## The Backbone

Five nouns, one arrow, no branches:

```
Message ──► AnalysisPass ──► ArtifactVersion ──► CorpusSnapshot ──► OracleRun
```

Every other primitive hangs off this spine. Clusters, summaries, and proposals are *kinds* of `AnalysisPass`. Memory entries, conventions, guards, fixtures, and doc edits are *kinds* of `ArtifactVersion`. Everything downstream of a message can be traced back through this chain.

Two policies govern the flow:

1. **Acknowledgement is universal.** Every sealed message runs through at least one post-hoc analysis pass. That pass may emit nothing durable — it still produces an `AnalysisPass` row, which is what makes the message "Acknowledged" instead of "New."
2. **Promotion is selective and wave-based.** Materialization into memory/doc/guard/fixture is not per-message. It is a scheduled sweep that looks at acknowledged messages (and their prior artifacts) and decides what has earned a durable home. Thresholds differ by artifact kind — memory is cheap, docs are curated.

---

## The Promotion Ladder

```
Message
  │
  ▼
AnalysisPass                        ← universal; makes the message Acknowledged
  │
  ├─── (most messages stop here) ──── terminal Acknowledged state
  │
  ▼
Memory Entry            ← low threshold; one corrective signal is enough
  │
  ▼
Doc / Convention        ← higher threshold; needs pattern + Oracle evidence
  │
  ▼
Compiled Corpus         ← CorpusCompiler's job; snapshotted, hashed
  │
  ▼
Oracle Run              ← scored against a fixture
```

Side rungs (not further down the ladder, just other destinations):

- **Guard pattern** — when the signal is "prevent this mistake," not "remember this fact."
- **Fixture candidate** — when the signal is "this exact case should be a regression test."

An artifact being "upgraded" from memory → doc is **not** a new artifact. It's a new `ArtifactVersion` on the same logical `artifact_id`, with its `ancestors[]` pointing at the prior version. The lineage chain stays intact.

---

## Primitives

Each primitive has a stable identity, provenance, and (where applicable) versioning. The storage model is metadata/provenance — **content lives in its native store** (memory system, convention files, guard registry, doc files). These tables track what exists, how it got there, and what it's currently aligned with.

### Message

Immutable fact. The canonical unit of "something happened in a session."

```
message_id, thread_id, sealed_at
first_seen_at
raw_event_ids: string[]       -- which SessionEvents compose this message
```

**No status column.** Operator labels are derived (see below). A message that produced no artifacts is still a valid terminal state — it was seen, classified, and judged insufficient for materialization. That judgement is the `AnalysisPass` row.

> **Message derivation is a live question.** Until the message-tree model from `HARNESS_LIFECYCLE.md` step 9 lands, distillation treats a "message" as a sealed turn boundary from the event stream. When the tree model arrives, message identity migrates to the tree node; the `raw_event_ids` field absorbs the transition without schema churn.

### AnalysisPass

The explicit record that something looked at a message (or cluster, or window) and produced a judgement. Makes "Acknowledged" concrete rather than fuzzy.

```
pass_id, scope: message | cluster | window, subject_ids: string[]
classifier_name, classifier_version
ran_at, token_cost
outputs: { classifications?, cluster_id?, summary_id?, proposals? }
```

Multiple passes can run on the same message over time (model upgrades, re-classification, deeper analysis). Each is its own row. `message_analysis_refs(message_id, pass_id)` is the join.

### Classification

A tag produced by an AnalysisPass. Multi-valued: one message can be `convention-gap` *and* `insight`.

```
classification_id, message_id, pass_id
tag: bug | convention-gap | ambiguity | insight | taste | adr | security | other
confidence: number
```

### Cluster

A set of related messages grouped by theme, across threads and time. Product of a clustering pass.

```
cluster_id, theme_summary
member_message_ids: string[]
opened_at, last_updated_at
state: open | closed | superseded
```

### Summary

A compact text artifact summarizing one thread, cluster, or time-window. Ephemeral — cheap to regenerate. **Not layer content.** If a summary is useful enough to inject, it should be promoted to a DurableArtifact first.

```
summary_id, scope: thread | cluster | window
source_message_ids: string[], source_cluster_ids: string[]
content, token_estimate, generated_at
state: current | stale | superseded
superseded_by: summary_id?
```

### Proposal

A candidate for promotion to a durable artifact. This is the "should this become a memory / doc / guard?" artifact.

```
proposal_id, artifact_kind: memory_entry | convention | guard_pattern | fixture | doc_edit
source_pass_ids, source_message_ids, source_ancestor_artifacts
draft_content, rationale
state: pending | accepted | rejected | expired
decided_by, decided_at
```

### Artifact + ArtifactVersion

Logical artifact identity is stable across upgrades. The **version** is what gets snapshotted, scored, and potentially superseded.

```
-- logical identity
artifact(artifact_id, artifact_kind, current_version_id, created_at, domain, tags)

-- versioned content metadata (not the content itself — that's in the native store)
artifact_version(
  version_id, artifact_id, version_number
  native_ref               -- pointer into memory store / docs file / guard registry
  content_hash             -- for snapshot integrity
  source_message_ids       -- every message that fed this version
  ancestor_version_ids     -- the prior rung(s) on the ladder
  promoted_from_kind       -- e.g. "memory_entry" when this is a doc that grew from memory
  confidence, source_count
  snapshot_introduced, snapshot_retired
  created_at, retired_at
  superseded_by_version_id
)
```

**Why split artifact and artifact_version:** the logical question "does Foundry have a convention for X?" needs a stable ID. The Oracle question "what did the convention for X say at snapshot N?" needs version history. Splitting them keeps both clean.

### CorpusSnapshot

Already exists as a concept (`VISION.md`, `THREE_SYSTEMS.md`). Distillation writes to it.

```
snapshot_id, content_hash, captured_at
artifact_version_ids: string[]     -- exact set of versions live in this snapshot
```

Every promotion/invalidation that changes the effective corpus produces a new snapshot. Snapshots are immutable and hashed, which is what lets Oracle runs be reproducible.

### OracleRun

Already exists as a concept. Distillation consumes its outputs.

```
run_id, fixture_id, corpus_snapshot_id
score, diagnostics, ran_at
```

Closes the loop: a score drop between snapshot N and N+1 is a regression attributable to specific artifact_version changes.

### ArtifactEvent

Append-only cross-store lifecycle/audit log. The **only** Foundry-side record of what happened to an artifact across stores over time. Not a memory system, not a salience engine — just an audit trail Muninn can't produce on its own because the events cross stores it doesn't see.

```
event_id, trace_id, ran_at
artifact_id, version_id?
kind: promoted | upgraded | injected_into_snapshot | contradicted |
      retired | reintroduced | proposed | oracle_referenced
actor: agent_id                    -- which agent emitted this
context: { thread_id?, task_id?, project_id?, proposal_id?,
           from_version_id?, to_version_id?, snapshot_id?,
           oracle_run_id? }
```

Every lifecycle transition writes an `ArtifactEvent` row. This is how we answer:

- When was this memory promoted into a doc?
- When did this version first enter a compiled snapshot?
- Was this retired, reintroduced, and retired again? In which sessions?
- Which Oracle run referenced this version?
- What agent/trace made this change?

Muninn's associations answer "what is strong now." `ArtifactEvent` answers "what happened across time, across stores." Neither duplicates the other.

---

## Lineage Queries

The model above answers all of these with straight joins:

| Question | Query |
|---|---|
| Why is this doc here? | `artifact_version.ancestor_version_ids` + `source_message_ids` |
| What original conversations created this convention? | Follow `source_message_ids` to messages |
| Did this start as memory and later become doc? | Walk `ancestor_version_ids` back, check `promoted_from_kind` |
| What changed between before/after feature X? | Diff `artifact_version_ids` between two snapshots |
| Which Oracle run validated this artifact? | `oracle_run WHERE corpus_snapshot_id IN (snapshots that contain version_id)` |
| Is this message currently live anywhere? | `message_artifact_refs JOIN artifact_version WHERE retired_at IS NULL` |
| Has this memory entry been replayed into any new session? | `layer_injection_ledger JOIN artifact_version` (future) |

---

## Operator Labels (Derived)

The UI shows simple labels. None of them are columns. All are views over the tables above.

| Label | Rule |
|---|---|
| **New** | No `AnalysisPass` rows for this message |
| **Acknowledged** | Has at least one pass, no live artifact refs |
| **In Memory** | Has live version with `artifact_kind = memory_entry` |
| **In Docs** | Has live version with `artifact_kind = convention \| doc_edit` |
| **In N Systems** | Count distinct `artifact_kind` across live versions |
| **Historical** | Had live versions, all now retired (`retired_at IS NOT NULL`) |
| **Contested** | Live versions include at least one `contradicting` classification from a newer message |

**Historical is not terminal.** A message that dropped out of the live corpus can come back when a later AnalysisPass re-promotes it (new version, new snapshot). That's why none of this is encoded as a message state — it's lineage, and lineage is time-varying.

---

## Triggers (Universal Ack, Wave-Based Promotion)

| Stage | Event-driven | Scheduled (wave) | On-demand |
|---|---|---|---|
| **Intake (ack + route)** | On message seal — **every message** | Backfill, re-run on classifier upgrade | From viewer UI |
| **Cluster** | On new high-signal classification | Rolling window sweep | "What's recurring?" |
| **Propose** | — | Wave sweep: look at acked messages + existing artifacts, generate candidates | From viewer UI |
| **Promote** | Auto-approve for high-confidence proposals | Digest mode (batch human review) | Manual approve |
| **Deprecate (retire/reintroduce)** | On lifecycle events: thread archived, task completed, project finished, branch merged, contradiction signal | — (time decay is Muninn's job, not ours) | Manual flag |

The wave pattern is the point. Per-message promotion would churn the corpus and drown the operator in proposals. Scheduled waves look at clusters of acked messages and artifacts-at-risk together, which is when the "promote to doc?" and "supersede this memory?" questions have actual signal.

**Deprecate is lifecycle-event-driven only.** Time-based decay of memory entries is handled natively by Muninn. Distillation's Deprecator only retires artifacts in response to concrete Foundry-side events (thread archive, task completion, project end, explicit contradiction) — not timers. That's what keeps the two systems from fighting each other over the same signal.

Scheduled sweeps are bounded — each has a budget (tokens, wall time, items processed) and defers work to the next tick. If capture outruns distillation for long, **the Intake stage must keep up** even if proposal/promote lag; otherwise messages accumulate as `New` and every downstream stage guesses.

---

## Failure Modes

1. **Capture outruns analyze.** Messages pile up as `New`; operator labels lie. Fix: bounded queue on analyze with explicit drop-or-defer. Analyze is the highest-frequency stage — it must keep up.
2. **Classifier drift.** A new model version tags differently. Fix: `classifier_version` on every AnalysisPass; re-run on version bump produces new passes, not mutations.
3. **Artifact contradiction without invalidation.** Two conventions say opposite things. Fix: on promotion, scan for conflicts in the same domain; mark as proposals for reconciliation.
4. **Summary loops.** Summary A cites summary B cites summary A. Fix: summaries reference raw messages, not other summaries. Clusters reference messages, not clusters.
5. **Promotion floodgate.** Auto-approval accepts too much, corpus bloats. Fix: rate limits on promotion per domain, per time window.
6. **Invalidation starvation.** Stale artifacts keep shaping new sessions. Fix: staleness is a first-class signal emitted when analyze sees contradiction evidence — not a timer.
7. **Duplicate source of truth.** An `artifact_version` content drifts from what's actually in the native store. Fix: `content_hash` in the version row, recomputed on read; mismatch is an alarm, not a silent failure.

Each failure mode has one or more Oracle scoring dimensions tied to it.

---

## Relationship to the Rest

### fluid / formal / compiled

Distillation is the mechanism that decides what lives in `.foundry/corpus/fluid/`, when a fluid entry earns promotion to `.foundry/corpus/formal/`, and when those changes get re-compiled into `compiled.json`. Concretely:

- `analyze` + `cluster` + `summarize` → enrich fluid.
- `propose` + `promote` → create or update formal.
- Snapshot production stays owned by `CorpusCompiler`. Distillation emits the signal; the compiler produces the hash.

There is exactly one corpus. Distillation is its inbound enrichment layer, not a competing store.

### Session substrate

Sessions produce SessionEvents. The archive holds them. Distillation reads from the archive; it does not touch the live Session. Capture and absorption are decoupled, which is why the capture side could ship first.

### Layers

Durable ArtifactVersions become layer content when a layer's source query selects them. Memory entries populate the memory layer. Promoted conventions shape the convention layer. Guards update their pattern registry. Summaries are **not** layer content.

### Delta-aware hydration

Because ArtifactVersions are compact, addressable, and snapshot-pinned, `FlowOrchestrator` can diff the version set a session already has (from its injection ledger) against the current snapshot and inject only what changed. Without distillation, delta hydration has nothing stable to diff against.

### Oracle

Distillation is measurable. Oracle scoring dimensions:

- **Classification accuracy** — does the tag match human judgment?
- **Cluster quality** — are clusters coherent and useful?
- **Summary fidelity** — does the summary represent the source?
- **Proposal value** — accepted proposals produce measurable session improvements.
- **Coverage** — high-signal messages that never reached promotion.
- **Invalidation latency** — time between reality changing and the artifact being flagged.
- **Promotion latency** — time between a pattern being clusterable and actually becoming a doc. Large values indicate the loop is broken.

Each dimension feeds training signal back into the stage it measures.

### The re-alignment tax

The tax CLAUDE.md names is measured by the gap between "signals captured" and "signals absorbed into the corpus." Distillation closes that gap. If the gap widens, the system is silently getting worse.

---

## Routing & Ownership

Distillation is not a single pipeline with a single owner. It's orchestrated across a small set of named agents, each with a specific role. The rule that keeps this from getting mushy:

> **Any actor can emit evidence about an artifact. Only the artifact's steward reconciles that evidence into state.**

Many writers of evidence; one writer per artifact kind.

### Agent map

| Agent | Kind | Scope | Model tier |
|---|---|---|---|
| **IntakeLibrarian** | new | Every sealed message: universal ack, coarse classify, route to domain, emit first-pass summary. The initial sort that decides where a signal goes. | Gemini Flash |
| **Domain Stewards** | existing Domain Librarians, expanded | Own artifacts within their domain. Read evidence (touches via Muninn, contradictions via new AnalysisPasses) and reconcile into artifact metadata. Decide "this memory stays memory" vs "this now deserves a convention." | Gemini Flash |
| **Librarian** | existing | Reconciles cross-domain signals and writes thread-state. Unchanged from FLOW.md. | Gemini Flash |
| **Herald** | existing | Cross-thread clustering (convergence/divergence detection). Produces `Cluster` rows. | Gemini Flash |
| **Curator** | new | Wave-based promotion. Reads steward findings, clusters, and Oracle evidence; generates proposals; manages review queue. Handles memory → doc, pattern → guard, correction → fixture. | Gemini Flash |
| **Deprecator** | new | Event-driven retirement. Responds to thread archive, task complete, project finished, contradiction signals. **Does not handle time decay — Muninn does.** Writes `ArtifactEvent` rows for every retirement/reintroduction. | Gemini Flash |
| **CorpusCompiler** | existing | Takes currently-live `ArtifactVersion` rows and produces immutable, hashed snapshots. Pure code, no model calls. | — |
| **Oracle** | existing | Scores snapshot deltas; validates promotions and deprecations. | varies |

Every agent except CorpusCompiler and Oracle runs on cheap/fast models, keeping the "capable models for work, cheap models for decisions" rule intact.

### Memory Steward specifically

The Memory Steward is a Domain Steward. It is **a thin adapter over Muninn**, not a reimplementation.

- **Reads** Muninn's native association/activation API to answer "is this entry still strong, still contested, still associated with X."
- **Writes** new memory entries to Muninn via the existing adapter.
- **Applies** lifecycle retirements: when the Deprecator emits "thread archived, retire unreferenced thread-local memories," the Memory Steward is the one that executes against Muninn.
- **Does not** maintain its own salience, decay, or reinforcement columns.

### Lifecycle event triggers

These are the events that drive the Deprecator (and, in some cases, Curator's last-chance promotion sweeps):

| Event | Deprecator action | Curator action |
|---|---|---|
| Thread archived | Retire thread-local artifacts never referenced outside the thread. | "Last chance to promote": sweep thread-scoped acks, propose durable artifacts for patterns that never earned a wave promotion. |
| Task completed | Evaluate task-scoped artifacts: demote what proved wrong, mark what proved decisive for post-task summarize. | Post-task summary AnalysisPass. |
| Project finished | Large sweep: move project-scoped knowledge to historical tier; keep compiled-in conventions. | — |
| Branch merged | Re-score artifacts produced during that branch against the merged state. | — |
| Contradiction signal (new AnalysisPass) | Mark affected versions `superseded_by_version_id`; emit `ArtifactEvent { kind: contradicted }`. | If contradiction implies a new pattern, generate a proposal. |

Every one of these writes an `ArtifactEvent` row, which is how Oracle and the viewer reconstruct lineage across stores.

### Steward rule in practice

When an executor session cites a memory entry, the **session does not mutate** the memory's metadata. It emits a touch (into Muninn natively) and a trace. The **Memory Steward** periodically reads those, and only the steward can:

- Propose the entry for upgrade (push to Curator).
- Tag the entry as contradicted (push to Deprecator).
- Retire the entry in response to a lifecycle event.

Same pattern for Docs Steward, Guard Steward, Fixture Steward. Evidence flows freely; state transitions are deterministic and owned.

---

## Pick-Up Plan

Capture exists. No distillation stage is implemented yet.

**Phase 1 — end-to-end spine, cheapest credible version:**

1. **Event → message boundary.** Until the message-tree model lands (`HARNESS_LIFECYCLE.md` step 9), derive messages from sealed turns. Write `messages` and `raw_event_ids` tables as part of the archive work (HL step 7).
2. **IntakeLibrarian.** New config-driven agent. Fires on every sealed message; runs the universal ack pass (classify + route-to-domain). Writes `AnalysisPass` + `Classification` rows.
3. **Per-thread summarize.** On thread idle or N messages. One scope (`thread`) to start.
4. **Operator labels view.** Derived query producing `New / Acknowledged / In N Systems / Historical`. Wire to viewer thread-tree badges.
5. **`ArtifactEvent` log.** The append-only lifecycle audit table. Needed before any stage can write lifecycle transitions — the audit trail is the spine everything else hangs off.

**Phase 2 — promotion ladder + stewards:**

6. **Herald clustering.** Hourly sweep across recent classified messages; write `Cluster` rows.
7. **Curator.** New config-driven agent. Wave sweep generates proposals from clusters + summaries + Oracle evidence. Pending review UI.
8. **Domain Stewards (post-hoc role).** Expand existing Domain Librarians to read evidence and reconcile artifact state. Start with Memory Steward (thin Muninn adapter) and Docs Steward.
9. **ArtifactVersion + native-store binding.** Each `artifact_kind` wires to its native store. Memory promotions go to Muninn; doc promotions to `.foundry/corpus/formal/`; guards to the registry; fixtures to the index. Promotion writes a new version, updates the native store, emits a new corpus snapshot, writes an `ArtifactEvent`.
10. **Deprecator.** New config-driven agent. Responds to lifecycle events (thread archive, task completed, project finished, contradiction signals). Writes `ArtifactEvent { kind: retired | reintroduced | contradicted }` rows. Does **not** handle time decay — that's Muninn.

**Phase 3 — measurement:**

11. **Oracle scoring dimensions.** Start with classification accuracy (cheapest eval). Each dimension's signal feeds back into its stage.

Order is 1 → 2 → 3 → 4 → 5 before any of Phase 2. The first five get an end-to-end, testable loop — ack + summarize + labels + audit trail — even if crude. Without legibility (labels) and auditability (`ArtifactEvent`), the pipeline degrades silently.

**Not in this pick-up:**

- Cross-project corpus sharing.
- Federated distillation across Foundry instances.
- Distillation-driven prompt generation.
