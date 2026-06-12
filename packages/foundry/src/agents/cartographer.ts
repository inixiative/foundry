// ---------------------------------------------------------------------------
// Cartographer — context routing role (FLOW.md)
//
// Reads everything. Owns the topology map. Routes context slices to the
// session. Never modifies — only reads and routes. Sees the whole project
// so individual agents don't have to.
//
// The topology map is a compact (~500 token) index of what context exists:
//   { domain → layer IDs, approximate size, staleness }
//
// On incoming message: takes the message + compact map + thread-state,
// makes a fast LLM call to decide which layers to hydrate.
//
// On MCP query: same routing logic, triggered by the session mid-work.
//
// On signal (file changes, map rebuilds): rebuilds affected map sections.
// ---------------------------------------------------------------------------

import {
  ContextLayer,
  type ContextStack,
  type Signal,
  type SignalBus,
  type LLMProvider,
  type LLMMessage,
  type CompletionOpts,
} from "@inixiative/foundry-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One entry in the topology map — a domain's available context. */
export interface MapEntry {
  /** Domain name (e.g., "auth", "testing", "security"). */
  domain: string;
  /** Layer IDs available in this domain. */
  layers: string[];
  /** Approximate total token size of all layers in this domain. */
  approxTokens: number;
  /** Human-readable staleness (e.g., "2h ago", "1d ago"). */
  staleness: string;
  /** Optional one-line description of what this domain covers. */
  description?: string;
}

/** The full topology map. */
export interface TopologyMap {
  entries: MapEntry[];
  /** When the map was last built/rebuilt. */
  lastBuilt: number;
  /** Approximate token size of the serialized map itself. */
  mapTokens: number;
}

/** Routing result — which layers the message needs. */
export interface RouteResult {
  /** Layer IDs to hydrate and inject. */
  layers: string[];
  /** Domains the message touches (for domain librarian advise gating). */
  domains: string[];
  /** Atlas concepts the message touches (e.g. "feature:auth"), when an atlas index is loaded. */
  concepts?: string[];
  /** Confidence in the routing decision (0-1). */
  confidence: number;
}

/**
 * The shape of `atlas graph --json` (see @inixiative/atlas src/commands/graph.ts).
 * Only the fields the Cartographer consumes.
 */
export interface AtlasGraph {
  conceptToFiles: Record<string, string[]>;
  usesConsumers: Record<string, string[]>;
}

/** Compact per-concept entry kept in the topology map. */
export interface AtlasConceptEntry {
  /** Concept id, e.g. "feature:auth" or "infrastructure:redis". */
  id: string;
  /** Number of files declaring @partOf this concept. */
  files: number;
  /** Number of files declaring @uses this concept. */
  consumers: number;
}

/** The loaded atlas index. */
export interface AtlasIndex {
  concepts: AtlasConceptEntry[];
  /** Where the index came from: the atlas CLI or a MAP.md fallback. */
  source: "graph" | "map-md";
  loadedAt: number;
}

/** Configuration for the Cartographer. */
export interface CartographerConfig {
  /** The thread's context stack (to read all layers). */
  stack: ContextStack;
  /** Signal bus to listen for map-rebuild triggers. */
  signals: SignalBus;
  /** Fast LLM for routing decisions. */
  llm: LLMProvider;
  /** LLM options (should use cheap/fast model). */
  llmOpts?: CompletionOpts;
  /**
   * Domain groupings — maps domain names to layer ID patterns.
   * If not provided, the Cartographer infers domains from layer IDs.
   */
  domainMap?: Record<string, string[]>;
  /** Custom system prompt for routing decisions. */
  routePrompt?: string;
  /**
   * Repo root of an atlas-mapped project (has `.atlas/` and/or `MAP.md`).
   * When set, `loadAtlas()` pulls the concept graph into the topology map so
   * routing can reason in codebase concepts, not just layer names.
   */
  atlasRoot?: string;
}

// ---------------------------------------------------------------------------
// Cartographer
// ---------------------------------------------------------------------------

export class Cartographer {
  private _stack: ContextStack;
  private _signals: SignalBus;
  private _llm: LLMProvider;
  private _llmOpts: CompletionOpts;
  private _domainMap: Record<string, string[]>;
  private _routePrompt: string;
  private _map: TopologyMap;
  private _mapLayer: ContextLayer;
  private _unsubscribe: (() => void) | null = null;
  private _atlasRoot: string | undefined;
  private _atlas: AtlasIndex | null = null;

