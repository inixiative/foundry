import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  EvalRun,
  EvalDiagnosis,
  RubricScores,
  ContextGap,
  CorpusSuggestion,
} from "./types";
import type { BatchResult, BatchSummary, RunResult } from "./runner";

// ---------------------------------------------------------------------------
// Eval Store — persistent memory for evaluation runs
// ---------------------------------------------------------------------------

/**
 * A stored batch of evaluation runs, with metadata for comparison.
 */
export interface StoredBatch {
  readonly batchId: string;
  readonly timestamp: number;
  /** A label for this run (e.g. "baseline", "add-validation-rule", "v2"). */
  readonly label: string;
  /** Git SHA or other version identifier for the context config. */
  readonly contextVersion?: string;
  readonly result: BatchResult;
}

/**
 * A regression comparison between two stored batches.
 */
export interface RegressionReport {
  readonly baselineId: string;
  readonly candidateId: string;
  readonly baselineLabel: string;
  readonly candidateLabel: string;
  readonly delta: {
    composite: number;
    completion: number;
    correctness: number;
    craft: number;
    efficiency: number;
    precision: number;
  };
  readonly improved: string[]; // fixture IDs that got better
  readonly regressed: string[]; // fixture IDs that got worse
  readonly unchanged: string[]; // fixture IDs within noise threshold
  readonly verdict: "improved" | "regressed" | "neutral";
}

/**
 * Score trend for a single rubric over time.
 */
export interface ScoreTrend {
  readonly rubric: keyof RubricScores | "composite";
  readonly points: Array<{
    batchId: string;
    label: string;
    timestamp: number;
    value: number;
  }>;
  readonly direction: "improving" | "declining" | "stable";
  readonly slope: number;
}

/**
 * Persistent eval store — stores batches to disk as JSON, enables
 * regression tracking, trend analysis, and gap aggregation.
 *
 * File layout:
 *   <dir>/
 *     batches/
 *       <batchId>.json   — StoredBatch
 *     index.json          — BatchIndex[]
 */
export class EvalStore {
  readonly dir: string;
  private _index: BatchIndex[] = [];
  private _loaded = false;

  constructor(dir: string) {
    this.dir = resolve(dir);
    const batchDir = join(this.dir, "batches");
    if (!existsSync(batchDir)) {
      mkdirSync(batchDir, { recursive: true });
    }
  }

  // -- Core CRUD --

  /** Load the index from disk. */
  async load(): Promise<void> {
    const indexPath = join(this.dir, "index.json");
    const file = Bun.file(indexPath);
    if (await file.exists()) {
      this._index = await file.json();
    }
    this._loaded = true;
  }

  /** Save a batch result with a label. Returns the batch ID. */
  async save(
    result: BatchResult,
    label: string,
    contextVersion?: string
  ): Promise<string> {
    if (!this._loaded) await this.load();

    const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stored: StoredBatch = {
      batchId,
      timestamp: Date.now(),
      label,
      contextVersion,
      result,
    };

    // Write batch file
    const batchPath = join(this.dir, "batches", `${batchId}.json`);
    await Bun.write(batchPath, JSON.stringify(stored, null, 2));

    // Update index
    this._index.push({
      batchId,
      timestamp: stored.timestamp,
      label,
      contextVersion,
      fixtureCount: result.summary.totalFixtures,
      composite: result.summary.averageComposite,
    });
    await this._writeIndex();

    return batchId;
  }

  /** Get a stored batch by ID. */
  async get(batchId: string): Promise<StoredBatch | null> {
    const safeName = batchId.replace(/[\/\\]/g, "_");
    const batchPath = join(this.dir, "batches", `${safeName}.json`);
    const file = Bun.file(batchPath);
    if (!(await file.exists())) return null;
    return file.json();
  }

