import { RuntimeJobWorker } from "./runtime-job-worker";
import { RuntimeJobRegistry, type RuntimeIdentity } from "./runtime-job-handler";
import { z } from "zod";
import { isAbsolute } from "node:path";
import { kastleUrl } from "./kastle-client";
import { installationCredentialSchema, readPrivateJson } from "./kastle-credential-file";
import { makeUnrefInterval, type UnrefInterval } from "../ws/unref-interval";

export const kingdomRuntimeSchema = z.object({
  url: z.string().transform(kastleUrl),
  installationId: z.string().uuid(),
  credentialFile: z.string().refine(isAbsolute, "Credential path must be absolute"),
}).strict();
export type KingdomRuntimeSettings = z.input<typeof kingdomRuntimeSchema>;
/** One Foundry may hold runtimes on many Kingdoms; a runtime is identified by Kingdom origin and installation. */
export type KingdomRuntimeSelection = Pick<KingdomRuntimeSettings, "url" | "installationId">;
export const kingdomRuntimeKey = (runtime: KingdomRuntimeSelection) => `${kastleUrl(runtime.url)} ${runtime.installationId}`;
/** Picks the enrolled runtime on a Kingdom: by origin when given, otherwise the only one enrolled. */
export const selectKingdomRuntime = <T extends KingdomRuntimeSelection>(runtimes: readonly T[] | undefined, url?: string): T => {
  const candidates = (runtimes ?? []).filter(runtime => !url || kastleUrl(runtime.url) === kastleUrl(url));
  if (candidates.length === 1) return candidates[0]!;
  if (!candidates.length) throw Error(url ? "Foundry is not connected to that Kingdom" : "Connect Foundry to Kingdom first");
  throw Error(url ? "Several runtimes are enrolled with that Kingdom" : "Foundry is connected to several Kingdoms; choose one by its API address");
};
export const kingdomRuntimesSchema = z.array(kingdomRuntimeSchema).superRefine((runtimes, context) => {
  const keys = runtimes.map(kingdomRuntimeKey);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "Each Kingdom runtime (url + installationId) may appear once" });
});

/** Close code for a planned update restart; the reason is `runtimeUpdateCloseReason(...)`. Kingdom holds presence as "restarting" instead of "offline". */
export const RUNTIME_UPDATE_CLOSE_CODE = 4000;
export const MAX_EXPECTED_BACK_WITHIN_MS = 600_000;
export const runtimeUpdateCloseReason = (expectedBackWithinMs: number) =>
  JSON.stringify({ reason: "updating", expectedBackWithinMs });

export const RUNTIME_PING_INTERVAL_MS = 10_000;
export const RUNTIME_PONG_TIMEOUT_MS = 5_000;
const AUTHENTICATION_TIMEOUT_MS = 5_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CLAIM_RETRY_BASE_MS = 15_000;
const CLAIM_RETRY_MAX_MS = 60_000;
const UPDATE_CLOSE_FLUSH_MS = 2_000;

export type RuntimeSocketFactory = (url: string) => WebSocket;
export type KingdomRuntimeConnectionOptions = {
  openSocket?: RuntimeSocketFactory;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  reconnectBaseMs?: number;
};

const inboundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runtimeIdentity"), installationId: z.string().uuid(), userId: z.string().uuid(), expiresAt: z.string().datetime() }),
  z.object({ type: z.literal("runtimeJobAvailable"), jobId: z.string().uuid() }),
  z.object({ type: z.literal("runtimeRejected"), status: z.number().int(), message: z.string() }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("reconnect") }),
]);

const unavailable = () => Error("Kingdom runtime unavailable; check enrollment, expiry and connection");
const isRejection = (code: number) => code >= 4400 && code < 4500;
const unref = <T extends ReturnType<typeof setTimeout>>(timer: T) => { (timer as { unref?: () => void }).unref?.(); return timer; };

const live = new Set<KingdomRuntimeConnection>();

/**
 * Daemon hook, called immediately before exiting to apply an update: every live runtime socket in
 * this process closes with `RUNTIME_UPDATE_CLOSE_CODE` so Kingdom shows the runtime as restarting.
 */
export const closeKingdomRuntimeForUpdate = async (expectedBackWithinMs: number): Promise<void> => {
  await Promise.all([...live].map(connection => connection.closeForUpdate(expectedBackWithinMs)));
};

