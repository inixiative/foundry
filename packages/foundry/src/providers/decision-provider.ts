/**
 * @atlas
 * @kind config
 * @partOf primitive:decisions
 */
import type { LLMProvider } from '@inixiative/foundry-core';
import { MODEL_REGISTRY, modelHasCapability, resolveDecisionModel } from '@inixiative/foundry-core';
import { providerBaseUrl, providerEnabled } from '../models/vendors';
import type { FoundryConfig } from '../viewer/config';
import { AnthropicProvider } from './anthropic';
import { createRegisteredProvider, providerApiKey } from './openai-compatible';

export type DecisionDefaults = Pick<FoundryConfig, 'defaults' | 'vendors'>;

/**
 * Decisions run on any registered model tagged `judgment`. There is no judgment
 * provider kind: any hosted model with that tag is eligible, and the configuration
 * chooses between them. The worker model is never used as a fallback.
 */
export function createDecisionProvider(
  config: DecisionDefaults,
  environment: Record<string, string | undefined> = process.env,
): LLMProvider {
  const { provider, model } = resolveDecisionModel(config);
  const registered = MODEL_REGISTRY[provider]!;
  if (!providerEnabled(config, provider))
    throw Error(
      `Foundry decisions require ${provider} to be enabled; the worker model will not be used as a fallback.`,
    );
  if (!modelHasCapability(provider, model, 'judgment'))
    throw Error(
      `Foundry decisions require a model tagged for judgment; ${provider}/${model} is not.`,
    );
  const apiKey = providerApiKey(provider, environment);
  if (registered.credential === 'api-key' && !apiKey)
    throw Error(
      `Foundry decisions require ${registered.envKey} for ${provider}/${model}; the worker model will not be used as a fallback.`,
    );
  if (registered.type === 'anthropic' && apiKey)
    return new AnthropicProvider({
      apiKey,
      defaultModel: model,
      baseUrl: providerBaseUrl(config, provider),
      id: `${provider}-decisions`,
    });
  return createRegisteredProvider(provider, {
    apiKey,
    defaultModel: model,
    baseUrl: providerBaseUrl(config, provider),
    id: `${provider}-decisions`,
  });
}
