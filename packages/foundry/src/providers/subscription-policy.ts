/**
 * @atlas
 * @kind config
 * @partOf primitive:decisions
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  MODEL_REGISTRY,
  modelEfforts,
  REASONING_EFFORTS,
  type ReasoningEffort,
  registryModel,
  SUBSCRIPTION_DECISION_MODELS,
  SUBSCRIPTION_WORKER_MODELS,
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
import type { NativeRuntime } from './native-authentication';
import { assertPrivateProfile, assertProfile } from './private-profile';

export const SUBSCRIPTION_DECISIONS = 'subscription-decisions';
const model = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/);
/** Optional overrides of subscription mode. Every field has a default. */
export const subscriptionSettingsSchema = z
  .object({
    /**
     * Decision runtime when no explicit source is named: Claude (`~/.claude`) by default, or Codex.
     * With Claude decisions, Wardens' advice is held in each project's host (`claude-project`, the
     * default: every Warden of a project warm in one Foundry-owned Claude Code process, which every
     * thread of the project asks; docs/subscription-decisions.md, "Project Warden host"). `claude`
     * keeps every Warden on its own primed session (the evals' baseline).
     */
    decisionRuntime: z.enum(['claude', 'codex', 'claude-project']).optional(),
    /** Project hosts only: the host's composition and bounds (PROJECT_HOST_DEFAULTS). */
    projectHost: z
      .object({
        /** Held spares per Warden. */
        sparesPerWarden: z.number().int().min(1).max(4),
        /** Wardens per dispatcher: the roster is cut into slices this size, each refilled at once by its own dispatcher. */
        wardensPerDispatcher: z.number().int().min(1).max(64),
        /** Threads of one project advising at once, for the subagent bound. */
        concurrentTurns: z.number().int().min(1).max(16),
        /** Resident memory the host process tree may hold for a few seconds before it is replaced. */
        maxRssMb: z.number().int().min(256).max(65_536),
        /** Resident memory at which routing leaves the host at once and it is replaced. */
        hardRssMb: z.number().int().min(256).max(65_536),
        /** Dispatcher recycles per hour past which the host is replaced. */
        maxRecyclesPerHour: z.number().int().min(1).max(1_000),
        /** A dispatcher whose context passes this many tokens is recycled. */
        recycleTokens: z.number().int().min(10_000).max(190_000),
        /** Setup deadline. Default: scaled with the roster. */
        setupDeadlineMs: z.number().int().min(5_000).max(600_000),
        /** First wait before a failed host is started again; doubles to 5 minutes. */
        restartBackoffMs: z.number().int().min(100).max(300_000),
        /** A project with no turn or thread activity for this long has its host closed. */
        idleMs: z.number().int().min(60_000).max(86_400_000),
        /** Failed starts in a row before the project stays on primed Wardens until restart. */
        maxRestarts: z.number().int().min(1).max(100),
      })
      .partial()
      .strict()
      .optional(),
    decisionSourceId: z.string().uuid().optional(),
    model: model.optional(),
    expectedObservedModel: model.optional(),
    directory: z.string().startsWith('/').optional(),
    maxCalls: z.number().int().min(1).max(10_000).optional(),
    maxQueued: z.number().int().min(1).max(1_024).optional(),
    maxQueuedPerThread: z.number().int().min(1).max(1_024).optional(),
    maxConcurrent: z.number().int().min(1).max(32).optional(),
    callTimeoutMs: z.number().int().min(100).max(DECISION_CALL_TIMEOUT_MAX_MS).optional(),
    effort: z.enum(REASONING_EFFORTS).optional(),
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
  effort?: ReasoningEffort;
  /** Codex decisions still running after this long are hedged on a second branch. */
  hedgeAfterMs?: number;
  /**
   * Where a thread's Wardens advise: held in its project's host (Claude decisions by default; guard,
   * review and later stages stay primed, and primed serves while no host does), or primed sessions
   * (Codex decisions, or `decisionRuntime: claude`).
   */
  wardens: 'primed' | 'project';
  /** Project hosts: their composition and bounds, defaults filled. */
  projectHost?: ProjectHostPolicy;
}

export type ProjectHostPolicy = Required<
  Omit<NonNullable<SubscriptionSettings['projectHost']>, 'setupDeadlineMs'>
> &
  Pick<NonNullable<SubscriptionSettings['projectHost']>, 'setupDeadlineMs'>;

/**
 * The project host's defaults (oracle docs/foundry/PROJECT-WARDEN-HOST.md, "Memory and health"). One
 * spare per Warden to start (75 held measured in 31 s). Two threads of a project advising at once size
 * the subagent bound. Memory, measured 2026-11-02 (75 Wardens, 48 KB each, 15 rounds, one process):
 * ~1.0-1.4 GB between rounds, every fan-out peaking 1.5-2.5 GB for about two seconds, and twice a
 * climb at ~400 MB/s (to 5.9 GB, which fell back, and to 12.5 GB, which did not). So 1.5 GB held for
 * a few seconds starts a replacement while the old host serves, and 4 GB takes routing off the host at
 * once. A dispatcher grows ~400-600 tokens per member it starts (75 per advice fan-out), so 140k
 * recycles about every three turns, inside Haiku's window.
 */
export const PROJECT_HOST_DEFAULTS = {
  sparesPerWarden: 1,
  // why: one dispatcher refilled 75 held Wardens in ~20 s (2026-11-02).
  wardensPerDispatcher: 8,
  concurrentTurns: 2,
  maxRssMb: 1_536,
  hardRssMb: 4_096,
  maxRecyclesPerHour: 20,
  recycleTokens: 140_000,
  restartBackoffMs: 5_000,
  maxRestarts: 5,
  /** As primed roles are evicted after 30 minutes idle. */
  idleMs: 1_800_000,
} as const satisfies Omit<ProjectHostPolicy, 'setupDeadlineMs'>;
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
  /** Each usable worker's logins, its primary (`workers`) among them: several are balanced (login-pool.ts). */
  pools: Partial<Record<SubscriptionWorker, NativeProfileSource[]>>;
  /** Why each other worker is not usable (its vendor's subscription mode is on, its login is not). */
  unavailable: Partial<Record<SubscriptionWorker, string>>;
  /** Every worker a thread may name: its vendor's subscription mode is on, or a project defaults to it.
   * Each gets an adapter; one without a login runs only a Kingdom-capacity project's threads. */
  offered: SubscriptionWorker[];
  decision: DecisionProfileSource;
  /** Effective configuration: every enabled decision role runs on the subscription decision profile. */
  config: FoundryConfig;
  /** Decision roles whose saved provider/model differed from the subscription decision profile. */
  rerouted: string[];
}

