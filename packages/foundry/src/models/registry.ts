/**
 * @atlas
 * @kind registry
 * @partOf primitive:modelRegistry
 */
/**
 * The registry itself lives in `@inixiative/foundry-core`, so that consumers
 * depending on core alone can reason about models; import it from there.
 *
 * What lives here: the viewer's projection of the table (providers, and the vendors that
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

/** Native harnesses that run a main thread on the user's own subscription login, and the profile each uses. */
export const SUBSCRIPTION_WORKERS = {
  'claude-code': 'claude',
  codex: 'codex',
  muse: 'muse',
} as const;
export type SubscriptionWorker = keyof typeof SUBSCRIPTION_WORKERS;
/** The session-store bucket each worker's native binding is saved under (the session adapter's runtime). */
export const WORKER_SESSION_RUNTIMES: Readonly<Record<SubscriptionWorker, string>> = {
  'claude-code': 'claude-code',
  codex: 'codex-app-server',
  muse: 'muse-serve',
};
export const subscriptionWorker = (provider: string): provider is SubscriptionWorker =>
  Object.hasOwn(SUBSCRIPTION_WORKERS, provider);

/**
 * Whether a main thread on this provider can hold Foundry's MCP bridge (the `foundry` tools: set_plan,
 * fork_thread, the conversation tools). Muse Code cannot: agent-session's MuseSession offers it no session
 * MCP yet, so its threads run without the tools and without the standing note that teaches them.
 */
export const workerHostsFoundryTools = (provider: string | undefined): boolean =>
  provider !== 'muse';

/**
 * Archive's `runtime` for a thread's snapshot, where the worker settles it. Muse Code bills only the
 * user's own Muse login (no gateway, no API key), so its threads are `meta` on a subscription: Archive's
 * `alwaysPersonal` keeps them out of every organization. Claude Code and Codex can also run through a
 * gateway or an API key, which the thread record does not say, so they carry none.
 */
export function workerArchiveRuntime(
  worker: string | undefined,
): { provider: string; accessPath: 'subscription'; evidence: 'harness' } | undefined {
  return worker === 'muse'
    ? { provider: 'meta', accessPath: 'subscription', evidence: 'harness' }
    : undefined;
}

/**
 * What a main thread on this provider still needs, or undefined when it can run. Main threads run on
 * Anthropic, OpenAI, Google, Meta and xAI models: subscription harnesses (Claude Code, Codex, Muse Code) in any
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
