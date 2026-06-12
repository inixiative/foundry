#!/usr/bin/env bun
/**
 * Docs-layer routing probe — three-way bake-off.
 *
 * For a real markdown corpus (template's docs/claude/), measure whether a
 * docs-warden advise LLM picks the right files when its cache holds one of
 * three topology formats:
 *
 *   A) paths only                    — `docs/claude/AUTH.md (20KB)`
 *   B) deterministic headings        — path + H1 + H2 list (no LLM compile)
 *   C) LLM one-line summary per file — compiled once, cached on disk
 *
 * The probe runs each fixture query through each topology, collects the
 * returned file paths, and computes precision@K and recall against hand-
 * labeled ground truth.
 *
 * Throwaway — if a topology wins decisively, the probe can be deleted
 * and the winner wired into start.ts via MarkdownDocs.topologySource().
 *
 *   bun run scripts/probe-docs-layer.ts
 */

import { MarkdownDocs } from "../packages/core/src/adapters/markdown-docs";
import type { ContextSource } from "../packages/core/src/context-layer";
import type { LLMProvider, LLMMessage } from "../packages/core/src/types";
import { GeminiProvider } from "../packages/foundry/src/providers/gemini";
import { TEMPLATE_DOCS_FIXTURES, type RoutingFixture } from "../packages/foundry/tests/fixtures/template-docs-queries";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TEMPLATE_DOCS_DIR = "/Users/arongreenspan/Desktop/inixiative/template/docs/claude";
const SUMMARY_CACHE_PATH = ".foundry/probe/docs-summaries.json";
const MODEL = "gemini-2.5-flash-lite";
const PROBE_DIR = ".foundry/probe";

if (!process.env.GEMINI_API_KEY) {
  // Try to load .env.local manually — Bun doesn't auto-load it for scripts.
  const envLocal = ".env.local";
  if (existsSync(envLocal)) {
    const lines = (await Bun.file(envLocal).text()).split("\n");
    for (const line of lines) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}

if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY not set. Put it in .env.local or export it.");
  process.exit(1);
}

const llm: LLMProvider = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
  defaultModel: MODEL,
});

// ---------------------------------------------------------------------------
// Topology builders
// ---------------------------------------------------------------------------

/** Topology A: just paths + sizes. The cheapest, dumbest baseline. */
function topologyA_source(docs: MarkdownDocs): ContextSource {
  return {
    id: "topology-a",
    async load() {
      const files = await docs.load();
      const paths = [...files.keys()].sort();
      const lines: string[] = [];
      for (const path of paths) {
        const content = files.get(path) ?? "";
        if (!content.trim()) continue;
        const kb = Math.round(content.length / 1024);
        lines.push(`${path} (${kb}KB)`);
      }
      return lines.join("\n");
    },
  };
}

/** Topology B: path + H1 + H2 headings. Deterministic, uses MarkdownDocs.topologySource. */
function topologyB_source(docs: MarkdownDocs): ContextSource {
  return docs.topologySource("topology-b");
}

/**
 * Topology C: path + LLM one-line summary per file. Compiled once, cached
 * on disk in SUMMARY_CACHE_PATH so reruns don't re-compile.
 */
async function topologyC_source(docs: MarkdownDocs): Promise<ContextSource> {
  mkdirSync(PROBE_DIR, { recursive: true });

  let cache: Record<string, { summary: string; mtime: number }> = {};
  if (existsSync(SUMMARY_CACHE_PATH)) {
    try { cache = await Bun.file(SUMMARY_CACHE_PATH).json(); } catch {}
  }

  const files = await docs.load();
  const paths = [...files.keys()].sort();
  let compiled = 0;

  for (const path of paths) {
    const content = files.get(path) ?? "";
    if (!content.trim()) continue;
    // Cache key uses length as a cheap mtime proxy for this probe.
    const key = `${path}:${content.length}`;
    if (cache[key]) continue;

    const summary = await summarizeFile(path, content);
    cache[key] = { summary, mtime: Date.now() };
    compiled++;
    process.stdout.write(`  compiled ${path}\n`);
  }

  if (compiled > 0) {
    await Bun.write(SUMMARY_CACHE_PATH, JSON.stringify(cache, null, 2));
  }

  return {
    id: "topology-c",
    async load() {
      const files = await docs.load();
      const paths = [...files.keys()].sort();
      const lines: string[] = [];
      for (const path of paths) {
        const content = files.get(path) ?? "";
        if (!content.trim()) continue;
        const entry = cache[`${path}:${content.length}`];
        const summary = entry?.summary ?? "(uncached)";
        lines.push(`${path} — ${summary}`);
      }
      return lines.join("\n");
    },
  };
}

