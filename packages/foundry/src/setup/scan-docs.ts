/**
 * Docs-layer scanner — detects a project's docs directory and emits a polished
 * config snippet (source + layer + agent) ready to merge into settings.json.
 *
 * This is the generalization of the template-docs probe (scripts/PROBE_FINDINGS.md):
 * the probe validated that for a 400KB markdown corpus, topology-B (path + H1 + H2)
 * is the best warm-cache substrate. This module ports that operating point to any
 * repo — pick the dir, score its structure, pick a strategy, emit config.
 *
 * Intentional scope cuts:
 *   - No repo-modifying restructuring. If the docs are messy, we surface that,
 *     we don't autonomously rename files.
 *   - No LLM calls. Pure filesystem heuristics. Cheap, deterministic, testable.
 *   - The emitted config is a suggestion; `setup.ts` asks before writing.
 */

import { join, relative, basename } from "node:path";
import { existsSync, statSync } from "node:fs";
import type {
  AgentSettingsConfig,
  DataSourceConfig,
  LayerSettingsConfig,
} from "../viewer/config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A directory that might be the project's docs root. */
export interface DocsCandidate {
  /** Absolute path. */
  absPath: string;
  /** Path relative to the scanned repo root. */
  relPath: string;
  /** Count of markdown files matched under this dir (recursive). */
  fileCount: number;
  /** Approximate token count for the full content (bytes / 4). */
  approxTokens: number;
  /** Fraction of files with at least one H1. 1.0 = every file titled. */
  titleCoverage: number;
  /** Average number of H2 headings per file. */
  avgH2PerFile: number;
  /** Total H2 headings across all files. */
  totalH2: number;
  /** Composite score used for ranking (higher = better). */
  score: number;
}

/** The chosen strategy for the docs warden's warm cache. */
export type DocsStrategy =
  /** Corpus too small or missing. Don't set up a docs layer. */
  | "none"
  /** Small corpus (< ~3k tokens). Emit full content as the layer source. */
  | "inline"
  /** Large corpus. Emit a compact path+H1+H2 topology; bodies hydrate on demand. */
  | "topology";

/** A ready-to-merge config snippet for the docs domain. */
export interface DocsConfigSnippet {
  source: DataSourceConfig;
  layer: LayerSettingsConfig;
  agent: AgentSettingsConfig;
}

export interface DocsSetupPlan {
  /** The winning candidate, or null if nothing qualified. */
  chosen: DocsCandidate | null;
  /** All candidates considered, ranked by score (descending). */
  candidates: DocsCandidate[];
  /** How the warden's cache should be populated. */
  strategy: DocsStrategy;
  /** Human-readable explanation of the choice. */
  rationale: string;
  /** Config snippet (only populated when strategy ≠ "none"). */
  settings?: DocsConfigSnippet;
}

