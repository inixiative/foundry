import { ContextLayer, computeHash } from "./context-layer";
import { ContextStack } from "./context-stack";
import type { SignalBus, Signal, SignalKind } from "./signal";
import type { CompactionStrategy } from "./compaction";
import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A raw signal/interaction captured from agent sessions. */
export interface FluidEntry {
  id: string;
  kind: SignalKind;
  source: string;
  content: string;
  timestamp: number;
  refs?: Array<{ system: string; locator: string }>;
  confidence?: number;
}

/** A structured document derived from fluid entries. */
export interface FormalDoc {
  id: string;
  title: string;
  kind: "convention" | "adr" | "skill" | "security" | "taste" | "reference";
  content: string;
  sources: string[];
  version: number;
  state: DocState;
  trust: number;
  tier?: CorpusTier;
  createdAt: number;
  updatedAt: number;
}

export type DocState =
  | "draft"
  | "development"
  | "active"
  | "deprecated"
  | "archived";

/** The final compiled corpus — immutable snapshot. */
export interface CompiledCorpus {
  id: string;
  version: string;
  contentHash: string;
  layers: Array<{
    id: string;
    content: string;
    tokens: number;
    trust: number;
    sources: string[];
  }>;
  totalTokens: number;
  compiledAt: number;
  attribution: Array<{
    layerId: string;
    docs: string[];
    entries: string[];
  }>;
}

/** Tier classification for corpus promotion. */
export type CorpusTier =
  | "personal_private"
  | "personal_public"
  | "team"
  | "org";

