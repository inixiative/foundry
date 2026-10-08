import { withProfile } from './default-profiles';
import {
  NativeAuthentication,
  type NativeAuthenticationLaunch,
  type NativeAuthenticationSource,
} from './native-authentication';
import { nativeTextEnvironment } from './native-text-environment';
import {
  codexSubscriptionStatus,
  type StatusProcess,
  subscriptionStatus,
} from './native-text-provider';

// `claude auth status` reaches the network; under launchd it takes several seconds.
const STATUS_DEADLINE_MS = 20_000;
const STATUS_TTL_MS = 5 * 60_000;

/** The main-thread worker on its subscription login: Claude Code holds its profile exclusively; Codex shares
 * the login with Codex decisions on a Foundry-private CODEX_HOME, so the user's Codex config never applies. */
export class SubscriptionAuthentication extends NativeAuthentication {
  private statusChild?: StatusProcess;
  private statusCheck?: Promise<void>;
  private statusVerifiedAt = 0;
  private statusClosed = false;
  constructor(
    directory: string,
    private workerSource: Extract<NativeAuthenticationSource, { mode: 'native-profile' }>,
    private statusSpawn?: (profile: string) => StatusProcess,
    private statusDeadlineMs = STATUS_DEADLINE_MS,
  ) {
    super({
      directory,
      sources: [workerSource],
      defaultSourceId: workerSource.id,
      ...(workerSource.runtime === 'codex' ? { shared: true, privateHome: true } : {}),
    });
    this.workerSource = structuredClone(workerSource);
  }
  override async prepare(
    threadId: string,
    runtime: 'claude' | 'codex',
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
    // Codex launch overrides are already limited to sandbox, approval and effort by the native binding.
    if (runtime === 'codex')
      return { ...launch, launch: (argv, env) => launch.launch(argv, nativeTextEnvironment(env)) };
    return {
      ...launch,
      launch(argv, env) {
        if (argv.some((arg) => /^(--settings|--setting-sources|--fallback-model)(=|$)/.test(arg)))
          throw Error('Subscription launch override refused');
        const owned = launch.launch(argv, nativeTextEnvironment(env));
        return { argv: [...owned.argv, '--setting-sources', ''], env: owned.env };
      },
    };
  }
  private async verifyStatus(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let exited = false;
    const { runtime, profileDirectory } = this.workerSource;
    const child = this.statusSpawn
      ? this.statusSpawn(profileDirectory)
      : Bun.spawn(
          runtime === 'codex'
            ? ['codex', 'login', 'status']
            : ['claude', 'auth', 'status', '--json'],
          {
            env: withProfile(nativeTextEnvironment(process.env), runtime, profileDirectory),
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
    this.statusChild = child;
    const exit = child.exited.then(
      () => {
        exited = true;
      },
      () => {},
    );
    try {
      const status = await Promise.race([
        runtime === 'codex' ? codexSubscriptionStatus(child) : subscriptionStatus(child),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error('Subscription status deadline')),
            this.statusDeadlineMs,
          );
        }),
      ]);
      if (!status)
        throw Error(
          runtime === 'codex'
            ? 'Codex ChatGPT login required'
            : 'Authenticated Claude subscription required',
        );
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
