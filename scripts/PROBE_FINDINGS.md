# Docs-layer probe findings

Empirical bake-off for how the docs warden should represent a 400KB markdown corpus
in its warm cache. Corpus: `inixiative/template/docs/claude/` (34 files).
Fixtures: `packages/foundry/tests/fixtures/template-docs-queries.ts` (15 queries).
Model: `gemini-2.5-flash-lite` (cheap classifier, temp=0, maxTokens=1024).

## Candidates

| Topology | Format | Tokens | Deterministic |
|---|---|---|---|
| A | `path (size)` lines | 161 | yes |
| B | `path — H1` + `  H2: a, b, c` | 1486 | yes |
| C | LLM-compiled one-line summary per file | 417 | no (one compile pass, then cached) |

## Results (precision-biased prompt + disambiguation hint)

| Topology | Precision | Recall | F1 | Violations |
|---|---|---|---|---|
| A | 0.806 | 0.600 | 0.630 | **1** |
| **B** | **0.894** | 0.556 | **0.639** | **0** |
| C | 0.867 | 0.517 | 0.609 | 0 |

Violation = predicted a file explicitly listed in `mustNotInclude` (e.g. pulling
frontend `AUTHENTICATION.md` for a backend-only session-timeout question).

## Winner: topology B

- Highest F1 and highest precision.
- Zero violations — H2 headings earn their extra tokens by disambiguating
  near-duplicate filenames (AUTH.md vs AUTHENTICATION.md, INIT_SCRIPT.md vs
  INIT_SCRIPT_PATTERNS.md).
- Deterministic. No compile pass, no cache staleness vs. source files, no
  model drift between regenerations.
- 1486 tokens for 34 files ≈ 44 tokens/file — cheap as a warm-cache substrate.

Topology A is attractive for its 161-token cost but cost 1 violation and has
no way to disambiguate paired files. Topology C has the compact size (417 t)
of a compiled index but adds a dependency on a compile pass and didn't
outperform B on any axis.

## The AUTH / AUTHENTICATION test

This pair shares the H1 "Authentication" and is only disambiguated by H2
content (backend: `Session model`, `Token storage`; frontend: `Hooks`,
`Components`). Results on the session-timeout query:

- A (paths only): returned both files → **violation**.
- B (H1 + H2): returned only `AUTH.md` → P=R=F1=1.
- C (compiled summary): returned only `AUTH.md` → P=R=F1=1.

Confirms the premise that structural topology (H2 headings) carries real
signal beyond paths alone.

## Weakness across all three: recall ~0.56

The model is parsimonious — it picks one or two anchor files even when the
fixture lists 3–4. Two plausible causes:

1. The precision-biased prompt explicitly tells it to "prefer fewer files
   when not confident". A recall-biased prompt would push this up at the
   cost of violations. We tried that in run 4 and it broke B's zero-violation
   record.
2. The ground truth is deliberately generous — includes any doc a reasonable
   engineer might reach for. The model reaching for the single most-relevant
   doc isn't wrong, just conservative.

For the layer mechanism we care about, precision matters more: injecting a
small relevant slice > injecting a noisy larger one. Recall of 0.56 with
P=0.89 is an acceptable operating point for warm-cache routing.

## Recommendations

1. **Wire topology B into production.** Done — `start.ts` sourceResolver
   uses `MarkdownDocs.topologySource(id)` for `type: "markdown"` sources.
2. **Hydrate on demand.** The Artificer has tool access (Read/Grep); the
   warden's snippet paths act as anchors the Artificer reads. Not a full
   HydrationAdapter round-trip — pull-over-push via existing tools.
3. **`scanRepoDocs(repoPath)`.** Done — `packages/foundry/src/setup/scan-docs.ts`
   scans any repo, scores candidates, emits a settings.json snippet.
   Integrated into `bun run setup` as a menu option + first-time prompt.

## Prompt sweep (follow-up)

Held topology B fixed, varied the warden prompt across 5 variants
(15 fixtures each, same model). See `.foundry/probe/prompt-sweep.json`:

| Prompt | P | R | F1 | avg-k | violations |
|---|---|---|---|---|---|
| P0 precision-biased (original) | 0.878 | 0.600 | 0.663 | 1.80 | 0 |
| P1 recall-biased | 0.603 | 0.722 | 0.612 | 3.53 | 1 |
| P2 anchor+adjacent | 0.761 | 0.661 | 0.660 | 2.40 | 0 |
| P3 min-K=3 forced | 0.639 | 0.756 | 0.674 | 3.13 | 1 |
| **P4 aspect-decomposition** | **0.844** | **0.617** | **0.677** | **2.07** | **0** |

P4 is Pareto-best over P0 (slightly higher F1 + recall, same zero-violation
record). Recall improvements above ~0.70 trade violations — not worth it
for a cache that misleads the Artificer if wrong.

**Current baseline**: topology B + P4 prompt. Exported as `DOCS_ADVISE_PROMPT`
from `packages/foundry/src/setup/scan-docs.ts` — single source of truth used
by both `start.ts` (production warden config) and scanned-repo config snippets.

## What this doesn't yet measure

Every number in this doc measures **routing quality** — did the warden pick
the docs a senior engineer would pick. That's not the same as **alignment
quality** — did the Artificer produce code that matches repo conventions
given the warden's picks.

The remaining question: does the warden + topology actually help the
Artificer write better code than topology-alone or Grep-alone? That needs
an end-to-end eval (run the Artificer on 5 realistic tasks under 3
conditions: no warden, topology-only, full warden) grading each output
against the conventions it should have followed. Not yet run.

## Files produced by this probe

- `packages/core/src/adapters/markdown-docs.ts` — added `topologySource()`
- `packages/core/tests/markdown-docs.test.ts` — 6 tests, all pass
- `packages/foundry/tests/fixtures/template-docs-queries.ts` — 15 hand-labeled fixtures
- `scripts/probe-docs-layer.ts` — three-way probe runner
- `.foundry/probe/results.json` — raw per-fixture metrics
- `.foundry/probe/docs-summaries.json` — cached LLM summaries for topology C
