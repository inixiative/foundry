import type { CompletionOpts, ContextLayer, LLMProvider } from '@inixiative/foundry-core';
import { vendorOfProvider } from '@inixiative/foundry-core';
import { providerEnabled } from '../models/vendors';
import { roleComposition } from '../prompts/instruction-settings';
import type { AgentSettingsConfig, FoundryConfig } from '../viewer/config';
import { resolveProjectView } from '../viewer/config-resolve';
import { threadKnowledgeLayerId } from './domain-librarian';
import { resolveLearningSettings, validateLearningSettings } from './learning-config';
import type { LearningConfig, ThreadDomainConfig } from './thread-runtime';

export interface ConfiguredExpert {
  readonly agentId: string;
  readonly domain: string;
  readonly agent: AgentSettingsConfig;
}

const identity = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value);
// Diagnostics contain escaped, bounded identities and field names only, never
// layer contents, instructions, writer lists or provider configuration payloads.
const diagnosticLabel = (value: string): string => {
  const escaped = JSON.stringify(value);
  return escaped.length <= 202 ? escaped : `${escaped.slice(0, 199)}...`;
};

/**
 * Resolve declarations only. No provider construction, layer writes or runtime attachment. The
 * Wardens of `config` are a project view's generated region Wardens (settings declare none; the
 * hand-named roster was retired 2026-10-17), so a config without a project has none. A Warden's
 * instructions and domain knowledge come from the composition view (its `prompt` and
 * `domainKnowledge` sources, then the ladder's files for its role); it owns no configured layer.
 */
export function configuredExperts(config: FoundryConfig): {
  experts: ConfiguredExpert[];
  claimedDomains: Set<string>;
} {
  const experts: ConfiguredExpert[] = [],
    claimedDomains = new Set<string>();
  const domains = new Map<string, string>();
  for (const [id, agent] of Object.entries(config.agents)) {
    if (agent.flowRole !== 'domain-advising') continue;
    if (!identity(id) || agent.id !== id || !identity(agent.domain))
      throw Error(`Invalid configured expert identity: ${id}`);
    if (typeof agent.enabled !== 'boolean') throw Error(`Invalid expert enablement: ${id}`);
    claimedDomains.add(agent.domain);
    if (!agent.enabled) continue;
    if (agent.kind !== 'domain-librarian') throw Error(`Unsupported configured expert kind: ${id}`);
    if (agent.ownedLayers?.length)
      throw Error(
        `Expert ${id} owns layers (${agent.ownedLayers.join(', ')}); a Warden reads its knowledge from the composition view: list the sources in agents.${id}.domainKnowledge and drop ownedLayers`,
      );
    if (
      agent.domainKnowledge !== undefined &&
      (!Array.isArray(agent.domainKnowledge) ||
        agent.domainKnowledge.some((source) => typeof source !== 'string' || !source))
    )
      throw Error(`Expert ${id} domainKnowledge must be source ids`);
    const unknown = (agent.domainKnowledge ?? []).filter((source) => !config.sources[source]);
    if (unknown.length)
      throw Error(`Expert ${id} domainKnowledge names unknown sources: ${unknown.join(', ')}`);
    const disabled = (agent.domainKnowledge ?? []).filter(
      (source) => !config.sources[source]!.enabled,
    );
    if (disabled.length)
      throw Error(`Expert ${id} domainKnowledge names disabled sources: ${disabled.join(', ')}`);
    // Instruction files reach a Warden through its own role in the composition view, with its own
    // picks and audience; an instructions source here would compose the main thread's instead.
    const composed = (agent.domainKnowledge ?? []).filter(
      (source) => config.sources[source]!.type === 'instructions',
    );
    if (composed.length)
      throw Error(
        `Expert ${id} domainKnowledge names instructions sources (${composed.join(', ')}); pick instruction files with composition.roles.${id}.domainKnowledge.general`,
      );
    if (domains.has(agent.domain)) throw Error(`Duplicate expert domain: ${agent.domain}`);
    domains.set(agent.domain, id);
    if (typeof agent.prompt !== 'string' || !agent.prompt.trim())
      throw Error(`Expert ${id} requires explicit instructions`);
    if (
      agent.guardTriggers !== undefined &&
      (!Array.isArray(agent.guardTriggers) ||
        agent.guardTriggers.length > 32 ||
        agent.guardTriggers.some(
          (tool) => typeof tool !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(tool),
        ) ||
        new Set(agent.guardTriggers).size !== agent.guardTriggers.length)
    )
      throw Error(`Invalid expert guard triggers: ${id}`);
    if (
      (agent.tools !== undefined && agent.tools !== false) ||
      agent.browser !== undefined ||
      agent.executionEnv !== undefined ||
      agent.permissions !== undefined ||
      agent.peers.length ||
      agent.invocation === 'conditional' ||
      agent.condition !== undefined ||
      agent.visibleLayers.some((layer) => layer !== 'thread-state')
    )
      throw Error(`Unsupported configured expert tools, delegation or context policy: ${id}`);
    if (agent.timeout !== undefined && (!Number.isSafeInteger(agent.timeout) || agent.timeout < 1))
      throw Error(`Invalid expert timeout: ${id}`);
    if (
      agent.temperature !== undefined &&
      (!Number.isFinite(agent.temperature) || agent.temperature < 0 || agent.temperature > 2)
    )
      throw Error(`Invalid expert temperature: ${id}`);
    if (agent.cacheControl !== undefined && typeof agent.cacheControl !== 'boolean')
      throw Error(`Invalid expert cache control: ${id}`);
    validateLearningSettings({
      review: {
        ...(agent.provider !== undefined ? { provider: agent.provider } : {}),
        ...(agent.model !== undefined ? { model: agent.model } : {}),
        ...(agent.thinking !== undefined ? { thinking: agent.thinking } : {}),
      },
    });
    experts.push({ agentId: id, domain: agent.domain, agent: structuredClone(agent) });
  }
  return { experts, claimedDomains };
}

