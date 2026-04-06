// ---------------------------------------------------------------------------
// Tunnel — expose the local viewer over a public URL with auth
// ---------------------------------------------------------------------------
//
// Wraps localtunnel (zero-config) or cloudflared (production-grade) to give
// the Foundry viewer a publicly reachable URL. Every request through the
// tunnel must carry a valid bearer token.
//
// Usage:
//   const tunnel = new FoundryTunnel({ port: 4400, provider: "localtunnel" });
//   const url = await tunnel.start();
//   // ... later
//   await tunnel.stop();
//
// The bearer token is auto-generated on first run and persisted to
// .foundry/tunnel-token so it survives restarts. Pass it in the
// Authorization header or as ?token= query param.
// ---------------------------------------------------------------------------

import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { Subprocess } from "bun";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TunnelProvider = "localtunnel" | "cloudflared";

export interface TunnelConfig {
  /** Local port to tunnel. */
  port: number;
  /** Tunnel provider. Default: "localtunnel". */
  provider?: TunnelProvider;
  /** Subdomain hint (localtunnel only, not guaranteed). */
  subdomain?: string;
  /** Pre-set bearer token. If omitted, one is generated and persisted. */
  token?: string;
  /** Directory for persisting the token. Default: ".foundry". */
  configDir?: string;
  /** Cloudflared binary path. Default: "cloudflared". */
  cloudflaredBin?: string;
}

export interface TunnelInfo {
  /** Public URL. */
  url: string;
  /** Bearer token required for access. */
  token: string;
  /** Which provider is active. */
  provider: TunnelProvider;
}

// ---------------------------------------------------------------------------
// Auth middleware (Hono) — cookie-based for browsers, bearer for API clients
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "foundry_session";

/** Generate a signed session value from the token. */
function sessionValue(token: string): string {
  // HMAC the token so the cookie value isn't the raw secret
  const { createHmac } = require("crypto") as typeof import("crypto");
  return createHmac("sha256", token).update("foundry-session").digest("hex");
}

/**
 * Minimal HTML login page served when auth is required.
 */