export interface CorpusCompilerConfig {
  /** Max tokens for compiled output. Default 50000. */
  maxTokens?: number;
  /** Compaction strategy for over-budget compilation. */
  compactionStrategy?: CompactionStrategy;
  /** Minimum trust for a doc to be included in compilation. Default 20. */
  minTrust?: number;
  /** Minimum confidence for fluid entries to be promoted. Default 0.5. */
  minConfidence?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

let _nextId = 0;
function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(++_nextId).toString(36)}`;
}

// ---------------------------------------------------------------------------
// CorpusCompiler
// ---------------------------------------------------------------------------

/**
 * Three-stage corpus pipeline:
 *
 * 1. Fluid Memory  — raw signals, corrections, interactions
 * 2. Formal Docs   — structured conventions, ADRs, skills
 * 3. Compiled Corpus — optimized, deduplicated, token-efficient snapshot
 *
 * Each stage refines and compresses knowledge, building attribution
 * traces so you can always trace a compiled convention back to the
 * raw interactions that created it.
 */
export class CorpusCompiler {
  private _fluid: FluidEntry[] = [];
  private _docs: Map<string, FormalDoc> = new Map();
  private _maxTokens: number;
  private _compactionStrategy: CompactionStrategy | undefined;
  private _minTrust: number;
  private _minConfidence: number;
  private _compilationCount = 0;

  constructor(config?: CorpusCompilerConfig) {
    this._maxTokens = config?.maxTokens ?? 50_000;
    this._compactionStrategy = config?.compactionStrategy;
    this._minTrust = config?.minTrust ?? 20;
    this._minConfidence = config?.minConfidence ?? 0.5;
  }

  // -----------------------------------------------------------------------
  // Stage 1: Fluid — capture raw signals
  // -----------------------------------------------------------------------

  /** Ingest a raw fluid entry. Deduplicates by content similarity. */
  ingest(entry: FluidEntry): void {
    // Simple dedup: skip if identical content already exists from same source
    const isDupe = this._fluid.some(
      (e) => e.content === entry.content && e.source === entry.source
    );
    if (!isDupe) {
      this._fluid.push(entry);
    }
  }

  /** Auto-capture signals from a SignalBus. Returns unsubscribe function. */
  ingestFromSignalBus(signals: SignalBus): () => void {
    return signals.onAny((signal: Signal) => {
      this.ingest({
        id: signal.id,
        kind: signal.kind,
        source: signal.source,
        content:
          typeof signal.content === "string"
            ? signal.content
            : JSON.stringify(signal.content),
        timestamp: signal.timestamp,
        refs: signal.refs,
        confidence: signal.confidence,
      });
    });
  }

  get fluidEntries(): ReadonlyArray<FluidEntry> {
    return this._fluid;
  }

  // -----------------------------------------------------------------------
  // Stage 2: Fluid → Formal
  // -----------------------------------------------------------------------

  /** Promote fluid entries to a formal document. */
  promote(
    entryIds: string[],
    doc: Omit<
      FormalDoc,
      "id" | "version" | "sources" | "createdAt" | "updatedAt"
    >
  ): FormalDoc {
    const now = Date.now();
    const formalDoc: FormalDoc = {
      ...doc,
      id: generateId("doc"),
      version: 1,
      sources: entryIds,
      createdAt: now,
      updatedAt: now,
    };

    this._docs.set(formalDoc.id, formalDoc);
    return formalDoc;
  }

  /**
   * Auto-promote: group fluid entries by kind, create docs for clusters
   * above a threshold count. Returns newly created docs.
   */
  autoPromote(opts?: {
    minEntries?: number;
    minConfidence?: number;
  }): FormalDoc[] {
    const minEntries = opts?.minEntries ?? 3;
    const minConfidence = opts?.minConfidence ?? this._minConfidence;

    // Group by kind
    const groups = new Map<string, FluidEntry[]>();
    for (const entry of this._fluid) {
      if (entry.confidence !== undefined && entry.confidence < minConfidence) {
        continue;
      }
      const group = groups.get(entry.kind) ?? [];
      group.push(entry);
      groups.set(entry.kind, group);
    }

    const created: FormalDoc[] = [];

    for (const [kind, entries] of groups) {
      if (entries.length < minEntries) continue;

      // Merge content, deduplicating identical lines
      const lines = new Set<string>();
      for (const e of entries) {
        for (const line of e.content.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) lines.add(trimmed);
        }
      }

      const avgConfidence =
        entries.reduce((sum, e) => sum + (e.confidence ?? 0.5), 0) /
        entries.length;

      const docKind = this._mapSignalKindToDocKind(kind);

      const doc = this.promote(
        entries.map((e) => e.id),
        {
          title: `Auto-promoted ${kind} conventions`,
          kind: docKind,
          content: [...lines].join("\n"),
          state: "draft",
          trust: Math.round(avgConfidence * 100),
        }
      );

      created.push(doc);
    }

    return created;
  }

  /** Update a formal doc's state. */
  transition(docId: string, newState: DocState): FormalDoc | undefined {
    const doc = this._docs.get(docId);
    if (!doc) return undefined;

    doc.state = newState;
    doc.updatedAt = Date.now();
    return doc;
  }

  get formalDocs(): ReadonlyArray<FormalDoc> {
    return [...this._docs.values()];
  }

  docsByState(state: DocState): FormalDoc[] {
    return [...this._docs.values()].filter((d) => d.state === state);
  }

  docsByKind(kind: FormalDoc["kind"]): FormalDoc[] {
    return [...this._docs.values()].filter((d) => d.kind === kind);
  }

  // -----------------------------------------------------------------------
  // Stage 3: Formal → Compiled
  // -----------------------------------------------------------------------

  /** Compile active formal docs into an immutable corpus snapshot. */
  compile(tier?: CorpusTier): CompiledCorpus {
    this._compilationCount++;

    // Filter docs: active state + trust threshold + optional tier
    let eligible = [...this._docs.values()].filter(
      (d) => d.state === "active" && d.trust >= this._minTrust
    );

    if (tier) {
      eligible = eligible.filter(
        (d) => !d.tier || this._tierRank(d.tier) <= this._tierRank(tier)
      );
    }

    // Sort by trust descending
    eligible.sort((a, b) => b.trust - a.trust);

    // Build layers
    const layers: CompiledCorpus["layers"] = [];
    let totalTokens = 0;

    for (const doc of eligible) {
      const tokens = estimateTokens(doc.content);

      if (totalTokens + tokens > this._maxTokens) {
        // If we have a compaction strategy, compact the content to fit
        if (this._compactionStrategy) {
          const remaining = this._maxTokens - totalTokens;
          if (remaining > 0) {
            // Truncate to fit remaining budget
            const truncated = doc.content.slice(0, remaining * 4);
            const truncTokens = estimateTokens(truncated);
            layers.push({
              id: `layer_${doc.id}`,
              content: truncated,
              tokens: truncTokens,
              trust: doc.trust,
              sources: [doc.id],
            });
            totalTokens += truncTokens;
          }
        }
        // Stop adding more layers — over budget
        break;
      }

      layers.push({
        id: `layer_${doc.id}`,
        content: doc.content,
        tokens,
        trust: doc.trust,
        sources: [doc.id],
      });
      totalTokens += tokens;
    }

    // Build attribution trace
    const attribution: CompiledCorpus["attribution"] = layers.map((layer) => {
      const docIds = layer.sources;
      const entryIds: string[] = [];
      for (const docId of docIds) {
        const doc = this._docs.get(docId);
        if (doc) entryIds.push(...doc.sources);
      }
      return {
        layerId: layer.id,
        docs: docIds,
        entries: entryIds,
      };
    });

    // Compute content hash
    const allContent = layers.map((l) => l.content).join("\n\n");
    const contentHash = computeHash(allContent);

    return {
      id: generateId("corpus"),
      version: `${this._compilationCount}.0`,
      contentHash,
      layers,
      totalTokens,
      compiledAt: Date.now(),
      attribution,
    };
  }

  /** Load a compiled corpus into a ContextStack. */
  loadIntoStack(corpus: CompiledCorpus, stack: ContextStack): void {
    for (const layer of corpus.layers) {
      const contextLayer = new ContextLayer({
        id: layer.id,
        trust: layer.trust,
      });
      contextLayer.set(layer.content);
      stack.addLayer(contextLayer);
    }
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  async save(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });

    const data = {
      fluid: this._fluid,
      docs: [...this._docs.entries()],
      compilationCount: this._compilationCount,
    };

    await writeFile(join(dir, "corpus.json"), JSON.stringify(data, null, 2));
  }

  async load(dir: string): Promise<void> {
    const raw = await readFile(join(dir, "corpus.json"), "utf-8");
    const data = JSON.parse(raw);

    this._fluid = data.fluid ?? [];
    this._docs = new Map(data.docs ?? []);
    this._compilationCount = data.compilationCount ?? 0;
  }

  // -----------------------------------------------------------------------
  // Tier promotion
  // -----------------------------------------------------------------------

  /** Check if a doc meets promotion criteria for the target tier. */
  canPromoteTier(docId: string, targetTier: CorpusTier): boolean {
    const doc = this._docs.get(docId);
    if (!doc) return false;
    if (doc.state !== "active") return false;

    switch (targetTier) {
      case "personal_public":
        return doc.trust >= 30;
      case "team":
        return doc.trust >= 50 && doc.sources.length >= 5;
      case "org":
        return doc.trust >= 70 && doc.sources.length >= 10;
      case "personal_private":
        return true; // Base tier, always allowed
    }
  }

  /** Promote a doc to the target tier if it meets criteria. */
  promoteTier(docId: string, targetTier: CorpusTier): FormalDoc | undefined {
    if (!this.canPromoteTier(docId, targetTier)) return undefined;

    const doc = this._docs.get(docId);
    if (!doc) return undefined;

    doc.tier = targetTier;
    doc.updatedAt = Date.now();
    return doc;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private _mapSignalKindToDocKind(
    kind: string
  ): FormalDoc["kind"] {
    switch (kind) {
      case "convention":
        return "convention";
      case "adr":
        return "adr";
      case "security":
        return "security";
      case "taste":
        return "taste";
      default:
        return "reference";
    }
  }

  private _tierRank(tier: CorpusTier): number {
    switch (tier) {
      case "personal_private":
        return 0;
      case "personal_public":
        return 1;
      case "team":
        return 2;
      case "org":
        return 3;
    }
  }
}
