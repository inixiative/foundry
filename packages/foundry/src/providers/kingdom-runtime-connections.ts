import { RuntimeJobRegistry } from "./runtime-job-handler";
import { KingdomRuntimeConnection, kingdomRuntimeKey, type KingdomRuntimeConnectionOptions, type KingdomRuntimeSelection, type KingdomRuntimeSettings } from "./kingdom-runtime-connection";

/**
 * Every Kingdom this Foundry is enrolled with, one socket each. Each connection keeps its own presence,
 * status frame, backoff and job worker, so a job is claimed from and reported to the Kingdom that pushed it.
 */
export class KingdomRuntimeConnections {
  private connections = new Map<string, KingdomRuntimeConnection>();
  constructor(runtimes: readonly KingdomRuntimeSettings[], private sessionCount: () => number, private transport: typeof fetch = fetch, private handlers: RuntimeJobRegistry = new RuntimeJobRegistry(), private options: KingdomRuntimeConnectionOptions = {}) {
    for (const runtime of runtimes) this.connections.set(kingdomRuntimeKey(runtime), this.create(runtime));
  }
  get size() { return this.connections.size; }
  /** True when every enrolled runtime holds an authenticated socket. */
  get connected() { return this.size > 0 && this.all().every(connection => connection.connected); }
  all(): KingdomRuntimeConnection[] { return [...this.connections.values()]; }
  get(runtime: KingdomRuntimeSelection): KingdomRuntimeConnection | undefined { return this.connections.get(kingdomRuntimeKey(runtime)); }
  /** Resolves when every enrolled runtime is authorized; each unavailable one reconnects now. */
  async check(): Promise<void> { await Promise.all(this.all().map(connection => connection.check())); }
  /** Starts every runtime; each keeps reconnecting on its own. Rejects when any first connection failed. */
  async start(): Promise<void> {
    const results = await Promise.allSettled(this.all().map(connection => connection.start()));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  /** Connects a newly enrolled runtime; it joins the set only once authenticated. */
  async add(runtime: KingdomRuntimeSettings): Promise<KingdomRuntimeConnection> {
    const connection = this.create(runtime);
    try { await connection.start(); } catch (error) { connection.stop(); throw error; }
    this.connections.get(kingdomRuntimeKey(runtime))?.stop();
    this.connections.set(kingdomRuntimeKey(runtime), connection);
    return connection;
  }
  remove(runtime: KingdomRuntimeSelection): void {
    const key = kingdomRuntimeKey(runtime);
    this.connections.get(key)?.stop();
    this.connections.delete(key);
  }
  stop(): void {
    for (const connection of this.connections.values()) connection.stop();
  }
  private create(runtime: KingdomRuntimeSettings) {
    return new KingdomRuntimeConnection(runtime, this.sessionCount, this.transport, this.handlers, this.options);
  }
}
