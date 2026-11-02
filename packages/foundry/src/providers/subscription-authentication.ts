/**
 * @atlas
 * @kind service
 * @partOf feature:nativeAuth
 */
import { withProfile } from './default-profiles';
import { claudeSettingsFiles, subscriptionSettingsGuard } from './harness-settings';
import {
  NativeAuthentication,
  type NativeAuthenticationLaunch,
  type NativeAuthenticationSource,
  type NativeRuntime,
} from './native-authentication';
import { nativeTextEnvironment } from './native-text-environment';
import {
  codexSubscriptionStatus,
  museSubscriptionStatus,
  type StatusProcess,
  subscriptionStatus,
} from './native-text-provider';

/** Each runtime's read-only login check: no model turn, nothing about the account kept. */
const STATUS: Record<
  NativeRuntime,
  { argv: string[]; read: (child: StatusProcess) => Promise<boolean>; refusal: string }
> = {
  claude: {
    argv: ['claude', 'auth', 'status', '--json'],
    read: subscriptionStatus,
    refusal: 'Authenticated Claude subscription required',
  },
  codex: {
    argv: ['codex', 'login', 'status'],
    read: codexSubscriptionStatus,
    refusal: 'Codex ChatGPT login required',
  },
  muse: {
    argv: ['muse', 'usage', '--json'],
    read: museSubscriptionStatus,
    refusal: 'Muse Code subscription login required (run `muse login`)',
  },
};

// `claude auth status` reaches the network; under launchd it takes several seconds.
const STATUS_DEADLINE_MS = 20_000;
const STATUS_TTL_MS = 5 * 60_000;

/** The main-thread worker on its subscription login, a shared holder alongside decisions on the same login.
 * Codex runs on a Foundry-private CODEX_HOME, so the user's Codex config never applies. Muse Code runs on
 * the user's own login in place (`~/.config/muse`); see `MuseSessionAdapter` for what of its config loads. */
export class SubscriptionAuthentication extends NativeAuthentication {
  private statusChild?: StatusProcess;
  private statusCheck?: Promise<void>;
  private statusVerifiedAt = 0;
  private statusClosed = false;
  constructor(
    directory: string,
    private workerSource: Extract<NativeAuthenticationSource, { mode: 'native-profile' }>,
    private statusSpawn?: (environment: Record<string, string | undefined>) => StatusProcess,
    private statusDeadlineMs = STATUS_DEADLINE_MS,
  ) {
    super({
      directory,
      sources: [workerSource],
      defaultSourceId: workerSource.id,
      shared: true,
      ...(workerSource.runtime === 'codex' ? { privateHome: true } : {}),
    });
    this.workerSource = structuredClone(workerSource);
  }
  override async prepare(
    threadId: string,
    runtime: NativeRuntime,
  ): Promise<NativeAuthenticationLaunch> {
    if (runtime !== this.workerSource.runtime) throw Error('Subscription worker runtime mismatch');
    if (this.statusClosed)
      throw Error('Subscription status admission unavailable; no API fallback');
    if (Date.now() - this.statusVerifiedAt > STATUS_TTL_MS) {
      this.statusCheck ??= this.verifyStatus().finally(() => {
        this.statusCheck = undefined;
      });
      try {
        await this.statusCheck;
      } catch {
        throw Error('Subscription worker unavailable; no API fallback');
      }
    }
    const launch = await super.prepare(threadId, runtime);
    const configDirectory = this.workerSource.profileDirectory;
    // Codex launch overrides are already limited to sandbox, approval and effort by the native binding;
    // Muse Code's are fixed by agent-session (`serve --trust-workspace`, the sandbox switch).
    if (runtime === 'codex' || runtime === 'muse')
      return {
        ...launch,
        launch: (argv, env, harness) => launch.launch(argv, nativeTextEnvironment(env), harness),
      };
    return {
      ...launch,
      launch(argv, env, harness) {
        if (argv.some((arg) => /^(--settings|--setting-sources|--fallback-model)(=|$)/.test(arg)))
          throw Error('Subscription launch override refused');
        const owned = launch.launch(argv, nativeTextEnvironment(env));
        if (!harness) return { argv: [...owned.argv, '--setting-sources', ''], env: owned.env };
        const guard = subscriptionSettingsGuard(claudeSettingsFiles(configDirectory, harness));
        return {
          argv: [...owned.argv, '--setting-sources', harness.sources, '--settings', guard],
          env: owned.env,
        };
      },
    };
  }
  private async verifyStatus(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let exited = false;
    const { runtime, profileDirectory } = this.workerSource;
    const environment = {
      ...withProfile(
        nativeTextEnvironment(process.env),
        runtime,
        runtime === 'codex' ? await this.codexHome(this.workerSource) : profileDirectory,
      ),
      // `muse usage` would otherwise update the CLI past the SDK's pinned version.
      ...(runtime === 'muse' ? { MUSE_NO_AUTO_UPDATE: '1' } : {}),
    };
    const status = STATUS[runtime];
    const child = this.statusSpawn
      ? this.statusSpawn(environment)
      : Bun.spawn(status.argv, {
          env: environment,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        });
    this.statusChild = child;
    const exit = child.exited.then(
      () => {
        exited = true;
      },
      () => {},
    );
    try {
      const signedIn = await Promise.race([
        status.read(child),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error('Subscription status deadline')),
            this.statusDeadlineMs,
          );
        }),
      ]);
      if (!signedIn) throw Error(status.refusal);
    } finally {
      clearTimeout(timer);
      if (!exited) {
        try {
          child.kill();
        } catch {
          /* Exit, not a kill acknowledgement, settles ownership. */
        }
        await Promise.race([
          exit,
          new Promise<void>((resolve) => {
            cleanupTimer = setTimeout(resolve, 1_000);
          }),
        ]);
      }
      clearTimeout(cleanupTimer);
      if (exited) this.statusChild = undefined;
      else this.statusClosed = true; // Retain the unresolved child and refuse further launches.
    }
    if (this.statusClosed) throw Error('Subscription status process did not exit');
    this.statusVerifiedAt = Date.now();
  }
}
