import { NativeAuthentication, type NativeAuthenticationLaunch, type NativeAuthenticationSource } from "./native-authentication";
import { subscriptionStatus, type StatusProcess } from "./native-text-provider";
import { nativeTextEnvironment } from "./native-text-environment";

export class SubscriptionAuthentication extends NativeAuthentication {
  private statusChild?: StatusProcess;
  private statusChecking = false;
  private statusClosed = false;
  constructor(directory: string, private workerSource: Extract<NativeAuthenticationSource, { mode: "native-profile" }>, private statusSpawn?: (profile: string) => StatusProcess) {
    super({ directory, sources: [workerSource], defaultSourceId: workerSource.id });
    this.workerSource = structuredClone(workerSource);
    if (workerSource.runtime !== "claude") throw Error("Subscription worker requires a Claude native profile");
  }
  override async prepare(threadId: string, runtime: "claude" | "codex"): Promise<NativeAuthenticationLaunch> {
    if (runtime !== "claude") throw Error("Subscription worker runtime mismatch");
    if (this.statusChecking || this.statusClosed) throw Error("Subscription status admission unavailable; no API fallback");
    this.statusChecking = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let exited = false;
    try {
      const child = this.statusChild = this.statusSpawn ? this.statusSpawn(this.workerSource.profileDirectory) : Bun.spawn(["claude", "auth", "status", "--json"], {
        env: { ...nativeTextEnvironment(process.env), CLAUDE_CONFIG_DIR: this.workerSource.profileDirectory },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const exit = child.exited.then(() => { exited = true; }, () => {});
      try {
        const status = await Promise.race([
          subscriptionStatus(child),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Subscription status deadline")), 5_000); }),
        ]);
        if (!status) throw Error("Authenticated Claude subscription required");
      } finally {
        clearTimeout(timer);
        if (!exited) {
          try { child.kill(); } catch { /* Exit, not a kill acknowledgement, settles ownership. */ }
          await Promise.race([exit, new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 1_000); })]);
        }
        clearTimeout(cleanupTimer);
        if (exited) this.statusChild = undefined;
        else this.statusClosed = true; // Retain the unresolved child and refuse further launches.
      }
    } catch { throw Error("Subscription worker unavailable; no API fallback"); }
    finally { this.statusChecking = false; }
    const launch = await super.prepare(threadId, runtime);
    return { ...launch, launch(argv, env) {
      if (argv.some(arg => /^(--settings|--setting-sources|--fallback-model)(=|$)/.test(arg))) throw Error("Subscription launch override refused");
      const owned = launch.launch(argv, nativeTextEnvironment(env));
      return { argv: [...owned.argv, "--setting-sources", ""], env: owned.env };
    } };
  }
}
