/**
 * @atlas
 * @kind config
 * @partOf primitive:decisions
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  MODEL_REGISTRY,
  registryModel,
  SUBSCRIPTION_DECISION_MODELS,
} from '@inixiative/foundry-core';
import { z } from 'zod';
import {
  mainThreadRequirement,
  SUBSCRIPTION_WORKERS,
  type SubscriptionWorker,
  subscriptionWorker,
} from '../models/registry';
import { providerEnabled } from '../models/vendors';
import {
  type AgentSettingsConfig,
  type FoundryConfig,
  isAgentExtension,
  type ProjectAgentSettings,
} from '../viewer/config';
import { resolveProjectView } from '../viewer/config-resolve';
import { DECISION_CALL_TIMEOUT_MAX_MS, DECISION_DEADLINE_MS } from './decision-budget';
import { defaultProfileSource, type NativeProfileSource } from './default-profiles';
import { assertPrivateProfile, assertProfile } from './private-profile';

export const SUBSCRIPTION_DECISIONS = 'subscription-decisions';
const model = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/);
/** Optional overrides of subscription mode. Every field has a default. */
export const subscriptionSettingsSchema = z
  .object({
    /**
     * Decision runtime when no explicit source is named. Default claude. `claude-in-session` runs
     * Claude decisions too, but holds each thread's Wardens as subagents inside the thread's own
     * Claude Code process (docs/THREAD-TREE.md spec C); it needs the Claude Code main thread.
     */
    decisionRuntime: z.enum(['claude', 'codex', 'claude-in-session']).optional(),
    decisionSourceId: z.string().uuid().optional(),
    model: model.optional(),
    expectedObservedModel: model.optional(),
    directory: z.string().startsWith('/').optional(),
    maxCalls: z.number().int().min(1).max(10_000).optional(),
    maxQueued: z.number().int().min(1).max(1_024).optional(),
    maxQueuedPerThread: z.number().int().min(1).max(1_024).optional(),
    maxConcurrent: z.number().int().min(1).max(32).optional(),
    callTimeoutMs: z.number().int().min(100).max(DECISION_CALL_TIMEOUT_MAX_MS).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    hedgeAfterMs: z.number().int().min(500).max(30_000).optional(),
  })
  .strict();
export type SubscriptionSettings = z.infer<typeof subscriptionSettingsSchema>;
/** Every registered main thread (the global default worker and each enabled executor, globally and in project
 * overrides) runs on a main-thread lab. Whether it runs here is the mode's concern: `resolveSubscriptionPolicy`. */
export function assertMainThreadLabs(config: FoundryConfig): void {
  const providers = [config.defaults.provider];
  for (const agent of Object.values(config.agents))
    if (agent.kind === 'executor' && agent.enabled !== false)
      providers.push(agent.provider ?? config.defaults.provider);
  for (const project of Object.values(config.projects ?? {})) {
    const fallback = project.defaults?.provider ?? config.defaults.provider;
    providers.push(fallback);
    for (const agent of Object.values(project.agents ?? {})) {
      const inherited = isAgentExtension(agent) ? config.agents[agent.extends] : undefined;
      if (
        (inherited?.kind ?? (agent as AgentSettingsConfig).kind) === 'executor' &&
        (agent.enabled ?? inherited?.enabled) !== false
      )
        providers.push(agent.provider ?? inherited?.provider ?? fallback);
    }
  }
  for (const provider of providers) {
    // Unregistered ids are adapters supplied in code (tests, Oracle); only registered labs are classified.
    const requirement = MODEL_REGISTRY[provider] && mainThreadRequirement(provider, true);
    if (requirement) throw Error(requirement);
  }
}

/**
 * Why `modelId` cannot run on this subscription worker, or undefined when it can. The default is
 * only the default: an executor, a project or a thread may choose any model the worker's harness
 * runs (its registry entry), and nothing else, so a choice never reaches another provider.
 */
export function workerModelRequirement(
  worker: SubscriptionWorker,
  modelId: string,
): string | undefined {
  if (registryModel(worker, modelId)) return undefined;
  const known = MODEL_REGISTRY[worker]?.models.map((entry) => entry.id) ?? [];
  return `${modelId} is not a ${worker} model; choose one of ${known.join(', ')}`;
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
  /** Where a thread's Wardens run: primed sessions (default), or inside the thread's own process. */
  wardens: 'primed' | 'in-session';
}
/**
 * Sized for a full chorus: every Warden is asked on every user message, and every
 * guard-triggered Warden on every action, so one turn fans out ~25 advice calls plus the
 * Cartographer, then guards per tool call and a review per Warden. Each Claude decision is its own
 * CLI process (~130-230 MB measured 2026-10-12), so 16 at once is ~2-4 GB. Queues are deep enough that
 * a burst of guards never refuses admission; a call still waiting at its deadline did not run, and
 * the turn goes on without it. Decisions run at low effort: the model's default (medium) adds ~0.5 s.
 */
