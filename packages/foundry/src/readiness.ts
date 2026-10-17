import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type { ArchiveClient } from '@inixiative/archive/remote';
import { readPrivateJson, signetCredentialFile, signetCredentialSchema } from '@inixiative/signet';
import { configuredExperts } from './agents/configured-experts';
import { regionKey } from './agents/region-roster';
import { archiveStatus, localArchiveUrl } from './archives/local';
import { ensureAgentClisOnPath, type Install } from './daemon/agent-clis';
import { MODEL_REGISTRY } from './models/registry';
import { providerEnabled } from './models/vendors';
import { resolveDecisionModel } from './providers/decision-provider';
import {
  type KingdomIntegration,
  kingdomInstallationPaths,
  kingdomIntegrationId,
  listedSignets,
} from './providers/kingdom-installation-connection';
import { providerApiKey } from './providers/openai-compatible';
import { prefilterInstalled } from './providers/prefilter-model';
import { assertProfile } from './providers/private-profile';
import {
  resolveSubscriptionPolicy,
  SUBSCRIPTION_DECISIONS,
  type SubscriptionResolution,
} from './providers/subscription-policy';
import { resolvePrefilterSettings, WardenPrefilter } from './providers/warden-prefilter';
import { describeLegacyItem, findLegacyStarter } from './setup/legacy-starter';
import { type FoundryConfig, validateConfig } from './viewer/config';
import { type ResolvedChorus, resolveProjectView } from './viewer/config-resolve';