/**
 * The largest chorus any thread of this Foundry runs: an enabled project's region Wardens. Sizes the
 * primed decision pool, which every project's threads share.
 */
export function largestRoster(config: FoundryConfig): number {
  let largest = 0;
  for (const [id, project] of Object.entries(config.projects ?? {})) {
    if (project.enabled === false) continue;
    const view = resolveProjectView(config, id);
    if (view) largest = Math.max(largest, configuredExperts(view.config).experts.length);
  }
  return largest;
}

/** The most classify stages any running chorus asks per Warden: each keeps its own primed session. */
export function largestStageCount(config: FoundryConfig): number {
  let largest = 1;
  for (const [id, project] of Object.entries(config.projects ?? {})) {
    if (project.enabled === false) continue;
    const view = resolveProjectView(config, id);
    if (view?.chorus.on) largest = Math.max(largest, view.chorus.roles.warden.stages.length);
  }
  return largest;
}

/** The Cartographer's role in the composition view: the enabled cartographer agent's id, else "cartographer". */
export function cartographerRoleId(config: FoundryConfig): string {
  return (
    Object.values(config.agents).find((a) => a.enabled && a.kind === 'cartographer')?.id ??
    'cartographer'
  );
}

export interface ResolvedThreadDomain extends Omit<ThreadDomainConfig, 'layerId'> {
  /** Programmatic domains only: the stack layer it reads. A configured Warden reads its role's view. */
  layerId?: string;
  expert?: { agentId: string; source: 'configured' };
  adviseProvider?: LLMProvider;
  adviseOpts?: CompletionOpts;
  reviewProvider?: LLMProvider;
}