async function summarizeFile(path: string, content: string): Promise<string> {
  const truncated = content.slice(0, 4000);
  const messages: LLMMessage[] = [
    {
      role: "system",
      content:
        "Summarize this documentation file in ONE sentence (max 20 words). Focus on what the doc is about — concepts, systems, patterns covered. No fluff.",
    },
    { role: "user", content: `## File: ${path}\n\n${truncated}` },
  ];
  try {
    const res = await llm.complete(messages, { maxTokens: 80, temperature: 0 });
    return res.content.trim().replace(/\n+/g, " ").slice(0, 200);
  } catch (err) {
    return `(summary failed: ${(err as Error).message})`;
  }
}

// ---------------------------------------------------------------------------
// Advise runner — mimics DomainLibrarian.advise but returns file paths
// ---------------------------------------------------------------------------

interface AdviseResult {
  files: string[];
  confidence: number;
  raw: string;
  error?: string;
}

const ADVISE_PROMPT = `You are the docs-domain advisor for a codebase. The user has sent a message. Your job: pick the small set of documentation files most relevant to that message.

Rules:
- Return ONLY file paths that appear EXACTLY in the topology below.
- Prefer precision over recall. If you are not confident, return fewer files.
- Return 0–5 files. Most messages need 2–4.
- Be careful with near-duplicate filenames: read titles AND H2 headings to distinguish them (e.g. a backend AUTH.md vs a frontend AUTHENTICATION.md).
- Respond with JSON ONLY, no prose, no code fences: { "files": ["path1", "path2"], "confidence": 0.0-1.0 }`;

async function advise(topologyContent: string, query: string): Promise<AdviseResult> {
  const user = `## Docs topology\n\n${topologyContent}\n\n## User message\n\n${query}\n\nRespond with JSON.`;
  try {
    const res = await llm.complete(
      [
        { role: "system", content: ADVISE_PROMPT },
        { role: "user", content: user },
      ],
      { maxTokens: 1024, temperature: 0 },
    );
    const parsed = parseJSON<{ files?: unknown; confidence?: unknown }>(res.content);
    const files = Array.isArray(parsed.files)
      ? parsed.files.filter((f): f is string => typeof f === "string")
      : [];
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;
    return { files, confidence, raw: res.content };
  } catch (err) {
    return { files: [], confidence: 0, raw: "", error: (err as Error).message };
  }
}

function parseJSON<T>(text: string): T {
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fence) return JSON.parse(fence[1]);
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) return JSON.parse(brace[0]);
  throw new Error(`Could not parse JSON from: ${text.slice(0, 120)}`);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface QueryScore {
  query: string;
  topology: string;
  predicted: string[];
  expected: string[];
  tp: number;
  fp: number;
  fn: number;
  violations: string[];
  precision: number;
  recall: number;
  f1: number;
  confidence: number;
}

function normalize(paths: string[]): Set<string> {
  // Match against basenames for robustness — fixtures use `AUTH.md`, topology
  // uses the full relative path `AUTH.md` (since docs dir is the root).
  return new Set(paths.map((p) => p.split("/").pop() ?? p));
}