/** A login decisions run on: Claude's or Codex's (primed sessions); never Muse Code's. */
export type DecisionProfileSource = NativeProfileSource & { runtime: 'claude' | 'codex' };
const isDecisionSource = (source: NativeProfileSource): source is DecisionProfileSource =>
  source.runtime === 'claude' || source.runtime === 'codex';

/** The subscription worker each main thread runs on by default: the global default and every enabled project's. */
export function defaultWorkers(
  config: FoundryConfig,
  options: { onThisMachine?: boolean } = {},
): Map<string, string> {
  const defaults = new Map<string, string>([['global', config.defaults.provider]]);
  for (const [id, project] of Object.entries(config.projects ?? {}))
    if (project.enabled !== false && !(options.onThisMachine && project.capacity === 'kingdom'))
      defaults.set(`project ${id}`, project.defaults?.provider ?? config.defaults.provider);
  return defaults;
}

/** A worker's adapter default model: the global model on the global worker, else the worker's own. */
export function workerDefaultModel(config: FoundryConfig, worker: string): string {
  return worker === config.defaults.provider
    ? config.defaults.model
    : (SUBSCRIPTION_WORKER_MODELS[worker as keyof typeof SUBSCRIPTION_WORKER_MODELS] ??
        config.defaults.model);
}

/** How a runtime with several logins chooses one: agent-session's routing strategies. */
export const LOGIN_ROUTINGS = ['quartile-balanced', 'owner-first', 'priority-balanced'] as const;
export type LoginRouting = (typeof LOGIN_ROUTINGS)[number];
/** The pooled runtimes: Muse Code keeps one login (agent-session does not pool Muse yet). */
export const POOLED_RUNTIMES = ['claude', 'codex'] as const;
export type PooledRuntime = (typeof POOLED_RUNTIMES)[number];

/**
 * One runtime's balancing: the routing, the login `owner-first` prefers, and `pinned` (the scale
 * off: every launch runs on the preferred login). Pinning keeps the routing for when it is turned back on.
 */