export const SUBSCRIPTION_DEFAULTS = {
  maxCalls: 10_000,
  maxQueued: 512,
  maxQueuedPerThread: 256,
  maxConcurrent: { claude: 16, codex: 16 },
  callTimeoutMs: DECISION_DEADLINE_MS,
  effort: 'low',
  /** Just above a typical decision under a full fan-out (≈3–3.7 s live): only the slow tail is duplicated. */
  hedgeAfterMs: 4_000,
} as const;

export interface SubscriptionResolution {
  policy: SubscriptionPolicy;
  /** Each usable subscription worker's login: its vendor's subscription mode is on and (at startup) the login exists. */
  workers: Partial<Record<SubscriptionWorker, NativeProfileSource>>;
  /** Why each other worker is not usable (its vendor's subscription mode is on, its login is not). */
  unavailable: Partial<Record<SubscriptionWorker, string>>;
  decision: NativeProfileSource;
  /** Effective configuration: every enabled decision role runs on the subscription decision profile. */
  config: FoundryConfig;
  /** Decision roles whose saved provider/model differed from the subscription decision profile. */
  rerouted: string[];
}

/** The subscription worker each main thread runs on by default: the global default and every enabled project's. */
export function defaultWorkers(config: FoundryConfig): Map<string, string> {
  const defaults = new Map<string, string>([['global', config.defaults.provider]]);
  for (const [id, project] of Object.entries(config.projects ?? {}))
    if (project.enabled !== false)
      defaults.set(`project ${id}`, project.defaults?.provider ?? config.defaults.provider);
  return defaults;
}

/**
 * One login per runtime: the native profile `defaults.nativeAuthenticationId` names when it is that
 * runtime's, else the runtime's only configured native profile (the decision source gives way to another), else
 * its default profile location. Several of one runtime with none named is ambiguous and refused.
 */
function runtimeLogin(config: FoundryConfig, runtime: 'claude' | 'codex'): NativeProfileSource {
  const named = config.defaults.nativeAuthenticationId
    ? config.nativeAuthentication?.find(
        (item) => item.id === config.defaults.nativeAuthenticationId,
      )
    : undefined;
  if (config.defaults.nativeAuthenticationId && !named)
    throw Error('Subscription-only execution requires native profile sources');
  if (named?.runtime === runtime) {
    if (named.mode !== 'native-profile')
      throw Error('Subscription-only execution requires native profile sources');
    assertProfile(named.profileDirectory, named.runtime);
    return named;
  }
  const configured = (config.nativeAuthentication ?? []).filter(
    (item): item is NativeProfileSource =>
      item.runtime === runtime && item.mode === 'native-profile',
  );
  // Beside another login of its runtime, the decision source is the decisions' own.
  const candidates =
    configured.length > 1
      ? configured.filter((item) => item.id !== config.subscriptionOnly?.decisionSourceId)
      : configured;
  if (candidates.length > 1)
    throw Error(
      `Several ${runtime} logins are configured (${candidates.map((item) => item.id).join(', ')}); name the one main threads use with defaults.nativeAuthenticationId`,
    );
  const only = candidates[0];
  if (only) {
    assertProfile(only.profileDirectory, only.runtime);
    return only;
  }
  return defaultProfileSource(runtime);
}

