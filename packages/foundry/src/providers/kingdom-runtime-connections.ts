import {
  KingdomRuntimeConnection,
  type KingdomRuntimeSettings,
  kingdomRuntimeId,
} from './kingdom-runtime-connection';

/** `connected` when every paired Kingdom is, `unavailable` when any is not, `disconnected` when none is paired. */
export const overallStatus = (runtimes: readonly { status: string }[]) =>
  !runtimes.length
    ? ('disconnected' as const)
    : runtimes.every((runtime) => runtime.status === 'connected')
      ? ('connected' as const)
      : ('unavailable' as const);

/**
 * One connection per paired Kingdom. Each keeps its own heartbeat, backoff and job worker, so a job is
 * claimed from and reported to the Kingdom that issued it, and one Kingdom failing never stops another.
 */
export class KingdomRuntimeConnections {
  private connections = new Map<string, KingdomRuntimeConnection>();
  constructor(
    runtimes: readonly KingdomRuntimeSettings[],
    private sessionCount: () => number,
    private transport: typeof fetch = fetch,
  ) {
    for (const runtime of runtimes)
      this.connections.set(kingdomRuntimeId(runtime), this.create(runtime));
  }
  get size() {
    return this.connections.size;
  }
  all(): KingdomRuntimeConnection[] {
    return [...this.connections.values()];
  }
  get(id: string): KingdomRuntimeConnection | undefined {
    return this.connections.get(id);
  }
  /** True while no Kingdom is paired, or at least one paired Kingdom authorizes this Foundry. */
  get authorized() {
    return !this.size || this.all().some((connection) => connection.connected);
  }
  /** Resolves once any paired Kingdom authorizes this Foundry; every connection still refreshes its own state. */
  async check(): Promise<void> {
    if (!this.size) return;
    await Promise.any(this.all().map((connection) => connection.check())).catch(() => {
      throw Error('No paired Kingdom authorizes this Foundry');
    });
  }
  /** Starts every connection concurrently; each keeps reconnecting on its own. Resolves to the ids that failed first contact. */
  async start(): Promise<string[]> {
    const results = await Promise.allSettled(this.all().map((connection) => connection.start()));
    return this.all()
      .filter((_, index) => results[index]!.status === 'rejected')
      .map((connection) => connection.id);
  }
  /** Connects a newly saved runtime, replacing the connection with the same id. */
  async set(runtime: KingdomRuntimeSettings): Promise<KingdomRuntimeConnection> {
    const id = kingdomRuntimeId(runtime),
      connection = this.create(runtime);
    this.connections.get(id)?.stop();
    this.connections.set(id, connection);
    await connection.start().catch(() => {});
    return connection;
  }
  remove(id: string): void {
    this.connections.get(id)?.stop();
    this.connections.delete(id);
  }
  stop(): void {
    for (const connection of this.all()) connection.stop();
  }
  private create(runtime: KingdomRuntimeSettings) {
    return new KingdomRuntimeConnection(runtime, this.sessionCount, this.transport);
  }
}
