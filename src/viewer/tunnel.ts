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
// Auth middleware (Hono)
// ---------------------------------------------------------------------------

/**
 * Hono middleware that enforces bearer token auth.
 *
 * Checks (in order):
 *   1. Authorization: Bearer <token>
 *   2. ?token=<token> query param (for WebSocket clients)
 *
 * Skips auth for the health check endpoint so uptime monitors work.
 */
export function tunnelAuth(token: string) {
  return async (c: any, next: () => Promise<void>) => {
    const path = new URL(c.req.url).pathname;

    // Allow health check without auth
    if (path === "/api/health") return next();

    // Check Authorization header
    const authHeader = c.req.header("authorization") ?? "";
    if (authHeader === `Bearer ${token}`) return next();

    // Check query param (for WebSocket and browser access)
    const paramToken = new URL(c.req.url).searchParams.get("token");
    if (paramToken === token) return next();

    return c.json({ error: "Unauthorized. Provide a valid bearer token." }, 401);
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
