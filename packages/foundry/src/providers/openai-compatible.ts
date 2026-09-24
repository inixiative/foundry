import { MODEL_REGISTRY, type FoundryProviderInfo } from "../models/registry";
import { OpenAIProvider, openAiApiRoot } from "./openai";
import { XAIProvider } from "./xai";
import type { LLMProvider } from "@inixiative/foundry-core";

export interface RegisteredProviderConfig {
  /** Omit for a local provider (Ollama, vLLM); a placeholder bearer is sent. */
  apiKey?: string;
  /** Overrides the registry's apiRoot. Normalized: a bare origin gains /v1. */
  baseUrl?: string;
  defaultModel?: string;
  /** Distinguishes two clients on the same provider, as the decision client does. */
  id?: string;
  headers?: Record<string, string>;
}

/** Hosts that reject `reasoning_effort: "none"` because thinking cannot be switched off. */
const ALWAYS_REASONING = new Set(["kimi"]);

/** Local hosts require a bearer the server ignores; the OpenAI client library refuses an empty one. */
const LOCAL_PLACEHOLDER_KEY = "local";

const OPENROUTER_HEADERS = {
  // Required for app attribution; the request succeeds without it, the ranking page does not exist.
  "HTTP-Referer": "https://github.com/inixiative/foundry",
  "X-OpenRouter-Title": "Foundry",
};

export function registeredProvider(providerId: string): FoundryProviderInfo {
  const provider = MODEL_REGISTRY[providerId];
  if (!provider) throw Error(`Unregistered provider: ${providerId}`);
  return provider;
}

/**
 * API root this provider will post to: an explicit override wins and is
 * normalized, otherwise the registry's root is used verbatim.
 */
export function providerApiRoot(providerId: string, baseUrl?: string): string {
  if (baseUrl?.trim()) return openAiApiRoot(baseUrl);
  const root = registeredProvider(providerId).apiRoot;
  if (!root) throw Error(`Provider has no OpenAI-compatible endpoint: ${providerId}`);
  return root;
}

/** True when the registry says this model takes a reasoning effort. */
export function providerReasoningModels(providerId: string): (model: string) => boolean {
  const models = new Map(registeredProvider(providerId).models.map((model) => [model.id, model.capabilities]));
  return (model: string) => models.get(model)?.includes("reasoning") ?? false;
}

/**
 * Build a client for any registered OpenAI-compatible provider. One adapter,
 * one table — xAI is the exception and gets its own class.
 */
export function createRegisteredProvider(providerId: string, config: RegisteredProviderConfig = {}): LLMProvider {
  const provider = registeredProvider(providerId);
  if (!["openai", "openai-compatible", "xai"].includes(provider.type))
    throw Error(`Provider is not OpenAI-compatible: ${providerId}`);
  if (provider.credential === "api-key" && !config.apiKey?.trim())
    throw Error(`${providerId} requires ${provider.envKey}`);

  const options = {
    apiKey: config.apiKey?.trim() || LOCAL_PLACEHOLDER_KEY,
    apiRoot: providerApiRoot(providerId, config.baseUrl),
    defaultModel: config.defaultModel ?? provider.models[0]!.id,
    reasoningModels: providerReasoningModels(providerId),
    headers: { ...(providerId === "openrouter" ? OPENROUTER_HEADERS : {}), ...config.headers },
  };
  const id = config.id ?? providerId;
  return provider.type === "xai"
    ? new XAIProvider(options, id)
    : new OpenAIProvider({ ...options, explicitNoReasoning: !ALWAYS_REASONING.has(providerId) }, id);
}

/** Read a registered provider's credential from the environment. */
export function providerApiKey(providerId: string, environment: Record<string, string | undefined> = process.env): string | undefined {
  const { envKey } = registeredProvider(providerId);
  return envKey ? environment[envKey]?.trim() || undefined : undefined;
}