/**
 * Outbound WebSocket to Kingdom. The open, authenticated socket is this installation's liveness;
 * Kingdom pushes `runtimeJobAvailable` down it and the worker claims over HTTP.
 */
export class KingdomRuntimeConnection {
  private settings: z.output<typeof kingdomRuntimeSchema>;
  private socket?: WebSocket;
  private attempt?: { promise: Promise<void>; settle: (error?: Error) => void };
  private available = false;
  private started = false;
  private stopped = false;
  private failures = 0;
  private claimFailures = 0;
  private lastStatus?: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private authenticationTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: UnrefInterval;
  private pongTimer?: ReturnType<typeof setTimeout>;
  private claimRetryTimer?: ReturnType<typeof setTimeout>;
  private jobs?: RuntimeJobWorker;
  constructor(settings: KingdomRuntimeSettings, private sessionCount: () => number, private transport: typeof fetch = fetch, private handlers: RuntimeJobRegistry = new RuntimeJobRegistry(), private options: KingdomRuntimeConnectionOptions = {}) {
    this.settings = kingdomRuntimeSchema.parse(settings);
  }
  get connected() { return this.available; }
  get runtime(): Readonly<z.output<typeof kingdomRuntimeSchema>> { return this.settings; }
  /** Resolves while the socket is authenticated; otherwise joins or starts a reconnect now and waits for it. */
  check(): Promise<void> {
    if (this.available) return Promise.resolve();
    if (this.stopped) return Promise.reject(unavailable());
    return this.connect();
  }
  /** Connects and keeps reconnecting with backoff until `stop()`; rejects when the first connection fails. */
  async start(): Promise<void> {
    if (this.stopped) throw unavailable();
    this.jobs ??= new RuntimeJobWorker(this.settings, this.transport, this.handlers);
    this.started = true;
    live.add(this);
    await this.connect();
  }
  /** Asks the worker to claim now; resolves when the claim sweep settles. */
  claimJobs(): Promise<void> {
    const jobs = this.jobs;
    if (!jobs || this.stopped) return Promise.resolve();
    clearTimeout(this.claimRetryTimer);
    return jobs.check().then(() => { this.claimFailures = 0; }, error => { this.scheduleClaimRetry(); throw error; });
  }
  stop(): void {
    this.halt();
    const socket = this.socket;
    if (socket) {
      this.detach(socket);
      try { socket.close(1000, "Foundry stopped"); } catch {}
    }
  }
  /** Closes with the update reason so Kingdom holds presence as restarting, then stays closed. */
  async closeForUpdate(expectedBackWithinMs: number): Promise<void> {
    const socket = this.socket, authenticated = this.available;
    this.halt();
    if (!socket) return;
    this.detach(socket);
    if (!authenticated || socket.readyState !== WebSocket.OPEN) {
      try { socket.close(1000, "Foundry stopped"); } catch {}
      return;
    }
    const withinMs = Math.min(MAX_EXPECTED_BACK_WITHIN_MS, Math.max(1, Math.round(expectedBackWithinMs)));
    const flushed = new Promise<void>(resolve => {
      socket.onclose = () => resolve();
      unref(setTimeout(resolve, UPDATE_CLOSE_FLUSH_MS));
    });
    socket.close(RUNTIME_UPDATE_CLOSE_CODE, runtimeUpdateCloseReason(withinMs));
    await flushed;
  }
  private halt(): void {
    this.stopped = true;
    live.delete(this);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.claimRetryTimer);
    this.jobs?.stop();
    this.available = false;
    this.attempt?.settle(unavailable());
  }
  private connect(): Promise<void> {
    if (this.attempt) return this.attempt.promise;
    clearTimeout(this.reconnectTimer);
    let settle!: (error?: Error) => void;
    const promise = new Promise<void>((resolve, reject) => { settle = error => error ? reject(error) : resolve(); });
    promise.catch(() => {});
    this.attempt = { promise, settle: error => {
      if (this.attempt?.promise !== promise) return;
      this.attempt = undefined;
      settle(error);
    } };
    void this.open().catch(() => this.lost(this.socket, 1006));
    return promise;
  }
  private async open(): Promise<void> {
    const { secret } = installationCredentialSchema.parse(await readPrivateJson(this.settings.credentialFile));
    if (this.stopped) throw unavailable();
    const url = this.settings.url.replace(/^http/, "ws");
    const socket = this.options.openSocket?.(url) ?? new WebSocket(url);
    this.socket = socket;
    this.authenticationTimer = unref(setTimeout(() => this.abandon(socket), AUTHENTICATION_TIMEOUT_MS));
    socket.onopen = () => socket.send(JSON.stringify({ action: "authenticateRuntime", headers: { authorization: `Bearer ${secret}` } }));
    socket.onmessage = event => this.receive(socket, event.data);
    socket.onclose = event => this.lost(socket, event.code);
    socket.onerror = () => {};
  }
  private receive(socket: WebSocket, raw: unknown): void {
    if (socket !== this.socket) return;
    let decoded: unknown;
    try { decoded = JSON.parse(String(raw)); } catch { return; }
    const frame = inboundSchema.safeParse(decoded);
    if (!frame.success) return;
    switch (frame.data.type) {
      case "runtimeIdentity": {
        const { type: _, ...identity } = frame.data;
        return this.authenticated(socket, identity);
      }
      case "pong": return void clearTimeout(this.pongTimer);
      case "runtimeJobAvailable": return void this.claimJobs().catch(() => {});
      case "reconnect": return void (this.failures = 0);
      case "runtimeRejected": return void (this.available = false);
    }
  }
  private authenticated(socket: WebSocket, identity: RuntimeIdentity): void {
    try {
      for (const handler of this.handlers.all()) handler.verifyIdentity?.(identity);
      if (identity.installationId !== this.settings.installationId || Date.parse(identity.expiresAt) <= Date.now())
        throw Error("Runtime identity mismatch");
    } catch {
      this.failures = Math.max(this.failures, 5);
      return this.abandon(socket);
    }
    clearTimeout(this.authenticationTimer);
    this.available = true;
    this.failures = 0;
    this.lastStatus = undefined;
    this.sendStatus(socket);
    this.startHeartbeat(socket);
    this.attempt?.settle();
    void this.claimJobs().catch(() => {});
  }
  private sendStatus(socket: WebSocket): void {
    const status = JSON.stringify(Object.assign({ sessionCount: this.sessionCount() }, ...this.handlers.all().map(handler => handler.heartbeatBody?.() ?? {}), { action: "runtimeStatus" }));
    if (status === this.lastStatus) return;
    socket.send(status);
    this.lastStatus = status;
  }
  private startHeartbeat(socket: WebSocket): void {
    this.heartbeat?.stop();
    this.heartbeat = makeUnrefInterval({ intervalMs: this.options.pingIntervalMs ?? RUNTIME_PING_INTERVAL_MS, tick: () => {
      if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
      this.sendStatus(socket);
      socket.send(JSON.stringify({ action: "ping" }));
      clearTimeout(this.pongTimer);
      this.pongTimer = unref(setTimeout(() => this.abandon(socket), this.options.pongTimeoutMs ?? RUNTIME_PONG_TIMEOUT_MS));
    } });
    this.heartbeat.start();
  }
  private detach(socket: WebSocket): void {
    if (this.socket === socket) this.socket = undefined;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    this.heartbeat?.stop();
    clearTimeout(this.pongTimer);
    clearTimeout(this.authenticationTimer);
    this.available = false;
  }
  /** Drops a socket that cannot be trusted to close on its own (no pong, no identity, wrong identity). */
  private abandon(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.lost(socket, 1006);
    try { socket.close(1000, "Foundry reconnecting"); } catch {}
  }
  private lost(socket: WebSocket | undefined, code: number): void {
    if (socket && socket !== this.socket) return;
    if (socket) this.detach(socket);
    this.available = false;
    if (isRejection(code)) this.failures = Math.max(this.failures, 5);
    this.attempt?.settle(unavailable());
    this.scheduleReconnect();
  }
  private scheduleReconnect(): void {
    if (this.stopped || !this.started) return;
    clearTimeout(this.reconnectTimer);
    const backoff = Math.min(RECONNECT_MAX_MS, (this.options.reconnectBaseMs ?? RECONNECT_BASE_MS) * 2 ** this.failures);
    this.failures++;
    this.reconnectTimer = unref(setTimeout(() => { void this.connect().catch(() => {}); }, backoff * (0.8 + Math.random() * 0.4)));
  }
  private scheduleClaimRetry(): void {
    if (this.stopped || !this.available) return;
    const delay = Math.min(CLAIM_RETRY_MAX_MS, CLAIM_RETRY_BASE_MS * 2 ** this.claimFailures);
    this.claimFailures++;
    this.claimRetryTimer = unref(setTimeout(() => { void this.claimJobs().catch(() => {}); }, delay));
  }
}
