// ---------------------------------------------------------------------------
// Live bridge transport (T2)
//
// Owning-process loopback HTTP server for one pinned live thread authority.
// Every request is validated before any runtime or backend work: method,
// browser Origin (rejected, including "null"), Host, a header-carried
// bridge-specific capability, authority liveness and body size. Sessions use
// the installed SDK's web-standard Streamable HTTP transport, one per SDK
// session, each connected to its own McpServer from the caller's factory so
// every session shares the same pinned authority.
//
// Lifecycle ownership: session capacity is reserved before the asynchronous
// connection and released exactly once; a failed, refused or late initialize
// closes the server and transport it allocated; explicit termination closes the
// session's server; immutable invocation records are retained separately from
// live resources; bridge close is idempotent, awaitable and waits for
// outstanding initializations so none can escape it.
//
// The capability is written once to a newly created 0600 launch file inside a
// 0700 directory; argv for the proxy carries only that path. A same-OS-user
// process that can read that directory can read the file: this is an
// application boundary, not an OS sandbox.
// ---------------------------------------------------------------------------

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FoundryMcp, ToolInvocationRecord } from "./server";
import type { SharedRevocation } from "./authority";

export interface LiveBridgeOptions {
  /** Unique process-owned name for integration; legacy T2 default is foundry. */
  serverName?: string;
  /** Creates a bridge server for one SDK session; every result must pin the same thread. */
  createMcp: () => FoundryMcp;
  /** Parent directory for the owned 0700 launch directory. Default: OS temp dir. */
  launchRoot?: string;
  /** Maximum accepted request body. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Maximum SDK sessions, counting pending initializations. Default 16. */
  maxSessions?: number;
  /** Proxy entry point placed in launch descriptors. Default: this package's proxy.ts. */
  proxyEntry?: string;
}

/** Exact launch data for a native CLI. Data only: nothing here is applied to any session. */
export interface LaunchDescriptor {
  readonly command: string;
  readonly args: readonly string[];
  readonly claude: { readonly mcpConfig: { mcpServers: Record<string, { command: string; args: string[] }> }; readonly mcpConfigJson: string };
  readonly codex: { readonly configOverrides: readonly string[] };
}

export type RejectionReason = "closed" | "path" | "method" | "origin" | "host" | "unauthorized" | "revoked" | "too-large" | "malformed" | "session" | "capacity" | "connect";

export interface LiveBridgeStats {
  readonly requests: number;
  readonly rejected: Readonly<Record<RejectionReason, number>>;
  /** Established sessions with a live server. */
  readonly sessions: number;
  /** Initializations reserved but not yet established. */
  readonly pendingInitializations: number;
  /** Servers created by the factory that are still open. */
  readonly liveServers: number;
  readonly sessionsOpened: number;
  readonly serversCreated: number;
  readonly serversClosed: number;
  /** Records currently retained by the bridge (bounded) and how many oldest ones were dropped. */
  readonly retainedRecords: number;
  readonly droppedRecords: number;
  /** Server/transport closes requested but not yet settled, and closes that rejected. */
  readonly pendingCleanups: number;
  readonly cleanupFailures: number;
}

export interface LiveBridge {
  readonly endpoint: string;
  readonly port: number;
  readonly launchDir: string;
  readonly launchFile: string;
  readonly launch: LaunchDescriptor;
  readonly closed: boolean;
  /** Frozen records from every server this bridge ever created, live or closed, in creation order. */
  invocations(): readonly ToolInvocationRecord[];
  stats(): LiveBridgeStats;
  /** Idempotent and awaitable; waits for outstanding initializations, closes every owned resource. */
  close(): Promise<void>;
}

/** Shape of the protected launch file. The capability appears nowhere else. */
export interface LaunchFile {
  readonly version: 1;
  readonly endpoint: string;
  readonly capability: string;
  readonly threadId: string;
  readonly generation?: string;
  readonly createdAt: number;
}

const DEFAULT_MAX_BODY = 1_048_576;
const DEFAULT_MAX_SESSIONS = 16;
const MAX_RETAINED_RECORDS = 2_000;
const ALLOWED_METHODS = "POST, GET, DELETE";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

function isInitialize(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(m => m && typeof m === "object" && (m as { method?: unknown }).method === "initialize");
}

function bearer(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+([A-Za-z0-9_-]{16,512})$/.exec(header);
  return match?.[1];
}

