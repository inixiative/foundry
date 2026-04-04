import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Harness } from "../agents/harness";
import type { LLMProvider } from "../providers/types";

// ---------------------------------------------------------------------------
// Settings config model — serializable representation of system configuration
// ---------------------------------------------------------------------------

/**
 * The full settings config. Serialized to disk as JSON.
 * Everything the UI can configure lives here.
 */
export interface FoundryConfig {
  /** Global defaults. */
  defaults: {
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
  };

  /** Provider configurations (keyed by provider ID). */
  providers: Record<string, ProviderConfig>;

  /** Agent configurations (keyed by agent ID). */
  agents: Record<string, AgentSettingsConfig>;

  /** Layer configurations (keyed by layer ID). */
  layers: Record<string, LayerSettingsConfig>;

  /** Data source configurations (keyed by source ID). */
  sources: Record<string, DataSourceConfig>;
}

export interface ProviderConfig {
  id: string;
  type: "anthropic" | "openai" | "gemini" | "custom";
  /** Display label. */
  label: string;
  /** Available models for this provider. */
  models: ModelConfig[];
  /** Base URL override (e.g. for Cursor, Ollama, Azure). */
  baseUrl?: string;
  /** Whether this provider is enabled. */
  enabled: boolean;
}

export interface ModelConfig {
  id: string;
  label: string;
  /** Suggested use: "fast" for middleware, "standard" for general, "powerful" for execution. */
  tier: "fast" | "standard" | "powerful";
  /** Cost tier for display. */
  costTier?: "low" | "medium" | "high";
  /** Context window size. */
  contextWindow?: number;
}

export interface AgentSettingsConfig {
  id: string;
  /** What kind of agent: executor, classifier, router, decider. */
  kind: string;
  /** System prompt for this agent. */
  prompt: string;
  /** LLM settings. */
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** Which layers this agent can see (empty = all). */
  visibleLayers: string[];
  /** Peer agent IDs for delegation. */
  peers: string[];
  /** Max call-chain depth. */
  maxDepth: number;
  /** Whether this agent is active. */
  enabled: boolean;
}

export interface LayerSettingsConfig {
  id: string;
  /** Instruction prompt for this layer. */
  prompt: string;
  /** Data source IDs that feed this layer. */
  sourceIds: string[];
  /** Trust score (0-1). */
  trust: number;
  /** Staleness threshold in ms (0 = never stale). */
  staleness: number;
  /** Max token budget for this layer. */
  maxTokens: number;
  /** Whether this layer is enabled. */
  enabled: boolean;
}