export interface LoginPoolSettings {
  routing?: LoginRouting;
  preferredLoginId?: string;
  pinned?: boolean;
}
export type LoginPoolsSettings = Partial<Record<PooledRuntime, LoginPoolSettings>>;

export function validateLoginPools(where: string, pools: unknown): void {
  if (pools === undefined) return;
  if (!pools || typeof pools !== 'object' || Array.isArray(pools))
    throw Error(`${where} must be an object keyed by runtime (claude, codex)`);
  for (const [runtime, pool] of Object.entries(pools as Record<string, unknown>)) {
    if (!(POOLED_RUNTIMES as readonly string[]).includes(runtime))
      throw Error(`${where}.${runtime}: only ${POOLED_RUNTIMES.join(' and ')} logins are pooled`);
    if (!pool || typeof pool !== 'object' || Array.isArray(pool))
      throw Error(`${where}.${runtime} must be { routing?, preferredLoginId?, pinned? }`);
    for (const key of Object.keys(pool))
      if (key !== 'routing' && key !== 'preferredLoginId' && key !== 'pinned')
        throw Error(
          `${where}.${runtime}.${key} is not a pool setting (routing, preferredLoginId, pinned)`,
        );
    const { routing, preferredLoginId, pinned } = pool as LoginPoolSettings;
    if (pinned !== undefined && typeof pinned !== 'boolean')
      throw Error(`${where}.${runtime}.pinned must be true or false`);
    if (routing !== undefined && !LOGIN_ROUTINGS.includes(routing))
      throw Error(`${where}.${runtime}.routing must be one of ${LOGIN_ROUTINGS.join(', ')}`);
    if (preferredLoginId !== undefined && typeof preferredLoginId !== 'string')
      throw Error(`${where}.${runtime}.preferredLoginId must be a login id`);
  }
}

/** A runtime's pool settings: the project's (yours) over the Foundry-wide ones. */
export function loginPoolSettings(
  config: Pick<FoundryConfig, 'subscriptionPools' | 'projects'>,
  runtime: PooledRuntime,
  projectId?: string,
): LoginPoolSettings & { from: 'project' | 'foundry' | 'default' } {
  const project = projectId
    ? config.projects?.[projectId]?.subscriptionPools?.[runtime]
    : undefined;
  const global = config.subscriptionPools?.[runtime];
  const routing = project?.routing ?? global?.routing;
  const preferredLoginId = project?.preferredLoginId ?? global?.preferredLoginId;
  const pinned = project?.pinned ?? global?.pinned;
  return {
    ...(routing ? { routing } : {}),
    ...(preferredLoginId ? { preferredLoginId } : {}),
    ...(pinned ? { pinned } : {}),
    from: project && Object.keys(project).length ? 'project' : global ? 'foundry' : 'default',
  };
}

/**
 * Every login of a runtime, in the order they were added: each configured native profile of that
 * runtime (not the decision login when it is the only one), else the runtime's default profile
 * location. The first is the primary login: `defaults.nativeAuthenticationId` when it names one of
 * them, else the first. Several logins are a pool (Aron, 2026-11-02: "I have 3 subs").
 */
export function runtimeLogins(
  config: FoundryConfig,
  runtime: NativeRuntime,
): { primary: NativeProfileSource; logins: NativeProfileSource[] } {
  const named = config.defaults.nativeAuthenticationId
    ? config.nativeAuthentication?.find(
        (item) => item.id === config.defaults.nativeAuthenticationId,
      )
    : undefined;
  if (config.defaults.nativeAuthenticationId && !named)
    throw Error('Subscription-only execution requires native profile sources');
  if (named?.runtime === runtime && named.mode !== 'native-profile')
    throw Error('Subscription-only execution requires native profile sources');
  // The decision login is the Wardens', never a main thread's, unless it is also the named primary.
  const decisionId = config.subscriptionOnly?.decisionSourceId;
  const configured = (config.nativeAuthentication ?? []).filter(
    (item): item is NativeProfileSource =>
      item.runtime === runtime &&
      item.mode === 'native-profile' &&
      (item.id !== decisionId || item.id === config.defaults.nativeAuthenticationId),
  );
  // A runtime whose only configured sources are the decision login runs main threads on its default profile.
  if (!configured.length) {
    const fallback = defaultProfileSource(runtime);
    return { primary: fallback, logins: [fallback] };
  }
  // Muse Code runs only the user's own login; more than one is not a pool.
  if (runtime === 'muse' && configured.length > 1)
    throw Error(
      `Several Muse Code logins are configured (${configured.map((item) => item.id).join(', ')}); Muse Code runs one login`,
    );
  const primary = named?.runtime === runtime ? (named as NativeProfileSource) : configured[0]!;
  return { primary, logins: configured };
}

