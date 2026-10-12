import { createHash } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { LimitSnapshot } from '@inixiative/agent-session';
import { kingdomUrl } from '@inixiative/signet';
import { writePrivateFile } from '../client/private-file';
import {
  KingdomClient,
  type KingdomLimitReading,
  type KingdomRunEnvelope,
  type KingdomSubscriptionRelease,
} from './kingdom-client';
import {
  assertCodexLaunchArguments,
  type NativeAuthenticationLaunch,
  type NativeAuthenticationProvider,
  withoutCompetingCredentials,
} from './native-authentication';
import { assertPrivateProfile } from './private-profile';

/** Where one thread's subscription comes from: a Signet this Foundry holds, and the Kingdom project it bills. */
export interface KingdomCapacity {
  url: string;
  credentialFile: string;
  /** Kingdom UsageProject; its pool chooses the login. Absent: the Signet's own project. */
  projectId?: string;
  model: string;
  effort: string;
}

type Runtime = 'claude' | 'codex';
type Run = { envelope: KingdomRunEnvelope; client: KingdomClient; fingerprint: string };

const CODEX_HOME_CONFIG = 'cli_auth_credentials_store = "file"\n';
const fingerprintOf = (capacity: KingdomCapacity) =>
  createHash('sha256').update(JSON.stringify(capacity)).digest('hex');

/** A run's login as Kingdom reads limits: blocked means rate limited until the fullest window resets. */
export function limitReading(snapshot: LimitSnapshot, now = Date.now()): KingdomLimitReading {
  const resets = snapshot.windows
    .filter((window) => window.usedPercent >= 100 && window.resetsAt)
    .map((window) => window.resetsAt!);
  return {
    rateLimited: snapshot.blocked === true,
    retryAfterMs:
      snapshot.blocked === true && resets.length
        ? Math.max(0, Math.round(Math.min(...resets) - now))
        : null,
    windows: snapshot.windows.slice(0, 10).map((window) => ({
      id: window.id.slice(0, 60),
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt ?? null,
    })),
  };
}

/**
 * Main threads of a Kingdom-capacity project run on a subscription login Kingdom chooses from the
 * project's pool. Kingdom releases the login per launch; Foundry keeps it in memory and hands it only to
 * the native child, which runs in one config dir per Kingdom integration. Kingdom is the only refresher:
 * no refresh token ever reaches this machine.
 */
