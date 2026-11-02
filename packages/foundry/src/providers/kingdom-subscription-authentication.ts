/**
 * @atlas
 * @kind service
 * @partOf feature:nativeAuth, integration:kingdom
 */
import { createHash } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { kingdomUrl } from '@inixiative/signet';
import { writePrivateFile } from '../client/private-file';
import { capacityKingdomProject, type FoundryConfig } from '../viewer/config';
import { resolveThreadView } from '../viewer/config-resolve';
import { defaultProfileDirectory } from './default-profiles';
import {
  claudeSettingsFiles,
  codexUserConfig,
  type HarnessSettingsLaunch,
  shareCodexUserSetup,
  shareUserSetup,
  subscriptionSettingsGuard,
} from './harness-settings';
import {
  KingdomClient,
  type KingdomLimitReading,
  type KingdomRunEnvelope,
  type KingdomSubscriptionRelease,
} from './kingdom-client';
import { heldSignetFile, selectKingdomIntegration } from './kingdom-installation-connection';
import {
  assertCodexLaunchArguments,
  type NativeAuthenticationLaunch,
  type NativeAuthenticationProvider,
  type NativeLimitSnapshot,
  type NativeRuntime,
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
export function limitReading(snapshot: NativeLimitSnapshot, now = Date.now()): KingdomLimitReading {
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
      /** The user's own Claude home shared into each login's home; default ~/.claude. */
      userClaudeDirectory?: string;
      /** The user's own Codex home whose setup a main thread takes; default ~/.codex. */
      userCodexDirectory?: string;
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
    const baseHome = join(this.options.directory, released.integrationId, runtime);
    let home = baseHome;
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
      launch: (
        argv: string[],
        inherited: Record<string, string | undefined>,
        harness?: HarnessSettingsLaunch,
      ) => {
        check();
        if (active) throw Error('Authentication launch already owns a process');
        // A Codex main thread with the user's own setup runs on its own home beside the plain one.
        if (runtime === 'codex' && harness) home = `${baseHome}-user`;
        const env = withoutCompetingCredentials(inherited);
        mkdirSync(home, { recursive: true, mode: 0o700 });
        assertPrivateProfile(home);
        let launchArgs = [...argv];
        if (runtime === 'claude') {
          if (argv.some((arg) => /^(--settings|--setting-sources|--fallback-model)(=|$)/.test(arg)))
            throw Error('Subscription launch override refused');
          env.CLAUDE_CONFIG_DIR = home;
          env.CLAUDE_CODE_OAUTH_TOKEN = released.accessToken;
          if (harness) {
            // The login's home is Foundry's; the user's own setup is shared into it.
            shareUserSetup(
              home,
              this.options.userClaudeDirectory ?? defaultProfileDirectory('claude'),
            );
            const guard = subscriptionSettingsGuard(claudeSettingsFiles(home, harness));
            launchArgs = [...launchArgs, '--setting-sources', harness.sources, '--settings', guard];
          } else launchArgs = [...launchArgs, '--setting-sources', ''];
        } else {
          assertCodexLaunchArguments(argv);
          const userCodex = this.options.userCodexDirectory ?? defaultProfileDirectory('codex');
          this.writeCodexLogin(
            home,
            released,
            harness
              ? CODEX_HOME_CONFIG + codexUserConfig(userCodex, this.options.warn)
              : CODEX_HOME_CONFIG,
          );
          if (harness) shareCodexUserSetup(home, userCodex);
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
      observeLimits: (snapshot: NativeLimitSnapshot) => {
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
  private writeCodexLogin(home: string, released: KingdomSubscriptionRelease, config: string) {
    if (!released.idToken || !released.accountId)
      throw Error('Kingdom released a ChatGPT login without its account; log in again');
    writePrivateFile(join(home, 'config.toml'), config);
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

/** Kingdom pools hold Claude and Codex logins; a Muse Code login in a pool waits on its own ticket. */
const POOLED: ReadonlySet<NativeRuntime> = new Set(['claude', 'codex']);
const pooled = (runtime: NativeRuntime): Runtime => {
  if (!POOLED.has(runtime))
    throw Error(
      `This project runs on its Kingdom pool, which holds no ${runtime === 'muse' ? 'Muse Code' : runtime} logins yet; no local login is used. Run this thread in a project on this machine's capacity.`,
    );
  return runtime as Runtime;
};

/** Routes each thread to its project's capacity: this machine's login (`local`) or a Kingdom pool. */
export class ProjectCapacityAuthentication implements NativeAuthenticationProvider {
  constructor(
    private options: {
      kingdom: KingdomSubscriptionAuthentication;
      usesKingdom: (threadId: string) => boolean;
      local?: NativeAuthenticationProvider;
    },
  ) {}
  bindingId(threadId: string, runtime: NativeRuntime): string {
    if (this.options.usesKingdom(threadId))
      return this.options.kingdom.bindingId(threadId, pooled(runtime));
    return this.options.local?.bindingId(threadId, runtime) ?? threadId;
  }
  async resolveBindingId(threadId: string, runtime: NativeRuntime): Promise<string> {
    if (this.options.usesKingdom(threadId))
      return this.options.kingdom.resolveBindingId(threadId, pooled(runtime));
    const local = this.options.local;
    if (!local) return threadId;
    return (
      (await local.resolveBindingId?.(threadId, runtime)) ?? local.bindingId(threadId, runtime)
    );
  }
  async prepare(threadId: string, runtime: NativeRuntime): Promise<NativeAuthenticationLaunch> {
    if (this.options.usesKingdom(threadId))
      return this.options.kingdom.prepare(threadId, pooled(runtime));
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

/**
 * The capacity routing every worker's authentication shares: a thread of a Kingdom-capacity project
 * runs on the project's pool, on every worker, with its own worker's model and effort; any other
 * thread keeps `local`. One Kingdom client serves every worker (it is keyed by runtime and thread).
 */
export function projectCapacity(options: {
  foundryDir: string;
  config: () => FoundryConfig;
  /** A thread's record (its project and worker); an auxiliary session's is its thread's. */
  meta: (threadId: string) => { projectId?: string; worker?: string } | undefined;
  /** Test seam: the Signet credential file this Foundry holds for a Kingdom. */
  credentialFile?: (url: string, signetId: string) => Promise<string>;
}): (local: NativeAuthenticationProvider | undefined) => NativeAuthenticationProvider {
  const metaOf = (threadId: string) => options.meta(threadId.split(':aux:')[0]!);
  const projectOf = (threadId: string) => {
    const id = metaOf(threadId)?.projectId;
    return id ? options.config().projects[id] : undefined;
  };
  const kingdom = new KingdomSubscriptionAuthentication({
    directory: join(options.foundryDir, 'kingdom', 'subscriptions'),
    capacity: async (threadId) => {
      const project = projectOf(threadId);
      const capacity = project?.kingdomCapacity;
      if (!project || !capacity) throw Error('This project has no Kingdom capacity configured');
      const config = options.config();
      const kingdomProject = capacityKingdomProject(config, project);
      const { url } = selectKingdomIntegration(config.kingdomIntegrations, capacity.kingdom);
      const view = resolveThreadView(config, metaOf(threadId) ?? {}).config;
      return {
        url,
        credentialFile: await (
          options.credentialFile ??
          ((at, signetId) => heldSignetFile(options.foundryDir, at, signetId))
        )(url, capacity.signetId),
        ...(kingdomProject ? { projectId: kingdomProject } : {}),
        model: view.defaults.model,
        effort: view.defaults.codexEffort ?? 'default',
      };
    },
  });
  return (local) =>
    new ProjectCapacityAuthentication({
      local,
      usesKingdom: (threadId) => projectOf(threadId)?.capacity === 'kingdom',
      kingdom,
    });
}
