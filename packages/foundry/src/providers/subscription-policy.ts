import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  MODEL_REGISTRY,
  mainThreadRequirement,
  registryModel,
  SUBSCRIPTION_DECISION_MODELS,
  SUBSCRIPTION_WORKERS,
  type SubscriptionWorker,
  subscriptionWorker,
} from '../models/registry';
import type { AgentSettingsConfig, AgentSettingsOverride, FoundryConfig } from '../viewer/config';
import { resolveProjectView } from '../viewer/config-resolve';
import { defaultProfileSource, type NativeProfileSource } from './default-profiles';
import { assertPrivateProfile, assertProfile } from './private-profile';

export const SUBSCRIPTION_DECISIONS = 'subscription-decisions';
const model = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/);
/** Optional overrides of subscription mode. Every field has a default. */
export const subscriptionSettingsSchema = z
  .object({
    /** Decision runtime when no explicit source is named. Default claude. */
    decisionRuntime: z.enum(['claude', 'codex']).optional(),
    decisionSourceId: z.string().uuid().optional(),
    model: model.optional(),
    expectedObservedModel: model.optional(),
    directory: z.string().startsWith('/').optional(),
    maxCalls: z.number().int().min(1).max(10_000).optional(),
    maxQueued: z.number().int().min(1).max(1_024).optional(),
    maxQueuedPerThread: z.number().int().min(1).max(1_024).optional(),
    maxConcurrent: z.number().int().min(1).max(32).optional(),
    callTimeoutMs: z.number().int().min(100).max(30_000).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    hedgeAfterMs: z.number().int().min(500).max(30_000).optional(),
  })
  .strict();
export type SubscriptionSettings = z.infer<typeof subscriptionSettingsSchema>;
/** Every registered main thread (the global default worker and each enabled executor, globally and in project
 * overrides) runs on a main-thread lab. Whether it runs here is the mode's concern: `resolveSubscriptionPolicy`. */
export function assertMainThreadLabs(config: FoundryConfig): void {
  const providers = [config.defaults.provider];
  const executors = (
    agents: Record<string, Partial<AgentSettingsConfig>> | undefined,
    fallback: string,
    inherited?: Record<string, AgentSettingsConfig>,
  ) => {
    for (const [id, agent] of Object.entries(agents ?? {}))
      if (
        (agent.kind ?? inherited?.[id]?.kind) === 'executor' &&
        (agent.enabled ?? inherited?.[id]?.enabled) !== false
      )
        providers.push(agent.provider ?? inherited?.[id]?.provider ?? fallback);
  };
  executors(config.agents, config.defaults.provider);
  for (const project of Object.values(config.projects ?? {})) {
    const fallback = project.defaults?.provider ?? config.defaults.provider;
    providers.push(fallback);
    executors(
      project.agents as Record<string, Partial<AgentSettingsConfig>>,
      fallback,
      config.agents,
    );
  }
  for (const provider of providers) {
    // Unregistered ids are adapters supplied in code (tests, Oracle); only registered labs are classified.
    const requirement = MODEL_REGISTRY[provider] && mainThreadRequirement(provider, true);
    if (requirement) throw Error(requirement);
  }
}

export interface SubscriptionPolicy {
  model: string;
  expectedObservedModel?: string;
  directory: string;
  maxCalls: number;
  maxQueued: number;
  maxQueuedPerThread: number;
  maxConcurrent: number;
  callTimeoutMs: number;
  /** Decision reasoning effort. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Codex decisions still running after this long are hedged on a second branch. */
  hedgeAfterMs?: number;
}
/**
 * Sized for many threads: each turn fans out classifier, router, Cartographer and every expert at once
 * (nine decisions with six experts), and tool calls add guards. Codex concurrency is turns on one warm
 * process; each Claude decision is its own CLI process (~215 MB), so Claude admits one pre-message wave.
 * Decisions run at low effort: the model's default (medium) adds ~0.5 s per decision.
 */
export const SUBSCRIPTION_DEFAULTS = {
  maxCalls: 10_000,
  maxQueued: 256,
  maxQueuedPerThread: 32,
  maxConcurrent: { claude: 8, codex: 16 },
  callTimeoutMs: 30_000,
  effort: 'low',
  /** Just above a typical decision under a full fan-out (≈3–3.7 s live): only the slow tail is duplicated. */
  hedgeAfterMs: 4_000,
} as const;

export interface SubscriptionResolution {
  policy: SubscriptionPolicy;
  /** The native harness running every main thread. */
  workerProvider: SubscriptionWorker;
  worker: NativeProfileSource;
  decision: NativeProfileSource;
  /** Effective configuration: every enabled decision role runs on the subscription decision profile. */
  config: FoundryConfig;
  /** Decision roles whose saved provider/model differed from the subscription decision profile. */
  rerouted: string[];
}

