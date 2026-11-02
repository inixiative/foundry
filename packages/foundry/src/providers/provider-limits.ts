/**
 * @atlas
 * @kind service
 * @partOf feature:viewer
 */
/**
 * Each subscription login's usage windows (5 hour, 7 day…, percent used and when they reset), for
 * the footer. Read with agent-session's limit probes in the login's own home (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`): the CLI answers over its control channel, no model call. Cached a few minutes per
 * login, one probe in flight at a time. A Kingdom-pool login's limits are Kingdom's to report.
 */
import { type LimitSnapshot, probeClaudeLimits, probeCodexLimits } from '@inixiative/agent-session';
import { SUBSCRIPTION_WORKERS, type SubscriptionWorker } from '../models/registry';
import type { ProviderAccount } from './provider-accounts';

export interface ProviderLimits {
  provider: string;
  /** `probed`: read from the login; `kingdom`: the pool's limits are Kingdom's; `unavailable`: the CLI didn't answer. */
  state: 'probed' | 'kingdom' | 'unavailable';
  snapshot?: LimitSnapshot;
}

const FRESH_MS = 5 * 60_000;
const cache = new Map<string, { at: number; snapshot: LimitSnapshot | undefined }>();
const inFlight = new Map<string, Promise<LimitSnapshot | undefined>>();

/** `home` is a separate profile's directory; undefined is the default login (the CLI's own home). */
type Probe = (home: string | undefined) => Promise<LimitSnapshot | undefined>;
const PROBES: Record<SubscriptionWorker, Probe> = {
  'claude-code': (home) =>
    probeClaudeLimits({
      ...(home ? { env: { CLAUDE_CONFIG_DIR: home } } : {}),
      timeoutMs: 30_000,
    }).catch(() => undefined),
  codex: (home) =>
    probeCodexLimits({ ...(home ? { env: { CODEX_HOME: home } } : {}), timeoutMs: 15_000 }).catch(
      () => undefined,
    ),
};

async function probe(
  provider: SubscriptionWorker,
  home: string | undefined,
  probes: Record<SubscriptionWorker, Probe>,
) {
  const key = `${provider}:${home ?? 'login'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.snapshot;
  const running = inFlight.get(key);
  if (running) return running;
  const next = probes[provider](home).then((snapshot) => {
    cache.set(key, { at: Date.now(), snapshot });
    inFlight.delete(key);
    return snapshot;
  });
  inFlight.set(key, next);
  return next;
}

/** The limits of every subscription login among `accounts`. */
export async function providerLimits(
  accounts: readonly ProviderAccount[],
  probes: Record<SubscriptionWorker, Probe> = PROBES,
): Promise<ProviderLimits[]> {
  const subscriptions = accounts.filter(
    (a): a is ProviderAccount & { provider: SubscriptionWorker } =>
      a.provider in SUBSCRIPTION_WORKERS,
  );
  return Promise.all(
    subscriptions.map(async (account): Promise<ProviderLimits> => {
      if (account.source === 'kingdom') return { provider: account.provider, state: 'kingdom' };
      if ((account.source !== 'login' && account.source !== 'profile') || !account.ready)
        return { provider: account.provider, state: 'unavailable' };
      // The default login probes in the CLI's own home: pointing the CLI at that same directory by
      // variable changes where Claude Code looks up its credential.
      const home = account.source === 'profile' ? account.detail : undefined;
      const snapshot = await probe(account.provider, home, probes);
      return snapshot
        ? { provider: account.provider, state: 'probed', snapshot }
        : { provider: account.provider, state: 'unavailable' };
    }),
  );
}
