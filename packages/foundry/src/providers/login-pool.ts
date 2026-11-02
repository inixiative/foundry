/**
 * @atlas
 * @kind service
 * @partOf feature:nativeAuth
 */
/**
 * Several logins of one runtime, balanced (Aron, 2026-11-02: "I have 3 subs… how do we see if
 * balancing is happening?"). Each login is a `SubscriptionAuthentication`; which one serves a launch
 * is agent-session's `SubscriptionPool` ranking (`rankCandidates`: quartile-balanced by default,
 * owner-first, priority-balanced, or pinned), from each login's 5-hour and 7-day readings, so an
 * exhausted or cooling login is skipped and every refusal names its reason. Foundry does not rank.
 *
 * A thread keeps the login it last ran on while that login can serve: its native session (and its
 * prompt cache) lives in that login's home. It moves only when its login is exhausted, expired or
 * removed, or when balancing is off and pinned to another login; the move starts a fresh native
 * session seeded from the thread's journal, as a Kingdom pool's does. Every turn records the login
 * that served it (`LoginRunLog`), which the footer, Settings › Providers and Analytics read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ExclusionReason,
  type InstanceConfig,
  type LimitSnapshot,
  SubscriptionPool,
} from '@inixiative/agent-session';
import { writePrivateJson } from '../client/private-file';
import { isDefaultProfile, type NativeProfileSource } from './default-profiles';
import { type LoginAccount, loginAccount, PLAN_UNKNOWN } from './login-account';
import type {
  NativeAuthenticationLaunch,
  NativeAuthenticationProvider,
  NativeLimitSnapshot,
  NativeRuntime,
} from './native-authentication';
import { forgetLoginLimits, loginLimits } from './provider-limits';
import { SubscriptionAuthentication } from './subscription-authentication';
import type { LoginPoolSettings, LoginRouting, PooledRuntime } from './subscription-policy';

/** One admitted turn and the login that served it. */
export interface LoginRun {
  at: number;
  runtime: PooledRuntime;
  loginId: string;
  threadId: string;
  /** Why this login: kept (the thread's own), balanced, preferred, pinned, or moved (its login could not serve). */
  why: LoginChoice;
}
export type LoginChoice = 'kept' | 'balanced' | 'preferred' | 'pinned' | 'moved' | 'only';

/** Five hours: the window the footer counts runs in, the subscriptions' shortest. */
export const RUN_WINDOW_MS = 5 * 3_600_000;
const KEEP_RUNS = 2_000;

/**
 * The record of which login served each turn, kept in one private file under Foundry's directory.
 * It also remembers each thread's last login, so a restarted daemon resumes a thread on its own.
 */
