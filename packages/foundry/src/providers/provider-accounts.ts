import { MODEL_REGISTRY, SUBSCRIPTION_WORKERS, subscriptionWorker } from '../models/registry';
import type { FoundryConfig } from '../viewer/config';
import {
  defaultProfileSource,
  isDefaultProfile,
  type NativeProfileSource,
} from './default-profiles';
import type { NativeAuthenticationSource } from './native-authentication';
import { assertProfile } from './private-profile';
import { resolveSubscriptionPolicy } from './subscription-policy';

/** Where a provider's account comes from. Never carries a secret: an API key is reported by its variable name. */
export interface ProviderAccount {
  provider: string;
  source: 'login' | 'profile' | 'gateway' | 'kingdom' | 'api-key' | 'local' | 'none';
  detail: string;
  /** Local evidence only (profile usable, CLI on PATH, variable set); the provider can still refuse. */
  ready: boolean;
  issue?: string;
  /** What this Foundry runs on the provider: the main thread and/or decision roles. */
  uses: Array<'main thread' | 'decisions'>;
}

interface Inputs {
  environment?: Record<string, string | undefined>;
  which?: (command: string) => string | null;
}

export function providerAccounts(config: FoundryConfig, inputs: Inputs = {}): ProviderAccount[] {
  const environment = inputs.environment ?? process.env;
  const which = inputs.which ?? Bun.which;
  let subscription: ReturnType<typeof resolveSubscriptionPolicy>;
  let policyIssue: string | undefined;
  try {
    subscription = resolveSubscriptionPolicy(config);
  } catch (error) {
    policyIssue = error instanceof Error ? error.message : String(error);
  }
  const apiTokens = config.apiTokens === true;

  return Object.values(config.providers)
    .filter((provider) => provider.enabled)
    .map((provider): ProviderAccount => {
      const info = MODEL_REGISTRY[provider.id];
      const main = config.defaults.provider === provider.id;
      if (subscriptionWorker(provider.id)) {
        const runtime = SUBSCRIPTION_WORKERS[provider.id];
        const decides = subscription?.decision.runtime === runtime;
        const uses = [
          ...(main ? (['main thread'] as const) : []),
          ...(decides ? (['decisions'] as const) : []),
        ];
        if (!apiTokens) {
          // The main thread and the decision roles can sit on different profiles of one runtime; check each in use.
          const profiles = [
            ...(subscription?.worker.runtime === runtime ? [subscription.worker] : []),
            ...(decides && subscription && subscription.decision !== subscription.worker
              ? [subscription.decision]
              : []),
          ];
          const accounts = (profiles.length ? profiles : [defaultProfileSource(runtime)]).map(
            (profile) => nativeAccount(provider.id, profile, which),
          );
          const account = accounts.find((a) => !a.ready) ?? accounts[0]!;
          const issue = account.issue ?? policyIssue;
          return {
            ...account,
            ready: accounts.every((a) => a.ready) && !policyIssue,
            uses,
            ...(issue ? { issue } : {}),
          };
        }
        const ownerKey = main ? config.defaults.kingdomOwnerKey : undefined;
        if (ownerKey) {
          const kingdom = config.kingdomInference?.find((source) => source.id === ownerKey);
          return {
            provider: provider.id,
            source: 'kingdom',
            detail: kingdom?.url ?? ownerKey,
            ready: !!kingdom,
            ...(kingdom ? {} : { issue: `No kingdomInference entry for ${ownerKey}` }),
            uses,
          };
        }
        const selected = main
          ? config.nativeAuthentication?.find(
              (s) => s.id === config.defaults.nativeAuthenticationId,
            )
          : undefined;
        return {
          ...nativeAccount(provider.id, selected ?? defaultProfileSource(runtime), which),
          uses,
        };
      }
      const uses = main ? (['main thread'] as const) : [];
      if (info?.credential === 'local')
        return {
          provider: provider.id,
          source: 'local',
          detail: provider.baseUrl || info.apiRoot || '',
          ready: true,
          uses: [...uses],
        };
      const envKey = info?.envKey ?? '';
      if (!apiTokens)
        return {
          provider: provider.id,
          source: 'none',
          detail: envKey,
          ready: false,
          issue: `API providers need apiTokens: true and ${envKey}`,
          uses: [...uses],
        };
      return {
        provider: provider.id,
        source: 'api-key',
        detail: envKey,
        ready: !!environment[envKey],
        ...(environment[envKey] ? {} : { issue: `${envKey} is not set` }),
        uses: [...uses],
      };
    });
}

function nativeAccount(
  provider: string,
  source: NativeAuthenticationSource | NativeProfileSource,
  which: (command: string) => string | null,
): Omit<ProviderAccount, 'uses'> {
  if (source.mode === 'gateway')
    return { provider, source: 'gateway', detail: source.baseUrl, ready: true };
  const login = isDefaultProfile(source.profileDirectory, source.runtime);
  const base = {
    provider,
    source: login ? ('login' as const) : ('profile' as const),
    detail: source.profileDirectory,
  };
  if (!which(source.runtime))
    return { ...base, ready: false, issue: `The ${source.runtime} CLI is not on PATH` };
  try {
    assertProfile(source.profileDirectory, source.runtime);
    return { ...base, ready: true };
  } catch (error) {
    return { ...base, ready: false, issue: error instanceof Error ? error.message : String(error) };
  }
}