/**
 * A runtime's logins that can run now (read live, so a login added or removed in Settings applies to
 * the next launch): each configured one whose profile is usable, its primary first when usable.
 */
export function usableLogins(
  config: FoundryConfig,
  runtime: NativeRuntime,
): { primary: NativeProfileSource; logins: NativeProfileSource[] } {
  const { primary, logins } = runtimeLogins(config, runtime);
  const configured = new Set((config.nativeAuthentication ?? []).map((item) => item.id));
  const usable = logins.filter((login) => {
    // The default location was checked at startup; configured logins are checked as they are read.
    if (!configured.has(login.id)) return true;
    try {
      assertProfile(login.profileDirectory, login.runtime);
      return true;
    } catch {
      return false;
    }
  });
  return {
    primary: usable.includes(primary) ? primary : (usable[0] ?? primary),
    logins: usable,
  };
}

/**
 * Whether Claude Wardens advise from their project's host: the default for Claude decisions (Aron,
 * 2026-11-03: "the Claude project is the only thing that actually makes sense"), and what
 * `claude-project` names. `claude` keeps primed Wardens; Codex decisions have no project host.
 */
export function wardensInProjectHosts(
  decisionRuntime: SubscriptionSettings['decisionRuntime'],
  decisionSourceRuntime: NativeRuntime,
): boolean {
  return (
    decisionSourceRuntime === 'claude' &&
    (decisionRuntime === undefined || decisionRuntime === 'claude-project')
  );
}

/**
 * The same answer from settings alone (where Wardens compose, `projectWardenRoot`): `claude-project`
 * named, or, with none named, subscription mode on Claude decisions.
 */
export function configuredProjectWardens(
  config: Pick<FoundryConfig, 'apiTokens' | 'subscriptionOnly' | 'nativeAuthentication'>,
): boolean {
  const settings = config.subscriptionOnly ?? {};
  if (settings.decisionRuntime === 'claude-project') return true;
  if (config.apiTokens) return false;
  const named = settings.decisionSourceId
    ? config.nativeAuthentication?.find((item) => item.id === settings.decisionSourceId)?.runtime
    : undefined;
  const runtime = named ?? (settings.decisionRuntime === 'codex' ? 'codex' : 'claude');
  return wardensInProjectHosts(settings.decisionRuntime, runtime);
}

/**
 * `claude-in-session` (a thread's Wardens held inside its own Claude Code process) was removed on
 * 2026-11-03 for the per-project host. A saved setting naming it is refused with the fix (no alias).
 */
function refuseRemovedDecisionRuntime(settings: unknown): void {
  const runtime = (settings as { decisionRuntime?: unknown } | undefined)?.decisionRuntime;
  if (runtime === 'claude-in-session')
    throw Error(
      'subscriptionOnly.decisionRuntime "claude-in-session" is gone: Claude Wardens are held in each project\'s host (claude-project), the default for Claude decisions. Remove "decisionRuntime" (or write "claude-project"); "claude" keeps primed Wardens (docs/subscription-decisions.md, "Project Warden host")',
    );
}

