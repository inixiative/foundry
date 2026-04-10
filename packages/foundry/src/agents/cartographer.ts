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
  /** Confidence in the routing decision (0-1). */
  confidence: number;
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

  constructor(config: CartographerConfig) {
    this._stack = config.stack;
    this._signals = config.signals;
    this._llm = config.llm;
    this._llmOpts = config.llmOpts ?? { maxTokens: 256, temperature: 0 };
    this._domainMap = config.domainMap ?? {};
    this._map = { entries: [], lastBuilt: 0, mapTokens: 0 };

    this._routePrompt = config.routePrompt ??
      `You are a context router. Given a message and a topology map of available context, decide which layers the message needs. Route precisely — load what's needed, skip what isn't. Respond with JSON: { "layers": string[], "domains": string[], "confidence": number }`;

    // Create the map layer — always warm, holds the serialized topology map
    this._mapLayer = new ContextLayer({
      id: "__topology-map",
      trust: 0.9,
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

    // Write to the map layer
    this._mapLayer.set(JSON.stringify(this._map.entries, null, 2));

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

    const messages: LLMMessage[] = [
      { role: "system", content: this._routePrompt },
      {
        role: "user",
        content: [
          "## Available context (topology map)",
          mapContent,
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

    for (const entry of this._map.entries) {
      // Check if any keyword from the domain name appears in the message
      const domainWords = entry.domain.toLowerCase().split(/[-_\s]+/);
      const hit = domainWords.some((w) => w.length > 2 && lower.includes(w));
      if (hit) {
        matched.push(...entry.layers);
        domains.push(entry.domain);
      }
    }

    return {
      layers: matched,
      domains,
      confidence: matched.length > 0 ? 0.3 : 0,
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
