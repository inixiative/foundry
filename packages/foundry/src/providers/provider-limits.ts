/**
 * @atlas
 * @kind service
 * @partOf feature:viewer
 */
/**
 * Each subscription login's usage windows (5 hour, 7 day…, percent used and when they reset), for
 * the rail's Status view. Read with agent-session's limit probes in the login's own home (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`): the CLI answers over its control channel, no model call. Muse Code's are its
 * `muse usage --json` (no model turn), on the user's own login (the only Muse login Foundry runs). Cached a few minutes per
 * login, one probe in flight at a time. A Kingdom-pool login's limits are Kingdom's to report.
 */
import {
  fullWindowsResetAt,
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
  const own = isDefaultProfile(login.profileDirectory, login.runtime);
  const suffix = `:${own ? 'login' : login.profileDirectory}`;
  for (const key of cache.keys())
    if (
      key.endsWith(suffix) &&
      key.startsWith(login.runtime === 'codex' ? 'codex:' : 'claude-code:')
    )
      cache.delete(key);
}

/** How often a long pause reads the login again: a new sign-in can free it early. */
const QUOTA_RECHECK_MS = 15 * 60_000;

/**
 * When a used-up reading frees up: the latest reset among the windows at their limit (agent-session's
 * own rule, `fullWindowsResetAt`, so Foundry pauses exactly while the primed host refuses); `now +
 * unknownResetWaitMs` when it is used up with no known reset, since the primed host refuses that too,
 * and the login is read again then; undefined when it is not used up or its reset is already past.
 */
export function usedUpResetAt(
  limits: LimitSnapshot | undefined,
  now = Date.now(),
  unknownResetWaitMs = QUOTA_RECHECK_MS,
): number | undefined {
  if (!limits?.blocked) return undefined;
  const at = fullWindowsResetAt(limits.windows);
  if (at === undefined) return now + unknownResetWaitMs;
  return at > now ? at : undefined;
}

/** A login read that did not answer: not evidence either way. */
export const LOGIN_UNREAD = 'unread' as const;

/**
 * When a used-up login's usage frees up (`usedUpResetAt`), read from the login (no model turn); or
 * `LOGIN_UNREAD` when the login gave no reading. A cached reading that already shows it used up, with
 * a known reset, is trusted until that reset; any other is read again, since it may predate the limit.
 */
export async function fetchLoginQuotaResetAt(
  login: NativeProfileSource,
  now = Date.now(),
  probes: Record<SubscriptionWorker, Probe> = PROBES,
): Promise<number | undefined | typeof LOGIN_UNREAD> {
  const held = await loginLimits(login, probes);
  // A cached reading is trusted only with a known reset; one without could be stale for ever.
  if (held?.blocked && fullWindowsResetAt(held.windows) !== undefined) {
    const cached = usedUpResetAt(held, now);
    if (cached !== undefined) return cached;
  }
  forgetLoginLimits(login);
  const fresh = await loginLimits(login, probes);
  return fresh ? usedUpResetAt(fresh, now) : LOGIN_UNREAD;
}

/** A read from the login at most this often after a rate limit, so retries do not each spawn the CLI. */
const QUOTA_READ_SPACING_MS = 60_000;
/** The longest delay a timer takes (2^31 - 1 ms); a longer one fires at once. */
const LONGEST_TIMER_MS = 2_147_483_647;

/**
 * One decision login's used-up pause, shared by everything that asks the login (the decision
 * scheduler, every classify stage host, and the project Warden hosts), so a login out of usage is
 * said once and asked no more until it resets.
 */
