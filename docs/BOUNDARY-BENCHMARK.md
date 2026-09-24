# Boundary loop pilot

The pilot compares the same native Claude session substrate in three conditions: `native` bypasses Foundry's agents and context routing; `fixed` uses the production Foundry classifier, router, Wardens, action guards and journal with new knowledge reviews disabled; `learning` enables those reviews. Each has its own project, thread, state directory and editable files. Model, effort, worker instruction and task sequence are held constant. Native retains its own conversation memory in all conditions.

The initial problem is Template's environment-launcher regression, commit `a98a3b54cba7119c41b8e45605a873e09601fb20`. Oracle copies the exact pre-fix launcher and substitutes a deterministic project-config reader. The task and domain context are reconstructed for the experiment, not represented as an original historical issue or pre-existing corpus. The accepted solution remains outside participant workspaces. Do not add current repository maps or discussions to this historical fixture.

This is a mechanism pilot with a small behavioral evaluator. It is not a blind benchmark, a security sandbox, an installed-package acceptance proof, or evidence of general performance improvement. Participants are instructed to stay inside their workspaces; host filesystem access is not technically isolated. A scored study should use sandboxed workers and withhold evaluator material on a separate host.

## Prepare and run

From `oracle`:

```sh
bun run boundary prepare ../template /tmp/boundary-pilot
```

This reads pinned git objects; it does not checkout, reset, commit, install repository dependencies or call a provider. An existing experiment directory is rejected. `manifest.json` records provenance, hashes, UUID identities, fixed context and a randomized arm order. Run arms in that order; repeat fresh experiments to counterbalance order across trials.

From `foundry`, inspect `examples/boundary-bench.options.json` and the zero-call plan:

```sh
bun run boundary plan /tmp/boundary-pilot native examples/boundary-bench.options.json
bun run boundary run /tmp/boundary-pilot native examples/boundary-bench.options.json
bun run boundary run /tmp/boundary-pilot fixed examples/boundary-bench.options.json
bun run boundary run /tmp/boundary-pilot learning examples/boundary-bench.options.json
```

`run` admits actual model work. Native Claude authentication must already be available. The two Foundry conditions require `GEMINI_API_KEY` from an existing authorized credential source. The CLI never accepts a controlled model adapter; tests use an explicit library seam and label those artifacts `controlled-adapters`.

Each arm allows two central sends and one native process. The sample requests a **$1 worker budget for that process**, passed through the installed Claude CLI's `--max-budget-usd`, and eight native turns per send. This does not impose a dollar limit on Gemini: decisions have a shared 80-request ceiling, at most 100,000 input characters and 1,600 requested output tokens per call. The report keeps those distinctions explicit. Use a gateway-enforced financial cap before larger runs. No retries or account rotation occur. Admissions stop at the configured deadline or on a provider failure; already-owned work remains attached until idle release is confirmed.

After turn one, the experiment observes review settlement before sending turn two. This is experiment scheduling, not a learning barrier added to production. The second turn's `verifyExpertDelivery` evidence establishes what crossed the actual provider boundary. Abstention, failed review and absent delivery stay visible; a completed task is not automatically a successful learning demonstration.

Each arm writes `state/run/report.json`, an append-only native event file for the direct baseline, exact provider request and response artifacts, the frozen experiment manifest, the final submitted launcher, and (for Foundry) its ordinary SQLite journal. `artifacts.json` inventories immutable files with byte lengths and SHA-256 checksums after the journal closes. Unknown token usage and dollar costs remain unknown. Cleanup must finish before an arm is complete. A reserved run cannot be silently retried or overwritten.

From `oracle`:

```sh
bun run boundary compare /tmp/boundary-pilot
bun run boundary report /tmp/boundary-pilot /tmp/boundary-pilot-report
```

Oracle grades the resulting launcher in fresh controlled environments. It does not trust participant tests or a matching reference diff. Its six cases cover missing dependencies, authentication, environment selection and precedence, argument preservation, and exit propagation. Calibration rejects the original bug and an authentication-bypass mutant and accepts the shipped fix. Missing/controlled runs, mismatched settings and changed submissions cannot produce a comparable report.

A confirmed native worker budget stop is a valid measured outcome once cleanup and final artifact capture complete. It is scored alongside completed arms and explicitly labeled, not excluded in a way that favors expensive runs. Other infrastructure failures and unresolved work prevent comparison.

## Layer cycle evaluation