  constructor(config: CartographerConfig) {
    this._stack = config.stack;
    this._signals = config.signals;
    this._llm = config.llm;
    this._llmOpts = config.llmOpts ?? { maxTokens: 256, temperature: 0 };
    this._domainMap = config.domainMap ?? {};
    this._atlasRoot = config.atlasRoot;
    this._map = { entries: [], lastBuilt: 0, mapTokens: 0 };

    this._routePrompt = config.routePrompt ??
      `You are a context router. Given a message, a topology map of available context, and (when present) the codebase concept map, decide which layers the message needs. Concepts (e.g. "feature:auth") tell you which part of the codebase a message touches — use them to pick the matching domains and layers. Route precisely — load what's needed, skip what isn't. Respond with JSON: { "layers": string[], "domains": string[], "concepts": string[], "confidence": number }`;

    // Create the map layer — always warm, holds the serialized topology map
    this._mapLayer = new ContextLayer({
      id: "__topology-map",
      prompt: "Topology map of all available context. Used by the Cartographer for routing decisions.",
    });

    // Subscribe to signals that trigger map rebuilds
    this._unsubscribe = this._signals.onAny((signal) => {
      if (this._shouldRebuild(signal)) {
        this.buildMap();
      }
    });
  }

  /** The current topology map. */
  get map(): Readonly<TopologyMap> {
    return this._map;
  }

  /** The topology map as a context layer. */
  get mapLayer(): ContextLayer {
    return this._mapLayer;
  }

  /** The loaded atlas concept index, if any. */
  get atlas(): Readonly<AtlasIndex> | null {
    return this._atlas;
  }

  // -----------------------------------------------------------------------
  // Atlas — codebase concept map (from @inixiative/atlas annotations)
  // -----------------------------------------------------------------------

  /**
   * Load the repo's atlas concept graph into the topology map.
   *
   * Tries `bunx atlas graph --json` in the configured root; falls back to the
   * committed MAP.md when the CLI isn't installed. Both failing is fine —
   * the Cartographer simply stays layer-only. Re-run on demand (e.g. from a
   * map-rebuild signal) to pick up annotation changes.
   */
  async loadAtlas(root?: string): Promise<AtlasIndex | null> {
    const atlasRoot = root ?? this._atlasRoot;
    if (!atlasRoot) return null;

    const fromGraph = await this._loadAtlasGraph(atlasRoot);
    this._atlas = fromGraph ?? (await this._loadAtlasMapMd(atlasRoot));

    // Refresh the map layer so routing sees the concepts immediately
    if (this._atlas) this.buildMap();
    return this._atlas;
  }

