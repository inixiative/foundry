import type { LLMProvider } from '@inixiative/foundry-core';
import {
  MODEL_REGISTRY,
  modelHasCapability,
  registryModel,
  resolveDecisionModel,
} from '../models/registry';
import type { FoundryConfig } from '../viewer/config';
import { createRegisteredProvider, providerApiKey } from './openai-compatible';

/** Re-exported: the registry defaults and the resolver now live in core. */
export { DECISION_MODEL, DECISION_PROVIDER, resolveDecisionModel } from '../models/registry';

export type DecisionDefaults = Pick<FoundryConfig, 'defaults' | 'providers'>;

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
    throw Error(
      `Foundry decisions require ${provider} to be enabled; the worker model will not be used as a fallback.`,
    );
  // A local server has no fixed catalogue, so its served model cannot be tagged in advance.
  if (
    registryModel(provider, model)
      ? !modelHasCapability(provider, model, 'judgment')
      : registered.credential !== 'local'
  )
    throw Error(
      `Foundry decisions require a model tagged for judgment; ${provider}/${model} is not.`,
    );
  const apiKey = providerApiKey(provider, environment);
  if (registered.credential === 'api-key' && !apiKey)
    throw Error(
      `Foundry decisions require ${registered.envKey} for ${provider}/${model}; the worker model will not be used as a fallback.`,
    );
  return createRegisteredProvider(provider, {
    apiKey,
    defaultModel: model,
    baseUrl: config.providers[provider]?.baseUrl,
    id: `${provider}-decisions`,
  });
}
