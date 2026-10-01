/**
 * The registry itself lives in `@inixiative/foundry-core`, so that consumers
 * depending on core alone can reason about models. Re-exported here so every
 * existing `models/registry` import path keeps working.
 *
 * What stays: the two projections of the table into Foundry's own shapes — the
 * saved provider configuration and the viewer payload — which need `ProviderConfig`
 * from the viewer, and the tier sweep that feeds Foundry's research runs.
 */
import type { ProviderConfig } from "../viewer/config";
import { MODEL_REGISTRY, MODEL_REGISTRY_UPDATED_AT, type ModelSweepOption, type ModelTier } from "@inixiative/foundry-core";

export {
  MODEL_CAPABILITIES,
  MODEL_REGISTRY,
  MODEL_REGISTRY_UPDATED_AT,
  DECISION_MODEL,
  DECISION_PROVIDER,
  modelCapabilities,
  modelHasCapability,
  modelOptionsByCapability,
  providersWithCapability,
  registryModel,
  resolveDecisionModel,
  type ModelTier,
  type CostTier,
  type ProviderType,
  type RuntimeKind,
  type ModelCapability,
  type ProviderCredential,
  type ReasoningEffort,
  type ModelReasoning,
  type FoundryModelInfo,
  type FoundryProviderInfo,
  type ModelSweepOption,
  type DecisionModelDefaults,
} from "@inixiative/foundry-core";

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
          ...(model.trainsOnInput ? { trainsOnInput: true } : {}),
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
      credential: provider.credential,
      baseUrl: provider.apiRoot ?? "",
      models: provider.models.map((model) => ({
        id: model.id,
        label: model.label,
        tier: model.tier,
        runtimeKind: model.runtimeKind,
        nativeAlias: model.nativeAlias ?? false,
        trainsOnInput: model.trainsOnInput ?? false,
        capabilities: [...model.capabilities],
      })),
    })),
  };
}