`layer-cycle.json` exports each attempted turn, including failed turns: before-send, after-work and after-review snapshots; configured instructions and domain knowledge; generated thread knowledge with owner/revision/content; routing and advice decisions; guard request/outcome records; review jobs and evidence; native tool activity; and the preserved provider-boundary injection. Reviews can finish after the HTTP response, so the settled journal is retained separately from the response's pending status. No pending status is interpreted as a clear guard.

Oracle inspects this interchange without importing the Foundry runtime. It verifies inventory hashes, turn/owner joins, fresh-state controls, stable warmed domain caches and instructions, guard request correlation, knowledge content hashes, and the chain from a recorded review through a learned revision to a later exact provider request. Fixed controls cannot admit reviews or acquire learned knowledge; native controls cannot contain Foundry phases. Missing, truncated or malformed exports remain unassessed. Checksums detect changes, not malicious re-signing; the receipt proves recorded provider-boundary bytes, not the worker's attention or compliance.

`boundary report` creates a new directory with `comparison.json`, `comparison.md`, `task-outcomes.json` and `task-outcomes.md`. `comparable` describes task-outcome eligibility; `behaviorComparisonReady` also requires complete cycle evidence. The report command exits nonzero when the combined comparison is incomplete. For cycle-only inspection (including explicitly labeled controlled adapters), use `bun run cycles <experiment-directory> <new-report-directory>` from Oracle.

The cycle report shows advice/guard/review outcomes, knowledge before/assessed/after revisions, learned deliveries, tool errors and repeated inputs, and all observed worker/decision usage. Exact duplicate snippets and unchanged learned revisions are review flags, not automatic penalties. A rubric retains explicit unassessed scores for relevance, grounding, conflicting advice, guard follow-through, knowledge reuse and task outcome. Cumulative provider time can overlap; it is not wall-clock overhead. Native phases are not applicable, not missing failures.

The retained September 10 controlled evidence is under `.foundry/qa/layer-cycle-20260910`. It proves the export/checking path and exposed a topology bug where UUID prefixes were presented as domain names; Cartographer now uses the configured layer domain. Controlled advice deliberately repeats and reviews deliberately restate the same result, exercising the repetition flags. It supplies no live semantic-quality or improvement result. The real three-arm comparison still requires the decision-provider credential and fresh budgeted runs.

## Development team starter

```sh
bun run team /absolute/path/to/repository /absolute/path/to/new-foundry-config
bun run doctor /absolute/path/to/new-foundry-config
```

This creates ordinary `settings.json` with UUID agent, layer, source and project IDs. It snapshots Atlas's existing `MAP.md` feature and primitive sections with a content hash and source timestamp. Those Wardens enable only when their sections exist. Architecture and testing Wardens start with explicit instructions and no invented project conclusions. All decisions use the configured inexpensive Gemini profile; the native worker retains its separate model.

Slack, Linear, Notion and GitHub have separate attributed-evidence Warden declarations, disabled until supplied with an authorized snapshot. They are not live sync integrations. Kastle remains the authority for retrieving external evidence; connecting a source does not grant access through a prompt. Existing Kastle read operations and source refresh still need to be connected to these snapshots. New `guardTriggers` use the same explicit project list-patch syntax as other agent lists; an empty list disables a domain's action guards.

`learning.enabled: false` prevents new knowledge reviews while leaving advice, action guards, and durable evidence active. It does not erase previously learned knowledge. Comparisons therefore require fresh state directories.

## Herald starter contract

The existing Herald is not yet wired into the production domain-team runtime. Keep this as a separate cross-thread role, rather than adding a ninth Warden with unrestricted visibility.

- Input: explicitly published briefs with UUID publication/project/thread IDs, revision, source event references, affected paths, status and public decisions.
- Scope: project and audience authorization is checked before a brief enters the Herald. Same repository path, tags or pool membership cannot authorize access. Never feed private review rationale, credentials or raw sibling transcripts.
- Output: attributed duplication, conflict or useful-related-work signals to the Librarian, which remains the only thread-state writer. No direct edits to another Warden's memory, automatic permission changes, merges or forks.
- Lifecycle: accept updates/retractions, deduplicate source revisions, unsubscribe on archive/disposal, and report stale briefs as stale.
- Acceptance: two explicitly sharing threads see an overlap warning; a third unauthorized thread cannot see the brief or derived signal; retraction removes future delivery. Add this as a separate experimental condition once the basic learning comparison works.

The basic three-condition pilot deliberately excludes live external source refresh and Herald coordination so their effects are not mixed with learning. Subsequent studies can add each capability separately and use larger task sets, held-out tests and repeated trials.
