# Memory Amplification Baseline

Read-only measurement of six existing primary turns; no new model calls or source
policy changes. Report:
.foundry/qa/memory-injection/2026-09-07T00-57-55.876Z.json.
Checkpoint input: .foundry/qa/checkpoints/2026-09-07T00-32-07.792Z.json.
The report includes its input SHA256 and derived prompt hashes, not raw content.

| Turn suffix | Raw memory characters | Generated thread knowledge characters | Memory share of provider system section |
| --- | ---: | ---: | ---: |
| 60121c7e2abd | 68096 | 0 | 92.6% |
| 9cca1e9d3d03 | 85830 | 1326 | 90.9% |
| c034855c14b7 | 96688 | 1326 | 91.3% |
| fd8da2b3b69b | 109676 | 1326 | 92.0% |
| 1fd79e375b3a | 123674 | 1326 | 93.0% |
| e29ce89ebce8 | 137748 | 1326 | 93.7% |

Every measured formatted prompt exactly matches one user-input record in the
owned native Fable session, not just a Harness-prepared artifact. The latest is
turn_b191b46e-4106-4d48-9892-e29ce89ebce8 / trace_01a07940-55ed-7336-9e27-cf6d8dee7859,
native input timestamp2026-09-07T00:24:46.798Z,150675 characters. Raw memory alone
is34437 estimated tokens using four characters per token, NOT actual tokenizer
usage. Its provider system section is147085 characters. Full retained native
context, native compaction and quality/latency parity are not established here.

The latest trace separately records classifier8061ms, router14116ms, executor
177321ms; its plan.elapsed is10002ms within execution. Do not sum nested timings
twice or attribute execution time to memory without a controlled comparison.

## Reproduce

Run `bun scripts/measure-memory-injection.ts CHECKPOINT OWNED_CLAUDE_TAPE`.
Omit the tape argument for prepared-boundary-only measurement. The script reads
only user input text for matching and emits lengths/hashes/timestamps, not model
reasoning or prompt content. An exact native input match does not expose retained
native context. Trace timestamps are explicitly labeled monotonic milliseconds.

Strict explicit script typecheck passes:
`bun node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --types bun scripts/measure-memory-injection.ts`.
The initial typecheck invocation used a missing root bun-types package alias; the
working command uses installed bun types and the script's core type import is
relative to the actual workspace package. No dependency installation or runtime
source change occurred.

## Owning Work

FileMemory.asSource currently formats every visible matching entry; the production
memory source has no kind filter. Ownership boundaries are enforced, but raw audit
signals keep expanding the automatic prompt despite bounded generated knowledge.
This is a G3/G7 source-selection issue, not evidence that native retention permits
omitting context without proof.

The next owning slice must preserve the complete audit log and explicit/learned
instructions while separating it from automatic message input. Use owned generated
knowledge, explicit pinned facts and relevant retrieved excerpts with provenance,
visible selection/omission decisions and a bounded budget. Do not simply truncate
the log, delete history or hide missing context behind a performance claim.

Acceptance must cover a learned convention surviving many irrelevant signals,
retrieval of older relevant evidence, stale/failed learning, per-thread privacy,
reload/recovery and historical input inspection. Compare before/after prompt sizes
and native task correctness; direct/native latency needs controlled paired runs.
Native-context deduplication remains separately dependent on S6 retention proof.