/**
 * Subscription-only is the default. `apiTokens: true` is the only way to construct API
 * providers. Without it the worker (Claude Code or Codex) and the decision profile (Claude by
 * default, `decisionRuntime` to change) both use subscription logins, referenced in place, with no paid fallback.
 *
 * `startup` also checks the default login locations and prepares the default receipt
 * directory; configuration saves validate structure and explicit profiles only.
 */
export function resolveSubscriptionPolicy(
  config: FoundryConfig,
  options: { startup?: boolean; cwd?: string } = {},
): SubscriptionResolution | undefined {
  if (config.apiTokens !== undefined && typeof config.apiTokens !== 'boolean')
    throw Error('apiTokens must be true or false');
  if (config.apiTokens) {
    if (config.subscriptionOnly !== undefined)
      throw Error('apiTokens and subscriptionOnly are exclusive; remove one of them');
    return undefined;
  }
  const settings = subscriptionSettingsSchema.parse(config.subscriptionOnly ?? {});
  if (
    config.kingdomInference?.length ||
    config.defaults.kingdomOwnerKey ||
    Object.keys(config.kingdomInferenceAssignments ?? {}).length ||
    Object.keys(config.nativeAuthenticationSelections ?? {}).length
  )
    throw Error(
      'Subscription-only startup requires fixed native profile selections, without gateway or per-thread overrides; set apiTokens: true for other sources',
    );
  const workerProvider = config.defaults.provider;
  const requirement = mainThreadRequirement(workerProvider, false);
  if (requirement || !subscriptionWorker(workerProvider))
    throw Error(`Subscription-only mode: ${requirement}`);
  const workerRuntime = SUBSCRIPTION_WORKERS[workerProvider];
  const explicit = (id: string) => {
    const found = config.nativeAuthentication?.find((item) => item.id === id);
    if (!found || found.mode !== 'native-profile')
      throw Error('Subscription-only execution requires native profile sources');
    assertProfile(found.profileDirectory, found.runtime);
    return found;
  };
  const worker = config.defaults.nativeAuthenticationId
    ? explicit(config.defaults.nativeAuthenticationId)
    : defaultProfileSource(workerRuntime);
  if (worker.runtime !== workerRuntime)
    throw Error(`The ${workerProvider} subscription worker runs on a ${workerRuntime} profile`);
  const decision = settings.decisionSourceId
    ? explicit(settings.decisionSourceId)
    : defaultProfileSource(settings.decisionRuntime ?? 'claude');
  if (settings.decisionRuntime && settings.decisionRuntime !== decision.runtime)
    throw Error('subscriptionOnly.decisionRuntime does not match the decision source runtime');
  if (
    decision.runtime === 'codex' &&
    settings.expectedObservedModel !== undefined &&
    settings.expectedObservedModel !== settings.model
  )
    throw Error('Codex decisions cannot acknowledge a different observed model');
  const policy: SubscriptionPolicy = {
    // The setup wizard records the decision model as the subscription classifier default.
    model:
      settings.model ??
      (config.defaults.classifierProvider === SUBSCRIPTION_DECISIONS
        ? config.defaults.classifierModel
        : undefined) ??
      SUBSCRIPTION_DECISION_MODELS[decision.runtime],
    ...(settings.expectedObservedModel
      ? { expectedObservedModel: settings.expectedObservedModel }
      : {}),
    directory:
      settings.directory ?? join(options.cwd ?? process.cwd(), '.foundry', 'decision-receipts'),
    maxCalls: settings.maxCalls ?? SUBSCRIPTION_DEFAULTS.maxCalls,
    maxQueued: settings.maxQueued ?? SUBSCRIPTION_DEFAULTS.maxQueued,
    maxQueuedPerThread: Math.min(
      settings.maxQueuedPerThread ?? SUBSCRIPTION_DEFAULTS.maxQueuedPerThread,
      settings.maxQueued ?? SUBSCRIPTION_DEFAULTS.maxQueued,
    ),
    maxConcurrent: settings.maxConcurrent ?? SUBSCRIPTION_DEFAULTS.maxConcurrent[decision.runtime],
    callTimeoutMs: settings.callTimeoutMs ?? SUBSCRIPTION_DEFAULTS.callTimeoutMs,
    effort: settings.effort ?? SUBSCRIPTION_DEFAULTS.effort,
    ...(decision.runtime === 'codex'
      ? { hedgeAfterMs: settings.hedgeAfterMs ?? SUBSCRIPTION_DEFAULTS.hedgeAfterMs }
      : {}),
  };
  // A model registered only on the other runtime cannot run here, e.g. a recorded Claude model after switching to Codex.
  const runtimeProvider = { claude: 'claude-code', codex: 'codex' } as const;
  const other = decision.runtime === 'claude' ? 'codex' : 'claude';
  if (
    registryModel(runtimeProvider[other], policy.model) &&
    !registryModel(runtimeProvider[decision.runtime], policy.model)
  )
    throw Error(
      `Decision model ${policy.model} is a ${other} model; set subscriptionOnly.model or defaults.classifierModel for ${decision.runtime} decisions`,
    );
  if (options.startup) {
    for (const source of [worker, decision]) {
      try {
        assertProfile(source.profileDirectory, source.runtime);
      } catch (error) {
        throw Error(
          `${source.runtime} subscription profile unavailable at ${source.profileDirectory}: ${(error as Error).message}`,
        );
      }
    }
    if (!settings.directory) mkdirSync(policy.directory, { recursive: true, mode: 0o700 });
  }
  if (options.startup || settings.directory) assertPrivateProfile(policy.directory);
  // Worker and decisions are shared holders of one login, like interactive sessions on it.

  const { config: effective, rerouted } = routeDecisions(config, policy.model);
  const check = (view: FoundryConfig) => {
    if (view.defaults.provider !== workerProvider)
      throw Error(
        `Subscription-only mode runs every main thread on the ${workerProvider} worker; ${
          mainThreadRequirement(view.defaults.provider, false) ?? `set it as the global default`
        }`,
      );
    if (
      view.defaults.model !== config.defaults.model ||
      view.defaults.nativeAuthenticationId !== config.defaults.nativeAuthenticationId ||
      view.defaults.kingdomOwnerKey ||
      view.defaults.classifierProvider !== SUBSCRIPTION_DECISIONS ||
      view.defaults.classifierModel !== policy.model
    )
      throw Error(
        'Subscription-only defaults require the configured worker and subscription decision model',
      );
    model.parse(view.defaults.model);
    for (const agent of Object.values(view.agents)) {
      if (!agent.enabled) continue;
      const central = agent.kind === 'executor';
      if (
        (agent.provider ?? view.defaults.provider) !==
          (central ? workerProvider : SUBSCRIPTION_DECISIONS) ||
        (agent.model ?? (central ? view.defaults.model : undefined)) !==
          (central ? config.defaults.model : policy.model) ||
        (!central && agent.tools === true)
      )
        throw Error('Subscription-only agent provider, model or tool override refused');
      if (
        !central &&
        ((agent.thinking !== undefined && agent.thinking !== 'none') ||
          agent.cacheControl !== undefined ||
          (agent.temperature !== undefined && agent.temperature !== 0))
      )
        throw Error('Subscription decision sampling override cannot be enforced');
    }
    const review = view.learning?.review;
    if (
      review &&
      ((review.provider !== undefined && review.provider !== SUBSCRIPTION_DECISIONS) ||
        (review.model !== undefined && review.model !== policy.model) ||
        review.thinking !== undefined)
    )
      throw Error('Subscription-only review override refused');
  };
  check(effective);
  for (const id of Object.keys(effective.projects))
    check(resolveProjectView(effective, id)!.config);
  return structuredClone({ policy, workerProvider, worker, decision, config: effective, rerouted });
}

