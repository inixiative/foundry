/**
 * @atlas
 * @kind service
 * @partOf feature:nativeAuth
 */
/**
 * What a subscription login says about itself: its plan, as specifically as the provider tells us,
 * and the account it is signed in as (Aron, 2026-11-02: "when I expand… what type of plans they
 * are"). No model call and no credential is read:
 * - Claude: the profile Claude Code keeps beside the login (`.claude.json` `oauthAccount`: plan
 *   name, rate-limit tier, organization type, email, organization name). A `setup-token` login
 *   keeps no profile there; its plan comes from its usage reading when that names one, else unknown.
 * - Codex: `codex app-server` `account/read` in the login's own home (email and plan type).
 * Where the provider doesn't say, the plan is "plan unknown", never a guess. Cached a few minutes.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LimitSnapshot } from '@inixiative/agent-session';
import { isDefaultProfile, type NativeProfileSource } from './default-profiles';
import { withoutCompetingCredentials } from './native-authentication';
import { nativeTextEnvironment } from './native-text-environment';

export interface LoginAccount {
  /** "Claude Ultra (Max 20x)", "ChatGPT Pro"; "plan unknown" when the provider doesn't say. */
  plan: string;
  /** The email it is signed in as, else its organization's name. */
  account?: string;
}

export const PLAN_UNKNOWN = 'plan unknown';
const FRESH_MS = 5 * 60_000;
const cache = new Map<
  string,
  { at: number; account: Omit<LoginAccount, 'plan'> & { plan?: string } }
>();
const inFlight = new Map<string, Promise<Omit<LoginAccount, 'plan'> & { plan?: string }>>();

const words = (value: string) =>
  value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => (/^\d+x$/i.test(w) ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');

/** `default_claude_max_20x` → "Max 20x"; `claude_pro` → "Pro". */
export function claudeTier(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const tail = value.replace(/^default_/, '').replace(/^claude_/, '');
  return tail ? words(tail) : undefined;
}

/** The plan as the Claude profile names it: its display name, with the tier when that adds to it. */
export function claudePlan(profile: Record<string, unknown> | undefined): string | undefined {
  if (!profile) return undefined;
  const display = typeof profile.planDisplayName === 'string' ? profile.planDisplayName : undefined;
  const tier =
    claudeTier(profile.userRateLimitTier) ?? claudeTier(profile.organizationRateLimitTier);
  const type = claudeTier(profile.organizationType);
  const name = display ?? tier ?? type;
  if (!name) return undefined;
  const extra = display && tier && tier !== display ? ` (${tier})` : '';
  return `Claude ${name}${extra}`;
}

/** Codex `planType` → "ChatGPT Pro". */
export function codexPlan(planType: unknown): string | undefined {
  return typeof planType === 'string' && planType ? `ChatGPT ${words(planType)}` : undefined;
}

/** A usage reading's plan (`subscription_type`, `planType`), when the account read had none. */
function readingPlan(login: NativeProfileSource, limits?: LimitSnapshot): string | undefined {
  if (!limits?.plan) return undefined;
  return login.runtime === 'codex' ? codexPlan(limits.plan) : `Claude ${words(limits.plan)}`;
}

/** Claude keeps its profile in `<config dir>/.claude.json`; the default login's is `~/.claude.json`. */
function readClaude(login: NativeProfileSource) {
  const file = isDefaultProfile(login.profileDirectory, 'claude')
    ? join(process.env.HOME || homedir(), '.claude.json')
    : join(login.profileDirectory, '.claude.json');
  try {
    const profile = (JSON.parse(readFileSync(file, 'utf8')) as { oauthAccount?: unknown })
      .oauthAccount;
    if (!profile || typeof profile !== 'object') return {};
    const p = profile as Record<string, unknown>;
    const plan = claudePlan(p);
    const account =
      typeof p.emailAddress === 'string'
        ? p.emailAddress
        : typeof p.organizationName === 'string'
          ? p.organizationName
          : undefined;
    return { ...(plan ? { plan } : {}), ...(account ? { account } : {}) };
  } catch {
    return {};
  }
}

/** `codex app-server` → `account/read`, in the login's own home; no model turn. */
async function readCodex(login: NativeProfileSource, timeoutMs = 15_000) {
  const env = withoutCompetingCredentials(nativeTextEnvironment(process.env), 'codex');
  if (!isDefaultProfile(login.profileDirectory, 'codex')) env.CODEX_HOME = login.profileDirectory;
  const child = Bun.spawn(['codex', 'app-server', '--listen', 'stdio://'], {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const send = (message: object) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.flush();
  };
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'foundry-account', version: '0' }, capabilities: {} },
    });
    send({ jsonrpc: '2.0', method: 'initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'account/read', params: {} });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return {};
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf('\n');
      while (cut >= 0) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        cut = buffer.indexOf('\n');
        let message: { id?: unknown; result?: { account?: Record<string, unknown> } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== 2) continue;
        const account = message.result?.account;
        const plan = codexPlan(account?.planType);
        const email = typeof account?.email === 'string' ? account.email : undefined;
        return { ...(plan ? { plan } : {}), ...(email ? { account: email } : {}) };
      }
    }
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
    try {
      child.kill();
    } catch {
      /* Already gone. */
    }
  }
}

export type AccountReader = (
  login: NativeProfileSource,
) => Promise<Omit<LoginAccount, 'plan'> & { plan?: string }>;
const READ: AccountReader = async (login) =>
  login.runtime === 'codex' ? readCodex(login) : readClaude(login);

/** A login's plan and account; its usage reading's plan when the account doesn't name one. */
export async function loginAccount(
  login: NativeProfileSource,
  limits?: LimitSnapshot,
  read: AccountReader = READ,
): Promise<LoginAccount> {
  const key = `${login.runtime}:${login.profileDirectory}`;
  const hit = cache.get(key);
  let found = hit && Date.now() - hit.at < FRESH_MS ? hit.account : undefined;
  if (!found) {
    let running = inFlight.get(key);
    if (!running) {
      running = read(login)
        .catch(() => ({}))
        .then((account) => {
          cache.set(key, { at: Date.now(), account });
          inFlight.delete(key);
          return account;
        });
      inFlight.set(key, running);
    }
    found = await running;
  }
  return {
    plan: found.plan ?? readingPlan(login, limits) ?? PLAN_UNKNOWN,
    ...(found.account ? { account: found.account } : {}),
  };
}