export interface DataSourceConfig {
  id: string;
  type: "file" | "sqlite" | "postgres" | "redis" | "http" | "markdown" | "inline";
  label: string;
  /** Connection string, file path, URL — depends on type. */
  uri: string;
  /** Whether this source is enabled. */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Default config with sensible starting values
// ---------------------------------------------------------------------------

export function defaultConfig(): FoundryConfig {
  return {
    defaults: {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      temperature: 0,
      maxTokens: 4096,
    },
    providers: {
      anthropic: {
        id: "anthropic",
        type: "anthropic",
        label: "Anthropic",
        models: [
          { id: "claude-opus-4-20250514", label: "Opus 4", tier: "powerful", costTier: "high", contextWindow: 200000 },
          { id: "claude-sonnet-4-20250514", label: "Sonnet 4", tier: "standard", costTier: "medium", contextWindow: 200000 },
          { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", tier: "fast", costTier: "low", contextWindow: 200000 },
        ],
        enabled: true,
      },
      openai: {
        id: "openai",
        type: "openai",
        label: "OpenAI",
        models: [
          { id: "gpt-4o", label: "GPT-4o", tier: "powerful", costTier: "high", contextWindow: 128000 },
          { id: "gpt-4o-mini", label: "GPT-4o Mini", tier: "fast", costTier: "low", contextWindow: 128000 },
          { id: "o3", label: "o3", tier: "powerful", costTier: "high", contextWindow: 200000 },
        ],
        enabled: true,
      },
      gemini: {
        id: "gemini",
        type: "gemini",
        label: "Google Gemini",
        models: [
          { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", tier: "powerful", costTier: "high", contextWindow: 1000000 },
          { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "fast", costTier: "low", contextWindow: 1000000 },
        ],
        enabled: true,
      },
    },
    agents: {},
    layers: {},
    sources: {},
  };
}

// ---------------------------------------------------------------------------
// ConfigStore — persists settings to disk
// ---------------------------------------------------------------------------

export class ConfigStore {
  private _dir: string;
  private _config: FoundryConfig;
  private _loaded = false;

  constructor(dir: string) {
    this._dir = resolve(dir);
    if (!existsSync(this._dir)) {
      mkdirSync(this._dir, { recursive: true });
    }
    this._config = defaultConfig();
  }

  /** Load config from disk, merging with defaults. */
  async load(): Promise<FoundryConfig> {
    const path = join(this._dir, "settings.json");
    const file = Bun.file(path);
    if (await file.exists()) {
      const saved = await file.json() as Partial<FoundryConfig>;
      // Merge saved over defaults
      this._config = {
        ...defaultConfig(),
        ...saved,
        providers: { ...defaultConfig().providers, ...saved.providers },
      };
    }
    this._loaded = true;
    return this._config;
  }

  /** Get current config. */
  get config(): FoundryConfig {
    return this._config;
  }

  /** Update the full config and persist. */
  async save(config: FoundryConfig): Promise<void> {
    this._config = config;
    await this._write();
  }

  /** Patch a section of the config. */
  async patch(section: string, data: Record<string, unknown>): Promise<FoundryConfig> {
    if (section === "defaults") {
      this._config.defaults = { ...this._config.defaults, ...data } as FoundryConfig["defaults"];
    } else if (section === "providers") {
      this._config.providers = { ...this._config.providers, ...data } as FoundryConfig["providers"];
    } else if (section === "agents") {
      this._config.agents = { ...this._config.agents, ...data } as FoundryConfig["agents"];
    } else if (section === "layers") {
      this._config.layers = { ...this._config.layers, ...data } as FoundryConfig["layers"];
    } else if (section === "sources") {
      this._config.sources = { ...this._config.sources, ...data } as FoundryConfig["sources"];
    }
    await this._write();
    return this._config;
  }

  /** Delete an item from a section. */
  async deleteItem(section: string, id: string): Promise<FoundryConfig> {
    const map = (this._config as any)[section];
    if (map && typeof map === "object" && id in map) {
      delete map[id];
      await this._write();
    }
    return this._config;
  }

  /**
   * Sync current runtime state into config.
   * Reads agents, layers, etc. from the harness and updates config to match.
   */
  syncFromHarness(harness: Harness): void {
    const thread = harness.thread;

    // Sync agents
    for (const [id, agent] of thread.agents) {
      if (!this._config.agents[id]) {
        this._config.agents[id] = {
          id,
          kind: agent.constructor.name.toLowerCase().replace("agent", ""),
          prompt: agent.prompt ?? "",
          provider: agent.llm?.provider ?? this._config.defaults.provider,
          model: agent.llm?.model ?? this._config.defaults.model,
          temperature: agent.llm?.temperature ?? this._config.defaults.temperature,
          maxTokens: agent.llm?.maxTokens ?? this._config.defaults.maxTokens,
          visibleLayers: agent.llm?.sources ?? [],
          peers: agent.peers,
          maxDepth: agent.llm?.maxDepth ?? 3,
          enabled: true,
        };
      }
    }

    // Sync layers
    for (const layer of thread.stack.layers) {
      if (!this._config.layers[layer.id]) {
        this._config.layers[layer.id] = {
          id: layer.id,
          prompt: (layer as any)._prompt ?? "",
          sourceIds: ((layer as any)._sources ?? []).map((s: any) => s.id),
          trust: layer.trust,
          staleness: (layer as any)._staleness ?? 0,
          maxTokens: (layer as any)._maxTokens ?? 0,
          enabled: true,
        };
      }
    }
  }

  private async _write(): Promise<void> {
    const path = join(this._dir, "settings.json");
    await Bun.write(path, JSON.stringify(this._config, null, 2));
  }
}