export interface LoginQuotaPause {
  /** When the pause ends (epoch ms), or undefined when the login is not paused. */
  pausedUntil(now?: number): number | undefined;
  /** A read is in flight: what was asked waits for it rather than fail on the login. */
  reading(): boolean;
  /**
   * Read whether the login is used up (its host's own reading first, then the login), and pause until
   * its reset when it is. One read at a time; resolves to the pause's end, or undefined.
   */
  read(): Promise<number | undefined>;
  /** A reading the login's host just reported: used up with a known reset pauses at once. */
  observe(limits: LimitSnapshot): void;
  /** Told when the pause starts or moves (its end) or ends (undefined). */
  onChange(listener: (until: number | undefined) => void): () => void;
  /** Stop its timer; it pauses no more. */
  close(): void;
}

export function makeLoginQuotaPause(options: {
  /** Reads the login itself, when its host has no reading that shows it used up. */
  fetchResetAt: () => Promise<number | undefined | typeof LOGIN_UNREAD>;
  /** The host's own merged reading (agent-session `PrimedSessions.limits()`). */
  hostLimits?: () => LimitSnapshot | undefined;
  recheckMs?: number;
}): LoginQuotaPause {
  const recheckMs = options.recheckMs ?? QUOTA_RECHECK_MS;
  const listeners = new Set<(until: number | undefined) => void>();
  let until = 0,
    closed = false,
    fetchedAt = Number.NEGATIVE_INFINITY,
    timer: ReturnType<typeof setTimeout> | undefined,
    inFlight: Promise<number | undefined | typeof LOGIN_UNREAD> | undefined;
  const tell = (value: number | undefined) => {
    for (const listener of listeners)
      try {
        listener(value);
      } catch {
        /* listeners only */
      }
  };
  const arm = () => {
    clearTimeout(timer);
    const wait = Math.min(Math.max(0, until - Date.now()), recheckMs, LONGEST_TIMER_MS);
    // why: a reset from a partial reading may come before the login's real one, so it is read again.
    timer = setTimeout(() => {
      timer = undefined;
      void recheck();
    }, wait);
    (timer as { unref?: () => void }).unref?.();
  };
  /**
   * Pause until `at`. A partial reading (a host's one rejected window, a cached probe) only extends
   * a pause; a full read of the login (`recheck`) may also bring its end earlier.
   */
  const pauseUntil = (at: number, full = false) => {
    if (closed || at <= Date.now()) return;
    if (until > Date.now() && at < until && !full) return;
    const changed = at !== until;
    until = at;
    arm();
    if (changed) tell(at);
  };
  const end = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!until) return;
    until = 0;
    tell(undefined);
  };
  const fetchLogin = () => {
    if (!inFlight) fetchedAt = Date.now();
    inFlight ??= options
      .fetchResetAt()
      .catch(() => LOGIN_UNREAD)
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  /**
   * A long pause read again: still used up keeps it (its reset may move), a reading that shows usage
   * ends it; no reading keeps it, extended by the host's own reading when that is later.
   */
  const recheck = async () => {
    const at = await fetchLogin();
    if (closed) return;
    if (at === LOGIN_UNREAD) {
      const own = usedUpResetAt(options.hostLimits?.(), Date.now(), recheckMs);
      if (own !== undefined) pauseUntil(own);
    } else if (at !== undefined) pauseUntil(at, true);
    if (at === undefined || until <= Date.now()) end();
    else arm();
  };
  return {
    pausedUntil: (now = Date.now()) => (until > now ? until : undefined),
    reading: () => inFlight !== undefined,
    read: async () => {
      if (closed) return undefined;
      const own = usedUpResetAt(options.hostLimits?.(), Date.now(), recheckMs);
      const spaced = inFlight || Date.now() - fetchedAt >= QUOTA_READ_SPACING_MS;
      const fetched = own === undefined && spaced ? await fetchLogin() : undefined;
      const at = own ?? (fetched === LOGIN_UNREAD ? undefined : fetched);
      if (at !== undefined) pauseUntil(at);
      return until > Date.now() ? until : undefined;
    },
    observe: (limits) => {
      const at = usedUpResetAt(limits, Date.now(), recheckMs);
      if (at !== undefined) pauseUntil(at);
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
      listeners.clear();
    },
  };
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