/**
 * Subscription-only is the default. `apiTokens: true` is the only way to construct API
 * providers. Without it every main thread runs on a subscription worker (Claude Code, Codex or Muse Code, its
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
  refuseRemovedDecisionRuntime(config.subscriptionOnly);
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
  // Every worker whose vendor's subscription mode is on (or a project's default) is offered, and
  // runs threads on its runtime's one login. A default worker of a thread that runs on this machine
  // must have that login; a Kingdom-capacity project's threads run on its pool, never on it.
  const workers: Partial<Record<SubscriptionWorker, NativeProfileSource>> = {};
  const pools: Partial<Record<SubscriptionWorker, NativeProfileSource[]>> = {};
  const unavailable: Partial<Record<SubscriptionWorker, string>> = {};
  const offered: SubscriptionWorker[] = [];
  const required = new Set(defaultWorkers(config, { onThisMachine: true }).values());
  const projectDefaults = new Set(defaults.values());
  for (const worker of Object.keys(SUBSCRIPTION_WORKERS) as SubscriptionWorker[]) {
    if (!projectDefaults.has(worker) && !providerEnabled(config, worker)) continue;
    offered.push(worker);
    try {
      const { primary, logins } = runtimeLogins(config, SUBSCRIPTION_WORKERS[worker]);
      const configured = new Set((config.nativeAuthentication ?? []).map((item) => item.id));
      // Configured logins are checked on every save, the default location only at startup. A login
      // whose profile is unusable is left out of the pool; the worker needs at least one usable.
      const usable: NativeProfileSource[] = [];
      const refusals: string[] = [];
      for (const login of logins)
        try {
          if (options.startup || configured.has(login.id))
            assertProfile(login.profileDirectory, login.runtime);
          usable.push(login);
        } catch (error) {
          refusals.push(
            `${login.runtime} subscription profile unavailable at ${login.profileDirectory}: ${(error as Error).message}`,
          );
        }
      if (!usable.length) throw Error(refusals.join('; '));
      workers[worker] = usable.includes(primary) ? primary : usable[0]!;
      pools[worker] = usable;
    } catch (error) {
      if (required.has(worker)) throw error;
      unavailable[worker] = (error as Error).message;
    }
  }
  const decisionRuntime =
    settings.decisionRuntime === 'claude-project' ? 'claude' : settings.decisionRuntime;
  const source = settings.decisionSourceId
    ? explicit(settings.decisionSourceId)
    : defaultProfileSource(decisionRuntime ?? 'claude');
  // Decisions run on primed Claude or Codex sessions; Muse Code runs main threads only.
  if (!isDecisionSource(source))
    throw Error(
      'subscriptionOnly.decisionSourceId must be a Claude or Codex login; Muse Code runs main threads only',
    );
  const decision = source;
  if (decisionRuntime && decisionRuntime !== decision.runtime)
    throw Error('subscriptionOnly.decisionRuntime does not match the decision source runtime');
  const project = wardensInProjectHosts(settings.decisionRuntime, decision.runtime);
  if (settings.projectHost && !project)
    throw Error(
      'subscriptionOnly.projectHost applies only to project Warden hosts (Claude decisions without decisionRuntime "claude")',
    );
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
    wardens: project ? 'project' : 'primed',
    ...(project ? { projectHost: { ...PROJECT_HOST_DEFAULTS, ...settings.projectHost } } : {}),
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
  const takes = policy.effort && modelEfforts(runtimeProvider[decision.runtime], policy.model);
  if (takes && policy.effort && !takes.includes(policy.effort))
    throw Error(
      `subscriptionOnly.effort ${policy.effort} is not one ${policy.model} takes (${takes.join(', ')})`,
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
  const logins = new Set(
    Object.values(pools).flatMap((pool) => (pool ?? []).map((login) => login.id)),
  );

  const { config: effective, rerouted } = routeDecisions(config, policy.model);
  // Each view is checked against its own worker: the global defaults, then every project's.
  const check = (view: FoundryConfig, pooled = false) => {
    const worker = view.defaults.provider;
    if (!subscriptionWorker(worker) || !(pooled ? offered.includes(worker) : workers[worker]))
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
  for (const [id, project] of Object.entries(effective.projects))
    check(
      resolveProjectView(effective, id, { repository: false })!.config,
      project.capacity === 'kingdom',
    );
  return structuredClone({
    policy,
    workers,
    pools,
    unavailable,
    offered,
    decision,
    config: effective,
    rerouted,
  });
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
  projectId?: string,
): string | undefined {
  if (worker === view.defaults.provider && !resolution) return undefined;
  if (view.apiTokens === true || !resolution)
    return `With apiTokens on, every thread runs on the default provider ${view.defaults.provider}; ${worker} is refused`;
  if (!subscriptionWorker(worker))
    return `${worker} is not a subscription worker; a thread runs on ${Object.keys(SUBSCRIPTION_WORKERS).join(' or ')}`;
  if (!providerEnabled(view, worker))
    return `The ${worker} worker is off: turn on its vendor's subscription mode`;
  if (!resolution.offered.includes(worker))
    return `The ${worker} worker was not started with Foundry; restart Foundry`;
  // A Kingdom-capacity project's threads run on its pool, which refuses a runtime it has no login for;
  // a pooled thread never falls back to this machine's login.
  if (projectId && view.projects[projectId]?.capacity === 'kingdom') return undefined;
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