export interface ScanOptions {
  /** Candidate subdirs to probe, in order of preference. */
  candidateDirs?: string[];
  /** File glob (passed to Bun.Glob). Default: all .md files, recursive. */
  glob?: string;
  /** IDs used in the emitted config snippet. */
  sourceId?: string;
  layerId?: string;
  agentId?: string;
  /** Minimum total tokens for any layer at all. Below this: strategy = "none". */
  minTokens?: number;
  /** Threshold above which topology is preferred over inline content. */
  topologyThreshold?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CANDIDATE_DIRS = [
  "docs/claude",
  "docs/ai",
  ".ai",
  "docs",
  "documentation",
];

const DEFAULT_GLOB = "**/*.md";
const DEFAULT_SOURCE_ID = "docs-src";
const DEFAULT_LAYER_ID = "docs";
const DEFAULT_AGENT_ID = "librarian-docs";
const DEFAULT_MIN_TOKENS = 200;
const DEFAULT_TOPOLOGY_THRESHOLD = 3_000;

/**
 * Docs-warden advise prompt — the baseline.
 *
 * Decent operating point on the template's 34-file docs/claude/ corpus:
 * P≈0.84, R≈0.62, F1≈0.68, zero violations across 15 routing fixtures
 * (prompt-sweep run over topology B, gemini-2.5-flash-lite, temp=0).
 *
 * The aspect-decomposition reasoning step ("list aspects, then pick files
 * per aspect") was the pareto-best variant in that sweep — small recall
 * gain over a pure precision-biased prompt without trading zero violations.
 *
 * Exported from here so start.ts + scan-docs stay on one string.
 */
export const DOCS_ADVISE_PROMPT = [
  "You are the docs-domain advisor. Pick the small set of doc files from the topology that would help the user's message.",
  "",
  "Procedure:",
  "1. Identify the ASPECTS of the task (e.g. \"database schema\", \"auth\", \"API routing\", \"notifications\", \"naming conventions\").",
  "2. For each aspect, find the file in the topology that covers it.",
  "3. Collect those files as your answer. Typically 2–4 files, up to 5 for cross-cutting queries.",
  "",
  "Rules:",
  "- Return ONLY file paths that appear EXACTLY in the topology below.",
  "- Distinguish near-duplicate filenames by reading their H1 title AND H2 headings (e.g. a backend AUTH.md vs a frontend AUTHENTICATION.md). A doc from the wrong side of the stack is worse than a missing doc.",
  "- Respond with JSON only, no prose, no code fences:",
  '  {"layers": ["docs"], "snippets": ["path1", "path2"], "confidence": 0.0-1.0}',
].join("\n");

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

/**
 * Scan a repo for its docs directory and plan how to wire the docs warden.
 *
 * Always returns a plan — when nothing qualifies, strategy is "none" with a
 * rationale explaining why. Never throws for a missing repo; returns an empty
 * plan instead.
 */
export async function scanRepoDocs(
  repoPath: string,
  opts: ScanOptions = {},
): Promise<DocsSetupPlan> {
  const candidateDirs = opts.candidateDirs ?? DEFAULT_CANDIDATE_DIRS;
  const glob = opts.glob ?? DEFAULT_GLOB;
  const minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS;
  const topologyThreshold = opts.topologyThreshold ?? DEFAULT_TOPOLOGY_THRESHOLD;

  if (!existsSync(repoPath)) {
    return {
      chosen: null,
      candidates: [],
      strategy: "none",
      rationale: `Repo path does not exist: ${repoPath}`,
    };
  }

  // When scoring a parent dir, exclude paths that belong to another candidate
  // dir nested beneath it (so `docs/` doesn't absorb `docs/claude/` into its
  // score — otherwise the parent always wins when both exist).
  const candidates: DocsCandidate[] = [];
  for (const sub of candidateDirs) {
    const abs = join(repoPath, sub);
    if (!existsSync(abs) || !isDir(abs)) continue;
    const nestedCandidates = candidateDirs
      .filter((other) => other !== sub && other.startsWith(sub + "/"))
      .map((other) => other.slice(sub.length + 1));
    const cand = await scoreCandidate(repoPath, abs, glob, nestedCandidates);
    if (cand.fileCount > 0) candidates.push(cand);
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return {
      chosen: null,
      candidates: [],
      strategy: "none",
      rationale: `No markdown corpus found. Looked for: ${candidateDirs.join(", ")}.`,
    };
  }

  const chosen = candidates[0];

  if (chosen.approxTokens < minTokens) {
    return {
      chosen,
      candidates,
      strategy: "none",
      rationale: `Best candidate (${chosen.relPath}) has only ~${chosen.approxTokens} tokens — too small to justify a warm layer.`,
    };
  }

  const strategy: DocsStrategy =
    chosen.approxTokens >= topologyThreshold ? "topology" : "inline";

  const settings = emitConfigSnippet(chosen, strategy, opts);

  const rationale = explainChoice(chosen, candidates, strategy, topologyThreshold);

  return { chosen, candidates, strategy, rationale, settings };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

async function scoreCandidate(
  repoRoot: string,
  absDir: string,
  glob: string,
  excludePrefixes: string[] = [],
): Promise<DocsCandidate> {
  const scanner = new Bun.Glob(glob).scan({ cwd: absDir, absolute: false });

  let fileCount = 0;
  let totalBytes = 0;
  let filesWithH1 = 0;
  let totalH2 = 0;

  for await (const relPath of scanner) {
    if (excludePrefixes.some((p) => relPath === p || relPath.startsWith(p + "/"))) continue;
    const abs = join(absDir, relPath);
    const file = Bun.file(abs);
    const text = await file.text();
    if (!text.trim()) continue;

    fileCount++;
    totalBytes += text.length;

    const { hasH1, h2Count } = countHeadings(text);
    if (hasH1) filesWithH1++;
    totalH2 += h2Count;
  }

  const approxTokens = Math.round(totalBytes / 4);
  const titleCoverage = fileCount > 0 ? filesWithH1 / fileCount : 0;
  const avgH2PerFile = fileCount > 0 ? totalH2 / fileCount : 0;

  // Composite score — rewards breadth, structure, and H2 density.
  // Heavy weight on H2s because the probe showed they're what disambiguates
  // near-duplicate filenames (AUTH.md vs AUTHENTICATION.md).
  const score =
    fileCount * 1.0 +
    totalH2 * 0.5 +
    titleCoverage * 10 +
    Math.min(approxTokens / 1000, 50); // cap token contribution

  return {
    absPath: absDir,
    relPath: relative(repoRoot, absDir) || ".",
    fileCount,
    approxTokens,
    titleCoverage,
    avgH2PerFile,
    totalH2,
    score,
  };
}

function countHeadings(text: string): { hasH1: boolean; h2Count: number } {
  let hasH1 = false;
  let h2Count = 0;
  for (const line of text.split("\n")) {
    if (!hasH1 && /^#\s+\S/.test(line)) hasH1 = true;
    else if (/^##\s+\S/.test(line)) h2Count++;
  }
  return { hasH1, h2Count };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Config emission
// ---------------------------------------------------------------------------

function emitConfigSnippet(
  chosen: DocsCandidate,
  strategy: Exclude<DocsStrategy, "none">,
  opts: ScanOptions,
): DocsConfigSnippet {
  const sourceId = opts.sourceId ?? DEFAULT_SOURCE_ID;
  const layerId = opts.layerId ?? DEFAULT_LAYER_ID;
  const agentId = opts.agentId ?? DEFAULT_AGENT_ID;

  const source: DataSourceConfig = {
    id: sourceId,
    type: "markdown",
    label: `Project documentation (${chosen.relPath})`,
    uri: chosen.absPath,
    enabled: true,
  };

  // Size the layer budget to the content. Inline needs room for everything;
  // topology is ~44 tokens/file so a 2× headroom over fileCount suffices.
  const maxTokens =
    strategy === "inline"
      ? Math.min(Math.max(chosen.approxTokens + 500, 1_000), 32_000)
      : Math.max(chosen.fileCount * 80, 1_000);

  const layer: LayerSettingsConfig = {
    id: layerId,
    domain: "docs",
    contentShape:
      strategy === "topology"
        ? "Compact path+H1+H2 index of the docs corpus. The warden picks file paths; bodies hydrate on demand."
        : "Full markdown content of the docs corpus, joined with path headers.",
    prompt:
      "Project documentation. The docs warden routes reads against this cache.",
    sourceIds: [sourceId],
    staleness: 60_000,
    writers: [agentId],
    enabled: true,
    activation: "conditional",
    condition: {
      tags: ["docs", "documentation", "readme", "api"],
    },
  };

  const agent: AgentSettingsConfig = {
    id: agentId,
    kind: "domain-librarian",
    flowRole: "domain-advising",
    domain: "docs",
    prompt: DOCS_ADVISE_PROMPT,
    temperature: 0,
    tools: false,
    visibleLayers: [layerId],
    ownedLayers: [layerId],
    peers: [],
    maxDepth: 1,
    invocation: "on-demand",
    enabled: true,
  };

  return { source, layer, agent };
}

// ---------------------------------------------------------------------------
// Rationale
// ---------------------------------------------------------------------------

function explainChoice(
  chosen: DocsCandidate,
  candidates: DocsCandidate[],
  strategy: DocsStrategy,
  topologyThreshold: number,
): string {
  const parts: string[] = [];

  parts.push(
    `Picked ${chosen.relPath} — ${chosen.fileCount} file${chosen.fileCount === 1 ? "" : "s"}, ~${chosen.approxTokens} tokens, ${(chosen.titleCoverage * 100).toFixed(0)}% titled, ${chosen.avgH2PerFile.toFixed(1)} H2/file.`,
  );

  if (candidates.length > 1) {
    const runners = candidates
      .slice(1, 4)
      .map((c) => `${c.relPath} (${c.fileCount}f, ${c.approxTokens}t)`)
      .join(", ");
    parts.push(`Also considered: ${runners}.`);
  }

  if (strategy === "topology") {
    parts.push(
      `Strategy: topology — corpus exceeds ${topologyThreshold} tokens, so the layer caches a compact H1+H2 index (~44 tok/file) and the Artificer reads file bodies on demand.`,
    );
  } else if (strategy === "inline") {
    parts.push(
      `Strategy: inline — corpus fits under ${topologyThreshold} tokens, so the full content lives in the layer cache.`,
    );
  }

  if (chosen.titleCoverage < 0.7) {
    parts.push(
      `Note: only ${(chosen.titleCoverage * 100).toFixed(0)}% of files have an H1 title — the warden's disambiguation will be weaker. Adding \`# Title\` lines to untitled files would help.`,
    );
  }
  if (chosen.avgH2PerFile < 2) {
    parts.push(
      `Note: average ${chosen.avgH2PerFile.toFixed(1)} H2 per file. H2 headings are what let the warden tell near-duplicate filenames apart — more structure → better routing.`,
    );
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Convenience: format a plan for CLI display
// ---------------------------------------------------------------------------

export function formatPlan(plan: DocsSetupPlan): string {
  const lines: string[] = [];
  lines.push("Docs-layer scan results:");
  lines.push("");

  if (plan.candidates.length === 0) {
    lines.push("  No docs directory found.");
    lines.push(`  ${plan.rationale}`);
    return lines.join("\n");
  }

  lines.push("  Candidates (best first):");
  for (const c of plan.candidates) {
    const marker = c === plan.chosen ? ">" : " ";
    lines.push(
      `    ${marker} ${c.relPath.padEnd(24)} ${c.fileCount.toString().padStart(3)}f  ${c.approxTokens.toString().padStart(6)}t  ${(c.titleCoverage * 100).toFixed(0).padStart(3)}% titled  ${c.avgH2PerFile.toFixed(1)} H2/f`,
    );
  }
  lines.push("");
  lines.push(`  Strategy: ${plan.strategy}`);
  lines.push(`  ${plan.rationale}`);
  return lines.join("\n");
}
