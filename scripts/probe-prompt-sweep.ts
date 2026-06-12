#!/usr/bin/env bun
/**
 * Prompt sweep for the docs-layer warden.
 *
 * The earlier probe (scripts/probe-docs-layer.ts) held the prompt fixed
 * (precision-biased) and varied the topology. That run hit recall 0.56 and
 * I rationalized it as "the right operating point." The analysis in
 * /tmp/foundry-wire-probe/analyze-errors.ts showed the failure pattern is
 * anchor-only selection — the model picks the primary doc but skips adjacent
 * support docs. That's a direct consequence of the precision-biased prompt.
 *
 * This sweep holds topology B fixed and varies the prompt to see whether a
 * different operating point is available. Reports P / R / F1 / violations
 * per variant so the precision/recall tradeoff is visible.
 *
 *   bun run scripts/probe-prompt-sweep.ts
 */

import { MarkdownDocs } from "../packages/core/src/adapters/markdown-docs";
import type { LLMProvider } from "../packages/core/src/types";
import { GeminiProvider } from "../packages/foundry/src/providers/gemini";
import { TEMPLATE_DOCS_FIXTURES, type RoutingFixture } from "../packages/foundry/tests/fixtures/template-docs-queries";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const TEMPLATE_DOCS_DIR = "/Users/arongreenspan/Desktop/inixiative/template/docs/claude";
const MODEL = "gemini-2.5-flash-lite";
const PROBE_DIR = ".foundry/probe";

// Load .env.local.
if (!process.env.GEMINI_API_KEY && existsSync(".env.local")) {
  const lines = (await Bun.file(".env.local").text()).split("\n");
  for (const line of lines) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY not set.");
  process.exit(1);
}

const llm: LLMProvider = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
  defaultModel: MODEL,
});

// ---------------------------------------------------------------------------
// Prompt variants
// ---------------------------------------------------------------------------

interface PromptVariant {
  id: string;
  label: string;
  rationale: string;
  system: string;
}

const PROMPTS: PromptVariant[] = [
  {
    id: "P0-precision",
    label: "current (precision-biased)",
    rationale: "Baseline — the production prompt. Prefer fewer files when uncertain.",
    system: [
      "You are the docs-domain advisor. The user has sent a message. Your job: pick the small set of doc files from the topology that would help.",
      "",
      "Rules:",
      "- Return ONLY file paths that appear EXACTLY in the topology below.",
      "- Prefer precision over recall. If you are not confident, return fewer files.",
      "- Return 0–5 files. Most messages need 2–4.",
      "- Distinguish near-duplicate filenames by reading their H1 title AND H2 headings (e.g. a backend AUTH.md vs a frontend AUTHENTICATION.md).",
      "- Respond with JSON only, no prose, no code fences:",
      '  {"files": ["path1", "path2"], "confidence": 0.0-1.0}',
    ].join("\n"),
  },
  {
    id: "P1-recall",
    label: "recall-biased",
    rationale: "Flip the bias — err toward including more, accept some noise.",
    system: [
      "You are the docs-domain advisor. The user has sent a message. Your job: pick all the doc files from the topology that a senior engineer would actually open for this task.",
      "",
      "Rules:",
      "- Return ONLY file paths that appear EXACTLY in the topology below.",
      "- Err on the side of including more files, not fewer. Missing a relevant doc is worse than including an extra one.",
      "- Return 2–5 files. Most messages need 3–4.",
      "- Distinguish near-duplicate filenames by reading their H1 title AND H2 headings (backend AUTH.md vs frontend AUTHENTICATION.md). Don't include a file from the wrong side.",
      "- Respond with JSON only, no prose, no code fences:",
      '  {"files": ["path1", "path2"], "confidence": 0.0-1.0}',
    ].join("\n"),
  },
  {
    id: "P2-anchor-adjacent",
    label: "anchor + adjacent (structured)",
    rationale: "Name the failure mode directly — pick anchor, then adjacents.",
    system: [
      "You are the docs-domain advisor. For each user message, pick the docs a senior engineer would actually open.",
      "",
      "Reasoning procedure:",
      "1. Identify the ANCHOR file — the primary doc most directly about the task.",
      "2. Identify ADJACENT files — docs the engineer would also need to do the task well. Typical adjacents:",
      "   - If task touches the database → schema conventions, hooks, naming",
      "   - If task adds an API endpoint → routing conventions, auth/permissions",
      "   - If task sends a notification/email → communications / event system",
      "   - If task touches deployment → CI/CD, docker, environments",
      "3. Return anchor + adjacents (usually 2–4 total).",
      "",
      "Rules:",
      "- Return ONLY file paths that appear EXACTLY in the topology below.",
      "- Distinguish near-duplicate filenames by H1 title and H2 headings (backend AUTH.md vs frontend AUTHENTICATION.md).",
      "- Respond with JSON only, no prose, no code fences:",
      '  {"files": ["path1", "path2"], "confidence": 0.0-1.0}',
    ].join("\n"),
  },
  {
    id: "P3-k3-minimum",
    label: "minimum K=3 forced",
    rationale: "Blunt instrument — always return at least 3 files.",
    system: [
      "You are the docs-domain advisor. Pick the most relevant doc files for the user's message.",
      "",
      "Rules:",
      "- Return ONLY file paths that appear EXACTLY in the topology below.",
      "- Return EXACTLY 3 files (or 4 if the query genuinely spans more domains). Never fewer than 3 unless the corpus has fewer than 3 relevant files.",
      "- Rank by relevance — the anchor doc first, then supporting docs.",
      "- Distinguish near-duplicate filenames by H1/H2 (backend AUTH.md vs frontend AUTHENTICATION.md).",
      "- Respond with JSON only, no prose, no code fences:",
      '  {"files": ["path1", "path2", "path3"], "confidence": 0.0-1.0}',
    ].join("\n"),
  },
  {
    id: "P4-aspect-decomp",
    label: "aspect decomposition (CoT)",
    rationale: "Explicit aspect-by-aspect reasoning in the response.",
    system: [
      "You are the docs-domain advisor. Pick the most relevant doc files for the user's message.",
      "",
      "Procedure:",
      "1. List the ASPECTS of the task (e.g. \"database schema\", \"auth\", \"API routing\", \"notifications\").",
      "2. For each aspect, find the file in the topology that covers it.",
      "3. Collect those files as your answer. Typically 2–5 files.",
      "",
      "Rules:",
      "- Return ONLY file paths that appear EXACTLY in the topology below.",
      "- Distinguish near-duplicate filenames by H1 title and H2 headings.",
      "- Respond with JSON only, no prose, no code fences:",
      '  {"aspects": ["aspect-1", "aspect-2"], "files": ["path1", "path2"], "confidence": 0.0-1.0}',
    ].join("\n"),
  },
];