function score(
  topology: string,
  query: string,
  predicted: string[],
  fixture: RoutingFixture,
  confidence: number,
): QueryScore {
  const pred = normalize(predicted);
  const exp = normalize(fixture.expectedDocs);
  let tp = 0, fp = 0, fn = 0;
  for (const p of pred) { if (exp.has(p)) tp++; else fp++; }
  for (const e of exp) { if (!pred.has(e)) fn++; }

  const mustNot = normalize(fixture.mustNotInclude ?? []);
  const violations: string[] = [];
  for (const p of pred) { if (mustNot.has(p)) violations.push(p); }

  const precision = pred.size === 0 ? 0 : tp / pred.size;
  const recall = exp.size === 0 ? 1 : tp / exp.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return { query, topology, predicted: [...pred], expected: [...exp], tp, fp, fn, violations, precision, recall, f1, confidence };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function estimateTokens(text: string): Promise<number> {
  // Rough char/4 estimate. Good enough for a probe.
  return Math.round(text.length / 4);
}

async function main() {
  console.log("=== Docs-layer routing probe ===");
  console.log(`Corpus: ${TEMPLATE_DOCS_DIR}`);
  console.log(`Model:  ${MODEL}`);
  console.log(`Fixtures: ${TEMPLATE_DOCS_FIXTURES.length}\n`);

  if (!existsSync(TEMPLATE_DOCS_DIR)) {
    console.error(`Corpus not found: ${TEMPLATE_DOCS_DIR}`);
    process.exit(1);
  }

  const docs = new MarkdownDocs(TEMPLATE_DOCS_DIR, "*.md");
  const allFiles = await docs.load();
  console.log(`Files loaded: ${allFiles.size}`);

  // Build the three topologies.
  console.log("\nBuilding topologies:");
  const topoA = await topologyA_source(docs).load();
  console.log(`  A (paths+size):      ${await estimateTokens(topoA)} tokens (${topoA.length} chars)`);

  const topoB = await topologyB_source(docs).load();
  console.log(`  B (H1+H2):           ${await estimateTokens(topoB)} tokens (${topoB.length} chars)`);

  console.log(`  C (LLM summary):     compiling per-file summaries…`);
  const topoCSource = await topologyC_source(docs);
  const topoC = await topoCSource.load();
  console.log(`  C (LLM summary):     ${await estimateTokens(topoC)} tokens (${topoC.length} chars)`);

  // Run every query against every topology.
  const results: QueryScore[] = [];
  const topologies = [
    { name: "A", content: topoA },
    { name: "B", content: topoB },
    { name: "C", content: topoC },
  ];

  console.log("\nRunning advise queries…\n");
  for (const fx of TEMPLATE_DOCS_FIXTURES) {
    console.log(`[Q] ${fx.query}`);
    console.log(`    expected: ${fx.expectedDocs.join(", ")}`);

    for (const topo of topologies) {
      const res = await advise(topo.content, fx.query);
      const s = score(topo.name, fx.query, res.files, fx, res.confidence);
      results.push(s);
      const violStr = s.violations.length > 0 ? ` ⚠ violates: ${s.violations.join(",")}` : "";
      const errStr = res.error ? ` (error: ${res.error})` : "";
      console.log(
        `    ${topo.name}: P=${s.precision.toFixed(2)} R=${s.recall.toFixed(2)} F1=${s.f1.toFixed(2)} c=${s.confidence.toFixed(2)} | ${res.files.join(", ") || "(none)"}${violStr}${errStr}`,
      );
    }
    console.log();
  }

  // Aggregate per topology.
  console.log("=== Summary ===\n");
  for (const topo of topologies) {
    const rows = results.filter((r) => r.topology === topo.name);
    const avg = (fn: (r: QueryScore) => number) => rows.reduce((a, r) => a + fn(r), 0) / rows.length;
    const violations = rows.reduce((a, r) => a + r.violations.length, 0);
    console.log(
      `Topology ${topo.name}: precision=${avg((r) => r.precision).toFixed(3)} recall=${avg((r) => r.recall).toFixed(3)} F1=${avg((r) => r.f1).toFixed(3)} confidence=${avg((r) => r.confidence).toFixed(3)} violations=${violations}`,
    );
  }

  // Persist full results for offline inspection.
  mkdirSync(PROBE_DIR, { recursive: true });
  const outPath = join(PROBE_DIR, "results.json");
  await Bun.write(
    outPath,
    JSON.stringify(
      {
        corpus: TEMPLATE_DOCS_DIR,
        model: MODEL,
        fixtureCount: TEMPLATE_DOCS_FIXTURES.length,
        topologyTokens: {
          A: await estimateTokens(topoA),
          B: await estimateTokens(topoB),
          C: await estimateTokens(topoC),
        },
        results,
        ranAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`\nFull results → ${outPath}`);
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exit(1);
});
