import type { ProviderConfig } from "../viewer/config";

export type ModelTier = "fast" | "standard" | "powerful";
export type CostTier = "low" | "medium" | "high";
export type ProviderType =
  | "anthropic"
  | "openai"
  | "openai-compatible"
  | "gemini"
  | "claude-code"
  | "codex"
  | "xai"
  | "typesafe"
  | "custom";
export type RuntimeKind = "api" | "native-harness" | "typed-decision";

/**
 * What a model is worth using for. Every model is a judgment client — that is
 * not a provider category, it is a tag every entry carries. The other tags name
 * work Foundry already distinguishes:
 *
 * - judgment        classifier/router/decider agent kinds and the decision
 *                   provider: which archive, which middleware, which domain.
 * - execution       the executor kind (Artificer): tools on, multi-turn.
 * - domain-advising the `domain-advising` flow role: read an owned domain layer
 *                   and advise/guard from it.
 * - learning-review the background `learning.review` pass over finished work.
 * - tool-use        CompletionOpts.tools / toolDefinitions.
 * - reasoning       CompletionOpts.thinking (reasoning effort / think budget).
 */
export type ModelCapability =
  | "judgment"
  | "execution"
  | "domain-advising"
  | "learning-review"
  | "tool-use"
  | "reasoning";

export const MODEL_CAPABILITIES: readonly ModelCapability[] = [
  "judgment", "execution", "domain-advising", "learning-review", "tool-use", "reasoning",
] as const;

/** How the provider is paid for. `envKey` is present exactly when this is "api-key". */
export type ProviderCredential = "api-key" | "subscription" | "local";

export interface FoundryModelInfo {
  id: string;
  label: string;
  tier: ModelTier;
  costTier?: CostTier;
  contextWindow?: number;
  maxOutputTokens?: number;
  runtimeKind: RuntimeKind;
  nativeAlias?: boolean;
  /** Always includes "judgment". */
  capabilities: ModelCapability[];
  notes?: string;
}

export interface FoundryProviderInfo {
  id: string;
  type: ProviderType;
  label: string;
  description: string;
  envKey?: string;
  credential: ProviderCredential;
  /**
   * Versioned API root for OpenAI-compatible hosts, used verbatim: requests go
   * to `${apiRoot}/chat/completions`. Hosts disagree about the version segment
   * (/v1, /api/paas/v4, /compatible-mode/v1, none at all), so this is not
   * normalized. A user's `providers[id].baseUrl` override is.
   */
  apiRoot?: string;
  enabledByDefault: boolean;
  models: FoundryModelInfo[];
}

export interface ModelSweepOption {
  provider: string;
  model: string;
  label: string;
}

export const MODEL_REGISTRY_UPDATED_AT = "2026-09-06";