  /** List all stored batches (metadata only, sorted newest first). */
  async list(): Promise<BatchIndex[]> {
    if (!this._loaded) await this.load();
    return [...this._index].sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Get the most recent batch, optionally filtered by label. */
  async latest(label?: string): Promise<StoredBatch | null> {
    if (!this._loaded) await this.load();
    const filtered = label
      ? this._index.filter((b) => b.label === label)
      : this._index;
    if (filtered.length === 0) return null;
    const newest = filtered.sort((a, b) => b.timestamp - a.timestamp)[0];
    return this.get(newest.batchId);
  }

  // -- Regression tracking --

  /**
   * Compare two batches and produce a regression report.
   * Matches fixtures by fixtureId — only fixtures present in both are compared.
   */
  async compare(
    baselineId: string,
    candidateId: string
  ): Promise<RegressionReport | null> {
    const baseline = await this.get(baselineId);
    const candidate = await this.get(candidateId);
    if (!baseline || !candidate) return null;

    const baseMap = new Map<string, RunResult>();
    for (const r of baseline.result.runs) {
      baseMap.set(r.run.fixtureId, r);
    }

    const improved: string[] = [];
    const regressed: string[] = [];
    const unchanged: string[] = [];
    const NOISE_THRESHOLD = 3; // points

    for (const r of candidate.result.runs) {
      const base = baseMap.get(r.run.fixtureId);
      if (!base) continue;

      const delta = r.run.composite - base.run.composite;
      if (delta > NOISE_THRESHOLD) {
        improved.push(r.run.fixtureId);
      } else if (delta < -NOISE_THRESHOLD) {
        regressed.push(r.run.fixtureId);
      } else {
        unchanged.push(r.run.fixtureId);
      }
    }

    const bSum = baseline.result.summary;
    const cSum = candidate.result.summary;

    const delta = {
      composite: cSum.averageComposite - bSum.averageComposite,
      completion: cSum.averageScores.completion - bSum.averageScores.completion,
      correctness:
        cSum.averageScores.correctness - bSum.averageScores.correctness,
      craft: cSum.averageScores.craft - bSum.averageScores.craft,
      efficiency: cSum.averageScores.efficiency - bSum.averageScores.efficiency,
      precision: cSum.averageScores.precision - bSum.averageScores.precision,
    };

    const verdict =
      Math.abs(delta.composite) < 2
        ? "neutral"
        : delta.composite > 0
          ? "improved"
          : "regressed";

    return {
      baselineId,
      candidateId,
      baselineLabel: baseline.label,
      candidateLabel: candidate.label,
      delta,
      improved,
      regressed,
      unchanged,
      verdict,
    };
  }

  // -- Trend analysis --

  /**
   * Compute score trends over stored batches.
   * Returns one trend per rubric showing direction and slope.
   */
  async trends(
    opts: { label?: string; limit?: number } = {}
  ): Promise<ScoreTrend[]> {
    if (!this._loaded) await this.load();

    let filtered = opts.label
      ? this._index.filter((b) => b.label === opts.label)
      : [...this._index];
    filtered.sort((a, b) => a.timestamp - b.timestamp);
    if (opts.limit) filtered = filtered.slice(-opts.limit);

    if (filtered.length < 2) return [];

    // Load all batches
    const batches: StoredBatch[] = [];
    for (const entry of filtered) {
      const batch = await this.get(entry.batchId);
      if (batch) batches.push(batch);
    }

    const rubrics: Array<keyof RubricScores | "composite"> = [
      "composite",
      "completion",
      "correctness",
      "craft",
      "efficiency",
      "precision",
    ];

    return rubrics.map((rubric) => {
      const points = batches.map((b) => ({
        batchId: b.batchId,
        label: b.label,
        timestamp: b.timestamp,
        value:
          rubric === "composite"
            ? b.result.summary.averageComposite
            : b.result.summary.averageScores[rubric],
      }));

      const slope = linearSlope(points.map((p) => p.value));
      const direction: ScoreTrend["direction"] =
        Math.abs(slope) < 0.5
          ? "stable"
          : slope > 0
            ? "improving"
            : "declining";

      return { rubric, points, direction, slope };
    });
  }

  // -- Gap aggregation --

  /**
   * Aggregate context gaps across all (or recent) batches.
   * Returns gaps sorted by frequency — most common first.
   */
  async aggregateGaps(
    opts: { limit?: number } = {}
  ): Promise<AggregatedGap[]> {
    if (!this._loaded) await this.load();

    let entries = [...this._index].sort(
      (a, b) => b.timestamp - a.timestamp
    );
    if (opts.limit) entries = entries.slice(0, opts.limit);

    const gapCounts = new Map<string, { gap: ContextGap; count: number; batches: string[] }>();

    for (const entry of entries) {
      const batch = await this.get(entry.batchId);
      if (!batch) continue;

      for (const run of batch.result.runs) {
        if (!run.diagnosis) continue;
        for (const gap of run.diagnosis.contextGaps) {
          const key = `${gap.layerId}:${gap.missing}`;
          const existing = gapCounts.get(key);
          if (existing) {
            existing.count++;
            if (!existing.batches.includes(entry.batchId)) {
              existing.batches.push(entry.batchId);
            }
          } else {
            gapCounts.set(key, {
              gap,
              count: 1,
              batches: [entry.batchId],
            });
          }
        }
      }
    }

    return [...gapCounts.values()]
      .sort((a, b) => b.count - a.count)
      .map((g) => ({
        gap: g.gap,
        occurrences: g.count,
        acrossBatches: g.batches.length,
      }));
  }

  /**
   * Aggregate suggestions across batches.
   * Returns suggestions sorted by frequency and confidence.
   */
  async aggregateSuggestions(
    opts: { limit?: number } = {}
  ): Promise<AggregatedSuggestion[]> {
    if (!this._loaded) await this.load();

    let entries = [...this._index].sort(
      (a, b) => b.timestamp - a.timestamp
    );
    if (opts.limit) entries = entries.slice(0, opts.limit);

    const suggCounts = new Map<
      string,
      { suggestion: CorpusSuggestion; count: number; avgConfidence: number }
    >();

    for (const entry of entries) {
      const batch = await this.get(entry.batchId);
      if (!batch) continue;

      for (const run of batch.result.runs) {
        if (!run.diagnosis) continue;
        for (const sugg of run.diagnosis.suggestions) {
          const key = `${sugg.kind}:${sugg.layerId}:${sugg.content.slice(0, 80)}`;
          const existing = suggCounts.get(key);
          if (existing) {
            existing.count++;
            existing.avgConfidence =
              (existing.avgConfidence * (existing.count - 1) + sugg.confidence) /
              existing.count;
          } else {
            suggCounts.set(key, {
              suggestion: sugg,
              count: 1,
              avgConfidence: sugg.confidence,
            });
          }
        }
      }
    }

    return [...suggCounts.values()]
      .sort((a, b) => b.count * b.avgConfidence - a.count * a.avgConfidence)
      .map((s) => ({
        suggestion: s.suggestion,
        occurrences: s.count,
        averageConfidence: Math.round(s.avgConfidence * 100) / 100,
      }));
  }

  // -- Internal --

  private async _writeIndex(): Promise<void> {
    const indexPath = join(this.dir, "index.json");
    await Bun.write(indexPath, JSON.stringify(this._index, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

interface BatchIndex {
  batchId: string;
  timestamp: number;
  label: string;
  contextVersion?: string;
  fixtureCount: number;
  composite: number;
}

export interface AggregatedGap {
  readonly gap: ContextGap;
  readonly occurrences: number;
  readonly acrossBatches: number;
}

export interface AggregatedSuggestion {
  readonly suggestion: CorpusSuggestion;
  readonly occurrences: number;
  readonly averageConfidence: number;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Simple linear regression slope over a series of values. */
function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}