export class KingdomSubscriptionAuthentication implements NativeAuthenticationProvider {
  private runs = new Map<string, Run>();
  private pending = new Map<string, Promise<Run>>();
  private holders = new Map<string, number>();
  constructor(
    private options: {
      directory: string;
      capacity: (threadId: string) => Promise<KingdomCapacity>;
      warn?: (message: string) => void;
    },
  ) {
    if (!isAbsolute(options.directory)) throw Error('Kingdom profile directory must be absolute');
  }
  private async run(threadId: string, runtime: Runtime): Promise<Run> {
    const key = `${runtime}:${threadId}`;
    const capacity = await this.options.capacity(threadId),
      fingerprint = fingerprintOf(capacity);
    const current = this.runs.get(key);
    if (
      current &&
      current.fingerprint === fingerprint &&
      Date.parse(current.envelope.expiresAt) > Date.now()
    )
      return current;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = (async () => {
        const client = await KingdomClient.fromFile(capacity.credentialFile);
        if (client.origin !== kingdomUrl(capacity.url))
          throw Error('Kingdom Signet belongs to another Kingdom');
        const envelope = await client.resolve(crypto.randomUUID(), {
          model: capacity.model,
          effort: capacity.effort,
          authentication: 'subscription',
          runtime,
          ...(capacity.projectId ? { projectId: capacity.projectId } : {}),
        });
        if (envelope.authentication !== 'subscription' || envelope.runtime !== runtime)
          throw Error('Kingdom selected a login for a different runtime');
        const run = { envelope, client, fingerprint };
        this.runs.set(key, run);
        return run;
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return await pending;
  }
  private bindingFor(threadId: string, run: Run) {
    return `${threadId}:kingdom:${run.envelope.integrationId}`;
  }
  bindingId(threadId: string, runtime: Runtime): string {
    const run = this.runs.get(`${runtime}:${threadId}`);
    if (!run) throw Error('Kingdom subscription has not been resolved yet');
    return this.bindingFor(threadId, run);
  }
  async resolveBindingId(threadId: string, runtime: Runtime): Promise<string> {
    return this.bindingFor(threadId, await this.run(threadId, runtime));
  }
  async prepare(threadId: string, runtime: Runtime): Promise<NativeAuthenticationLaunch> {
    const run = await this.run(threadId, runtime);
    const released = await run.client.release(run.envelope.id);
    if (released.runtime !== runtime || released.integrationId !== run.envelope.integrationId)
      throw Error('Kingdom released a different login');
    const bindingId = this.bindingFor(threadId, run);
    const home = join(this.options.directory, released.integrationId, runtime);
    let active = false,
      ended = false;
    const check = () => {
      if (ended) throw Error('Kingdom subscription launch was released');
    };
    return Object.freeze({
      bindingId,
      sourceId: released.integrationId,
      integrationId: released.integrationId,
      capacityId: released.capacityId,
      mode: 'kingdom-subscription' as const,
      check,
      launch: (argv: string[], inherited: Record<string, string | undefined>) => {
        check();
        if (active) throw Error('Authentication launch already owns a process');
        const env = withoutCompetingCredentials(inherited);
        mkdirSync(home, { recursive: true, mode: 0o700 });
        assertPrivateProfile(home);
        let launchArgs = [...argv];
        if (runtime === 'claude') {
          if (argv.some((arg) => /^(--settings|--setting-sources|--fallback-model)(=|$)/.test(arg)))
            throw Error('Subscription launch override refused');
          env.CLAUDE_CONFIG_DIR = home;
          env.CLAUDE_CODE_OAUTH_TOKEN = released.accessToken;
          launchArgs = [...launchArgs, '--setting-sources', ''];
        } else {
          assertCodexLaunchArguments(argv);
          this.writeCodexLogin(home, released);
          env.CODEX_HOME = home;
        }
        active = true;
        this.holders.set(home, (this.holders.get(home) ?? 0) + 1);
        return { argv: launchArgs, env };
      },
      release: () => {
        if (ended) return;
        ended = true;
        if (!active) return;
        active = false;
        const left = (this.holders.get(home) ?? 1) - 1;
        if (left > 0) this.holders.set(home, left);
        else {
          this.holders.delete(home);
          if (runtime === 'codex')
            try {
              unlinkSync(join(home, 'auth.json'));
            } catch {}
        }
      },
      observeLimits: (snapshot: LimitSnapshot) => {
        void run.client
          .reportLimits(run.envelope.id, limitReading(snapshot))
          .catch((error: unknown) =>
            (this.options.warn ?? console.warn)(
              `[Kingdom] limit report for ${released.integrationId} failed: ${(error as Error).message}`,
            ),
          );
      },
    });
  }
  /** Codex reads its ChatGPT login from CODEX_HOME. It gets the access and id tokens only: with no
   * refresh token it cannot become a second refresher of the login Kingdom refreshes. */
  private writeCodexLogin(home: string, released: KingdomSubscriptionRelease) {
    if (!released.idToken || !released.accountId)
      throw Error('Kingdom released a ChatGPT login without its account; log in again');
    writePrivateFile(join(home, 'config.toml'), CODEX_HOME_CONFIG);
    writePrivateFile(
      join(home, 'auth.json'),
      JSON.stringify({
        OPENAI_API_KEY: null,
        auth_mode: 'chatgpt',
        tokens: {
          id_token: released.idToken,
          access_token: released.accessToken,
          refresh_token: '',
          account_id: released.accountId,
        },
        last_refresh: new Date().toISOString(),
      }),
    );
  }
}

/** Routes each thread to its project's capacity: this machine's login (`local`) or a Kingdom pool. */
export class ProjectCapacityAuthentication implements NativeAuthenticationProvider {
  constructor(
    private options: {
      kingdom: KingdomSubscriptionAuthentication;
      usesKingdom: (threadId: string) => boolean;
      local?: NativeAuthenticationProvider;
    },
  ) {}
  bindingId(threadId: string, runtime: Runtime): string {
    if (this.options.usesKingdom(threadId))
      return this.options.kingdom.bindingId(threadId, runtime);
    return this.options.local?.bindingId(threadId, runtime) ?? threadId;
  }
  async resolveBindingId(threadId: string, runtime: Runtime): Promise<string> {
    if (this.options.usesKingdom(threadId))
      return this.options.kingdom.resolveBindingId(threadId, runtime);
    const local = this.options.local;
    if (!local) return threadId;
    return (
      (await local.resolveBindingId?.(threadId, runtime)) ?? local.bindingId(threadId, runtime)
    );
  }
  async prepare(threadId: string, runtime: Runtime): Promise<NativeAuthenticationLaunch> {
    if (this.options.usesKingdom(threadId)) return this.options.kingdom.prepare(threadId, runtime);
    if (this.options.local) return this.options.local.prepare(threadId, runtime);
    return Object.freeze({
      bindingId: threadId,
      sourceId: 'local',
      integrationId: 'local',
      mode: 'local' as const,
      check: () => {},
      launch: (argv: string[], env: Record<string, string | undefined>) => ({ argv, env }),
      release: () => {},
    });
  }
}