// ---------------------------------------------------------------------------
// Advise runner
// ---------------------------------------------------------------------------

async function advise(
  system: string,
  topology: string,
  query: string,
): Promise<{ files: string[]; confidence: number; raw: string; error?: string }> {
  const user = `## Docs topology\n\n${topology}\n\n## User message\n\n${query}\n\nRespond with JSON.`;
  try {
    const res = await llm.complete(
      [
        { role: "system", content: system },
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
  throw new Error(`Could not parse JSON: ${text.slice(0, 120)}`);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface QueryScore {
  promptId: string;
  query: string;
  predicted: string[];
  expected: string[];
  violations: string[];
  precision: number;
  recall: number;
  f1: number;
  predCount: number;
}

function normalize(paths: string[]): Set<string> {
  return new Set(paths.map((p) => p.split("/").pop() ?? p));
}

function score(
  promptId: string,
  query: string,
  predicted: string[],
  fixture: RoutingFixture,
): QueryScore {
  const pred = normalize(predicted);
  const exp = normalize(fixture.expectedDocs);
  const mustNot = normalize(fixture.mustNotInclude ?? []);
  let tp = 0;
  for (const p of pred) if (exp.has(p)) tp++;
  const violations: string[] = [];
  for (const p of pred) if (mustNot.has(p)) violations.push(p);
  const precision = pred.size === 0 ? 0 : tp / pred.size;
  const recall = exp.size === 0 ? 1 : tp / exp.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { promptId, query, predicted: [...pred], expected: [...exp], violations, precision, recall, f1, predCount: pred.size };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Prompt sweep: topology B fixed, 5 prompt variants ===");
  console.log(`Corpus: ${TEMPLATE_DOCS_DIR}`);
  console.log(`Model:  ${MODEL}`);
  console.log(`Fixtures: ${TEMPLATE_DOCS_FIXTURES.length}`);
  console.log(`Prompts: ${PROMPTS.length}\n`);

  const docs = new MarkdownDocs(TEMPLATE_DOCS_DIR, "*.md");
  const topology = await docs.topologySource("b").load();
  console.log(`Topology B: ${Math.round(topology.length / 4)} tokens\n`);

  const results: QueryScore[] = [];

  for (const prompt of PROMPTS) {
    console.log(`-- ${prompt.id}: ${prompt.label} --`);
    for (const fx of TEMPLATE_DOCS_FIXTURES) {
      const res = await advise(prompt.system, topology, fx.query);
      const s = score(prompt.id, fx.query, res.files, fx);
      results.push(s);
      const violStr = s.violations.length > 0 ? ` ⚠ ${s.violations.join(",")}` : "";
      const err = res.error ? ` (err: ${res.error})` : "";
      console.log(
        `  P=${s.precision.toFixed(2)} R=${s.recall.toFixed(2)} F1=${s.f1.toFixed(2)} k=${s.predCount} | ${fx.query.slice(0, 55)}${violStr}${err}`,
      );
    }
    console.log();
  }

  // Aggregate.
  console.log("=== Summary (15 queries per variant) ===\n");
  console.log("  variant                                 |   P   |   R   |  F1   | avg-k | violations");
  console.log("  ----------------------------------------+-------+-------+-------+-------+-----------");
  for (const prompt of PROMPTS) {
    const rows = results.filter((r) => r.promptId === prompt.id);
    const avg = (fn: (r: QueryScore) => number) =>
      rows.reduce((a, r) => a + fn(r), 0) / rows.length;
    const violations = rows.reduce((a, r) => a + r.violations.length, 0);
    console.log(
      `  ${prompt.id.padEnd(24)} ${prompt.label.slice(0, 16).padEnd(16)}| ${avg(r => r.precision).toFixed(3)} | ${avg(r => r.recall).toFixed(3)} | ${avg(r => r.f1).toFixed(3)} | ${avg(r => r.predCount).toFixed(2).padStart(5)} | ${violations}`,
    );
  }

  mkdirSync(PROBE_DIR, { recursive: true });
  const outPath = join(PROBE_DIR, "prompt-sweep.json");
  await Bun.write(
    outPath,
    JSON.stringify(
      {
        corpus: TEMPLATE_DOCS_DIR,
        model: MODEL,
        topology: "B",
        fixtureCount: TEMPLATE_DOCS_FIXTURES.length,
        prompts: PROMPTS.map(({ id, label, rationale }) => ({ id, label, rationale })),
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
  console.error("Sweep failed:", err);
  process.exit(1);
});
