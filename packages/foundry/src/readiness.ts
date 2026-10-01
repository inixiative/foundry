import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { configuredExperts } from './agents/configured-experts';
import { type ArchiveDestination, destinationUrl, readDestinations } from './archives/config';
import { verifyArchiveDestination } from './archives/publish';
import { MODEL_REGISTRY } from './models/registry';
import { FoundryCredentials } from './providers/credentials';
import { resolveDecisionModel } from './providers/decision-provider';
import { accessCredentialSchema } from './providers/kingdom-access-client';
import { installationCredentialSchema, readPrivateJson } from './providers/kingdom-credential-file';
import {
  KingdomRuntimeConnection,
  type KingdomRuntimeSettings,
  kingdomRuntimeId,
} from './providers/kingdom-runtime-connection';
import { assertProfile } from './providers/private-profile';
import {
  resolveSubscriptionPolicy,
  SUBSCRIPTION_DECISIONS,
  type SubscriptionResolution,
} from './providers/subscription-policy';
import { type FoundryConfig, validateConfig } from './viewer/config';
import { resolveProjectView } from './viewer/config-resolve';

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
  layerId?: string;
}
export interface ReadinessKingdom {
  id: string;
  url: string;
  owner: string;
  installationId: string;
  status: 'connected' | 'unavailable' | 'unverified';
}
export interface ReadinessArchive {
  projectId: string;
  status: 'none' | 'configured' | 'verification-failing';
  destinations: number;
}
export interface ReadinessReport {
  configurationReady: boolean;
  liveAccess: 'unverified';
  profiles: ReadinessProfile[];
  issues: ReadinessIssue[];
  /** Every paired Kingdom, checked independently. */
  kingdoms?: ReadinessKingdom[];
  /** Present when a configuration directory is inspected. */
  archives?: ReadinessArchive[];
}
/** Local configuration inspection only. No provider construction, auth renewal, reservation or task dispatch. */
export async function inspectReadiness(
  config: FoundryConfig,
  options: {
    environment?: Record<string, string | undefined>;
    which?: (binary: string) => string | null;
    /** Enables archive destination inspection (`<configDir>/archives.json`). */
    configDir?: string;
    /** Enables one Kingdom heartbeat and one search per archive destination. */
    transport?: typeof fetch;
  } = {},
): Promise<ReadinessReport> {
  const saved = config;
  const issues: ReadinessIssue[] = [],
    profiles: ReadinessProfile[] = [];
  const environment = options.environment ?? process.env,
    which = options.which ?? Bun.which;
  const issue = (
    severity: ReadinessIssue['severity'],
    scope: string,
    code: string,
    message: string,
  ) => issues.push({ severity, scope, code, message });
  let kingdoms: ReadinessKingdom[] | undefined, archives: ReadinessArchive[] | undefined;
  const result = (): ReadinessReport => ({
    configurationReady: !issues.some((item) => item.severity === 'error'),
    liveAccess: 'unverified',
    profiles,
    issues,
    ...(kingdoms ? { kingdoms } : {}),
    ...(archives ? { archives } : {}),
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
  const checkedProviders = new Set<string>();
  const checkProvider = (id: string, scope: string) => {
    if (checkedProviders.has(id)) return;
    checkedProviders.add(id);
    if (subscription && id === SUBSCRIPTION_DECISIONS) {
      if (!which(subscription.decision.runtime === 'codex' ? 'codex' : 'claude'))
        issue(
          'error',
          scope,
          'native-cli-missing',
          "Install the decision profile's native CLI on PATH before starting Foundry.",
        );
      return;
    }
    if (!config.providers[id]?.enabled)
      issue('error', scope, 'provider-disabled', 'A requested provider is absent or disabled.');
    if (
      id !== config.defaults.provider &&
      !(!subscription && id === decisionProvider && config.providers[id]?.enabled)
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
    if (['claude-code', 'codex'].includes(id) && !which(id === 'claude-code' ? 'claude' : 'codex'))
      issue(
        'error',
        scope,
        'native-cli-missing',
        'Install the requested native CLI on PATH before starting Foundry.',
      );
  };
  checkProvider(config.defaults.provider, 'global');
  for (const source of config.kingdomAccess ?? []) {
    try {
      accessCredentialSchema.parse(await readPrivateJson(source.credentialFile));
    } catch {
      issue(
        'error',
        source.id,
        'integration-credential-unavailable',
        'The integration access token must be in an owned private regular file. Inference installation and run tokens cannot authorize integration reads.',
      );
    }
    issue(
      'warning',
      source.id,
      'integration-access-unverified',
      'The local grant is configured. Kingdom must verify its current Signet, connection, resources and allowance when used.',
    );
  }
  const scopes: Array<readonly [string, FoundryConfig]> = [['global', config]];
  for (const id of Object.keys(config.projects)) {
    try {
      scopes.push([id, resolveProjectView(config, id)!.config]);
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
        "Check each enabled expert's domain, single owned layer, instructions and context policy.",
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
        ...(expert ? { domain: expert.domain, layerId: expert.layerId } : {}),
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
    if (scope !== 'global' && !experts.length)
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
      const value = await readPrivateJson(source.credentialFile);
      installationCredentialSchema.parse(value);
    } catch {
      issue(
        'error',
        source.id,
        'kingdom-credential-unavailable',
        'The installation file must contain a runtime secret and be an owned private regular file. Re-enroll if necessary.',
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
      if (!subscription && !(config.providers.openai?.enabled && environment.OPENAI_API_KEY))
        issue(
          'error',
          source.id,
          'native-profile-decision-provider',
          'The native profile has one refresh owner. Production startup requires the separate OpenAI decision provider.',
        );
    } else if (source.credential.type === 'environment' && !environment[source.credential.variable])
      issue(
        'error',
        source.id,
        'gateway-credential-missing',
        'The configured gateway credential environment variable is absent.',
      );
  }
  kingdoms = await Promise.all(
    (saved.kingdomRuntimes ?? []).map((runtime) =>
      inspectKingdom(runtime, issue, options.transport),
    ),
  );
  if (options.configDir)
    archives = await inspectArchives(saved, options.configDir, kingdoms, issue, options.transport);
  return result();
}

type Issue = (
  severity: ReadinessIssue['severity'],
  scope: string,
  code: string,
  message: string,
) => void;

async function inspectKingdom(
  runtime: KingdomRuntimeSettings,
  issue: Issue,
  transport?: typeof fetch,
): Promise<ReadinessKingdom> {
  const identity = {
    id: kingdomRuntimeId(runtime),
    url: runtime.url,
    owner: runtime.owner,
    installationId: runtime.installationId,
  };
  try {
    installationCredentialSchema.parse(await readPrivateJson(runtime.credentialFile));
  } catch {
    issue(
      'error',
      `kingdom:${identity.id}`,
      'kingdom-credential-unavailable',
      `The runtime credential for ${runtime.url} must be an owned private file. Pair again with bun run kingdom pair --replace --kingdom ${identity.id}.`,
    );
    return { ...identity, status: 'unavailable' };
  }
  if (!transport) return { ...identity, status: 'unverified' };
  const connection = new KingdomRuntimeConnection(runtime, () => 0, transport);
  try {
    await connection.check();
    return { ...identity, status: 'connected' };
  } catch {
    issue(
      'error',
      `kingdom:${identity.id}`,
      'kingdom-unavailable',
      `${runtime.url} refused or could not be reached; its jobs and archives wait until it returns. Check the runtime in that Kingdom's Foundry tab, or pair again with bun run kingdom pair --replace --kingdom ${identity.id}.`,
    );
    return { ...identity, status: 'unavailable' };
  } finally {
    connection.stop();
  }
}

async function inspectArchives(
  config: FoundryConfig,
  configDir: string,
  kingdoms: ReadinessKingdom[],
  issue: Issue,
  transport?: typeof fetch,
): Promise<ReadinessArchive[]> {
  let destinations: ArchiveDestination[];
  try {
    destinations = readDestinations(join(configDir, 'archives.json'));
  } catch {
    issue(
      'error',
      'archives',
      'archive-configuration-invalid',
      'archives.json is invalid, so no archives publish. Fix or remove it, then run bun run archive setup.',
    );
    return [];
  }
  const credentials = new FoundryCredentials(configDir, () => config.kingdomRuntimes);
  const paired = ({ credential, url }: ArchiveDestination) =>
    credential?.type !== 'kingdom-runtime' ||
    kingdoms.some(
      (kingdom) =>
        kingdom.owner === credential.owner &&
        destinationUrl(kingdom.url).href === destinationUrl(url).href,
    );
  const projectIds = [
    ...new Set([...Object.keys(config.projects), ...destinations.map((d) => d.projectId)]),
  ];
  return Promise.all(
    projectIds.map(async (projectId): Promise<ReadinessArchive> => {
      const owned = destinations.filter((d) => d.projectId === projectId);
      if (!owned.length) return { projectId, status: 'none', destinations: 0 };
      let failing = false;
      for (const destination of owned) {
        if (!paired(destination)) failing = true;
        else if (transport)
          failing ||= await verifyArchiveDestination(destination, credentials, transport).then(
            () => false,
            () => true,
          );
      }
      if (failing)
        issue(
          'warning',
          projectId,
          'archive-destination-failing',
          'An archive destination failed verification; captured sessions stay local. Check its credential or Kingdom pairing, or reconnect with bun run archive setup.',
        );
      return {
        projectId,
        status: failing ? 'verification-failing' : 'configured',
        destinations: owned.length,
      };
    }),
  );
}