/** Existing phase providers only. Explicit expert profiles never use an unrelated flow fallback. */
export function resolveThreadDomains(
  config: FoundryConfig,
  available: ReadonlyMap<string, Pick<ContextLayer, 'definition' | 'segment'>>,
  options: {
    /** Domain defaults by name (guard triggers, programmatic guard) for configured Wardens without their own. */
    policy: readonly ThreadDomainConfig[];
    /** Wardens registered in code over a stack layer (tests, research runs); never from settings. */
    programmatic: readonly ThreadDomainConfig[];
    llm: LLMProvider;
    providers?: ReadonlyMap<string, LLMProvider>;
    learning?: LearningConfig;
    /** Existing runtime reporting hook; emitted once after complete validation. */
    warn?: (line: string) => void;
  },
): ResolvedThreadDomain[] {
  const { experts, claimedDomains } = configuredExperts(config);
  const diagnostics = new Set<string>();
  const providers = new Map([
    [options.llm.id, options.llm],
    ...(options.learning?.reviewProvider
      ? [[options.learning.reviewProvider.id, options.learning.reviewProvider] as const]
      : []),
    ...(options.providers ?? []),
  ]);
  const providerFor = (id: string) => {
    const provider = providers.get(id);
    // An unregistered id is an adapter supplied in code (tests, Oracle); a registered one must be switched on.
    if (!provider || (vendorOfProvider(id) && !providerEnabled(config, id)))
      throw Error(`Configured expert provider unavailable: ${id}`);
    return provider;
  };
  const validateNative = (provider: LLMProvider, opts: CompletionOpts) => {
    // Mirrors the established startup restriction. There is no public native
    // auxiliary capability negotiation; reject unsupported requests before send.
    if (
      provider.completionLifecycle?.kind !== 'session' &&
      provider.nativeOwnership !== 'required-prewrite'
    )
      return;
    if (!['claude-code', 'subscription-decisions'].includes(provider.id))
      throw Error('Configured native expert requires an available text-only Claude provider');
    if (opts.thinking !== undefined)
      throw Error('Native expert thinking/effort cannot be enforced by the current adapter');
    if (opts.cacheControl !== undefined || opts.temperature !== 0)
      throw Error(
        'Native expert cache/temperature setting cannot be enforced by the current adapter',
      );
  };
  const result: ResolvedThreadDomain[] = experts.map(({ agentId, domain, agent }) => {
    const provider = providerFor(agent.provider || config.defaults.provider);
    const model = agent.model || config.defaults.model;
    if (!model?.trim()) throw Error(`Configured expert model unavailable: ${agentId}`);
    const opts: CompletionOpts = {
      model,
      temperature: agent.temperature ?? 0,
      tools: false,
      maxTurns: 1,
      ...(agent.thinking !== undefined ? { thinking: agent.thinking } : {}),
      ...(agent.timeout !== undefined ? { timeout: agent.timeout } : {}),
      ...(agent.cacheControl !== undefined ? { cacheControl: agent.cacheControl } : {}),
    };
    const phase = config.learning?.review
      ? resolveLearningSettings(config.learning, providers, provider, model)
      : undefined;
    const reviewProvider = phase?.reviewProvider ?? provider;
    providerFor(reviewProvider.id);
    const reviewOpts: CompletionOpts = {
      ...opts,
      maxTokens: options.learning?.reviewOpts?.maxTokens ?? 1600,
      ...phase?.reviewOpts,
      timeout: 0,
    };
    validateNative(provider, opts);
    validateNative(reviewProvider, reviewOpts);
    if (phase) {
      const changed = [
        ...(provider.id !== reviewProvider.id ? ['provider'] : []),
        ...(opts.model !== reviewOpts.model ? ['model'] : []),
        ...(opts.thinking !== reviewOpts.thinking ? ['thinking'] : []),
        ...((options.learning?.reviewOpts?.maxTokens ?? 1600) !== reviewOpts.maxTokens
          ? ['maxTokens']
          : []),
      ];
      if (changed.length)
        diagnostics.add(
          `[expert-review-profile-override] domain=${diagnosticLabel(domain)} agent=${diagnosticLabel(agentId)}: explicit learning.review takes precedence for post-review; changed=${changed.join(',')}. Advise/guard profile is unchanged. Inspect learning.review and this expert's profile; these are requested settings, not native acknowledgment.`,
        );
    }
    const policy = options.policy.find((d) => d.domain === domain);
    return {
      domain,
      expert: { agentId, source: 'configured' },
      budget: roleComposition(config.composition, agentId).budget,
      guardTriggers: [...(agent.guardTriggers ?? policy?.guardTriggers ?? [])],
      programmaticGuard: policy?.programmaticGuard,
      adviseProvider: provider,
      adviseOpts: { ...opts, maxTokens: 512 },
      reviewProvider,
      reviewOpts,
      // One set of instructions for every phase; each phase appends its own response protocol.
      advisePrompt: agent.prompt,
      guardPrompt: agent.prompt,
      reviewPrompt: agent.prompt,
    };
  });
  // Wardens registered in code read the stack layer they name, where no configured Warden holds the domain.
  for (const dc of options.programmatic) {
    const instance = available.get(dc.layerId);
    if (claimedDomains.has(dc.domain) || !instance || instance.segment === 'thread-knowledge')
      continue;
    result.push({ ...dc, guardTriggers: [...dc.guardTriggers] });
  }
  const seenDomains = new Set<string>(),
    seenLayers = new Set<string>();
  for (const dc of result) {
    if (
      !identity(dc.domain) ||
      seenDomains.has(dc.domain) ||
      (dc.layerId !== undefined && seenLayers.has(dc.layerId))
    )
      throw Error(`Ambiguous runtime expert ownership: ${dc.domain}`);
    if (available.has(threadKnowledgeLayerId(dc.domain)))
      throw Error(`Generated expert layer already exists: ${dc.domain}`);
    seenDomains.add(dc.domain);
    if (dc.layerId !== undefined) seenLayers.add(dc.layerId);
  }
  for (const diagnostic of diagnostics) options.warn?.(diagnostic);
  return result;
}