/** Constant-time comparison over digests so lengths never leak. */
function sameCapability(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}

interface Owned {
  readonly mcp: FoundryMcp;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  sessionId?: string;
  closed: boolean;
  releasing?: Promise<void>;
}

export async function createLiveBridge(options: LiveBridgeOptions): Promise<LiveBridge> {
  const serverName = options.serverName ?? "foundry";
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,80}$/.test(serverName)) throw Error("Invalid bridge server name");
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const primary = options.createMcp();
  const authority = primary.authority;
  let primaryUsed = false;
  const stats = {
    requests: 0, sessionsOpened: 0, serversCreated: 1, serversClosed: 0,
    rejected: { closed: 0, path: 0, method: 0, origin: 0, host: 0, unauthorized: 0, revoked: 0, "too-large": 0, malformed: 0, session: 0, capacity: 0, connect: 0 } as Record<RejectionReason, number>,
  };
  const sessions = new Map<string, Owned>();
  const live = new Set<Owned>();
  const pending = new Set<Promise<Response>>();
  /**
   * Every sealed record from every server this bridge created, delivered by the
   * server's record subscription at creation time. Retention is independent of
   * transport or server lifetime, so an owned operation that settles after its
   * session was terminated or the bridge closed is still inspectable with its
   * original owner, SDK ids and actual outcome. Bounded: oldest records drop
   * first and the drop count is reported truthfully.
   */
  const retained: ToolInvocationRecord[] = [];
  let droppedRecords = 0;
  const retain = (record: ToolInvocationRecord) => {
    retained.push(record);
    if (retained.length > MAX_RETAINED_RECORDS) { retained.splice(0, retained.length - MAX_RETAINED_RECORDS); droppedRecords += 1; }
  };
  primary.onRecord(retain);
  let reservations = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  let launchDir: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let expectedHost = "";

  const reject = (reason: RejectionReason, response: Response): Response => { stats.rejected[reason] += 1; return response; };

  // One revocation lifetime for the whole bridge. Every authority created for it,
  // primary or later session, is bound here at creation; latching `reason` at
  // close entry revokes them all, including authorities whose transports were
  // already released while a backend read is still pending. No list of servers.
  const revocation: SharedRevocation = { reason: null };
  primary.authority.bindLifetime(revocation);

  // Every requested close is owned until it settles: counted as completed only
  // when it resolves, as a cleanup failure when it rejects, and visible as pending
  // in between. Nothing is reported closed at request time or orphaned.
  const cleanups = new Set<Promise<void>>();
  // A release owns the whole transport -> server chain, even after DELETE has
  // removed it from live. A snapshot of individual closes misses later links.
  const releases = new Set<Promise<void>>();
  let cleanupFailures = 0;
  const trackCleanup = (request: () => Promise<unknown>, onComplete?: () => void): Promise<void> => {
    let attempt: Promise<unknown>;
    try { attempt = Promise.resolve(request()); } catch (error) { attempt = Promise.reject(error); }
    const tracked: Promise<void> = attempt.then(() => { onComplete?.(); }, () => { cleanupFailures += 1; }).finally(() => { cleanups.delete(tracked); });
    cleanups.add(tracked);
    return tracked;
  };
  const closeServer = (mcp: FoundryMcp) => trackCleanup(() => mcp.server.close(), () => { stats.serversClosed += 1; });

  const acquire = (): FoundryMcp => {
    if (!primaryUsed) { primaryUsed = true; return primary; }
    const next = options.createMcp();
    stats.serversCreated += 1;
    next.authority.bindLifetime(revocation);
    if (next.authority.thread !== authority.thread) {
      // A factory that hands out another thread's server is invalid configuration.
      // The allocation is revoked, its hook released and its close owned until it
      // settles; it is never adopted and never counted closed before it is.
      next.authority.revoke("revoked");
      void closeServer(next);
      throw new Error("Bridge session servers must pin the same thread");
    }
    next.onRecord(retain);
    return next;
  };

  /**
   * Close one owned server/transport exactly once. Live transport cleanup is
   * separate from operation settlement: an in-flight tool handler keeps running
   * to its own outcome and its record still arrives through the retention
   * subscription, and its authority keeps every live check. Only the authority's
   * disposal hook is detached here, so SDK churn leaves no hooks on the thread.
   * Nothing here labels that work cancelled or completed.
   */
  const release = (owned: Owned): Promise<void> => {
    if (owned.releasing) return owned.releasing;
    owned.closed = true;
    live.delete(owned);
    if (owned.sessionId) sessions.delete(owned.sessionId);
    owned.mcp.authority.detach();
    // Install the owner before invoking reentrant SDK close callbacks.
    const chain = Promise.resolve().then(async () => {
      await trackCleanup(() => owned.transport.close());
      await closeServer(owned.mcp);
    });
    owned.releasing = chain;
    releases.add(chain);
    void chain.finally(() => releases.delete(chain));
    return chain;
  };

  const admit = async (req: Request, parsedBody: unknown): Promise<Response> => {
    // Capacity is reserved synchronously, before any asynchronous work, and
    // released exactly once on every exit path below.
    if (sessions.size + reservations >= maxSessions) return reject("capacity", rpcError(429, -32000, "Too many bridge sessions"));
    reservations += 1;
    let reserved = true;
    const settle = () => { if (reserved) { reserved = false; reservations -= 1; } };
    let owned: Owned | undefined;
    try {
      let mcp: FoundryMcp;
      try { mcp = acquire(); }
      catch { return reject("connect", rpcError(500, -32000, "Bridge session could not be allocated")); }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        allowedHosts: [expectedHost],
        onsessioninitialized: (id) => {
          if (!owned || owned.closed) return;
          owned.sessionId = id; sessions.set(id, owned); stats.sessionsOpened += 1;
        },
        onsessionclosed: (id) => { const o = sessions.get(id); if (o) void release(o); },
      });
      owned = { mcp, transport, closed: false };
      live.add(owned);
      try { await mcp.server.connect(transport); }
      catch { await release(owned); return reject("connect", rpcError(500, -32000, "Bridge session could not be connected")); }
      // Recheck at the asynchronous admission boundary: a close or revocation that
      // happened while connecting must not let this initialization escape.
      if (closed) { await release(owned); return reject("closed", rpcError(410, -32000, "Bridge closed")); }
      const refusal = authority.check();
      if (refusal) { await release(owned); return reject("revoked", rpcError(410, -32000, `Bridge authority is no longer valid: ${refusal}`)); }
      const response = await transport.handleRequest(req, { parsedBody });
      const established = !!owned.sessionId && sessions.get(owned.sessionId) === owned && response.status < 400;
      if (!established || closed) {
        await release(owned);
        if (closed && response.status < 400) return reject("closed", rpcError(410, -32000, "Bridge closed"));
      }
      return response;
    } catch (error) {
      if (owned) await release(owned);
      throw error;
    } finally { settle(); }
  };

  const handle = async (req: Request): Promise<Response> => {
    stats.requests += 1;
    if (closed) return reject("closed", rpcError(410, -32000, "Bridge closed"));
    const url = new URL(req.url);
    if (url.pathname !== "/mcp") return reject("path", rpcError(404, -32000, "Not found"));
    if (!["POST", "GET", "DELETE"].includes(req.method)) return reject("method", rpcError(405, -32000, "Method not allowed", { Allow: ALLOWED_METHODS }));
    // Any browser-origin request, including an opaque "null" origin, is refused.
    if (req.headers.has("origin")) return reject("origin", rpcError(403, -32000, "Browser origins are not accepted by this bridge"));
    if (req.headers.get("host") !== expectedHost) return reject("host", rpcError(400, -32000, "Invalid Host header"));
    if (!sameCapability(capability, bearer(req.headers.get("authorization")))) {
      return reject("unauthorized", rpcError(401, -32000, "Unauthorized", { "WWW-Authenticate": 'Bearer realm="foundry-bridge"' }));
    }
    if (authority.check()) return reject("revoked", rpcError(410, -32000, `Bridge authority is no longer valid: ${authority.check()}`));
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBody) return reject("too-large", rpcError(413, -32000, "Request body too large"));
    let parsedBody: unknown;
    if (req.method === "POST") {
      const reader = req.body?.getReader();
      const chunks: Uint8Array[] = []; let total = 0;
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBody) { await reader.cancel().catch(() => {}); return reject("too-large", rpcError(413, -32000, "Request body too large")); }
          chunks.push(value);
        }
      }
      try { parsedBody = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
      catch { return reject("malformed", rpcError(400, -32700, "Parse error")); }
      // The body read was asynchronous: recheck the boundary before admitting work.
      if (closed) return reject("closed", rpcError(410, -32000, "Bridge closed"));
      const late = authority.check();
      if (late) return reject("revoked", rpcError(410, -32000, `Bridge authority is no longer valid: ${late}`));
    }
    const sessionId = req.headers.get("mcp-session-id");
    if (req.method === "POST" && !sessionId && isInitialize(parsedBody)) {
      const attempt = admit(req, parsedBody);
      pending.add(attempt);
      try { return await attempt; } finally { pending.delete(attempt); }
    }
    if (!sessionId) return reject("session", rpcError(400, -32000, "Bad Request: no session; initialize first"));
    const session = sessions.get(sessionId);
    if (!session || session.closed) return reject("session", rpcError(404, -32001, "Session not found"));
    return session.transport.handleRequest(req, { parsedBody });
  };

  const capability = randomBytes(32).toString("base64url");
  try {
    launchDir = mkdtempSync(join(options.launchRoot ?? tmpdir(), "foundry-bridge-"));
    chmodSync(launchDir, 0o700);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, maxRequestBodySize: maxBody, fetch: handle });
    const port = server.port;
    if (typeof port !== "number") throw new Error("Loopback bridge did not receive an allocated port");
    expectedHost = `127.0.0.1:${port}`;
    const endpoint = `http://${expectedHost}/mcp`;
    const launchFile = join(launchDir, "launch.json");
    // Newly created, never replaced, never through a symlink: 0600 from the first byte.
    const fd = openSync(launchFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const record: LaunchFile = { version: 1, endpoint, capability, threadId: authority.threadId, ...(authority.generation ? { generation: authority.generation } : {}), createdAt: Date.now() };
      writeSync(fd, JSON.stringify(record));
    } finally { closeSync(fd); }
    const proxyEntry = options.proxyEntry ?? fileURLToPath(new URL("./proxy.ts", import.meta.url));
    const args = [proxyEntry, launchFile];
    // Owned deep-frozen configuration snapshot: the nested server entry and its args
    // cannot be altered after creation, and the canonical JSON is taken from it once.
    const mcpConfig = Object.freeze({ mcpServers: Object.freeze({ [serverName]: Object.freeze({ command: "bun", args: Object.freeze([...args]) as unknown as string[] }) }) });
    const launch: LaunchDescriptor = Object.freeze({
      command: "bun", args: Object.freeze(args),
      claude: Object.freeze({ mcpConfig, mcpConfigJson: JSON.stringify(mcpConfig) }),
      codex: Object.freeze({ configOverrides: Object.freeze([`mcp_servers.${serverName}.command="bun"`, `mcp_servers.${serverName}.args=${JSON.stringify(args)}`]) }),
    });
    const close = async (): Promise<void> => {
      if (closing) return closing;
      closing = (async () => {
        // Latched synchronously at close entry: every authority this bridge created
        // is revoked now, whatever the state of its transport or pending backend work.
        closed = true;
        revocation.reason = "revoked";
        // Outstanding initializations observe `closed` at their next boundary and release themselves.
        await Promise.allSettled([...pending]);
        for (const owned of [...live]) await release(owned);
        if (!primaryUsed) await closeServer(primary);
        primary.authority.revoke("revoked");
        // Owned closes requested earlier (for example a refused allocation) settle
        // before the bridge reports closed; backend reads are never awaited here.
        while (releases.size || cleanups.size) await Promise.allSettled([...releases, ...cleanups]);
        server?.stop(true);
        // Only this bridge's own directory and file are removed; nothing else in the launch root.
        rmSync(launchDir!, { recursive: true, force: true });
      })();
      return closing;
    };
    const bridge: LiveBridge = {
      endpoint, port, launchDir, launchFile, launch,
      get closed() { return closed; },
      invocations: () => retained.slice(),
      stats: () => ({
        requests: stats.requests, rejected: { ...stats.rejected }, sessions: sessions.size, pendingInitializations: reservations,
        liveServers: live.size, sessionsOpened: stats.sessionsOpened, serversCreated: stats.serversCreated, serversClosed: stats.serversClosed,
        retainedRecords: retained.length, droppedRecords,
        pendingCleanups: cleanups.size, cleanupFailures,
      }),
      close,
    };
    return bridge;
  } catch (error) {
    // Partial setup never leaves a listener or a launch directory behind.
    server?.stop(true);
    if (launchDir) rmSync(launchDir, { recursive: true, force: true });
    try { await primary.server.close(); } catch {}
    throw error;
  }
}
