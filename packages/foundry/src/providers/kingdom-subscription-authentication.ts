/**
 * @atlas
 * @kind service
 * @partOf feature:nativeAuth, integration:kingdom
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
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
  shareMuseUserConfig,
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
import { nativeTextEnvironment } from './native-text-environment';
import { museLoginRejected, type StatusProcess } from './native-text-provider';
import { assertPrivateDirectory, assertPrivateProfile } from './private-profile';

/** Where one thread's subscription comes from: a Signet this Foundry holds, and the Kingdom project it bills. */
export interface KingdomCapacity {
  url: string;
  credentialFile: string;
  /** Kingdom UsageProject; its pool chooses the login. Absent: the Signet's own project. */
  projectId?: string;
  model: string;
  effort: string;
}

type Runtime = NativeRuntime;
type Run = { envelope: KingdomRunEnvelope; client: KingdomClient; fingerprint: string };

const CODEX_HOME_CONFIG = 'cli_auth_credentials_store = "file"\n';
/** How long `muse usage` may take to confirm a rejected login, and how soon a failed launch may ask again. */
const MUSE_CONFIRM_DEADLINE_MS = 20_000;
const MUSE_CONFIRM_COOLDOWN_MS = 5 * 60_000;
const SIGN_IN_AGAIN = 'sign in again with `bun run kingdom login muse`';
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
  /** Muse logins Meta rejected in this process: a pool left with none says so. */
  private rejectedMuse = new Set<string>();
  constructor(
    private options: {
      directory: string;
      capacity: (threadId: string) => Promise<KingdomCapacity>;
      warn?: (message: string) => void;
      /** The user's own Claude home shared into each login's home; default ~/.claude. */
      userClaudeDirectory?: string;
      /** The user's own Codex home whose setup a main thread takes; default ~/.codex. */
      userCodexDirectory?: string;
      /** The user's own config home (`$XDG_CONFIG_HOME`, default ~/.config) a Muse login's home links to. */
      userConfigDirectory?: string;
      /** Test seam: runs `muse usage --json` in this environment. */
      museStatus?: (environment: Record<string, string | undefined>) => StatusProcess;
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
        const envelope = await client
          .resolve(Bun.randomUUIDv7(), {
            model: capacity.model,
            effort: capacity.effort,
            authentication: 'subscription',
            runtime,
            ...(capacity.projectId ? { projectId: capacity.projectId } : {}),
          })
          .catch((error: unknown) => {
            if (runtime !== 'muse' || !this.rejectedMuse.size) throw error;
            throw Error(
              `${(error as Error).message}. Meta rejected this pool's Muse Code login (${[...this.rejectedMuse].join(', ')}); ${SIGN_IN_AGAIN}`,
            );
          });
        if (envelope.authentication !== 'subscription' || envelope.runtime !== runtime)
          throw Error('Kingdom selected a login for a different runtime');
        // A login Kingdom releases again was signed in anew.
        this.rejectedMuse.delete(envelope.integrationId);
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
    // Muse reads its login only from `$XDG_CONFIG_HOME/muse/auth.json`: the login's own config home.
    let home = runtime === 'muse' ? join(baseHome, 'muse-config') : baseHome;
    let active = false,
      ended = false,
      reported = false,
      confirming: Promise<boolean> | undefined,
      confirmedAt = 0;
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
        const env = withoutCompetingCredentials(inherited, runtime);
        mkdirSync(home, { recursive: true, mode: 0o700 });
        // A Muse config home holds links to the user's config (any name); its login is checked in `muse/`.
        if (runtime === 'muse') assertPrivateDirectory(home);
        else assertPrivateProfile(home);
        let launchArgs = [...argv];
        if (runtime === 'muse') {
          // Every command Muse runs inherits XDG_CONFIG_HOME, so the user's other config is linked in;
          // XDG_DATA_HOME stays the user's, so sessions, resume and Archive capture are unchanged.
          shareMuseUserConfig(home, this.userConfigDirectory);
          this.writeMuseLogin(home, released.accessToken);
          env.XDG_CONFIG_HOME = home;
        } else if (runtime === 'claude') {
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
        this.hold(home);
        return { argv: launchArgs, env };
      },
      release: () => {
        if (ended) return;
        ended = true;
        if (!active) return;
        active = false;
        this.unhold(home, runtime);
      },
      // Only Muse has a read-only check that names a rejected login; a Claude or Codex login that
      // stops working shows as Kingdom's refusal at its next release.
      loginFailed: async () => {
        if (runtime !== 'muse') return false;
        if (reported) return true;
        if (!confirming && Date.now() - confirmedAt < MUSE_CONFIRM_COOLDOWN_MS) return false;
        confirming ??= (async () => {
          try {
            if (!(await this.museRejected(baseHome, released.accessToken))) return false;
            const { recorded } = await run.client.reportCredentialRejected(
              released.executionId,
              released.credentialVersion,
            );
            reported = true;
            this.rejectedMuse.add(released.integrationId);
            // The next launch resolves again: Kingdom picks another login in the pool, or says none is left.
            const key = `${runtime}:${threadId}`;
            if (this.runs.get(key) === run) this.runs.delete(key);
            (this.options.warn ?? console.warn)(
              `[Kingdom] Meta rejected the Muse Code login ${released.integrationId}; ${recorded ? 'Kingdom now shows it as needing a new sign-in' : 'Kingdom had already marked it, or it was replaced since'}. ${SIGN_IN_AGAIN}.`,
            );
            return true;
          } catch (error) {
            (this.options.warn ?? console.warn)(
              `[Kingdom] could not confirm or report the Muse Code login ${released.integrationId}: ${(error as Error).message}`,
            );
            return false;
          } finally {
            confirmedAt = Date.now();
            confirming = undefined;
          }
        })();
        return await confirming;
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
  private get userConfigDirectory() {
    return this.options.userConfigDirectory ?? dirname(defaultProfileDirectory('muse'));
  }
  private hold(home: string) {
    this.holders.set(home, (this.holders.get(home) ?? 0) + 1);
  }
  /** The last holder of a login's home takes the login's tokens with it. */
  private unhold(home: string, runtime: Runtime) {
    const left = (this.holders.get(home) ?? 1) - 1;
    if (left > 0) {
      this.holders.set(home, left);
      return;
    }
    this.holders.delete(home);
    const login =
      runtime === 'codex'
        ? join(home, 'auth.json')
        : runtime === 'muse'
          ? join(home, 'muse', 'auth.json')
          : undefined;
    if (login)
      try {
        unlinkSync(login);
      } catch {}
  }
  /**
   * Muse reads its login from `<config home>/muse/auth.json`, a file-backed OAuth login (the CLI
   * then adds the subscription api key it derives, so a file holding the same token is kept).
   */
  private writeMuseLogin(home: string, accessToken: string) {
    const museHome = join(home, 'muse');
    const file = join(museHome, 'auth.json');
    mkdirSync(museHome, { recursive: true, mode: 0o700 });
    let current: unknown;
    try {
      current = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      /* None yet, or unreadable: written below. */
    }
    const held = (current as { providers?: { meta?: { access_token?: unknown } } } | undefined)
      ?.providers?.meta?.access_token;
    if (held !== accessToken)
      writePrivateFile(
        file,
        JSON.stringify({
          schema_version: 1,
          providers: {
            meta: {
              mechanism: 'oauth',
              storage: 'file',
              obtained_via: 'device_code',
              api_base_url: 'https://api.meta.ai/v1',
              access_token: accessToken,
            },
          },
        }),
      );
    assertPrivateProfile(museHome);
  }
  /**
   * Whether Meta rejects this launch's token, asked the way the user would (`muse usage --json`) in a
   * throwaway config home beside the login's, so the check never rewrites the shared home's login
   * (a newer token another thread runs on) and a release never removes the file under it.
   */
  private async museRejected(loginDirectory: string, accessToken: string): Promise<boolean> {
    mkdirSync(loginDirectory, { recursive: true, mode: 0o700 });
    const home = mkdtempSync(join(loginDirectory, 'check-'));
    let child: StatusProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.writeMuseLogin(home, accessToken);
      const environment = {
        ...withoutCompetingCredentials(nativeTextEnvironment(process.env), 'muse'),
        XDG_CONFIG_HOME: home,
      };
      const spawned =
        this.options.museStatus?.(environment) ??
        Bun.spawn(['muse', 'usage', '--json'], {
          env: environment,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        });
      child = spawned;
      return await Promise.race([
        museLoginRejected(spawned),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), MUSE_CONFIRM_DEADLINE_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        /* Already exited. */
      }
      rmSync(home, { recursive: true, force: true });
    }
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
      return this.options.kingdom.bindingId(threadId, runtime);
    return this.options.local?.bindingId(threadId, runtime) ?? threadId;
  }
  async resolveBindingId(threadId: string, runtime: NativeRuntime): Promise<string> {
    if (this.options.usesKingdom(threadId))
      return this.options.kingdom.resolveBindingId(threadId, runtime);
    const local = this.options.local;
    if (!local) return threadId;
    return (
      (await local.resolveBindingId?.(threadId, runtime)) ?? local.bindingId(threadId, runtime)
    );
  }
  async prepare(threadId: string, runtime: NativeRuntime): Promise<NativeAuthenticationLaunch> {
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