  private async _loadAtlasGraph(root: string): Promise<AtlasIndex | null> {
    try {
      // --no-install: only use the repo's own atlas devDep — never fall back
      // to npm, where "atlas" is an unrelated package.
      const proc = Bun.spawn(["bunx", "--no-install", "atlas", "graph", "--json"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      if ((await proc.exited) !== 0) return null;

      const graph = JSON.parse(stdout) as AtlasGraph;
      const ids = new Set([
        ...Object.keys(graph.conceptToFiles ?? {}),
        ...Object.keys(graph.usesConsumers ?? {}),
      ]);
      const concepts = [...ids].sort().map((id) => ({
        id,
        files: graph.conceptToFiles?.[id]?.length ?? 0,
        consumers: graph.usesConsumers?.[id]?.length ?? 0,
      }));
      if (concepts.length === 0) return null;

      return { concepts, source: "graph", loadedAt: Date.now() };
    } catch {
      return null;
    }
  }

  /** Fallback: pull concept ids out of a committed MAP.md (class:name tokens). */
  private async _loadAtlasMapMd(root: string): Promise<AtlasIndex | null> {
    try {
      const file = Bun.file(`${root.replace(/\/$/, "")}/MAP.md`);
      if (!(await file.exists())) return null;
      const text = await file.text();

      const ids = new Set<string>();
      for (const match of text.matchAll(/\b([a-z][a-z0-9_-]*):([a-z][a-zA-Z0-9_-]*)\b/g)) {
        ids.add(`${match[1]}:${match[2]}`);
      }
      if (ids.size === 0) return null;

      const concepts = [...ids].sort().map((id) => ({ id, files: 0, consumers: 0 }));
      return { concepts, source: "map-md", loadedAt: Date.now() };
    } catch {
      return null;
    }
  }

  /** Compact serialization of the atlas index for prompts and the map layer. */
  private _atlasSection(): string | null {
    if (!this._atlas) return null;
    const lines = this._atlas.concepts.map((c) =>
      c.files || c.consumers
        ? `${c.id} (${c.files} files, ${c.consumers} consumers)`
        : c.id
    );
    return lines.join("\n");
  }

  // -----------------------------------------------------------------------
  // Map building — creates the compact index from the stack's layers
  // -----------------------------------------------------------------------

  /**
   * Build (or rebuild) the topology map from the current stack state.
   * Groups layers by domain and computes approximate sizes.
   */
  buildMap(): TopologyMap {
    const layers = this._stack.layers;
    const domainGroups = new Map<string, { layers: string[]; totalTokens: number; oldestWarm: number | null }>();

    for (const layer of layers) {
      // Skip the Librarian's thread-state layer (not routable context)
      if (layer.id === "thread-state") continue;

      const domain = this._inferDomain(layer.id);
      if (!domainGroups.has(domain)) {
        domainGroups.set(domain, { layers: [], totalTokens: 0, oldestWarm: null });
      }
      const group = domainGroups.get(domain)!;
      group.layers.push(layer.id);
      // Rough estimate: 4 chars ≈ 1 token
      group.totalTokens += Math.ceil(layer.content.length / 4);

      const warmedAt = layer.lastWarmed;
      if (warmedAt && (!group.oldestWarm || warmedAt < group.oldestWarm)) {
        group.oldestWarm = warmedAt;
      }
    }

    const now = Date.now();
    const entries: MapEntry[] = [];

    for (const [domain, group] of domainGroups) {
      entries.push({
        domain,
        layers: group.layers,
        approxTokens: group.totalTokens,
        staleness: group.oldestWarm ? formatAge(now - group.oldestWarm) : "unknown",
      });
    }

    this._map = {
      entries,
      lastBuilt: now,
      mapTokens: Math.ceil(JSON.stringify(entries).length / 4),
    };

    // Write to the map layer — layer topology plus the codebase concept map
    const atlasSection = this._atlasSection();
    this._mapLayer.set(
      atlasSection
        ? `${JSON.stringify(this._map.entries, null, 2)}\n\n## Codebase concepts (atlas)\n${atlasSection}`
        : JSON.stringify(this._map.entries, null, 2)
    );

    return this._map;
  }

  // -----------------------------------------------------------------------
  // Context routing — the core LLM-backed routing decision
  // -----------------------------------------------------------------------

  /**
   * Route a message: decide which layers it needs from the topology map.
   * This is the fast LLM call from FLOW.md step 1.
   */
  async route(message: string, threadState?: string): Promise<RouteResult> {
    // If map is empty, build it first
    if (this._map.entries.length === 0) {
      this.buildMap();
    }

    // If still empty after build, nothing to route
    if (this._map.entries.length === 0) {
      return { layers: [], domains: [], confidence: 0 };
    }

    const mapContent = JSON.stringify(this._map.entries, null, 2);
    const atlasSection = this._atlasSection();

    const messages: LLMMessage[] = [
      { role: "system", content: this._routePrompt },
      {
        role: "user",
        content: [
          "## Available context (topology map)",
          mapContent,
          atlasSection ? `\n## Codebase concepts (atlas)\n${atlasSection}` : "",
          threadState ? `\n## Current thread state\n${threadState}` : "",
          `\n## Message to route\n${message}`,
          `\nWhich layers does this message need? Respond with JSON only.`,
        ].join("\n"),
      },
    ];

    try {
      const result = await this._llm.complete(messages, this._llmOpts);
      const parsed = parseJSON<RouteResult>(result.content);
      return {
        layers: parsed.layers ?? [],
        domains: parsed.domains ?? [],
        concepts: parsed.concepts ?? [],
        confidence: parsed.confidence ?? 0.5,
      };
    } catch {
      // LLM failure → fall back to keyword matching against map
      return this._keywordFallback(message);
    }
  }

  // -----------------------------------------------------------------------
  // Keyword fallback — when the LLM is unavailable
  // -----------------------------------------------------------------------

  private _keywordFallback(message: string): RouteResult {
    const lower = message.toLowerCase();
    const matched: string[] = [];
    const domains: string[] = [];
    const concepts: string[] = [];

    for (const entry of this._map.entries) {
      // Check if any keyword from the domain name appears in the message
      const domainWords = entry.domain.toLowerCase().split(/[-_\s]+/);
      const hit = domainWords.some((w) => w.length > 2 && lower.includes(w));
      if (hit) {
        matched.push(...entry.layers);
        domains.push(entry.domain);
      }
    }

    // Match concept names: "feature:auth" hits on "auth"
    if (this._atlas) {
      for (const concept of this._atlas.concepts) {
        const name = concept.id.split(":").pop() ?? concept.id;
        const words = name.toLowerCase().split(/[-_\s]+/);
        if (words.some((w) => w.length > 2 && lower.includes(w))) {
          concepts.push(concept.id);
        }
      }
    }

    return {
      layers: matched,
      domains,
      concepts,
      confidence: matched.length > 0 || concepts.length > 0 ? 0.3 : 0,
    };
  }

  // -----------------------------------------------------------------------
  // Domain inference
  // -----------------------------------------------------------------------

  private _inferDomain(layerId: string): string {
    // Check explicit domain map first
    for (const [domain, patterns] of Object.entries(this._domainMap)) {
      if (patterns.some((p) => layerId.includes(p))) {
        return domain;
      }
    }
    // Infer from layer ID: "auth-conventions" → "auth", "security-patterns" → "security"
    const parts = layerId.split("-");
    return parts[0] || "general";
  }

  // -----------------------------------------------------------------------
  // Signal handling — rebuild triggers
  // -----------------------------------------------------------------------

  private _shouldRebuild(signal: Signal): boolean {
    // Rebuild map when layers change
    return (
      signal.kind === "context_loaded" ||
      signal.kind === "context_evicted" ||
      signal.kind === "architecture_observation"
    );
  }

  /** Stop listening to signals. */
  dispose(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function parseJSON<T>(text: string): T {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (match) return JSON.parse(match[1]);
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) return JSON.parse(braceMatch[0]);
    throw new Error(`Could not parse JSON from LLM response: ${text.slice(0, 200)}`);
  }
}
