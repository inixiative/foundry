#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Foundry bridge proxy (T2): thin stdio MCP proxy for a native CLI.
//
// The native CLI launches `bun proxy.ts <launch-file>`. The proxy reads the
// protected launch file (no symlinks, 0600, loopback endpoint only), connects
// to the owning process's loopback bridge with the header-carried capability,
// and forwards tools/list and tools/call over the SDK's own protocol classes.
// It is a transport adapter: no Thread is reconstructed, no configuration is
// loaded, no redirect is followed, and no native ID is invented.
// ---------------------------------------------------------------------------

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import type { LaunchFile } from "./transport";

const MAX_LAUNCH_BYTES = 65_536;
const CAPABILITY = /^[A-Za-z0-9_-]{32,256}$/;

/**
 * Read the launch file without following symlinks and refuse anything but a
 * private regular file describing a loopback bridge. Throws with a bounded
 * message that never includes file contents.
 */
export function readLaunchFile(path: string): LaunchFile {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ELOOP") throw new Error("launch file is a symlink; refusing to follow it");
    throw new Error(`launch file cannot be opened (${code ?? "unknown error"})`);
  }
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("launch file is not a regular file");
    if ((stat.mode & 0o077) !== 0) throw new Error("launch file mode must be 0600; group/other bits are set");
    if (stat.size > MAX_LAUNCH_BYTES) throw new Error("launch file is too large");
    const buffer = Buffer.alloc(stat.size);
    readSync(fd, buffer, 0, stat.size, 0);
    text = buffer.toString("utf8");
  } finally { closeSync(fd); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("launch file is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("launch file must be a JSON object");
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) throw new Error("unsupported launch file version");
  if (typeof record.endpoint !== "string") throw new Error("launch file endpoint missing");
  let url: URL;
  try { url = new URL(record.endpoint); } catch { throw new Error("launch file endpoint is not a URL"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/mcp" || url.search || url.hash || url.username || url.password) {
    throw new Error("launch file endpoint must be a plain loopback http://127.0.0.1:<port>/mcp bridge");
  }
  if (typeof record.capability !== "string" || !CAPABILITY.test(record.capability)) throw new Error("launch file capability has an invalid shape");
  if (typeof record.threadId !== "string" || !record.threadId) throw new Error("launch file threadId missing");
  return {
    version: 1, endpoint: url.toString(), capability: record.capability, threadId: record.threadId,
    ...(typeof record.generation === "string" ? { generation: record.generation } : {}),
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
  };
}

/**
 * Fetch pinned to the bridge endpoint: any other destination is refused and a
 * redirect is an error, so the capability can only ever be sent to the
 * loopback bridge named in the launch file.
 */
export function guardedFetch(endpoint: URL): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const target = new URL(url);
    if (target.origin !== endpoint.origin || target.pathname !== endpoint.pathname) {
      throw new Error("refusing request to a destination other than the launch file's loopback bridge");
    }
    const response = await fetch(target, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("redirect refused: the bridge endpoint must answer directly; the capability is not forwarded");
    }
    return response;
  };
}

export interface ProxyOptions {
  /** Connect to the bridge and stop; no stdio server. Used to verify a launch file. */
  connectOnly?: boolean;
  stdin?: Readable;
  stdout?: Writable;
}

export interface RunningProxy { close(): Promise<void> }

export async function runProxy(launchPath: string, options: ProxyOptions = {}): Promise<RunningProxy> {
  const launch = readLaunchFile(launchPath);
  const endpoint = new URL(launch.endpoint);
  const client = new Client({ name: "foundry-bridge-proxy", version: "0.1.0" });
  const upstream = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${launch.capability}` } },
    fetch: guardedFetch(endpoint),
  });
  // Owned cleanup discipline: the proxy terminates the SDK session it established
  // (the SDK's own DELETE) before dropping its client, so the bridge frees that
  // capacity. A session that never got established has nothing to terminate. This
  // is transport cleanup only: never native cancel, idle evidence or replay.
  let released: Promise<void> | undefined;
  const releaseUpstream = (): Promise<void> => {
    if (released) return released;
    released = (async () => {
      if (upstream.sessionId) { try { await upstream.terminateSession(); } catch {} }
      try { await client.close(); } catch {}
    })();
    return released;
  };
  try { await client.connect(upstream); }
  catch (error) { await releaseUpstream(); throw error; }
  if (options.connectOnly) { await releaseUpstream(); return { close: releaseUpstream }; }

  const server = new Server({ name: "foundry-bridge-proxy", version: "0.1.0" }, { capabilities: { tools: {} } });
  // Forwarded as-is: tool content, isError and structured results are the bridge's; the SDK
  // correlates each stdio request with its own upstream request id.
  server.setRequestHandler(ListToolsRequestSchema, async () => (await client.listTools()) as ListToolsResult);
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    (await client.callTool(request.params as { name: string; arguments?: Record<string, unknown> })) as unknown as CallToolResult);
  const stdio = new StdioServerTransport(options.stdin, options.stdout);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    // The guard must exist before any synchronous work: closing the server closes
    // the stdio transport, whose `onclose` re-enters this function synchronously.
    let settle!: () => void;
    closing = new Promise<void>(resolve => { settle = resolve; });
    void (async () => {
      try { await server.close(); } catch {}
      await releaseUpstream();
    })().finally(settle);
    return closing;
  };
  stdio.onclose = () => { void close(); };
  try { await server.connect(stdio); }
  catch (error) { await close(); throw error; }
  return { close };
}

if (import.meta.main) {
  const path = process.argv[2];
  let capability: string | undefined;
  try {
    if (!path) throw new Error("usage: proxy.ts <launch-file>");
    try { capability = readLaunchFile(path).capability; } catch { /* reported by runProxy below */ }
    const running = await runProxy(path);
    process.stdin.on("end", () => { void running.close().then(() => process.exit(0)); });
  } catch (error) {
    // Bounded, redacted: never the launch contents or the capability.
    let message = String((error as Error)?.message ?? error).slice(0, 300);
    if (capability) message = message.split(capability).join("[redacted]");
    process.stderr.write(`foundry-bridge-proxy: ${message}\n`);
    process.exit(2);
  }
}