/** Decision roles (every enabled non-executor agent) run on the subscription decision profile.
 * Explicit sampling, tool and review overrides are still refused by the policy check. */
function routeDecisions(
  config: FoundryConfig,
  decisionModel: string,
): { config: FoundryConfig; rerouted: string[] } {
  const effective = structuredClone(config),
    rerouted: string[] = [];
  const route = (
    scope: string,
    id: string,
    agent: Pick<AgentSettingsOverride, 'kind' | 'enabled' | 'provider' | 'model'>,
    inherited?: AgentSettingsConfig,
  ) => {
    if (
      (agent.kind ?? inherited?.kind) === 'executor' ||
      (agent.enabled ?? inherited?.enabled) === false
    )
      return;
    if (inherited && agent.provider === undefined && agent.model === undefined) return;
    if (agent.provider === SUBSCRIPTION_DECISIONS && agent.model === decisionModel) return;
    rerouted.push(
      `${scope}${id} (${agent.provider ?? inherited?.provider ?? 'default'}/${agent.model ?? inherited?.model ?? 'default'})`,
    );
    agent.provider = SUBSCRIPTION_DECISIONS;
    agent.model = decisionModel;
  };
  effective.defaults = {
    ...effective.defaults,
    classifierProvider: SUBSCRIPTION_DECISIONS,
    classifierModel: decisionModel,
  };
  for (const [id, agent] of Object.entries(effective.agents)) route('', id, agent);
  for (const [projectId, project] of Object.entries(effective.projects)) {
    if (
      project.defaults &&
      ('classifierProvider' in project.defaults || 'classifierModel' in project.defaults)
    )
      project.defaults = {
        ...project.defaults,
        classifierProvider: SUBSCRIPTION_DECISIONS,
        classifierModel: decisionModel,
      };
    for (const [id, agent] of Object.entries(project.agents ?? {}))
      route(`${projectId}/`, id, agent, config.agents[id]);
  }
  return { config: effective, rerouted };
}
