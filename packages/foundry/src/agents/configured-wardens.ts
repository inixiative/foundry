/**
 * @atlas
 * @kind config
 * @partOf feature:flow, feature:wardens
 */
import type { CompletionOpts, ContextLayer, LLMProvider } from '@inixiative/foundry-core';
import { vendorOfProvider } from '@inixiative/foundry-core';
import { DEFAULT_STAGES, type StageConfig } from '../classify';
import { providerEnabled } from '../models/vendors';
import { roleComposition } from '../prompts/instruction-settings';
import { isIdName, isRoleId } from '../prompts/role-namespace';
import type { AgentSettingsConfig, FoundryConfig } from '../viewer/config';
import { resolveProjectView } from '../viewer/config-resolve';
import { resolveLearningSettings, validateLearningSettings } from './learning-config';
import type { CodeWardenConfig, LearningConfig } from './thread-runtime';
import { threadKnowledgeLayerId } from './warden';

export interface ConfiguredWarden {
  readonly agentId: string;
  readonly domain: string;
  readonly agent: AgentSettingsConfig;
}

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
export function configuredWardens(config: FoundryConfig): {
  wardens: ConfiguredWarden[];
  claimedDomains: Set<string>;
} {
  const wardens: ConfiguredWarden[] = [],
    claimedDomains = new Set<string>();
  const domains = new Map<string, string>();
  for (const [id, agent] of Object.entries(config.agents)) {
    if (agent.flowRole !== 'warden') continue;
    if (!isRoleId(id) || agent.id !== id || !isIdName(agent.domain))
      throw Error(`Invalid Warden identity: ${id}`);
    if (typeof agent.enabled !== 'boolean') throw Error(`Invalid Warden enablement: ${id}`);
    claimedDomains.add(agent.domain);
    if (!agent.enabled) continue;
    if (agent.kind !== 'warden') throw Error(`Unsupported Warden kind: ${id}`);
    if (
      agent.domainKnowledge !== undefined &&
      (!Array.isArray(agent.domainKnowledge) ||
        agent.domainKnowledge.some((source) => typeof source !== 'string' || !source))
    )
      throw Error(`Warden ${id} domainKnowledge must be source ids`);
    const unknown = (agent.domainKnowledge ?? []).filter((source) => !config.sources[source]);
    if (unknown.length)
      throw Error(`Warden ${id} domainKnowledge names unknown sources: ${unknown.join(', ')}`);
    const disabled = (agent.domainKnowledge ?? []).filter(
      (source) => !config.sources[source]!.enabled,
    );
    if (disabled.length)
      throw Error(`Warden ${id} domainKnowledge names disabled sources: ${disabled.join(', ')}`);
    // Instruction files never reach a region Warden (Aron, 2026-11-02); for another role they come
    // through its own picks in the composition view, never as an instructions source here.
    const composed = (agent.domainKnowledge ?? []).filter(
      (source) => config.sources[source]!.type === 'instructions',
    );
    if (composed.length)
      throw Error(
        `Warden ${id} domainKnowledge names instructions sources (${composed.join(', ')}); a Warden reads its role files and region, never instruction files`,
      );
    if (domains.has(agent.domain)) throw Error(`Duplicate Warden domain: ${agent.domain}`);
    domains.set(agent.domain, id);
    if (typeof agent.prompt !== 'string' || !agent.prompt.trim())
      throw Error(`Warden ${id} requires explicit instructions`);
    if (
      agent.guardTriggers !== undefined &&
      (!Array.isArray(agent.guardTriggers) ||
        agent.guardTriggers.length > 32 ||
        agent.guardTriggers.some(
          (tool) => typeof tool !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(tool),
        ) ||
        new Set(agent.guardTriggers).size !== agent.guardTriggers.length)
    )
      throw Error(`Invalid Warden guard triggers: ${id}`);
    if (
      (agent.tools !== undefined && agent.tools !== false) ||
      agent.browser !== undefined ||
      agent.permissions !== undefined
    )
      throw Error(`Unsupported Warden tools or permissions: ${id}`);
    if (agent.timeout !== undefined && (!Number.isSafeInteger(agent.timeout) || agent.timeout < 1))
      throw Error(`Invalid Warden timeout: ${id}`);
    if (
      agent.temperature !== undefined &&
      (!Number.isFinite(agent.temperature) || agent.temperature < 0 || agent.temperature > 2)
    )
      throw Error(`Invalid Warden temperature: ${id}`);
    if (agent.cacheControl !== undefined && typeof agent.cacheControl !== 'boolean')
      throw Error(`Invalid Warden cache control: ${id}`);
    validateLearningSettings({
      review: {
        ...(agent.provider !== undefined ? { provider: agent.provider } : {}),
        ...(agent.model !== undefined ? { model: agent.model } : {}),
        ...(agent.thinking !== undefined ? { thinking: agent.thinking } : {}),
      },
    });
    wardens.push({ agentId: id, domain: agent.domain, agent: structuredClone(agent) });
  }
  return { wardens, claimedDomains };
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
    if (view) largest = Math.max(largest, configuredWardens(view.config).wardens.length);
  }
  return largest;
}