export class LoginRunLog {
  private runs: LoginRun[] = [];
  private last = new Map<string, string>();
  /** How many times each thread moved to another login: its native binding's epoch. */
  private moves = new Map<string, number>();
  private writing?: ReturnType<typeof setTimeout>;
  constructor(
    private file?: string,
    private now: () => number = Date.now,
  ) {
    if (!file || !existsSync(file)) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as {
        runs?: LoginRun[];
        threads?: Record<string, string>;
        moves?: Record<string, number>;
      };
      this.runs = Array.isArray(saved.runs) ? saved.runs.slice(-KEEP_RUNS) : [];
      this.last = new Map(Object.entries(saved.threads ?? {}));
      this.moves = new Map(Object.entries(saved.moves ?? {}));
    } catch {
      /* A damaged record starts empty; threads then take a login afresh. */
    }
  }
  record(run: Omit<LoginRun, 'at'>): void {
    this.runs.push({ ...run, at: this.now() });
    if (this.runs.length > KEEP_RUNS) this.runs.splice(0, this.runs.length - KEEP_RUNS);
    this.last.set(`${run.runtime}:${run.threadId}`, run.loginId);
    this.save();
  }
  /**
   * A thread moving to another login starts a fresh native session there; its binding carries the
   * move count, so coming back to a login it left never resumes that login's older session.
   */
  moved(runtime: PooledRuntime, threadId: string): void {
    const key = `${runtime}:${threadId}`;
    this.moves.set(key, (this.moves.get(key) ?? 0) + 1);
    this.save();
  }
  epoch(runtime: PooledRuntime, threadId: string): number {
    return this.moves.get(`${runtime}:${threadId}`) ?? 0;
  }
  /** The login a thread last ran on, on this runtime. */
  lastLogin(runtime: PooledRuntime, threadId: string): string | undefined {
    return this.last.get(`${runtime}:${threadId}`);
  }
  /** The newest runs first. */
  recent(runtime: PooledRuntime, limit = 12): LoginRun[] {
    const out: LoginRun[] = [];
    for (let i = this.runs.length - 1; i >= 0 && out.length < limit; i--)
      if (this.runs[i]!.runtime === runtime) out.push(this.runs[i]!);
    return out;
  }
  /** How many turns each login served since `since` (default: the last five hours). */
  counts(runtime: PooledRuntime, since = this.now() - RUN_WINDOW_MS): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const run of this.runs)
      if (run.runtime === runtime && run.at >= since)
        counts[run.loginId] = (counts[run.loginId] ?? 0) + 1;
    return counts;
  }
  /** Every run of a thread, oldest first. */
  ofThread(threadId: string): LoginRun[] {
    return this.runs.filter((run) => run.threadId === threadId);
  }
  /** Writes the record soon after a change, once for a burst of turns. */
  private save() {
    if (!this.file || this.writing) return;
    this.writing = setTimeout(() => this.flush(), 250);
    (this.writing as { unref?: () => void }).unref?.();
  }
  flush(): void {
    if (this.writing) clearTimeout(this.writing);
    this.writing = undefined;
    if (!this.file) return;
    try {
      writePrivateJson(this.file, {
        runs: this.runs,
        threads: Object.fromEntries(this.last),
        moves: Object.fromEntries(this.moves),
      });
    } catch (error) {
      console.warn(`[logins] could not save the run record: ${(error as Error).message}`);
    }
  }
}

/** A login's state, as the footer and Settings show it. */
export type LoginStatus = 'ready' | 'signing-in' | 'expired' | 'exhausted';

export interface PoolLoginState {
  id: string;
  name: string;
  /** "Claude Ultra (Max 20x)", "ChatGPT Pro", or "plan unknown" (login-account.ts). */
  plan: string;
  /** The email it is signed in as, else its organization's name. */
  account?: string;
  /** Whose subscription it is, as the person set it. */
  owner?: string;
  /** This machine's own login location (`~/.claude`, `~/.codex`), not one Foundry made. */
  own: boolean;
  status: LoginStatus;
  /** Why it is not ready, in a few words. */
  issue?: string;
  limits?: LimitSnapshot;
  /** Turns it served in the last five hours. */
  runs: number;
  preferred: boolean;
}

/** Whether, across how many logins, and if not, why. */
export type Balancing =
  | {
      state: 'balanced';
      across: number;
      routing: LoginRouting;
      /** `usage`: by each login's windows; `turns`: by turns served, because a login reports no usage. */
      by: 'usage' | 'turns';
    }
  | {
      state: 'stopped';
      reason: 'pinned' | 'one-login' | 'one-left' | 'none-left';
      /** The login everything runs on, when there is one. */
      on?: string;
    };

export interface PoolState {
  runtime: PooledRuntime;
  routing: LoginRouting;
  /** The scale off: every launch runs on the preferred login. */
  pinned: boolean;
  preferredLoginId?: string;
  /** Where the routing setting comes from. */
  from: 'project' | 'foundry' | 'default';
  balancing: Balancing;
  logins: PoolLoginState[];
  lastRuns: Array<{
    at: number;
    loginId: string;
    name: string;
    threadId: string;
    why: LoginChoice;
  }>;
  /** Projects that set their own balancing for this runtime (the route fills it). */
  overrides?: Array<{ projectId: string; name: string }>;
}

const TRANSPORT = { claude: 'claude-cli', codex: 'codex-app-server' } as const;
/** A login's working threads share it (shared holders); the pool counts them, never caps them. */
const SHARED_HOLDERS = 1_000;
/** The reasons a login cannot take work for now, as a person reads them. */
const EXHAUSTED: ReadonlySet<ExclusionReason> = new Set(['exhausted', 'blocked', 'unavailable']);

/** Balance by turns when a balanced routing has a candidate with no usage reading. */
const byTurns = (
  routing: LoginRouting,
  candidates: readonly { utilizationPercent: number | null }[],
) =>
  (routing === 'quartile-balanced' || routing === 'priority-balanced') &&
  candidates.length > 1 &&
  candidates.some((c) => c.utilizationPercent === null);