function loginPage(error?: string): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Foundry — Login</title>
<style>
  body { background: #0a0a0c; color: #e0e0e0; font-family: system-ui; display: flex;
         align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #141418; border: 1px solid #2a2a30; border-radius: 12px;
          padding: 32px; width: 320px; text-align: center; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { font-size: 13px; color: #888; margin: 0 0 20px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid #2a2a30; border-radius: 6px;
          background: #0a0a0c; color: #e0e0e0; font-size: 14px; box-sizing: border-box;
          font-family: monospace; margin-bottom: 12px; }
  input:focus { outline: none; border-color: #6c9eff; }
  button { width: 100%; padding: 10px; border: none; border-radius: 6px; background: #6c9eff;
           color: #0a0a0c; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:hover { background: #8ab4ff; }
  .error { color: #f87171; font-size: 12px; margin-bottom: 12px; }
</style>
</head><body>
<div class="card">
  <h1>foundry</h1>
  <p>Enter your access token to continue.</p>
  ${error ? `<div class="error">${error}</div>` : ""}
  <form method="POST" action="/auth">
    <input type="password" name="token" placeholder="Access token" autofocus required />
    <button type="submit">Continue</button>
  </form>
</div>
</body></html>`;
}

/**
 * Hono middleware that enforces session auth for tunneled connections.
 *
 * Auth flow:
 *   1. Browser hits URL with ?token= → auto-login, set cookie, redirect to clean URL
 *   2. Browser without cookie → redirect to /auth login page
 *   3. POST /auth with token → validate, set cookie, redirect to /
 *   4. API clients can use Authorization: Bearer <token> header
 *   5. /api/health is always open (uptime monitors)
 *
 * Session cookie is HttpOnly + SameSite=Strict. Value is HMAC of the
 * token, not the token itself.
 */
export function tunnelAuth(token: string) {
  const validSession = sessionValue(token);

  return async (c: any, next: () => Promise<void>) => {
    const url = new URL(c.req.url);
    const path = url.pathname;

    // Always allow health check
    if (path === "/api/health") return next();

    // Serve login page (GET /auth)
    if (path === "/auth" && c.req.method === "GET") {
      return c.html(loginPage());
    }

    // Handle login submission (POST /auth)
    if (path === "/auth" && c.req.method === "POST") {
      const body = await c.req.parseBody();
      const submitted = (body.token ?? "").trim();
      if (submitted === token) {
        // Set session cookie and redirect to root
        const secure = url.protocol === "https:";
        const cookie = `${SESSION_COOKIE}=${validSession}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? "; Secure" : ""}`;
        return new Response(null, {
          status: 302,
          headers: { Location: "/", "Set-Cookie": cookie },
        });
      }
      return c.html(loginPage("Invalid token. Try again."), 401);
    }

    // Auto-login via ?token= query param → set cookie + redirect to clean URL
    const paramToken = url.searchParams.get("token");
    if (paramToken === token) {
      const secure = url.protocol === "https:";
      const cookie = `${SESSION_COOKIE}=${validSession}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? "; Secure" : ""}`;
      // Strip token from URL before redirect
      url.searchParams.delete("token");
      return new Response(null, {
        status: 302,
        headers: { Location: url.pathname + url.search, "Set-Cookie": cookie },
      });
    }

    // Check Authorization header (API clients)
    const authHeader = c.req.header("authorization") ?? "";
    if (authHeader === `Bearer ${token}`) return next();

    // Check session cookie
    const cookies = c.req.header("cookie") ?? "";
    const sessionMatch = cookies.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    if (sessionMatch && sessionMatch[1] === validSession) return next();

    // WebSocket: check token in query param (WS can't set cookies on upgrade)
    if (path === "/ws" && paramToken === token) return next();

    // Not authenticated — redirect browsers to login, return 401 for API
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html")) {
      return new Response(null, { status: 302, headers: { Location: "/auth" } });
    }
    return c.json({ error: "Unauthorized" }, 401);
  };
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

function resolveToken(config: TunnelConfig): string {
  if (config.token) return config.token;

  const dir = config.configDir ?? ".foundry";
  const tokenPath = `${dir}/tunnel-token`;

  // Read existing token
  try {
    if (existsSync(tokenPath)) {
      const content = readFileSync(tokenPath, "utf-8").trim();
      if (content.length >= 32) return content;
    }
  } catch {
    // Fall through to generate
  }

  // Generate new token
  const token = randomBytes(32).toString("hex");

  // Persist
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(tokenPath, token, "utf-8");
  } catch (err) {
    console.warn("[Tunnel] could not persist token:", (err as Error).message);
  }

  return token;
}

// ---------------------------------------------------------------------------
// FoundryTunnel
// ---------------------------------------------------------------------------

export class FoundryTunnel {
  private _config: TunnelConfig;
  private _token: string;
  private _url: string | null = null;
  private _proc: Subprocess | null = null;
  private _cleanup: (() => void) | null = null;

  constructor(config: TunnelConfig) {
    this._config = config;
    this._token = resolveToken(config);
  }

  get token(): string {
    return this._token;
  }

  get url(): string | null {
    return this._url;
  }

  get info(): TunnelInfo | null {
    if (!this._url) return null;
    return {
      url: this._url,
      token: this._token,
      provider: this._config.provider ?? "localtunnel",
    };
  }

  /**
   * Start the tunnel. Returns the public URL.
   */
  async start(): Promise<string> {
    const provider = this._config.provider ?? "localtunnel";

    switch (provider) {
      case "localtunnel":
        return this._startLocaltunnel();
      case "cloudflared":
        return this._startCloudflared();
      default:
        throw new Error(`Unknown tunnel provider: ${provider}`);
    }
  }

  /**
   * Stop the tunnel and clean up.
   */
  async stop(): Promise<void> {
    if (this._proc) {
      this._proc.kill();
      this._proc = null;
    }
    if (this._cleanup) {
      this._cleanup();
      this._cleanup = null;
    }
    this._url = null;
  }

  // -------------------------------------------------------------------------
  // localtunnel — npm package, zero-config
  // -------------------------------------------------------------------------

  private async _startLocaltunnel(): Promise<string> {
    // Use localtunnel CLI via subprocess (no need to bundle the dependency)
    const args = ["npx", "localtunnel", "--port", String(this._config.port)];

    if (this._config.subdomain) {
      args.push("--subdomain", this._config.subdomain);
    }

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    this._proc = proc;

    // localtunnel prints the URL to stdout
    const url = await this._readUrlFromStdout(proc, /https?:\/\/\S+/);
    this._url = url;

    console.log(`[Tunnel] localtunnel active: ${url}`);
    console.log(`[Tunnel] Token: ${this._token}`);
    console.log(`[Tunnel] Authenticated URL: ${url}?token=${this._token}`);

    return url;
  }

  // -------------------------------------------------------------------------
  // cloudflared — Cloudflare's tunnel, production-grade
  // -------------------------------------------------------------------------

  private async _startCloudflared(): Promise<string> {
    const bin = this._config.cloudflaredBin ?? "cloudflared";

    const proc = Bun.spawn(
      [bin, "tunnel", "--url", `http://localhost:${this._config.port}`],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      },
    );

    this._proc = proc;

    // cloudflared prints the URL to stderr (not stdout)
    const url = await this._readUrlFromStderr(proc, /https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    this._url = url;

    console.log(`[Tunnel] cloudflared active: ${url}`);
    console.log(`[Tunnel] Token: ${this._token}`);
    console.log(`[Tunnel] Authenticated URL: ${url}?token=${this._token}`);

    return url;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async _readUrlFromStdout(proc: Subprocess, pattern: RegExp): Promise<string> {
    return this._readUrlFromStream(new Response(proc.stdout as ReadableStream).body!, pattern);
  }

  private async _readUrlFromStderr(proc: Subprocess, pattern: RegExp): Promise<string> {
    return this._readUrlFromStream(new Response(proc.stderr as ReadableStream).body!, pattern);
  }

  private async _readUrlFromStream(stream: ReadableStream, pattern: RegExp): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const timeout = 30_000;
    const start = Date.now();

    try {
      while (Date.now() - start < timeout) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const match = buffer.match(pattern);
        if (match) {
          reader.releaseLock();
          return match[0];
        }
      }
    } catch {
      // Stream ended or errored
    }

    reader.releaseLock();
    throw new Error(
      `Tunnel did not produce a URL within ${timeout / 1000}s. Output: ${buffer.slice(0, 300)}`,
    );
  }
}
