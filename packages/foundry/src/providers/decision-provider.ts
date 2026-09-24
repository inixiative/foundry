import type { LLMProvider } from "@inixiative/foundry-core";
import { DECISION_MODEL, DECISION_PROVIDER, MODEL_REGISTRY, modelHasCapability, registryModel } from "../models/registry";
import { createRegisteredProvider, providerApiKey } from "./openai-compatible";
import type { FoundryConfig } from "../viewer/config";

/** Re-exported: the defaults used when the configuration names no constructible classifier provider. */
export { DECISION_MODEL, DECISION_PROVIDER } from "../models/registry";

export type DecisionDefaults = Pick<FoundryConfig, "defaults" | "providers">;

/** What the API-token path would construct, before any credential is read. */
export function resolveDecisionModel(config: DecisionDefaults): { provider: string; model: string } {
  const configured = config.defaults.classifierProvider;
  // A classifier provider outside the registry — the subscription decision
  // profile — belongs to the native path, which constructs its own client.
  const provider = configured && MODEL_REGISTRY[configured] ? configured : DECISION_PROVIDER;
  const model = (provider === configured && config.defaults.classifierModel) || DECISION_MODEL;
  return { provider, model };
}

/**
 * Decisions run on any registered model tagged `judgment`. There is no judgment
 * provider kind: a keyless local Ollama and a hosted frontier model are both
 * eligible, and the configuration chooses between them. The worker model is
 * never used as a fallback.
 */
export function createDecisionProvider(
  config: DecisionDefaults,
  environment: Record<string, string | undefined> = process.env,
): LLMProvider {
  const { provider, model } = resolveDecisionModel(config);
  const registered = MODEL_REGISTRY[provider]!;
  if (!config.providers[provider]?.enabled)
    throw Error(`Foundry decisions require ${provider} to be enabled; the worker model will not be used as a fallback.`);
  // A local server has no fixed catalogue, so its served model cannot be tagged in advance.
  if (registryModel(provider, model) ? !modelHasCapability(provider, model, "judgment") : registered.credential !== "local")
    throw Error(`Foundry decisions require a model tagged for judgment; ${provider}/${model} is not.`);
  const apiKey = providerApiKey(provider, environment);
  if (registered.credential === "api-key" && !apiKey)
    throw Error(`Foundry decisions require ${registered.envKey} for ${provider}/${model}; the worker model will not be used as a fallback.`);
  return createRegisteredProvider(provider, {
    apiKey,
    defaultModel: model,
    baseUrl: config.providers[provider]?.baseUrl,
    id: `${provider}-decisions`,
  });
}