export const loginName = (login: NativeProfileSource, own: boolean) =>
  login.name ??
  (own
    ? `this machine's ${login.runtime === 'claude' ? 'Claude' : 'Codex'} login`
    : login.id.slice(0, 8));

export interface LoginPoolOptions {
  runtime: PooledRuntime;
  /** Where each login's private launch homes live (`runtime-profiles`). */
  directory: string;
  /** The runtime's usable logins, read live: a login added or removed applies to the next launch. */
  logins: () => NativeProfileSource[];
  /** The primary login (the policy's), preferred when nothing else is set. */
  primary: () => NativeProfileSource;
  /** A thread's pool settings: its project's (yours) over the Foundry-wide ones. */
  settings: (threadId: string) => LoginPoolSettings;
  runs: LoginRunLog;
  /** Test seams. */
  authentication?: (login: NativeProfileSource) => SubscriptionAuthentication;
  probe?: (login: NativeProfileSource) => Promise<LimitSnapshot | undefined>;
  account?: (login: NativeProfileSource, limits?: LimitSnapshot) => Promise<LoginAccount>;
  /** Whether a login is the runtime's own default location. */
  own?: (login: NativeProfileSource) => boolean;
  now?: () => number;
}

/**
 * The worker's authentication when it runs this machine's logins: one login or several. With one it
 * is that login's `SubscriptionAuthentication`, unchanged; with several, the pool chooses.
 */
export class LoginPoolAuthentication implements NativeAuthenticationProvider {
  private auths = new Map<string, { key: string; auth: SubscriptionAuthentication }>();
  private pool?: { key: string; pool: SubscriptionPool };
  /** Each thread's login for its current launch, so bindingId and prepare agree. */
  private assigned = new Map<string, { loginId: string; why: LoginChoice }>();
  /** Logins whose status check failed, with the refusal, until a later check passes. */
  private expired = new Map<string, string>();
  /** Each login's plan and account, as last read (login-account.ts). */
  private accounts = new Map<string, LoginAccount>();
  /** Launches holding each login (a native process running on it). */
  private holders = new Map<string, number>();
  constructor(private options: LoginPoolOptions) {}