/**
 * Subscription-only is the default. `apiTokens: true` is the only way to construct API
 * providers. Without it every main thread runs on a subscription worker (Claude Code or Codex, its
 * project's default or the one chosen for the thread) and the decision profile (Claude by default,
 * `decisionRuntime` to change) on subscription logins, referenced in place, with no paid fallback.
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
  const defaults = defaultWorkers(config);
  for (const provider of new Set(defaults.values())) {
    const requirement = mainThreadRequirement(provider, false);
    if (requirement || !subscriptionWorker(provider))
      throw Error(`Subscription-only mode: ${requirement}`);
  }
  const explicit = (id: string) => {
    const found = config.nativeAuthentication?.find((item) => item.id === id);
    if (!found || found.mode !== 'native-profile')
      throw Error('Subscription-only execution requires native profile sources');
    assertProfile(found.profileDirectory, found.runtime);
    return found;
  };
  // Every worker whose vendor's subscription mode is on, with its runtime's one login. A default
  // worker must be usable; another worker without a login is simply not offered.
  const workers: Partial<Record<SubscriptionWorker, NativeProfileSource>> = {};
  const unavailable: Partial<Record<SubscriptionWorker, string>> = {};
  const required = new Set(defaults.values());
  for (const worker of Object.keys(SUBSCRIPTION_WORKERS) as SubscriptionWorker[]) {
    if (!required.has(worker) && !providerEnabled(config, worker)) continue;
    try {
      const login = runtimeLogin(config, SUBSCRIPTION_WORKERS[worker]);
      if (options.startup)
        try {
          assertProfile(login.profileDirectory, login.runtime);
        } catch (error) {
          throw Error(
            `${login.runtime} subscription profile unavailable at ${login.profileDirectory}: ${(error as Error).message}`,
          );
        }
      workers[worker] = login;
    } catch (error) {
      if (required.has(worker)) throw error;
      unavailable[worker] = (error as Error).message;
    }
  }
  const inSession = settings.decisionRuntime === 'claude-in-session';
  if (inSession && !workers['claude-code'])
    throw Error(
      'subscriptionOnly.decisionRuntime claude-in-session holds Wardens inside Claude Code main threads; it needs a usable Claude Code login',
    );
  const decisionRuntime =
    settings.decisionRuntime === 'claude-in-session' ? 'claude' : settings.decisionRuntime;
  const decision = settings.decisionSourceId
    ? explicit(settings.decisionSourceId)
    : defaultProfileSource(decisionRuntime ?? 'claude');
  if (decisionRuntime && decisionRuntime !== decision.runtime)
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
    wardens: inSession ? 'in-session' : 'primed',
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
    try {
      assertProfile(decision.profileDirectory, decision.runtime);
    } catch (error) {
      throw Error(
        `${decision.runtime} subscription profile unavailable at ${decision.profileDirectory}: ${(error as Error).message}`,
      );
    }
    if (!settings.directory) mkdirSync(policy.directory, { recursive: true, mode: 0o700 });
  }
  if (options.startup || settings.directory) assertPrivateProfile(policy.directory);
  // Workers and decisions are shared holders of their logins, like interactive sessions on them.
  const logins = new Set(Object.values(workers).map((login) => login.id));

  const { config: effective, rerouted } = routeDecisions(config, policy.model);
  // Each view is checked against its own worker: the global defaults, then every project's.
  const check = (view: FoundryConfig) => {
    const worker = view.defaults.provider;
    if (!subscriptionWorker(worker) || !workers[worker])
      throw Error(
        `Subscription-only mode: ${mainThreadRequirement(worker, false) ?? `the ${worker} worker has no usable login`}`,
      );
    if (
      (view.defaults.nativeAuthenticationId !== undefined &&
        !logins.has(view.defaults.nativeAuthenticationId)) ||
      view.defaults.kingdomOwnerKey ||
      view.defaults.classifierProvider !== SUBSCRIPTION_DECISIONS ||
      view.defaults.classifierModel !== policy.model
    )
      throw Error(
        'Subscription-only defaults require a configured worker login and the subscription decision model',
      );
    model.parse(view.defaults.model);
    // A main-thread model other than the global default must be one the worker runs.
    const workerModel = (chosen: string) => {
      const refusal =
        chosen === config.defaults.model && worker === config.defaults.provider
          ? undefined
          : workerModelRequirement(worker, chosen);
      if (refusal) throw Error(`Subscription-only mode: ${refusal}`);
    };
    workerModel(view.defaults.model);
    for (const agent of Object.values(view.agents)) {
      if (!agent.enabled) continue;
      const central = agent.kind === 'executor';
      if (
        (agent.provider ?? view.defaults.provider) !==
          (central ? worker : SUBSCRIPTION_DECISIONS) ||
        (!central && (agent.model ?? undefined) !== policy.model) ||
        (!central && agent.tools === true)
      )
        throw Error('Subscription-only agent provider, model or tool override refused');
      if (central) workerModel(agent.model ?? view.defaults.model);
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
  return structuredClone({ policy, workers, unavailable, decision, config: effective, rerouted });
}

/**
 * Why a thread cannot run on `worker` in `view` (its project's view), or undefined when it can.
 * Checked when a thread is created, restored or reopened, so a vendor turned off since is refused.
 * There is never a fallback: no other login, no API provider.
 */
export function threadWorkerRequirement(
  resolution: SubscriptionResolution | undefined,
  view: FoundryConfig,
  worker: string,
): string | undefined {
  if (worker === view.defaults.provider && !resolution) return undefined;
  if (view.apiTokens === true || !resolution)
    return `With apiTokens on, every thread runs on the default provider ${view.defaults.provider}; ${worker} is refused`;
  if (!subscriptionWorker(worker))
    return `${worker} is not a subscription worker; a thread runs on ${Object.keys(SUBSCRIPTION_WORKERS).join(' or ')}`;
  if (!providerEnabled(view, worker))
    return `The ${worker} worker is off: turn on its vendor's subscription mode`;
  if (!resolution.workers[worker])
    return `The ${worker} worker has no usable login${resolution.unavailable[worker] ? ` (${resolution.unavailable[worker]})` : ''}; log in with its CLI and restart Foundry`;
  return undefined;
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
    agent: ProjectAgentSettings,
    inherited?: AgentSettingsConfig,
  ) => {
    if (
      (inherited?.kind ?? (agent as AgentSettingsConfig).kind) === 'executor' ||
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
      route(
        `${projectId}/`,
        id,
        agent,
        isAgentExtension(agent) ? config.agents[agent.extends] : undefined,
      );
  }
  return { config: effective, rerouted };
}