export const MODEL_REGISTRY: Record<string, FoundryProviderInfo> = {
  "claude-code": {
    id: "claude-code",
    type: "claude-code",
    label: "Claude Code (CLI subscription)",
    description: "Native Claude Code harness using the user's authenticated subscription.",
    enabledByDefault: true,
    models: [
      {
        id: "fable",
        label: "Fable 5.1",
        tier: "powerful",
        costTier: "high",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        runtimeKind: "native-harness",
        nativeAlias: true,
        notes: "Claude Code alias for claude-fable-5-1.",
      },
      {
        id: "opus",
        label: "Opus 5",
        tier: "powerful",
        costTier: "high",
        contextWindow: 1_000_000,
        runtimeKind: "native-harness",
        nativeAlias: true,
      },
      {
        id: "sonnet",
        label: "Sonnet 5",
        tier: "standard",
        costTier: "medium",
        contextWindow: 1_000_000,
        runtimeKind: "native-harness",
        nativeAlias: true,
      },
      {
        id: "haiku",
        label: "Haiku 4.5",
        tier: "fast",
        costTier: "low",
        contextWindow: 200_000,
        runtimeKind: "native-harness",
        nativeAlias: true,
      },
    ],
  },
  anthropic: {
    id: "anthropic",
    type: "anthropic",
    label: "Anthropic (API key)",
    description: "Direct Anthropic API access without the Claude Code native harness.",
    envKey: "ANTHROPIC_API_KEY",
    enabledByDefault: true,
    models: [
      {
        id: "claude-fable-5-1",
        label: "Claude Fable 5.1",
        tier: "powerful",
        costTier: "high",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        runtimeKind: "api",
      },
      {
        id: "claude-opus-5",
        label: "Claude Opus 5",
        tier: "powerful",
        costTier: "high",
        contextWindow: 1_000_000,
        runtimeKind: "api",
      },
      {
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5",
        tier: "standard",
        costTier: "medium",
        contextWindow: 1_000_000,
        runtimeKind: "api",
      },
      {
        id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        tier: "fast",
        costTier: "low",
        contextWindow: 200_000,
        runtimeKind: "api",
      },
    ],
  },
  codex: {
    id: "codex",
    type: "codex",
    label: "Codex CLI (OpenAI subscription)",
    description: "Native Codex harness using the user's authenticated OpenAI/Codex subscription.",
    enabledByDefault: true,
    models: [
      {
        id: "gpt-6-astra",
        label: "GPT-6 Astra",
        tier: "powerful",
        costTier: "high",
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        runtimeKind: "native-harness",
      },
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        tier: "powerful",
        costTier: "high",
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        runtimeKind: "native-harness",
      },
      {
        id: "gpt-5.6-terra",
        label: "GPT-5.6 Terra",
        tier: "standard",
        costTier: "medium",
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        runtimeKind: "native-harness",
      },
      {
        id: "gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        tier: "fast",
        costTier: "low",
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        runtimeKind: "native-harness",
      },
    ],
  },
  openai: {
    id: "openai",
    type: "openai",
    label: "OpenAI",
    description: "OpenAI API models for classification, routing, and execution.",
    envKey: "OPENAI_API_KEY",
    enabledByDefault: true,
    models: [
      {
        id: "gpt-6-astra",
        label: "GPT-6 Astra",
        tier: "powerful",
        costTier: "high",
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        runtimeKind: "api",
      },
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        tier: "powerful",
        costTier: "high",
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        runtimeKind: "api",
      },
      {
        id: "gpt-5.6-terra",
        label: "GPT-5.6 Terra",
        tier: "standard",
        costTier: "medium",
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        runtimeKind: "api",
      },
      {
        id: "gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        tier: "fast",
        costTier: "low",
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        runtimeKind: "api",
      },
    ],
  },
  gemini: {
    id: "gemini",
    type: "gemini",
    label: "Google Gemini",
    description: "Gemini API models for high-volume agent work.",
    envKey: "GEMINI_API_KEY",
    enabledByDefault: true,
    models: [
      { id: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite", tier: "fast", costTier: "low", contextWindow: 1_000_000, runtimeKind: "api" },
      { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", tier: "standard", costTier: "medium", contextWindow: 1_000_000, runtimeKind: "api" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", tier: "powerful", costTier: "high", contextWindow: 1_000_000, runtimeKind: "api" },
    ],
  },
};

export function providerConfigsFromRegistry(): Record<string, ProviderConfig> {
  return Object.fromEntries(
    Object.values(MODEL_REGISTRY).map((provider) => [
      provider.id,
      {
        id: provider.id,
        type: provider.type,
        label: provider.label,
        enabled: provider.enabledByDefault,
        models: provider.models.map((model) => ({
          id: model.id,
          label: model.label,
          tier: model.tier,
          costTier: model.costTier,
          contextWindow: model.contextWindow,
        })),
      },
    ]),
  );
}

export function modelOptionsByTier(tiers: ModelTier[]): ModelSweepOption[] {
  const wanted = new Set<ModelTier>(tiers);
  return Object.values(MODEL_REGISTRY).flatMap((provider) =>
    provider.models
      .filter((model) => wanted.has(model.tier))
      .map((model) => ({
        provider: provider.id,
        model: model.id,
        label: model.id,
      })),
  );
}

export function registryForViewer() {
  return {
    updatedAt: MODEL_REGISTRY_UPDATED_AT,
    providers: Object.values(MODEL_REGISTRY).map((provider) => ({
      id: provider.id,
      type: provider.type,
      label: provider.id === "claude-code" ? "Claude Code (recommended)" : provider.label,
      desc: provider.description,
      envKey: provider.envKey ?? "",
      models: provider.models.map((model) => ({
        id: model.id,
        label: model.label,
        tier: model.tier,
        runtimeKind: model.runtimeKind,
        nativeAlias: model.nativeAlias ?? false,
      })),
    })),
  };
}
