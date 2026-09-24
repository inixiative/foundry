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

export const MODEL_REGISTRY_UPDATED_AT = "2026-09-23";

/** Tag rule: every model judges. Cheap models review and route; capable models execute and advise. */
const FAST = ["judgment", "learning-review", "tool-use"] as ModelCapability[];
const FAST_REASONING = [...FAST, "reasoning"] as ModelCapability[];
const STANDARD = ["judgment", "learning-review", "execution", "domain-advising", "tool-use"] as ModelCapability[];
const STANDARD_REASONING = [...STANDARD, "reasoning"] as ModelCapability[];
const POWERFUL = ["judgment", "execution", "domain-advising", "tool-use"] as ModelCapability[];
const POWERFUL_REASONING = [...POWERFUL, "reasoning"] as ModelCapability[];

export const MODEL_REGISTRY: Record<string, FoundryProviderInfo> = {
  "claude-code": {
    id: "claude-code",
    type: "claude-code",
    label: "Claude Code (CLI subscription)",
    description: "Native Claude Code harness using the user's authenticated subscription.",
    credential: "subscription",
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
        capabilities: POWERFUL_REASONING,
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
        capabilities: POWERFUL_REASONING,
      },
      {
        id: "sonnet",
        label: "Sonnet 5",
        tier: "standard",
        costTier: "medium",
        contextWindow: 1_000_000,
        runtimeKind: "native-harness",
        nativeAlias: true,
        capabilities: STANDARD_REASONING,
      },
      {
        id: "haiku",
        label: "Haiku 4.5",
        tier: "fast",
        costTier: "low",
        contextWindow: 200_000,
        runtimeKind: "native-harness",
        nativeAlias: true,
        capabilities: FAST_REASONING,
      },
    ],
  },
  anthropic: {
    id: "anthropic",
    type: "anthropic",
    label: "Anthropic (API key)",
    description: "Direct Anthropic API access without the Claude Code native harness.",
    envKey: "ANTHROPIC_API_KEY",
    credential: "api-key",
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
        capabilities: POWERFUL_REASONING,
      },
      {
        id: "claude-opus-5",
        label: "Claude Opus 5",
        tier: "powerful",
        costTier: "high",
        contextWindow: 1_000_000,
        runtimeKind: "api",
        capabilities: POWERFUL_REASONING,
      },
      {
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5",
        tier: "standard",
        costTier: "medium",
        contextWindow: 1_000_000,
        runtimeKind: "api",
        capabilities: STANDARD_REASONING,
      },
      {
        id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        tier: "fast",
        costTier: "low",
        contextWindow: 200_000,
        runtimeKind: "api",
        capabilities: FAST_REASONING,
      },
    ],
  },
  codex: {
    id: "codex",
    type: "codex",
    label: "Codex CLI (OpenAI subscription)",
    description: "Native Codex harness using the user's authenticated OpenAI/Codex subscription.",
    credential: "subscription",
    enabledByDefault: true,
    models: [
      { id: "gpt-6-astra", label: "GPT-6 Astra", tier: "powerful", costTier: "high", contextWindow: 1_050_000, maxOutputTokens: 128_000, runtimeKind: "native-harness", capabilities: POWERFUL_REASONING },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", tier: "powerful", costTier: "high", contextWindow: 1_050_000, maxOutputTokens: 128_000, runtimeKind: "native-harness", capabilities: POWERFUL_REASONING },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", tier: "standard", costTier: "medium", contextWindow: 1_050_000, maxOutputTokens: 128_000, runtimeKind: "native-harness", capabilities: STANDARD_REASONING },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", tier: "fast", costTier: "low", contextWindow: 1_050_000, maxOutputTokens: 128_000, runtimeKind: "native-harness", capabilities: FAST_REASONING },
    ],
  },
  openai: {
    id: "openai",
    type: "openai",
    label: "OpenAI",
    description: "OpenAI API models for classification, routing, and execution.",
    envKey: "OPENAI_API_KEY",
    credential: "api-key",
    apiRoot: "https://api.openai.com/v1",
    enabledByDefault: true,
    models: [
      { id: "gpt-6-astra", label: "GPT-6 Astra", tier: "powerful", costTier: "high", contextWindow: 1_050_000, maxOutputTokens: 128_000, runtimeKind: "api", capabilities: POWERFUL_REASONING },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", tier: "powerful", costTier: "high", contextWindow: 1_050_000, maxOutputTokens: 128_000, runtimeKind: "api", capabilities: POWERFUL_REASONING },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", tier: "standard", costTier: "medium", contextWindow: 1_050_000, maxOutputTokens: 128_000, runtimeKind: "api", capabilities: STANDARD_REASONING },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", tier: "fast", costTier: "low", contextWindow: 1_050_000, maxOutputTokens: 128_000, runtimeKind: "api", capabilities: FAST_REASONING },
    ],
  },
  gemini: {
    id: "gemini",
    type: "gemini",
    label: "Google Gemini",
    description: "Gemini API models for high-volume agent work.",
    envKey: "GEMINI_API_KEY",
    credential: "api-key",
    enabledByDefault: true,
    models: [
      { id: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite", tier: "fast", costTier: "low", contextWindow: 1_000_000, runtimeKind: "api", capabilities: FAST },
      { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", tier: "standard", costTier: "medium", contextWindow: 1_000_000, runtimeKind: "api", capabilities: STANDARD },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", tier: "powerful", costTier: "high", contextWindow: 1_000_000, runtimeKind: "api", capabilities: POWERFUL_REASONING },
    ],
  },
  xai: {
    id: "xai",
    type: "xai",
    label: "xAI (Grok)",
    description: "Grok models. Near-OpenAI-compatible; reasoning effort is a nested object and cannot be turned off.",
    envKey: "XAI_API_KEY",
    credential: "api-key",
    apiRoot: "https://api.x.ai/v1",
    enabledByDefault: true,
    models: [
      { id: "grok-4.7", label: "Grok 4.7", tier: "powerful", costTier: "high", contextWindow: 500_000, runtimeKind: "api", capabilities: POWERFUL_REASONING, notes: "Reasoning effort low/medium/high/xhigh; cannot be disabled." },
      { id: "grok-4.6", label: "Grok 4.6", tier: "powerful", costTier: "high", contextWindow: 500_000, runtimeKind: "api", capabilities: POWERFUL_REASONING },
      { id: "grok-4.5", label: "Grok 4.5", tier: "standard", costTier: "medium", contextWindow: 500_000, runtimeKind: "api", capabilities: STANDARD_REASONING, notes: "xhigh effort is served as high." },
      { id: "grok-4.3", label: "Grok 4.3", tier: "standard", costTier: "medium", contextWindow: 1_000_000, runtimeKind: "api", capabilities: STANDARD },
      { id: "grok-4.20-0309-reasoning", label: "Grok 4.20 (reasoning)", tier: "powerful", costTier: "high", contextWindow: 1_000_000, runtimeKind: "api", capabilities: POWERFUL_REASONING },
      { id: "grok-4.20-0309-non-reasoning", label: "Grok 4.20 (non-reasoning)", tier: "fast", costTier: "low", contextWindow: 1_000_000, runtimeKind: "api", capabilities: FAST },
      { id: "grok-build-0.1", label: "Grok Build 0.1", tier: "fast", costTier: "low", contextWindow: 256_000, runtimeKind: "api", capabilities: FAST },
    ],
  },
  deepseek: {
    id: "deepseek",
    type: "openai-compatible",
    label: "DeepSeek",
    description: "DeepSeek API. OpenAI-compatible; penalties are silently ignored and output defaults differ.",
    envKey: "DEEPSEEK_API_KEY",
    credential: "api-key",
    apiRoot: "https://api.deepseek.com",
    enabledByDefault: true,
    models: [
      { id: "deepseek-flash", label: "DeepSeek Flash (V4.1)", tier: "fast", costTier: "low", contextWindow: 1_000_000, maxOutputTokens: 393_216, runtimeKind: "api", capabilities: FAST_REASONING, notes: "Thinking on by default; the legacy deepseek-v4-flash ids route here." },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", tier: "powerful", costTier: "high", contextWindow: 1_000_000, maxOutputTokens: 393_216, runtimeKind: "api", capabilities: POWERFUL_REASONING },
    ],
  },
  kimi: {
    id: "kimi",
    type: "openai-compatible",
    label: "Kimi (Moonshot AI)",
    description: "Moonshot Kimi models. OpenAI-compatible; temperature range is 0-1, not 0-2.",
    envKey: "MOONSHOT_API_KEY",
    credential: "api-key",
    apiRoot: "https://api.moonshot.ai/v1",
    enabledByDefault: true,
    models: [
      { id: "kimi-k3", label: "Kimi K3", tier: "powerful", costTier: "high", contextWindow: 1_048_576, maxOutputTokens: 131_072, runtimeKind: "api", capabilities: POWERFUL_REASONING, notes: "Thinking is always on and cannot be disabled." },
      { id: "kimi-k2.6", label: "Kimi K2.6", tier: "standard", costTier: "medium", contextWindow: 262_144, runtimeKind: "api", capabilities: STANDARD_REASONING, notes: "Thinking requires temperature 1.0; non-thinking requires 0.6." },
      { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", tier: "standard", costTier: "medium", contextWindow: 262_144, runtimeKind: "api", capabilities: STANDARD, notes: "tool_choice required is unsupported." },
    ],
  },
  glm: {
    id: "glm",
    type: "openai-compatible",
    label: "GLM (Z.ai / Zhipu)",
    description: "GLM over Z.ai's OpenAI-compatible v4 endpoint. Mainland Zhipu is https://open.bigmodel.cn/api/paas/v4.",
    envKey: "ZAI_API_KEY",
    credential: "api-key",
    apiRoot: "https://api.z.ai/api/paas/v4",
    enabledByDefault: true,
    models: [
      { id: "glm-4.6", label: "GLM-4.6", tier: "standard", costTier: "medium", contextWindow: 204_800, maxOutputTokens: 128_000, runtimeKind: "api", capabilities: STANDARD_REASONING, notes: "Thinking is opt-in via the thinking parameter." },
      { id: "glm-4.7", label: "GLM-4.7", tier: "standard", costTier: "medium", maxOutputTokens: 128_000, runtimeKind: "api", capabilities: STANDARD_REASONING },
      { id: "glm-4.7-flash", label: "GLM-4.7 Flash", tier: "fast", costTier: "low", runtimeKind: "api", capabilities: FAST_REASONING, notes: "Free on Z.ai's pricing page." },
      { id: "glm-5.3", label: "GLM-5.3", tier: "powerful", costTier: "high", maxOutputTokens: 128_000, runtimeKind: "api", capabilities: POWERFUL_REASONING },
      { id: "glm-5.3-flash", label: "GLM-5.3 Flash", tier: "fast", costTier: "low", runtimeKind: "api", capabilities: FAST_REASONING },
    ],
  },
  qwen: {
    id: "qwen",
    type: "openai-compatible",
    label: "Qwen (Alibaba Model Studio)",
    // The legacy static domain still works; Alibaba now recommends the per-workspace
    // domain (https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1),
    // which has no static form. Keys are region-bound: a wrong-region key reads as a bad key.
    description: "DashScope compatible mode, Singapore. Set baseUrl to your workspace or region domain; mainland China is https://dashscope.aliyuncs.com/compatible-mode/v1.",
    envKey: "DASHSCOPE_API_KEY",
    credential: "api-key",
    apiRoot: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    enabledByDefault: true,
    models: [
      { id: "qwen-flash", label: "Qwen Flash", tier: "fast", costTier: "low", contextWindow: 1_000_000, maxOutputTokens: 32_768, runtimeKind: "api", capabilities: FAST },
      { id: "qwen3.8-flash", label: "Qwen3.8 Flash", tier: "fast", costTier: "low", contextWindow: 1_000_000, maxOutputTokens: 131_072, runtimeKind: "api", capabilities: FAST_REASONING },
      { id: "qwen3.8-max", label: "Qwen3.8 Max", tier: "powerful", costTier: "high", contextWindow: 1_000_000, maxOutputTokens: 131_072, runtimeKind: "api", capabilities: POWERFUL_REASONING },
    ],
  },
  openrouter: {
    id: "openrouter",
    type: "openai-compatible",
    label: "OpenRouter",
    description: "One key, many vendors. Model ids are namespaced vendor/model; a :free suffix marks free models.",
    envKey: "OPENROUTER_API_KEY",
    credential: "api-key",
    apiRoot: "https://openrouter.ai/api/v1",
    enabledByDefault: true,
    models: [
      { id: "meta-llama/llama-3.1-8b-instruct", label: "Llama 3.1 8B Instruct", tier: "fast", costTier: "low", contextWindow: 131_072, runtimeKind: "api", capabilities: FAST, notes: "Cheapest Llama on OpenRouter." },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct", tier: "standard", costTier: "medium", contextWindow: 131_072, runtimeKind: "api", capabilities: STANDARD },
      { id: "meta-llama/llama-4-scout", label: "Llama 4 Scout", tier: "standard", costTier: "low", contextWindow: 1_310_720, runtimeKind: "api", capabilities: STANDARD },
      { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick", tier: "powerful", costTier: "medium", contextWindow: 1_048_576, runtimeKind: "api", capabilities: POWERFUL },
      { id: "mistralai/mistral-nemo", label: "Mistral Nemo", tier: "fast", costTier: "low", runtimeKind: "api", capabilities: FAST, notes: "Cheapest model in the OpenRouter catalogue." },
      { id: "z-ai/glm-5.2:free", label: "GLM-5.2 (free)", tier: "standard", costTier: "low", runtimeKind: "api", capabilities: STANDARD, notes: "Free tier; the cheapest hosted judgment model that needs no local runtime." },
      { id: "qwen/qwen3.8-27b:free", label: "Qwen3.8 27B (free)", tier: "standard", costTier: "low", runtimeKind: "api", capabilities: STANDARD, notes: "Free tier." },
    ],
  },
  groq: {
    id: "groq",
    type: "openai-compatible",
    label: "Groq",
    description: "Groq LPU inference. Meta Llama chat models are enterprise-contract only here; GPT-OSS is the self-serve open-weight line.",
    envKey: "GROQ_API_KEY",
    credential: "api-key",
    apiRoot: "https://api.groq.com/openai/v1",
    enabledByDefault: true,
    models: [
      { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", tier: "fast", costTier: "low", contextWindow: 131_072, runtimeKind: "api", capabilities: FAST_REASONING },
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", tier: "standard", costTier: "low", contextWindow: 131_072, runtimeKind: "api", capabilities: STANDARD_REASONING },
    ],
  },
  together: {
    id: "together",
    type: "openai-compatible",
    label: "Together AI",
    description: "Hosted open-weight models. Llama ids are not uniform across versions; check each one.",
    envKey: "TOGETHER_API_KEY",
    credential: "api-key",
    apiRoot: "https://api.together.ai/v1",
    enabledByDefault: true,
    models: [
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", label: "Llama 3.3 70B Instruct Turbo", tier: "standard", costTier: "medium", contextWindow: 131_072, runtimeKind: "api", capabilities: STANDARD },
      { id: "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo", label: "Llama 3.1 405B Instruct Turbo", tier: "powerful", costTier: "high", runtimeKind: "api", capabilities: POWERFUL, notes: "The 3.1 line keeps the Meta- prefix; 3.3 and 4 drop it." },
      { id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8", label: "Llama 4 Maverick 17B 128E FP8", tier: "powerful", costTier: "medium", runtimeKind: "api", capabilities: POWERFUL },
    ],
  },
  fireworks: {
    id: "fireworks",
    type: "openai-compatible",
    label: "Fireworks AI",
    description: "Hosted open-weight models. Model ids are full account paths, not bare names.",
    envKey: "FIREWORKS_API_KEY",
    credential: "api-key",
    apiRoot: "https://api.fireworks.ai/inference/v1",
    enabledByDefault: true,
    models: [
      { id: "accounts/fireworks/models/llama-v3p1-8b-instruct", label: "Llama 3.1 8B Instruct", tier: "fast", costTier: "low", runtimeKind: "api", capabilities: FAST },
      { id: "accounts/fireworks/models/llama-v3p3-70b-instruct", label: "Llama 3.3 70B Instruct", tier: "standard", costTier: "medium", runtimeKind: "api", capabilities: STANDARD },
      { id: "accounts/fireworks/models/llama-v3p1-405b-instruct", label: "Llama 3.1 405B Instruct", tier: "powerful", costTier: "high", runtimeKind: "api", capabilities: POWERFUL },
      { id: "accounts/fireworks/models/llama4-scout-instruct-basic", label: "Llama 4 Scout", tier: "standard", costTier: "low", runtimeKind: "api", capabilities: STANDARD },
      { id: "accounts/fireworks/models/llama4-maverick-instruct-basic", label: "Llama 4 Maverick", tier: "powerful", costTier: "medium", runtimeKind: "api", capabilities: POWERFUL },
    ],
  },
  ollama: {
    id: "ollama",
    type: "openai-compatible",
    label: "Ollama (local)",
    description: "Local Ollama server. No credential: clients must send a bearer, the server ignores it.",
    credential: "local",
    apiRoot: "http://localhost:11434/v1",
    enabledByDefault: true,
    models: [
      { id: "llama3.2:3b", label: "Llama 3.2 3B", tier: "fast", costTier: "low", contextWindow: 128_000, runtimeKind: "api", capabilities: FAST, notes: "ollama pull llama3.2:3b — the cheapest working judgment model." },
      { id: "llama3.1:8b", label: "Llama 3.1 8B", tier: "fast", costTier: "low", contextWindow: 128_000, runtimeKind: "api", capabilities: FAST },
      { id: "llama3.3:70b", label: "Llama 3.3 70B", tier: "standard", costTier: "low", contextWindow: 128_000, runtimeKind: "api", capabilities: STANDARD },
      { id: "llama4:16x17b", label: "Llama 4 Scout", tier: "standard", costTier: "low", contextWindow: 10_000_000, runtimeKind: "api", capabilities: STANDARD },
      { id: "llama4:128x17b", label: "Llama 4 Maverick", tier: "powerful", costTier: "low", contextWindow: 1_000_000, runtimeKind: "api", capabilities: POWERFUL },
      { id: "qwen3:8b", label: "Qwen3 8B", tier: "fast", costTier: "low", runtimeKind: "api", capabilities: FAST },
      { id: "gpt-oss:20b", label: "GPT-OSS 20B", tier: "fast", costTier: "low", runtimeKind: "api", capabilities: FAST_REASONING },
    ],
  },
  vllm: {
    id: "vllm",
    type: "openai-compatible",
    label: "vLLM (local)",
    description: "Local vLLM server on port 8000. Keyless unless started with --api-key; the model id is whatever --served-model-name says.",
    credential: "local",
    apiRoot: "http://localhost:8000/v1",
    enabledByDefault: true,
    models: [
      {
        id: "NousResearch/Meta-Llama-3-8B-Instruct",
        label: "vLLM served model",
        tier: "standard",
        costTier: "low",
        runtimeKind: "api",
        capabilities: STANDARD,
        notes: "vLLM's own quickstart example. Replace with this server's --served-model-name; vLLM has no fixed catalogue.",
      },
    ],
  },
  mistral: {
    id: "mistral",
    type: "openai-compatible",
    label: "Mistral AI",
    description: "Mistral API. Wire-compatible with OpenAI; JSON mode needs the word JSON in the prompt.",
    envKey: "MISTRAL_API_KEY",
    credential: "api-key",
    apiRoot: "https://api.mistral.ai/v1",
    enabledByDefault: true,
    models: [
      { id: "ministral-3b-2512", label: "Ministral 3 3B", tier: "fast", costTier: "low", runtimeKind: "api", capabilities: FAST },
      { id: "ministral-8b-2512", label: "Ministral 3 8B", tier: "fast", costTier: "low", runtimeKind: "api", capabilities: FAST },
      { id: "ministral-14b-2512", label: "Ministral 3 14B", tier: "fast", costTier: "low", runtimeKind: "api", capabilities: FAST },
      { id: "mistral-small-2603", label: "Mistral Small 4", tier: "standard", costTier: "low", contextWindow: 256_000, runtimeKind: "api", capabilities: STANDARD_REASONING, notes: "Unifies instruct, reasoning and coding." },
      { id: "mistral-medium-3-5", label: "Mistral Medium 3.5", tier: "powerful", costTier: "medium", contextWindow: 256_000, runtimeKind: "api", capabilities: POWERFUL_REASONING, notes: "Takes reasoning_effort." },
      { id: "mistral-large-2512", label: "Mistral Large 3", tier: "powerful", costTier: "high", contextWindow: 256_000, runtimeKind: "api", capabilities: POWERFUL },
    ],
  },
  typesafe: {
    id: "typesafe",
    type: "typesafe",
    label: "TypeSafe (Jev)",
    description: "Typed decisions — choice, score and noul with calibrated confidence. Judgment only: it answers typed questions, it does not complete chat.",
    envKey: "TYPESAFE_API_KEY",
    credential: "api-key",
    apiRoot: "https://api.typesafe.ai/v1",
    enabledByDefault: false,
    models: [
      {
        id: "jev-latest",
        label: "Jev (latest)",
        tier: "fast",
        costTier: "low",
        runtimeKind: "typed-decision",
        capabilities: ["judgment"],
        notes: "Not an LLMProvider: TypeSafeDecisionClient.evaluate takes typed questions, so it cannot back a chat agent.",
      },
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
        ...(provider.apiRoot ? { baseUrl: provider.apiRoot } : {}),
        models: provider.models.map((model) => ({
          id: model.id,
          label: model.label,
          tier: model.tier,
          costTier: model.costTier,
          contextWindow: model.contextWindow,
          capabilities: [...model.capabilities],
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

/** Every registered model carrying all of the requested capabilities. */
export function modelOptionsByCapability(...capabilities: ModelCapability[]): ModelSweepOption[] {
  return Object.values(MODEL_REGISTRY).flatMap((provider) =>
    provider.models
      .filter((model) => capabilities.every((capability) => model.capabilities.includes(capability)))
      .map((model) => ({ provider: provider.id, model: model.id, label: model.id })),
  );
}

export function registryModel(providerId: string, modelId: string): FoundryModelInfo | undefined {
  return MODEL_REGISTRY[providerId]?.models.find((model) => model.id === modelId);
}

/** Unknown provider/model pairs report no capabilities rather than throwing. */
export function modelCapabilities(providerId: string, modelId: string): ModelCapability[] {
  return [...(registryModel(providerId, modelId)?.capabilities ?? [])];
}

export function modelHasCapability(providerId: string, modelId: string, capability: ModelCapability): boolean {
  return modelCapabilities(providerId, modelId).includes(capability);
}

/** Providers with at least one model carrying the capability. */
export function providersWithCapability(capability: ModelCapability): FoundryProviderInfo[] {
  return Object.values(MODEL_REGISTRY).filter((provider) =>
    provider.models.some((model) => model.capabilities.includes(capability)),
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
      credential: provider.credential,
      baseUrl: provider.apiRoot ?? "",
      models: provider.models.map((model) => ({
        id: model.id,
        label: model.label,
        tier: model.tier,
        runtimeKind: model.runtimeKind,
        nativeAlias: model.nativeAlias ?? false,
        capabilities: [...model.capabilities],
      })),
    })),
  };
}