export interface ReadinessIssue {
  severity: 'error' | 'warning';
  scope: string;
  code: string;
  message: string;
}
export interface ReadinessProfile {
  scope: string;
  agentId: string;
  role: string;
  provider: string;
  model: string;
  domain?: string;
}
export interface ReadinessKingdom {
  id: string;
  url: string;
  owner: string;
  integrationId: string;
  signetId: string;
  status: 'connected' | 'unavailable' | 'unverified';
}
/** The Warden pre-filter's model: `off` in settings, missing, installed (offline), or checked. */
export interface ReadinessPrefilter {
  status: 'off' | 'not-installed' | 'installed' | 'ready' | 'unavailable';
  url: string;
}
/** A project's chorus as the doctor shows it: what runs, from which layers, each region's size and key. */
export interface ReadinessChorus {
  scope: string;
  source: ResolvedChorus['source'];
  requested: ResolvedChorus['requested'];
  requestedBy: ResolvedChorus['requestedBy'];
  /** The repository's `.foundry/project.json`, when it exists. */
  repository?: ResolvedChorus['repository'];
  /** Regions present but off (the chorus is not enabled). */
  available?: number;
  reason?: string;
  layers: Array<{ label: string; regionsDir: string; regions: number }>;
  regions: Array<{
    id: string;
    title: string;
    layer: string;
    replaces: string[];
    bytes: number;
    tokens?: number;
    /** The region's warm-cache key (`regionKey`): the content hash of its composed knowledge. */
    key?: string;
    /** Why the key could not be computed (the knowledge file could not be read). */
    keyError?: string;
  }>;
}
/** A native runtime's CLI as this Foundry would launch it: on PATH, or found in an app bundle. */
export interface ReadinessNativeCli {
  cli: string;
  /** The enabled provider that runs on it; absent when only the decision roles do. */
  provider?: string;
  /** Whether the main thread, the decision roles or a requested provider launches it. */
  used: boolean;
  /** The binary that launches, or null when no working install was found. */
  binary: string | null;
  version?: string;
}
export interface ReadinessArchive {
  status: 'not-set-up' | 'unverified' | 'reachable' | 'unreachable';
  url: string;
}
export interface ReadinessReport {
  configurationReady: boolean;
  liveAccess: 'unverified';
  profiles: ReadinessProfile[];
  issues: ReadinessIssue[];
  /** Every paired Kingdom, checked independently. */
  kingdoms?: ReadinessKingdom[];
  /** This machine's local Archive; present when inspected. */
  archive?: ReadinessArchive;
  /** The Warden pre-filter's model. */
  prefilter?: ReadinessPrefilter;
  /** Each project's chorus, read-only; present when the configuration validated. */
  chorus?: ReadinessChorus[];
  /** Each native runtime CLI the configuration launches; present when the configuration validated. */
  nativeClis?: ReadinessNativeCli[];
}
/** The native providers and the CLI each launches. */
const NATIVE_CLIS = [
  ['claude-code', 'claude'],
  ['codex', 'codex'],
] as const;
const NATIVE_LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * Each native runtime CLI the configuration launches (every enabled native provider's, and the
 * decision runtime's), located by the shared resolver, which puts a CLI found off PATH (an app
 * bundle's) on this process's PATH; and an issue for each one missing: an error when the main
 * thread, the decision roles or a `requested` provider launches it, else a warning.
 */
export async function inspectNativeClis(
  saved: FoundryConfig,
  options: {
    /** Test seam in place of the resolver. */
    which?: (binary: string) => string | null;
    /** Provider ids something in the configuration launches beyond the main thread. */
    requested?: ReadonlySet<string>;
  } = {},
): Promise<{ nativeClis: ReadinessNativeCli[]; issues: ReadinessIssue[] }> {
  let subscription: SubscriptionResolution | undefined;
  try {
    subscription = resolveSubscriptionPolicy(saved);
  } catch {
    // An invalid policy is reported by inspectReadiness; the providers still say what launches.
  }
  const config = subscription?.config ?? saved;
  const use = new Map<string, { provider?: string; used: boolean }>();
  for (const [provider, cli] of NATIVE_CLIS)
    if (providerEnabled(config, provider))
      use.set(cli, {
        provider,
        used: config.defaults.provider === provider || !!options.requested?.has(provider),
      });
  if (subscription) {
    const cli = subscription.decision.runtime === 'codex' ? 'codex' : 'claude';
    use.set(cli, { ...use.get(cli), used: true });
  }
  const which = options.which;
  const located: Map<string, Install> = which
    ? new Map(
        [...use.keys()].flatMap((cli) => {
          const binary = which(cli);
          return binary ? [[cli, { binary, version: [] }] as const] : [];
        }),
      )
    : await ensureAgentClisOnPath([...use.keys()]);
  const nativeClis = [...use].map(([cli, { provider, used }]) => {
    const install = located.get(cli);
    return {
      cli,
      ...(provider ? { provider } : {}),
      used,
      binary: install?.binary ?? null,
      ...(install?.version.length ? { version: install.version.join('.') } : {}),
    };
  });
  const issues = nativeClis
    .filter((native) => !native.binary)
    .map((native): ReadinessIssue => {
      const label = NATIVE_LABELS[native.cli] ?? native.cli;
      return {
        severity: native.used ? 'error' : 'warning',
        scope: 'global',
        code: 'native-cli-missing',
        message: native.provider
          ? `${label} is enabled but no ${native.cli} CLI was found on PATH or in an app bundle; install ${label} or disable it.`
          : `Decisions run on ${native.cli} but no ${native.cli} CLI was found on PATH or in an app bundle; install ${label} or change subscriptionOnly.decisionRuntime.`,
      };
    });
  return { nativeClis, issues };
}

/** Local configuration inspection only. No provider construction, auth renewal, reservation or task dispatch. */
export async function inspectReadiness(
  config: FoundryConfig,
  options: {
    environment?: Record<string, string | undefined>;
    /** Test seam for locating the native CLIs; default: the shared resolver, which also puts a CLI
     * found off PATH (an app bundle's) on this process's PATH. */
    which?: (binary: string) => string | null;
    /** Enables the local Archive check with this client (undefined: none is set up). */
    archive?: () => ArchiveClient | undefined;
    /** Where the Kingdom Installation keys and Signets live (default `.foundry`). */
    configDir?: string;
    /** Enables one Signet listing per paired Kingdom, one local Archive request and one pre-filter health check. */
    transport?: typeof fetch;
    /** Where the pre-filter's model is installed (default ~/.foundry/models). */
    modelsDir?: string;
  } = {},
): Promise<ReadinessReport> {
  const saved = config;
  const issues: ReadinessIssue[] = [],
    profiles: ReadinessProfile[] = [];
  const environment = options.environment ?? process.env;
  const issue = (
    severity: ReadinessIssue['severity'],
    scope: string,
    code: string,
    message: string,
  ) => issues.push({ severity, scope, code, message });
  let kingdoms: ReadinessKingdom[] | undefined,
    archive: ReadinessArchive | undefined,
    prefilter: ReadinessPrefilter | undefined,
    chorus: ReadinessChorus[] | undefined,
    nativeClis: ReadinessNativeCli[] | undefined;
  const result = (): ReadinessReport => ({
    configurationReady: !issues.some((item) => item.severity === 'error'),
    liveAccess: 'unverified',
    profiles,
    issues,
    ...(kingdoms ? { kingdoms } : {}),
    ...(archive ? { archive } : {}),
    ...(prefilter ? { prefilter } : {}),
    ...(chorus ? { chorus } : {}),
    ...(nativeClis ? { nativeClis } : {}),
  });
  let subscription: SubscriptionResolution | undefined;
  try {
    validateConfig(saved);
    subscription = resolveSubscriptionPolicy(saved);
  } catch {
    issue(
      'error',
      'global',
      'invalid-configuration',
      'Configuration validation failed. Check authentication references, learning settings and source policies.',
    );
    return result();
  }
  const legacy = findLegacyStarter(saved);
  if (legacy.length)
    issue(
      'warning',
      'global',
      'legacy-starter-defaults',
      `Starter defaults from an older install wrap every thread: ${legacy.map(describeLegacyItem).join(', ')}. Remove them with \`bun run setup --remove-legacy-defaults\` (edited items are kept).`,
    );
  // Subscription mode inspects the effective routing startup would construct.
  config = subscription?.config ?? saved;
  for (const source of subscription ? [subscription.worker, subscription.decision] : []) {
    try {
      assertProfile(source.profileDirectory, source.runtime);
    } catch {
      issue(
        'error',
        source.runtime,
        'subscription-profile-unavailable',
        `Log in with the ${source.runtime} CLI; its profile must be an owned directory with private credential files.`,
      );
    }
  }
  const decisionProvider = resolveDecisionModel(config).provider;
  const checkedProviders = new Set<string>(),
    requested = new Set<string>();
  const checkProvider = (id: string, scope: string) => {
    if (checkedProviders.has(id)) return;
    checkedProviders.add(id);
    if (subscription && id === SUBSCRIPTION_DECISIONS) {
      return;
    }
    if (!providerEnabled(config, id))
      issue('error', scope, 'provider-disabled', 'A requested provider is absent or disabled.');
    if (
      id !== config.defaults.provider &&
      !(!subscription && id === decisionProvider && providerEnabled(config, id))
    )
      issue(
        'error',
        scope,
        'provider-not-constructed',
        'Production startup constructs the default provider and the configured decision provider. This requested provider needs an explicit runtime integration.',
      );
    const provider = MODEL_REGISTRY[id];
    if (!provider) {
      issue(
        'error',
        scope,
        'provider-unregistered',
        'The requested provider has no registered runtime.',
      );
      return;
    }
    // Subscription and local providers have no key to set; only an api-key provider can be missing one.
    if (provider.credential === 'api-key' && !environment[provider.envKey ?? ''])
      issue(
        'error',
        scope,
        'provider-credential-missing',
        `Set ${provider.envKey} through the existing secret mechanism.`,
      );
    requested.add(id);
  };
  checkProvider(config.defaults.provider, 'global');
  for (const source of config.kingdomAccess ?? []) {
    try {
      signetCredentialSchema.parse(await readPrivateJson(source.credentialFile));
    } catch {
      issue(
        'error',
        source.id,
        'integration-credential-unavailable',
        'The integration grant must be an enrolled Signet credential file this Foundry holds, owned and private. Inference installation and run tokens cannot authorize integration reads.',
      );
    }
    issue(
      'warning',
      source.id,
      'integration-access-unverified',
      'The local grant is configured. Kingdom must verify its current Signet, integration, resources and allowance when used.',
    );
  }
  const scopes: Array<readonly [string, FoundryConfig]> = [['global', config]];
  const choruses: Array<readonly [string, ResolvedChorus]> = [];
  for (const id of Object.keys(config.projects)) {
    try {
      const view = resolveProjectView(config, id)!;
      scopes.push([id, view.config]);
      choruses.push([id, view.chorus]);
    } catch {
      issue(
        'error',
        id,
        'invalid-project-configuration',
        'Project overrides could not be resolved. Use explicit list patches and valid layer/agent settings.',
      );
    }
  }
  for (const [scope, effective] of scopes) {
    let experts: ReturnType<typeof configuredExperts>['experts'];
    try {
      experts = configuredExperts(effective).experts;
    } catch {
      issue(
        'error',
        scope,
        'invalid-expert-ownership',
        "Check each enabled expert's domain, domain knowledge sources, instructions and context policy.",
      );
      continue;
    }
    const expertById = new Map(experts.map((expert) => [expert.agentId, expert]));
    for (const [id, agent] of Object.entries(effective.agents)) {
      if (!agent.enabled) continue;
      const provider = agent.provider ?? effective.defaults.provider,
        model = agent.model ?? effective.defaults.model;
      const expert = expertById.get(id);
      profiles.push({
        scope,
        agentId: id,
        role: agent.flowRole ?? agent.kind,
        provider,
        model,
        ...(expert ? { domain: expert.domain } : {}),
      });
      checkProvider(provider, scope);
      if (
        ['classifier', 'router', 'decider', 'domain-librarian'].includes(agent.kind) &&
        ['claude-code', 'codex'].includes(provider)
      )
        issue(
          'warning',
          scope,
          'native-decision-capacity',
          'A decision role uses native runtime capacity. Check its assigned resources and allowance; no cheaper profile was substituted.',
        );
      if (expert && effective.learning?.review?.provider)
        checkProvider(effective.learning.review.provider, scope);
    }
    // An unwrapped project (no layers) has no experts by design; layers without experts is the gap.
    if (scope !== 'global' && !experts.length && Object.keys(effective.layers ?? {}).length)
      issue(
        'warning',
        scope,
        'no-domain-experts',
        'This project has no enabled explicit domain experts; layer labels alone do not create experts.',
      );
    if (
      scope !== 'global' &&
      !Object.values(effective.agents).some((agent) => agent.enabled && agent.kind === 'executor')
    )
      issue('warning', scope, 'no-executor', 'This project has no enabled executor.');
    if (scope !== 'global') {
      const overrides = config.projects[scope]!.defaults;
      if (
        overrides &&
        ['kingdomOwnerKey', 'nativeAuthenticationId'].some(
          (key) =>
            key in overrides &&
            overrides[key as keyof typeof overrides] !==
              config.defaults[key as keyof typeof config.defaults],
        )
      )
        issue(
          'error',
          scope,
          'project-authentication-override',
          'Authentication is configured on the Foundry instance. Use explicit thread assignments or a separate instance for a different default Kingdom owner/source.',
        );
    }
  }
  if (!Object.keys(config.projects).length)
    issue(
      'warning',
      'global',
      'no-projects',
      'Add a project and configure its executor and domain experts.',
    );
  const selectedOwners = new Set(
    [
      config.defaults.kingdomOwnerKey,
      ...Object.values(config.kingdomInferenceAssignments ?? {}).map((item) => item.ownerKey),
    ].filter((id): id is string => !!id),
  );
  for (const source of config.kingdomInference ?? []) {
    if (!selectedOwners.has(source.id)) continue;
    try {
      signetCredentialSchema.parse(await readPrivateJson(source.credentialFile));
    } catch {
      issue(
        'error',
        source.id,
        'kingdom-credential-unavailable',
        "The credential file must hold this Foundry's Signet and be an owned private regular file. Pair again if necessary.",
      );
    }
    issue(
      'warning',
      source.id,
      'kingdom-access-unverified',
      'Local credentials do not prove server authorization, model capacity, renewal policy or budget headroom. Verify with a bounded Kingdom pilot.',
    );
  }
  const selectedNative = new Set([
    config.defaults.nativeAuthenticationId,
    ...Object.values(config.nativeAuthenticationSelections ?? {}),
  ]);
  for (const source of config.nativeAuthentication ?? []) {
    if (!selectedNative.has(source.id)) continue;
    if (source.runtime !== (config.defaults.provider === 'codex' ? 'codex' : 'claude'))
      issue(
        'error',
        source.id,
        'native-runtime-mismatch',
        'The selected credential source belongs to a different native runtime.',
      );
    if (source.mode === 'gateway' && source.credential.type === 'command') {
      try {
        if (!(await stat(source.credential.command)).isFile()) throw Error('Not a helper file');
        await access(source.credential.command, constants.X_OK);
      } catch {
        issue(
          'error',
          source.id,
          'gateway-helper-unavailable',
          'The configured credential helper is missing or not executable. No helper was executed.',
        );
      }
    }
    if (source.mode === 'native-profile') {
      try {
        if (!(await stat(source.profileDirectory)).isDirectory())
          throw Error('Not a profile directory');
      } catch {
        issue(
          'error',
          source.id,
          'native-profile-missing',
          'The selected native profile directory is unavailable.',
        );
      }
      if (
        !subscription &&
        !(
          providerEnabled(config, decisionProvider) && providerApiKey(decisionProvider, environment)
        )
      )
        issue(
          'error',
          source.id,
          'native-profile-decision-provider',
          'The native profile has one refresh owner. Production startup requires the separate API decision provider and its key.',
        );
    } else if (source.credential.type === 'environment' && !environment[source.credential.variable])
      issue(
        'error',
        source.id,
        'gateway-credential-missing',
        'The configured gateway credential environment variable is absent.',
      );
  }
  const configDir = options.configDir ?? '.foundry',
    integrations = saved.kingdomIntegrations ?? [];
  const listed = options.transport
    ? await listedSignets(
        configDir,
        integrations.map((integration) => integration.url),
      )
    : undefined;
  kingdoms = await Promise.all(
    integrations.map((integration) => inspectKingdom(integration, configDir, issue, listed)),
  );
  if (options.archive) archive = await inspectArchive(options.archive(), issue, options.transport);
  prefilter = await inspectPrefilter(config, issue, options.transport, options.modelsDir);
  const native = await inspectNativeClis(saved, { which: options.which, requested });
  nativeClis = native.nativeClis;
  issues.push(...native.issues);
  for (const [scope, c] of choruses)
    if (c.repository?.error)
      issue(
        'error',
        scope,
        'repository-settings-unreadable',
        `${c.repository.file} was not read (${c.repository.error}); its chorus setting is ignored.`,
      );
  chorus = await Promise.all(
    choruses.map(([scope, c]) =>
      describeReadinessChorus(scope, c, (region, message) =>
        issue(
          'error',
          scope,
          'region-knowledge-unreadable',
          `Region ${region} knowledge could not be read (${message}); its Warden would run without it.`,
        ),
      ),
    ),
  );
  return result();
}

/**
 * A project's chorus with each region's key computed (the file is read once per region). A region
 * whose knowledge cannot be read gets `keyError` instead of a key, and `onError` hears of it.
 */
export async function describeReadinessChorus(
  scope: string,
  chorus: ResolvedChorus,
  onError: (region: string, message: string) => void = () => {},
): Promise<ReadinessChorus> {
  return {
    scope,
    source: chorus.source,
    requested: chorus.requested,
    requestedBy: chorus.requestedBy,
    ...(chorus.repository ? { repository: chorus.repository } : {}),
    ...(chorus.available ? { available: chorus.available } : {}),
    ...(chorus.reason ? { reason: chorus.reason } : {}),
    layers: chorus.layers.map((layer) => ({
      label: layer.label,
      regionsDir: layer.regionsDir,
      regions: layer.regions.length,
    })),
    regions: await Promise.all(
      chorus.regions.map(async (region) => ({
        id: region.id,
        title: region.title,
        layer: region.layer,
        replaces: [...region.replaces],
        bytes: region.bytes,
        ...(region.tokens !== undefined ? { tokens: region.tokens } : {}),
        ...(await regionKey(region).then(
          (key) => ({ key }),
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            onError(region.id, message);
            return { keyError: message };
          },
        )),
      })),
    ),
  };
}

