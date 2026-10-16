# Warden eval reporting

Every Warden eval (the correction eval, the size test, a language A/B, a charter or model round, the v1 pipeline) ends in the same two files beside its answers: `report.json` (schema `warden-eval-report/2`) and `REPORT.md`, rendered from it. One tool writes both:

```bash
bun scripts/evals/warden-charter-report.ts --run <run dir> --probes <probes.jsonl> \
  [--labels <labels.json>] [--recognise <stage-1 run dir>] [--baseline <run dir>] \
  [--judge-pointers] [--window <before,after>] [--trigger-rates 17,60] \
  [--finding <file> --experiment <name> --layer <layer> --change <text>]
```

It reads a run (`answers.jsonl`, `turns.jsonl`, `score.json`, `quota.jsonl`, and a `--pipeline` run's `answers.pick.jsonl`/`turns.pick.jsonl`) and writes only the pointer-judge cache, the two report files and, when asked, a finding record. Re-rendering costs no model calls unless `--judge-pointers` finds unjudged remarks. The size test renders each cell as it finishes; the other evals are rendered by hand after the run (and after `--rejudge`, so the judged answers are used).

## Stages

The chorus is scored as the chain it runs as, so a change can be placed: did recognition move, did picking move, or did what reached the main thread move.

| stage | what | measured from |
|---|---|---|
| 1 recognise | every region Warden asked (Haiku low; the classifier charter, or an experiment's recognise charter file), holding `recognise.md` where the regions directory has one (else `knowledge.md`, named in provenance) | the run's `answers.jsonl` |
| 2 confirm and pick | a stronger model (Sonnet low, an experiment's pick charter file) asked only the (moment, region) pairs stage 1 named, given the recogniser's line, holding `knowledge.md` | `answers.pick.jsonl` of a `--pipeline` run, or the `--run` when `--recognise` names its stage-1 run (offline-derived) |
| 3 deliver | what reaches the main thread and whether it changes what it builds | placeholder until the intervention test (Oracle replay) |
| chorus roll-up | the system as the main thread sees it: stage 1 alone, or stage 1 → stage 2 (unfired moments stay silent; cost is the sum; time is stage 1's moment plus stage 2's added-when-fired) | |

## Gauges and axes come from the inventory

The list of what is tracked is `~/.foundry/evals/experiments/INVENTORY.md`, section G (gauges) and section H (axes). The report emits every gauge under the field G names, per stage; **a new gauge is added to INVENTORY G first, then the report is made to emit it**, never the other way round.

| G gauge | report field (per stage) |
|---|---|
| Coverage, Correctness (+ majority-correct) | `goal.coverage`, `goal.correctness`, `goal.majorityCorrect`; stratified in `goal.byAxis` |
| Per-Warden miss rate, false-positive rate | `recognition.perRegion[<region>].miss` / `.falsePositive` (n, d, rate, Wilson CI) |
| Accumulated error | `accumulated` (moments with ≥ 1 miss, with ≥ 1 wrong chime, the compounding line) |
| Pointer ladder | `pointer.byMomentBestRung`, `pointer.leads`, `pointer.exact` |
| Cost | `cost.tokens` by kind, `cost.weighted` (by kind: input 1, cache read 0.1, cache write 2, output 5, thinking 5; then by model, `MODEL_COST_WEIGHTS` in `scripts/evals/cost-weights.ts`: Haiku 1, Sonnet 9, pre-registered; a model without a weight leaves the weighted cost empty; one coefficient to window points fixed from the after-run; `cost.weighted.byModel` per stage, the weights also in provenance), `cost.perMoment.windowPoints`, `cost.projectedPerHour` |
| Time | `time.call.{all,warm,cold}`, `time.moment`, `time.addedWhenFired` |
| Memory | `memory` (null until a tiny test or spec C run records RSS; carried so the field exists) |
| Run-to-run noise | top-level `noise` when `--repeat <same-arm run>` is given: the paired diff between the two runs |
| Quota state | `quota.fiveHour`, `quota.sevenDay` at the stage's first and last probe |
| Impact, Recurrence | top-level placeholders until the intervention test and Oracle measure them |
| Trigger rate | an input (`--trigger-rates`), from the trigger-rates finding |

The H axes stratify `goal` (`goal.byAxis`): kind of moment (the trigger), kind of miss (`target.miss`), where the answer lives (`held` / `class-only` = expected only / `gap`), project, authorship, and kind of knowledge, a deterministic map from the target's concept cluster written into `labels.json` (`kindOfKnowledge.map`: e.g. concurrency-locking → coding, access-signets-permissions → system-domain, process-communication → process, naming → convention-style). A cell with fewer than 5 moments is reported as `tooFew`, never as a rate.

## The blocks (every stage, same shape)

1. **Goal (coverage and correctness) and pointer.** Per targeted moment: `needed` = the regions that hold or are expected for the target; `shown` = the regions that said yes. Coverage = |needed ∩ shown| ÷ |needed|; correctness = |needed ∩ shown| ÷ |shown| (a silent moment counts 0 in the all-moments mean and is reported apart). Means over moments, the share of moments with correctness > 0.5 (majority-correct), anticipated (a remark the Opus judge matched to the real correction), the pointer ladder (best rung per moment: exact / candidates / class / wrong / silent / unjudged), and whether the goal (coverage and correctness both > 0.5) is met.
2. **Cost.** Exact tokens by kind (input, cache read, cache write, output, thinking), per call and per moment; the shared five-hour window's growth while the run ran (`quota.jsonl`, or `--window before,after`), always marked as a shared upper bound; projections per hour at the measured trigger rates (`--trigger-rates`, default 17 typical and 60 busy moments per hour).
3. **Time.** Per call p50/p95/max, split warm (cache read ≥ write) and cold (priming); per moment (the turn's wall clock with every call in flight); added only when fired (stage 2: the share of moments it ran on and its wall clock there).
4. **Per-Warden individual error (`recognition`).** For each region: calls, own moments (those it is needed on), miss rate = own moments it was asked and stayed silent ÷ own moments asked, false-positive rate = wrong yeses ÷ calls on scorable moments it does not own, plus yes / right / wrong, precision and recall. Macro averages, the share of speaking regions at precision ≥ 0.8, regions that never fired.
5. **Accumulated error.** Moments with ≥ 1 miss (no needed region shown), moments with ≥ 1 wrong chime, measured wrong chimes per moment, and the compounding line: regions asked per moment × mean per-Warden false-positive rate = expected wrong chimes per moment under independence, beside the measured number.
6. **Quota state and memory.** The shared five-hour and seven-day windows at the stage's first and last probe; host RSS when a tiny test measured it.
7. **Provenance.** Run and answers file, model and effort, `MAX_THINKING_TOKENS`, charter version, regions commit and directory (or the `--knowledge` dir), knowledge file held (and which regions fell back), roster size, machine load (1-minute average over the run's quota probes), the shared-window flag, and for a roll-up the two stages' models and tokens per call (stage 1's drop when it holds `recognise.md`).

Every rate is `{ n, d, rate, ci }` with a Wilson 95% interval. A moment is one turn (probe × trigger), as live triggers are.

## Truth and exclusions

- `--labels` (from `warden-prefilter.ts label-regions`) gives, per probe, `held` (regions whose knowledge holds the target) and `expected` (judged routing destination); their union is `needed`. Truth is multi-region.
- Without labels (the size test's single-Warden cells), a targeted positive needs every region asked.
- A correction with no doc target (a positive probe with no labelled region) is left out of scoring: its truth is unknown. Negatives count every yes as wrong. Cost and time count every moment.
- When regions are split or renamed between commits, remap the labels to the new ids before reporting the new run (the language A/B did this by hand: `testing → test-harness + test-factories-rules`).

## Fixtures and baseline

`fixtures` records the probes file, counts (positive, with a doc target, negative), moments and triggers, periods, the split rule (from `manifest.json` beside the probes file: train/test by date per project), the labels file and the truth rule. `--baseline` names the run the deltas are against; the report shows its headline beside this run's and the differences (this run minus baseline) for coverage, correctness, majority-correct, anticipated, pointer leads and exact, moments with a miss or a wrong chime, wrong chimes per moment, tokens and window points per moment, call and moment p50.

## Paired diff (A/B)

With `--baseline`, the report also pairs the two runs on the moments both saw: hit cells (region × moment where the region is needed and said yes) lost and gained, per region and in total, regions whose baseline hits fell to zero, and a moment-level paired bootstrap (2000 resamples of moments, seeded) giving intervals for net hits, Δcoverage, Δcorrectness and Δwrong chimes per moment. This is what a region rewrite, a charter change or a grouping arm is judged on: "lost − gained ≤ 1 and no region falls to zero" is read off this block.

## Grouped recognisers (eval-only)

`scripts/evals/warden-groups.ts build --regions <pinned> --budget <tokens|all|1> --out <arm> [--random --seed <n>] [--seams <seams.txt>] [--votes <json>] [--atlas-parents <json>]` groups regions by concept adjacency (fixed weights, greedy average linkage to a token budget; `--random` is the token-matched control) and writes `groups.json` plus a chorus directory whose `<group>/knowledge.md` is the members' `recognise.md` texts under `# Region <id>: <title>` headings (their own headings demoted). Run it with `warden-charter.ts --regions <arm>/regions`, then `warden-groups.ts expand --run <run> --groups <arm>/groups.json --out <expanded>` maps each group's multi-select answer back to per-region rows (named members yes with their line, unnamed members NO_COMMENT, ids outside the group counted as parse errors in `parse.json`), and the standard report runs on the expanded directory unchanged.

## Finding record

`--finding <file> --experiment <name> --layer <layer> --change <text>` writes a record in the `~/.foundry/evals/findings/README.md` schema from the report: the headline metrics, the baseline's, the regions commit, and a one-line summary with the path of the rendered `REPORT.md`. Records are generated from reports, never written by hand, so every number in a finding is in a report.

## Where runs live

Private, under `~/.foundry/evals/`: the correction eval's runs in `warden-corrections/runs/<run>/`, the size test's cells in `warden-size/<check>/runs/<run>/<cell>/`, language and charter rounds in `warden-corrections/runs/<round>/`. Never commit a run: answers hold session text.

## The two-stage experiment (eval-only)

`warden-charter.ts --pipeline --regions <dir> --recognise-charter <file> --pick-charter <file> [--pick-regions <dir>] [--model claude-haiku-5-5 --effort low] [--pick-model claude-sonnet-5-5 --pick-effort low]` runs the two-stage chain under test in one run directory; the report scores stage 1, stage 2 and the roll-up from it with no flags. This is an experiment arm, not Foundry's design: the two charters are files under `~/.foundry/evals/experiments/` (the first pair is `two-stage/recognise.md` and `two-stage/pick.md`), versioned by content hash in `score.json`; the stage-1 contract (`region <id>: <why>` per line, parsed by the eval; unparsable lines and unknown ids counted in the report) and the per-region `recognise.md` the recogniser holds (read beside `knowledge.md` when the regions directory has one, else `knowledge.md`, named in provenance) exist only in `scripts/evals`. Live Wardens run the one-stage classifier charter; nothing here changes a shipped default.

`--pick-regions <dir>` draws the stage-2 pickers from a regions directory by region id (`<dir>/<id>/{region.json,knowledge.md}`), independent of the stage-1 chorus. On a grouped stage 1 (`warden-groups.ts build`), each id a group names is checked against the group's `members` (in its `region.json`; a plain region holds itself) and handed to that region's full-catalog picker. Ids outside the members count as `unknownRegions`, ids with no picker as `missingPickers`; both appear in the report's stage-1 note (`scripts/evals/pipeline-dispatch.ts`, same semantics as `warden-groups.ts expand`).
