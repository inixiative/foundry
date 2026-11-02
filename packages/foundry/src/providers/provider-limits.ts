/**
 * @atlas
 * @kind service
 * @partOf feature:viewer
 */
/**
 * Each subscription login's usage windows (5 hour, 7 day…, percent used and when they reset), for
 * the footer. Read with agent-session's limit probes in the login's own home (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`): the CLI answers over its control channel, no model call. Muse Code's are its
 * `muse usage --json` (no model turn), on the user's own login (the only Muse login Foundry runs). Cached a few minutes per
 * login, one probe in flight at a time. A Kingdom-pool login's limits are Kingdom's to report.
 */
import {
  type LimitSnapshot,
  museLimitSnapshot,
  probeClaudeLimits,
  probeCodexLimits,
} from '@inixiative/agent-session';
import { SUBSCRIPTION_WORKERS, type SubscriptionWorker } from '../models/registry';
import { isDefaultProfile, type NativeProfileSource, profileEnvironment } from './default-profiles';
import { loginEnvironment, withoutCompetingCredentials } from './native-authentication';
import { nativeTextEnvironment } from './native-text-environment';
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

/** `env` selects a separate login (its home, and a setup-token login's token); absent, the CLI's own login. */
type Probe = (env: Record<string, string> | undefined) => Promise<LimitSnapshot | undefined>;
const PROBES: Record<SubscriptionWorker, Probe> = {
  'claude-code': (env) =>
    probeClaudeLimits({ ...(env ? { env } : {}), timeoutMs: 30_000 }).catch(() => undefined),
  codex: (env) =>
    probeCodexLimits({ ...(env ? { env } : {}), timeoutMs: 15_000 }).catch(() => undefined),
  muse: () => probeMuseLimits().catch(() => undefined),
};

/** `muse usage --json`'s allowance windows as agent-session reads Muse's own usage reports. */
async function probeMuseLimits(timeoutMs = 15_000): Promise<LimitSnapshot | undefined> {
  const child = Bun.spawn(['muse', 'usage', '--json'], {
    env: withoutCompetingCredentials(nativeTextEnvironment(process.env), 'muse'),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (code !== 0) return undefined;
    return museLimitSnapshot((JSON.parse(stdout) as { allowance?: unknown }).allowance, 'poll');
  } finally {
    clearTimeout(timer);
  }
}

async function probe(
  provider: SubscriptionWorker,
  key: string,
  env: () => Record<string, string> | undefined,
  probes: Record<SubscriptionWorker, Probe>,
) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.snapshot;
  const running = inFlight.get(key);
  if (running) return running;
  const next = Promise.resolve()
    .then(() => probes[provider](env()))
    .catch(() => undefined)
    .then((snapshot) => {
      cache.set(key, { at: Date.now(), snapshot });
      inFlight.delete(key);
      return snapshot;
    });
  inFlight.set(key, next);
  return next;
}

/**
 * One login's usage windows, read in its own home (and, for a setup-token login, with its token),
 * cached a few minutes per login. The default login is read in the CLI's own home: pointing the CLI
 * at that same directory by variable changes where Claude Code looks up its credential.
 */
export function loginLimits(
  login: NativeProfileSource,
  probes: Record<SubscriptionWorker, Probe> = PROBES,
): Promise<LimitSnapshot | undefined> {
  const worker = (Object.keys(SUBSCRIPTION_WORKERS) as SubscriptionWorker[]).find(
    (w) => SUBSCRIPTION_WORKERS[w] === login.runtime,
  )!;
  const own = isDefaultProfile(login.profileDirectory, login.runtime);
  return probe(
    worker,
    `${worker}:${own ? 'login' : login.profileDirectory}`,
    () => (own && !login.tokenFile ? undefined : loginEnvironment(login)),
    probes,
  );
}

/** Forget a login's cached reading: a new sign-in, or a session that saw its limits change. */
export function forgetLoginLimits(login: NativeProfileSource): void {
  for (const key of cache.keys()) if (key.endsWith(`:${login.profileDirectory}`)) cache.delete(key);
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
      const snapshot = await probe(
        account.provider,
        `${account.provider}:${home ?? 'login'}`,
        () => (home ? profileEnvironment(SUBSCRIPTION_WORKERS[account.provider], home) : undefined),
        probes,
      );
      return snapshot
        ? { provider: account.provider, state: 'probed', snapshot }
        : { provider: account.provider, state: 'unavailable' };
    }),
  );
}