  private get runtime(): PooledRuntime {
    return this.options.runtime;
  }
  private logins(): NativeProfileSource[] {
    return this.options.logins().filter((login) => login.runtime === this.runtime);
  }
  private authFor(login: NativeProfileSource): SubscriptionAuthentication {
    const { name: _label, owner: _owner, ...identity } = login;
    const key = JSON.stringify(identity);
    const held = this.auths.get(login.id);
    if (held?.key === key) return held.auth;
    const auth =
      this.options.authentication?.(login) ??
      new SubscriptionAuthentication(this.options.directory, login);
    this.auths.set(login.id, { key, auth });
    return auth;
  }
  /** The ranking pool over the current logins; rebuilt (readings carried over) when they change. */
  private ranking(): SubscriptionPool {
    const logins = this.logins();
    const key = JSON.stringify(logins.map((l) => [l.id, l.profileDirectory, l.tokenFile]));
    if (this.pool?.key === key) return this.pool.pool;
    const before = this.pool?.pool.instances() ?? [];
    const byId = new Map(logins.map((login) => [login.id, login]));
    const instances: InstanceConfig[] = logins.map((login, priority) => ({
      id: login.id,
      transport: TRANSPORT[this.runtime],
      profileDirectory: login.profileDirectory,
      concurrencyLimit: SHARED_HOLDERS,
      priority,
    }));
    const pool = new SubscriptionPool({
      instances,
      ...(this.options.now ? { now: this.options.now } : {}),
      // Each login is read in its own home with its own token (the footer's reading, cached).
      probe: async (instance) => {
        const login = byId.get(instance.id);
        return login ? (this.options.probe ?? loginLimits)(login) : undefined;
      },
    });
    for (const status of before)
      if (status.limits && byId.has(status.id)) pool.observeLimits(status.id, status.limits);
    this.pool = { key, pool };
    return pool;
  }
  private routing(threadId: string): {
    routing: LoginRouting;
    pinned: boolean;
    preferred?: string;
  } {
    const settings = this.options.settings(threadId);
    const routing = settings.routing ?? 'quartile-balanced';
    const ids = new Set(this.logins().map((l) => l.id));
    const named =
      settings.preferredLoginId && ids.has(settings.preferredLoginId)
        ? settings.preferredLoginId
        : undefined;
    const primary = this.options.primary();
    const preferred = named ?? (ids.has(primary.id) ? primary.id : this.logins()[0]?.id);
    return { routing, pinned: settings.pinned === true, ...(preferred ? { preferred } : {}) };
  }
  /** Rank the logins for a thread; the logins that cannot serve, with why. */
  private rank(threadId: string) {
    const { routing, pinned, preferred } = this.routing(threadId);
    const ranked = this.ranking().rank({
      runtime: this.runtime,
      // Every login serves every model its runtime runs; the model is the thread's, not the login's.
      model: 'thread',
      ordering: routing,
      ...(preferred ? { preferredInstanceId: preferred } : {}),
      // The scale off: only the preferred login serves (agent-session's eligibility filter).
      ...(pinned && preferred ? { pinned: true } : {}),
      // A login never read yet (a setup-token login whose usage Claude doesn't report) still serves, last.
      unknownUtilization: 'rank-last',
    });
    const excluded: Record<string, string> = { ...ranked.excluded };
    for (const [id, issue] of this.expired) if (!excluded[id]) excluded[id] = issue;
    let candidates = ranked.candidates.filter((c) => !this.expired.has(c.accountId));
    // A login that reports no usage (a `claude setup-token` login reports no windows) can't be ranked
    // by usage: rank-last would leave it idle until every read login is spent. Then the balanced
    // routings order by turns served in the last five hours instead, the pool's rank breaking ties.
    if (!pinned && byTurns(routing, candidates)) {
      const counts = this.options.runs.counts(this.runtime);
      // Launches placed but not yet admitted count too, so a burst of new threads spreads out.
      for (const [thread, { loginId }] of this.assigned)
        if (thread !== threadId && !this.options.runs.lastLogin(this.runtime, thread))
          counts[loginId] = (counts[loginId] ?? 0) + 1;
      const order = new Map(candidates.map((c, i) => [c.accountId, i]));
      candidates = [...candidates].sort(
        (a, b) =>
          (counts[a.accountId] ?? 0) - (counts[b.accountId] ?? 0) ||
          order.get(a.accountId)! - order.get(b.accountId)!,
      );
    }
    return {
      candidates: candidates.map((candidate) => candidate.accountId),
      excluded,
      routing,
      pinned,
      preferred,
    };
  }
  /** The login a launch of this thread runs on, and why: its own while it can serve, else the pool's pick. */
  choose(threadId: string): { login: NativeProfileSource; why: LoginChoice } {
    const logins = this.logins();
    if (!logins.length)
      throw Error(`No ${this.runtime} login on this machine; add one in Settings › Providers`);
    if (logins.length === 1) return { login: logins[0]!, why: 'only' };
    const { candidates, excluded, routing, pinned, preferred } = this.rank(threadId);
    const own =
      this.assigned.get(threadId)?.loginId ?? this.options.runs.lastLogin(this.runtime, threadId);
    const byId = new Map(logins.map((l) => [l.id, l]));
    if (own && candidates.includes(own)) return { login: byId.get(own)!, why: 'kept' };
    const best = candidates[0];
    if (!best)
      throw Error(
        `Every ${this.runtime} login is unavailable: ${Object.entries(excluded)
          .map(([id, why]) => `${loginName(byId.get(id)!, this.isOwn(byId.get(id)!))} ${why}`)
          .join(', ')}`,
      );
    const why: LoginChoice =
      own && byId.has(own)
        ? 'moved'
        : pinned
          ? 'pinned'
          : routing === 'owner-first' && best === preferred
            ? 'preferred'
            : 'balanced';
    return { login: byId.get(best)!, why };
  }
  private isOwn(login: NativeProfileSource): boolean {
    return this.options.own?.(login) ?? isDefaultProfile(login.profileDirectory, login.runtime);
  }
  private loginOf(id: string): NativeProfileSource {
    const login = this.logins().find((l) => l.id === id);
    if (!login) throw Error('That login was removed; the thread takes another at its next launch');
    return login;
  }
  /** The binding of a thread on a login: the login's own, plus the thread's move epoch once it moved. */
  private bindingOn(login: NativeProfileSource, threadId: string, runtime: NativeRuntime) {
    const base = this.authFor(login).bindingId(threadId, runtime);
    const epoch = this.options.runs.epoch(this.runtime, threadId);
    return epoch ? `${base}:move:${epoch}` : base;
  }
  /**
   * A lookup (resume, clear) never chooses: the login of the thread's live launch, else the one it
   * last ran on, else the primary. Only `prepare` chooses.
   */
  bindingId(threadId: string, runtime: NativeRuntime): string {
    const ids = new Set(this.logins().map((l) => l.id));
    const id = [
      this.assigned.get(threadId)?.loginId,
      this.options.runs.lastLogin(this.runtime, threadId),
      this.options.primary().id,
    ].find((candidate) => candidate && ids.has(candidate));
    const login = id ? this.loginOf(id) : this.logins()[0];
    if (!login) throw Error(`No ${this.runtime} login on this machine`);
    return this.bindingOn(login, threadId, runtime);
  }
  async resolveBindingId(threadId: string, runtime: NativeRuntime): Promise<string> {
    return this.bindingId(threadId, runtime);
  }
  /** Launches running on a login now: it can't be removed under them. */
  inUse(loginId: string): number {
    return this.holders.get(loginId) ?? 0;
  }
  async prepare(threadId: string, runtime: NativeRuntime): Promise<NativeAuthenticationLaunch> {
    if (runtime !== this.runtime) throw Error('Subscription worker runtime mismatch');
    if (this.logins().length > 1) await this.refresh();
    // A new launch is a new choice: the thread's own login while it serves, the pool's pick otherwise.
    for (let attempt = 0; ; attempt++) {
      this.assigned.delete(threadId);
      const { login, why } = this.choose(threadId);
      this.assigned.set(threadId, { loginId: login.id, why });
      const auth = this.authFor(login);
      try {
        await auth.verify();
        this.expired.delete(login.id);
      } catch (error) {
        // A login that fails its status check is set aside and the next one is tried.
        this.expired.set(login.id, `needs signing in again (${(error as Error).message})`);
        this.assigned.delete(threadId);
        if (this.logins().length > 1 && attempt < this.logins().length) continue;
        throw Error('Subscription worker unavailable; no API fallback');
      }
      const last = this.options.runs.lastLogin(this.runtime, threadId);
      if (last && last !== login.id) this.options.runs.moved(this.runtime, threadId);
      const launch = await auth.prepare(threadId, runtime);
      const pool = this.logins().length > 1 ? this.ranking() : undefined;
      let held = false;
      return {
        ...launch,
        bindingId: this.bindingOn(login, threadId, runtime),
        launch: (argv, env, harness) => {
          const owned = launch.launch(argv, env, harness);
          if (!held) {
            held = true;
            this.holders.set(login.id, this.inUse(login.id) + 1);
          }
          return owned;
        },
        release: () => {
          launch.release();
          if (held) {
            held = false;
            const left = this.inUse(login.id) - 1;
            if (left > 0) this.holders.set(login.id, left);
            else this.holders.delete(login.id);
          }
          // A launch that ended frees its placement; the run record keeps where it ran.
          if (this.assigned.get(threadId)?.loginId === login.id) this.assigned.delete(threadId);
        },
        admitted: () => {
          launch.admitted?.();
          this.options.runs.record({ runtime: this.runtime, loginId: login.id, threadId, why });
        },
        observeLimits: (snapshot: NativeLimitSnapshot) => {
          launch.observeLimits?.(snapshot);
          forgetLoginLimits(login);
          if (snapshot.runtime === this.runtime)
            pool?.observeLimits(login.id, snapshot as LimitSnapshot);
        },
      };
    }
  }
  /** Reads the logins whose readings are missing or stale (no model turn), before a choice. */
  async refresh(): Promise<void> {
    const pool = this.ranking();
    const now = this.options.now?.() ?? Date.now();
    const stale = pool
      .instances()
      .filter(
        (instance) =>
          !instance.limits ||
          now - instance.limits.observedAt > 5 * 60_000 ||
          instance.limits.windows.some((w) => w.resetsAt !== undefined && w.resetsAt <= now),
      )
      .map((instance) => instance.id);
    if (stale.length) await pool.refreshLimits(stale).catch(() => {});
  }
  /** Reads each login's plan and account (no model turn; cached a few minutes per login). */
  async readAccounts(): Promise<void> {
    const readings = new Map(
      this.ranking()
        .instances()
        .map((i) => [i.id, i.limits]),
    );
    await Promise.all(
      this.logins().map(async (login) => {
        this.accounts.set(
          login.id,
          await (this.options.account ?? loginAccount)(login, readings.get(login.id)),
        );
      }),
    );
  }
  /** Checks each login's sign-in (no model turn; cached a few minutes per login). */
  async checkLogins(): Promise<void> {
    await Promise.all(
      this.logins().map(async (login) => {
        try {
          await this.authFor(login).verify();
          this.expired.delete(login.id);
        } catch (error) {
          this.expired.set(login.id, `needs signing in again (${(error as Error).message})`);
        }
      }),
    );
  }
  /** The pool as the footer and Settings show it, for the Foundry-wide settings or a project's. */
  state(settings: LoginPoolSettings & { from: PoolState['from'] }): PoolState {
    const logins = this.logins();
    const routing = settings.routing ?? 'quartile-balanced';
    const pinned = settings.pinned === true;
    const ids = new Set(logins.map((l) => l.id));
    const primary = this.options.primary();
    const preferred =
      settings.preferredLoginId && ids.has(settings.preferredLoginId)
        ? settings.preferredLoginId
        : ids.has(primary.id)
          ? primary.id
          : logins[0]?.id;
    const pool = this.ranking();
    // Ranked as a new thread under these settings, without pinning: which logins could serve at all.
    const ranked = pool.rank({
      runtime: this.runtime,
      model: 'thread',
      ordering: 'quartile-balanced',
      unknownUtilization: 'rank-last',
    });
    const readings = new Map(pool.instances().map((i) => [i.id, i.limits]));
    const counts = this.options.runs.counts(this.runtime);
    const byId = new Map(logins.map((l) => [l.id, l]));
    const states: PoolLoginState[] = logins.map((login) => {
      const own = this.isOwn(login);
      const excluded = ranked.excluded[login.id];
      const expired = this.expired.get(login.id);
      const status: LoginStatus = expired
        ? 'expired'
        : excluded && EXHAUSTED.has(excluded)
          ? 'exhausted'
          : 'ready';
      const limits = readings.get(login.id);
      const account = this.accounts.get(login.id);
      return {
        id: login.id,
        name: loginName(login, own),
        plan: account?.plan ?? PLAN_UNKNOWN,
        ...(account?.account ? { account: account.account } : {}),
        ...(login.owner ? { owner: login.owner } : {}),
        own,
        status,
        ...(expired ? { issue: expired } : excluded ? { issue: excluded } : {}),
        ...(limits ? { limits } : {}),
        runs: counts[login.id] ?? 0,
        preferred: login.id === preferred,
      };
    });
    const ready = states.filter((s) => s.status === 'ready');
    const balancing: Balancing =
      logins.length <= 1
        ? {
            state: 'stopped',
            reason: 'one-login',
            ...(logins[0] ? { on: loginName(logins[0], this.isOwn(logins[0])) } : {}),
          }
        : pinned
          ? {
              state: 'stopped',
              reason: 'pinned',
              ...(preferred ? { on: states.find((s) => s.id === preferred)!.name } : {}),
            }
          : ready.length === 0
            ? { state: 'stopped', reason: 'none-left' }
            : ready.length === 1
              ? { state: 'stopped', reason: 'one-left', on: ready[0]!.name }
              : {
                  state: 'balanced',
                  across: ready.length,
                  routing,
                  by: byTurns(
                    routing,
                    ranked.candidates.filter((c) => ready.some((r) => r.id === c.accountId)),
                  )
                    ? 'turns'
                    : 'usage',
                };
    return {
      runtime: this.runtime,
      routing,
      pinned,
      ...(preferred ? { preferredLoginId: preferred } : {}),
      from: settings.from,
      balancing,
      logins: states,
      lastRuns: this.options.runs.recent(this.runtime).map((run) => {
        const login = byId.get(run.loginId);
        return {
          at: run.at,
          loginId: run.loginId,
          name: login ? loginName(login, this.isOwn(login)) : 'a removed login',
          threadId: run.threadId,
          why: run.why,
        };
      }),
    };
  }
  /** Login runs file under Foundry's directory. */
  static runsFile(foundryDir: string): string {
    return join(foundryDir, 'state', 'login-runs.json');
  }
}