/**
 * The most classify stages any running chorus asks per Warden, of those `counts` selects (the ones a
 * given decision host serves): each keeps its own primed session.
 */
export function largestStageCount(
  config: FoundryConfig,
  counts: (stage: StageConfig) => boolean = () => true,
): number {
  let largest = DEFAULT_STAGES.filter(counts).length;
  for (const [id, project] of Object.entries(config.projects ?? {})) {
    if (project.enabled === false) continue;
    const view = resolveProjectView(config, id);
    if (view?.chorus.on)
      largest = Math.max(largest, view.chorus.roles.warden.stages.filter(counts).length);
  }
  return largest;
}

export interface ResolvedCodeWarden extends Omit<CodeWardenConfig, 'layerId'> {
  /** Wardens registered in code only: the stack layer it reads. A configured Warden reads its role's view. */
  layerId?: string;
  /** A Warden resolved from settings (a project's region Warden): its agent id. Absent for one registered in code. */
  configuredAgentId?: string;
  adviseProvider?: LLMProvider;
  adviseOpts?: CompletionOpts;
  reviewProvider?: LLMProvider;
}

/** Existing phase providers only. Explicit Warden profiles never use an unrelated flow fallback. */
export function resolveThreadWardens(
  config: FoundryConfig,
  available: ReadonlyMap<string, Pick<ContextLayer, 'definition' | 'segment'>>,
  options: {
    /** Wardens registered in code over a stack layer (tests, research runs); never from settings. */
    codeWardens: readonly CodeWardenConfig[];
    llm: LLMProvider;
    providers?: ReadonlyMap<string, LLMProvider>;
    learning?: LearningConfig;
    /** Existing runtime reporting hook; emitted once after complete validation. */
    warn?: (line: string) => void;
  },
): ResolvedCodeWarden[] {
  const { wardens, claimedDomains } = configuredWardens(config);
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
      throw Error(`Warden provider unavailable: ${id}`);
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
      throw Error('A native Warden requires an available text-only Claude provider');
    if (opts.thinking !== undefined)
      throw Error('Native Warden thinking/effort cannot be enforced by the current adapter');
    if (opts.cacheControl !== undefined || opts.temperature !== 0)
      throw Error(
        'Native Warden cache/temperature setting cannot be enforced by the current adapter',
      );
  };
  const result: ResolvedCodeWarden[] = wardens.map(({ agentId, domain, agent }) => {
    const provider = providerFor(agent.provider || config.defaults.provider);
    const model = agent.model || config.defaults.model;
    if (!model?.trim()) throw Error(`Warden model unavailable: ${agentId}`);
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
          `[warden-review-profile-override] domain=${diagnosticLabel(domain)} agent=${diagnosticLabel(agentId)}: explicit learning.review takes precedence for post-review; changed=${changed.join(',')}. Advise/guard profile is unchanged. Inspect learning.review and this Warden's profile; these are requested settings, not native acknowledgment.`,
        );
    }
    return {
      domain,
      configuredAgentId: agentId,
      budget: roleComposition(config.composition, agentId).budget,
      guardTriggers: [...(agent.guardTriggers ?? [])],
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
  for (const dc of options.codeWardens) {
    const instance = available.get(dc.layerId);
    if (claimedDomains.has(dc.domain) || !instance || instance.segment === 'thread-knowledge')
      continue;
    result.push({ ...dc, guardTriggers: [...dc.guardTriggers] });
  }
  const seenDomains = new Set<string>(),
    seenLayers = new Set<string>();
  for (const dc of result) {
    if (
      !isIdName(dc.domain) ||
      seenDomains.has(dc.domain) ||
      (dc.layerId !== undefined && seenLayers.has(dc.layerId))
    )
      throw Error(`Ambiguous runtime Warden ownership: ${dc.domain}`);
    if (available.has(threadKnowledgeLayerId(dc.domain)))
      throw Error(`Generated Warden layer already exists: ${dc.domain}`);
    seenDomains.add(dc.domain);
    if (dc.layerId !== undefined) seenLayers.add(dc.layerId);
  }
  for (const diagnostic of diagnostics) options.warn?.(diagnostic);
  return result;
}