/** A missing or silent model is a warning, never an error: every Warden is then asked. */
async function inspectPrefilter(
  config: FoundryConfig,
  issue: Issue,
  transport?: typeof fetch,
  modelsDir?: string,
): Promise<ReadinessPrefilter> {
  const settings = resolvePrefilterSettings(config.prefilter);
  const url = settings.baseUrl;
  if (!settings.enabled) return { status: 'off', url };
  if (!prefilterInstalled(modelsDir)) {
    issue(
      'warning',
      'prefilter',
      'prefilter-not-installed',
      'The Warden pre-filter model is not installed, so every Warden is asked on every trigger. Run foundry-acp setup.',
    );
    return { status: 'not-installed', url };
  }
  if (!transport) return { status: 'installed', url };
  const health = await new WardenPrefilter(config.prefilter, { fetch: transport }).check();
  if (health.ok) return { status: 'ready', url };
  issue(
    'warning',
    'prefilter',
    'prefilter-unavailable',
    `The Warden pre-filter model at ${url} did not answer, so every Warden is asked. The daemon starts it; restart the daemon.`,
  );
  return { status: 'unavailable', url };
}

type Issue = (
  severity: ReadinessIssue['severity'],
  scope: string,
  code: string,
  message: string,
) => void;

async function inspectKingdom(
  integration: KingdomIntegration,
  configDir: string,
  issue: Issue,
  listed?: Map<string, Set<string> | null>,
): Promise<ReadinessKingdom> {
  const identity = {
    id: kingdomIntegrationId(integration),
    url: integration.url,
    owner: integration.owner,
    integrationId: integration.integrationId,
    signetId: integration.signetId,
  };
  const pairAgain = `Pair again with bun run kingdom pair --replace --kingdom ${identity.id}.`;
  try {
    const { directory } = kingdomInstallationPaths(configDir, integration.url);
    signetCredentialSchema.parse(
      await readPrivateJson(signetCredentialFile(directory, integration.signetId)),
    );
  } catch {
    issue(
      'error',
      `kingdom:${identity.id}`,
      'kingdom-credential-unavailable',
      `The Signet for ${integration.url} must be an owned private file. ${pairAgain}`,
    );
    return { ...identity, status: 'unavailable' };
  }
  if (!listed) return { ...identity, status: 'unverified' };
  if (listed.get(integration.url)?.has(integration.signetId))
    return { ...identity, status: 'connected' };
  issue(
    'error',
    `kingdom:${identity.id}`,
    'kingdom-unavailable',
    `${integration.url} refused, could not be reached, or no longer lists this Foundry's Signet. Check the Foundry integration in that Kingdom, or ${pairAgain.charAt(0).toLowerCase()}${pairAgain.slice(1)}`,
  );
  return { ...identity, status: 'unavailable' };
}

async function inspectArchive(
  client: ArchiveClient | undefined,
  issue: Issue,
  transport?: typeof fetch,
): Promise<ReadinessArchive> {
  const url = localArchiveUrl();
  if (!client) {
    issue(
      'warning',
      'archive',
      'archive-not-set-up',
      'No local Archive is set up, so captured sessions stay in the Foundry journal. Run bun run archive setup.',
    );
    return { status: 'not-set-up', url };
  }
  if (!transport) return { status: 'unverified', url };
  if ((await archiveStatus(client)).reachable) return { status: 'reachable', url };
  issue(
    'warning',
    'archive',
    'archive-unreachable',
    `The local Archive at ${url} did not answer; captures retry until it does. Start it with bun run archive setup.`,
  );
  return { status: 'unreachable', url };
}
