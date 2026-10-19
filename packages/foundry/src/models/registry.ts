/**
 * @atlas
 * @kind registry
 * @partOf primitive:modelRegistry
 */
/**
 * The registry itself lives in `@inixiative/foundry-core`, so that consumers
 * depending on core alone can reason about models. Re-exported here so every
 * existing `models/registry` import path keeps working.
 *
 * What stays: the viewer's projection of the table (providers, and the vendors that
 * group them into subscription and API modes) and the tier sweep that feeds
 * Foundry's research runs.
 */

import {
  MAIN_THREAD_LABS,
  MODEL_REGISTRY,
  MODEL_REGISTRY_UPDATED_AT,
  MODEL_VENDORS,
  type ModelSweepOption,
  type ModelTier,
  mainThreadLab,
  vendorModeProvider,
} from '@inixiative/foundry-core';

export {
  type CostTier,
  DECISION_MODEL,
  DECISION_PROVIDER,
  type DecisionModelDefaults,
  type FoundryModelInfo,
  type FoundryProviderInfo,
  MAIN_THREAD_LABS,
  type MainThreadLab,
  MODEL_CAPABILITIES,
  MODEL_REGISTRY,
  MODEL_REGISTRY_UPDATED_AT,
  type ModelCapability,
  type ModelLab,
  type ModelReasoning,
  type ModelSweepOption,
  type ModelTier,
  mainThreadLab,
  modelCapabilities,
  modelHasCapability,
  modelOptionsByCapability,
  type ProviderCredential,
  type ProviderType,
  providersWithCapability,
  type ReasoningEffort,
  type RuntimeKind,
  registryModel,
  resolveDecisionModel,
  SUBSCRIPTION_DECISION_MODELS,
} from '@inixiative/foundry-core';

/** Native harnesses that run a main thread on the user's own subscription login, and the profile each uses. */
export const SUBSCRIPTION_WORKERS = { 'claude-code': 'claude', codex: 'codex' } as const;
export type SubscriptionWorker = keyof typeof SUBSCRIPTION_WORKERS;
export const subscriptionWorker = (provider: string): provider is SubscriptionWorker =>
  Object.hasOwn(SUBSCRIPTION_WORKERS, provider);

/**
 * What a main thread on this provider still needs, or undefined when it can run. Main threads run on
 * Anthropic, OpenAI, Google, Meta and xAI models: subscription harnesses (Claude Code, Codex) in any
 * mode, API providers only with `apiTokens: true`.
 */
export function mainThreadRequirement(provider: string, apiTokens: boolean): string | undefined {
  const lab = mainThreadLab(provider);
  if (!lab)
    return `${provider} cannot run a main thread; main threads run on ${MAIN_THREAD_LABS.join(', ')} models`;
  if (apiTokens || subscriptionWorker(provider)) return undefined;
  const info = MODEL_REGISTRY[provider]!;
  const harness = Object.keys(SUBSCRIPTION_WORKERS).find((id) => MODEL_REGISTRY[id]?.lab === lab);
  return `${info.label} runs a main thread through its API: set apiTokens: true and ${info.envKey}${
    harness
      ? `, or use ${harness} for the subscription harness`
      : `; Foundry has no ${lab} subscription harness yet`
  }`;
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
      label: provider.id === 'claude-code' ? 'Claude Code (recommended)' : provider.label,
      desc: provider.description,
      envKey: provider.envKey ?? '',
      credential: provider.credential,
      lab: provider.lab ?? null,
      // null: not a main-thread lab. `requirement`: what a main thread here needs without API tokens.
      mainThread: mainThreadLab(provider.id)
        ? { requirement: mainThreadRequirement(provider.id, false) ?? null }
        : null,
      baseUrl: provider.apiRoot ?? '',
      models: provider.models.map((model) => ({
        id: model.id,
        label: model.label,
        tier: model.tier,
        costTier: model.costTier ?? null,
        contextWindow: model.contextWindow ?? null,
        maxOutputTokens: model.maxOutputTokens ?? null,
        runtimeKind: model.runtimeKind,
        nativeAlias: model.nativeAlias ?? false,
        trainsOnInput: model.trainsOnInput ?? false,
        capabilities: [...model.capabilities],
        notes: model.notes ?? null,
      })),
    })),
    // One row per vendor; each mode names the provider (above) that serves it, or is coming soon.
    vendors: MODEL_VENDORS.map((vendor) => ({
      id: vendor.id,
      label: vendor.label,
      lab: vendor.lab ?? null,
      modes: Object.fromEntries(
        (['subscription', 'api'] as const).flatMap((mode) => {
          if (!vendor[mode]) return [];
          const provider = vendorModeProvider(vendor, mode);
          return [
            [
              mode,
              provider ? { provider, comingSoon: false } : { provider: null, comingSoon: true },
            ],
          ];
        }),
      ),
    })),
  };
}
