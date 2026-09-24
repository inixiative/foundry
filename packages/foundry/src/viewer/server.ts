import { KingdomRuntimeConnection, type KingdomRuntimeSettings } from "../providers/kingdom-runtime-connection";
import { RuntimeJobRegistry } from "../providers/runtime-job-handler";
import { registerKingdomRoutes } from "./routes/kingdom";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import {
  ActionQueue,
  type EventStream,
  type Harness,
  type InterventionLog,
  type LLMProvider,
  type TokenTracker,
  type ToolRegistry,
} from "@inixiative/foundry-core";
import { ActionHandler } from "./actions";
import { AIAssist } from "./ai-assist";
import { AnalyticsStore } from "./analytics";
import { ConfigStore } from "./config";
import { log } from "../logger";
import {
  FoundryTunnel,
  tunnelAuth,
  type TunnelConfig,
  type TunnelInfo,
} from "./tunnel";
import { authenticatedRequest, sameOrigin } from "./request-auth";
import { registerDeviceRoutes } from "./routes/devices";
import { registerControlRoutes } from "./routes/control";
import { registerRuntimeRoutes } from "./routes/runtime";
import { LocalSessionStore } from "../persistence/local-session-store";
import { KnowledgePersistence } from "../persistence/knowledge-persistence";
import { ViewerThreadDirectory } from "./thread-directory";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerArchiveRoutes } from "../archives/routes";

export interface ViewerConfig {
  harness: Harness;
  eventStream: EventStream;
  interventions: InterventionLog;
  port?: number;
  /** Directory for persisting settings. Defaults to .foundry/ */
  configDir?: string;
  /** Optional identity file for an isolated local profile. */
  deviceIdentityPath?: string;
  /** LLM provider for AI assist (optional). */
  assistProvider?: LLMProvider;
  /** Model for AI assist (optional). */
  assistModel?: string;
  /** Token tracker for analytics (optional but recommended). */
  tokenTracker?: TokenTracker;
  /** Directory for analytics data persistence. Defaults to .foundry/analytics/ */
  analyticsDir?: string;
  /** Project registry (optional — enables multi-project management). */
  projectRegistry?: import("../agents/project").ProjectRegistry;
  /** PostgresMemory for persistence (optional — enables durable traces/messages/signals). */
  db?: import("../adapters/postgres-memory").PostgresMemory;
  /** Thread factory for creating new threads with independent instances. */
  threadFactory?: import("../agents/thread-factory").ThreadFactory;
  /** Config store for resolving project configs. */
  configStore?: import("./config").ConfigStore;
  /** Action queue for agent→human prompts (optional — enables prompt UI). */
  actionQueue?: ActionQueue;
  /** Tunnel config — expose the viewer over a public URL with auth. */
  tunnel?: TunnelConfig;
  kingdomRuntime?: KingdomRuntimeSettings;
  /** Job kinds this runtime may execute. Defaults to the framework built-ins. */
  runtimeJobs?: RuntimeJobRegistry;
  /** Tool registry — shared with executor agents; enables tool-use in self-chat. */
  assistTools?: ToolRegistry;
  /** Durable local journal; null opts out for an explicitly transient viewer. */
  localStore?: LocalSessionStore | null;
}

/**
 * Foundry Viewer — three-panel operator control surface.
 *
 * Left: thread tree + layers + agents + live events
 * Center: conversation / trace timeline with layer bands
 * Right: detail drawer (span detail, layer detail, corrections)
 *
 * Run with: bun run src/viewer/server.ts
 * Open: http://localhost:4400
 */
export function createViewer(config: ViewerConfig) {
  const { harness, eventStream, interventions, port = 4400 } = config;
  const runtimeJobs = config.runtimeJobs ?? new RuntimeJobRegistry();
  const app = new Hono();
  let kingdomConnection = config.kingdomRuntime
    ? new KingdomRuntimeConnection(config.kingdomRuntime, () => directory.all().length, fetch, runtimeJobs) : null;

  // Mutable tunnel holder — routes can start/stop at runtime
  const tunnelHolder: { tunnel: FoundryTunnel | null } = { tunnel: null };
  if (config.tunnel) {
    tunnelHolder.tunnel = new FoundryTunnel({ configDir: config.configDir, ...config.tunnel, port });
  }

  // Auth middleware — checks tunnelHolder dynamically so it works
  // even when tunnel is started/stopped at runtime
  app.use("*", async (c, next) => {
    const t = tunnelHolder.tunnel;
    if (!sameOrigin(c.req.raw, t?.url ?? undefined)) return c.json({ error: "Origin not allowed" }, 403);
    if (!t) {
      if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(c.req.url).hostname))
        return c.json({ error: "Local viewer requires a loopback host" }, 403);
      return next();
    }
    return tunnelAuth(t.token, t.url ?? undefined)(c, next);
  });

  app.use("*", async (c, next) => {
    if (kingdomConnection && c.req.path !== "/api/health" && c.req.path !== "/kingdom" && !c.req.path.startsWith("/api/kingdom/") && !c.req.path.startsWith("/ui/")) {
      try { await kingdomConnection.check(); }
      catch { return c.req.path === "/" ? c.redirect("/kingdom") : c.json({ error: "Kingdom runtime authorization unavailable", recoveryUrl: "/kingdom" }, 503); }
    }
    return next();
  });

  const localStore = config.localStore === undefined
    ? new LocalSessionStore(join(config.configDir ?? ".foundry", "sessions.sqlite")) : config.localStore;
  const directory = new ViewerThreadDirectory(harness.thread, config.projectRegistry, config.threadFactory);
  if (localStore) {
    localStore.recoverInterrupted();
    for (const warning of directory.restore(localStore.threads())) log.warn(`[Recovery] ${warning}`);
    for (const thread of directory.all()) localStore.saveThread(thread);
  }
  if (localStore) registerArchiveRoutes(app, localStore, eventStream, config.configDir ?? ".foundry");
  const knowledgePersistence = localStore && config.threadFactory?.runtime
    ? new KnowledgePersistence(config.threadFactory.runtime, localStore, eventStream, directory.all()) : null;
  app.get("/api/threads/:threadId/knowledge", c => {
    const id = c.req.param("threadId");
    if (!directory.get(id)) return c.json({ error: "Thread not found" }, 404);
    if (!knowledgePersistence) return c.json({ status: "unavailable", error: "Durable knowledge runtime is not configured" }, 503);
    const limit = Number(c.req.query("limit") ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return c.json({ error: "Invalid history limit" }, 400);
    try { return c.json(knowledgePersistence.inspect(id, limit)); }
    catch (error) { return c.json({ status: "blocked", error: (error as Error).message }, 503); }
  });
  const actions = new ActionHandler({ harness, eventStream, interventions,
    resolveThread: id => directory.get(id),
    onThreadChange: thread => localStore?.saveThread(thread),
  });
  const configStore = config.configStore ?? new ConfigStore(config.configDir ?? ".foundry");
  registerKingdomRoutes(app, configStore, config.configDir ?? ".foundry", () => directory.all().length, connection => { kingdomConnection?.stop(); kingdomConnection = connection; }, () => kingdomConnection?.connected ?? false, runtimeJobs);
  registerDeviceRoutes(app, configStore, config.deviceIdentityPath);
  const aiAssist = config.assistProvider
    ? new AIAssist(config.assistProvider, config.assistModel)
    : null;
  const analyticsStore = config.tokenTracker
    ? new AnalyticsStore(config.analyticsDir ?? ".foundry/analytics")
    : null;

  const analyticsReady = analyticsStore?.load() ?? Promise.resolve();
  // Retain rejection for constructors that await readiness; do not expose paths
  // or parsed private file contents in a startup diagnostic.
  analyticsReady.catch(() => log.warn("[Viewer] analytics history unavailable"));
  if (analyticsStore && config.tokenTracker) {
    analyticsStore.connectTracker(config.tokenTracker);
  }
  app.use('/api/analytics*', async (c, next) => {
    try { await analyticsReady; } catch { return c.json({ error: 'Analytics history unavailable' }, 503); }
    await next();
  });

  const db = config.db ?? null;

  registerRuntimeRoutes(app, {
    harness,
    eventStream,
    interventions,
    db,
    assistProviderId: config.assistProvider?.id,
    threadFactory: config.threadFactory,
    configStore,
    projectRegistry: config.projectRegistry,
    namingProvider: config.assistProvider,
    deviceIdentityPath: config.deviceIdentityPath,
    localStore,
    directory,
  });

  registerControlRoutes(app, {
    harness,
    actions,
    configStore,
    aiAssist,
    analyticsStore,
    tokenTracker: config.tokenTracker,
    projectRegistry: config.projectRegistry,
    actionQueue: config.actionQueue ?? null,
    tunnelHolder,
    port,
    selfChatDir: config.configDir ?? ".foundry",
    assistTools: config.assistTools,
  });

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    let boardInitialized = false;
    const boardApp = new Hono();

    const initBoard = async () => {
      if (boardInitialized) return;
      try {
        const { createBullBoard } = await import("@bull-board/api");
        const { BullMQAdapter } = await import("@bull-board/api/bullMQAdapter");
        const { HonoAdapter } = await import("@bull-board/hono");
        const { Queue } = await import("bullmq");
        const Redis = (await import("ioredis")).default;

        const boardRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
        const boardQueue = new Queue("foundry-jobs", { connection: boardRedis });

        const serverAdapter = new HonoAdapter(serveStatic);
        createBullBoard({
          queues: [new BullMQAdapter(boardQueue)],
          serverAdapter,
        });
        serverAdapter.setBasePath("/jobs");
        boardApp.route("/", serverAdapter.registerPlugin());
        boardInitialized = true;
        log.info("[Viewer] BullBoard dashboard initialized at /jobs");
      } catch (err) {
        log.warn(`[Viewer] BullBoard unavailable: ${(err as Error).message}`);
        boardInitialized = true;
      }
    };

    app.all("/jobs/*", async (c) => {
      await initBoard();
      return boardApp.fetch(c.req.raw);
    });
  }

  // The browser and offline verifier execute the same import-free proof module.
  app.get("/ui/delivery-evidence.js", async c => c.body(new Bun.Transpiler({ loader: "ts" }).transformSync(
    await Bun.file(new URL("../../../core/src/delivery-evidence.ts", import.meta.url)).text()), 200,
    { "Content-Type": "application/javascript" }));
  app.get("/ui/*", serveStatic({ root: fileURLToPath(new URL("./", import.meta.url)) }));
  app.get("/kingdom", serveStatic({ root: fileURLToPath(new URL("./", import.meta.url)), path: "ui/kingdom.html" }));
  app.get("/", serveStatic({ root: fileURLToPath(new URL("./", import.meta.url)), path: "ui/index.html" }));

  return { app, port, actions, configStore, analyticsStore, analyticsReady, tunnelHolder, localStore, directory, get kingdomConnection() { return kingdomConnection; } };
}

/** Start the viewer server. */
export async function startViewer(config: ViewerConfig) {
  const initialStore = config.configStore ?? new ConfigStore(config.configDir ?? ".foundry");
  const saved = await initialStore.load();
  config = { ...config, kingdomRuntime: config.kingdomRuntime ?? saved.kingdomRuntime };
  if (!config.tunnel && saved.tunnel?.enabled) config = { ...config, tunnel: {
    port: config.port ?? 4400, provider: saved.tunnel.provider, subdomain: saved.tunnel.subdomain,
    configDir: config.configDir,
  } };
  const viewer = createViewer({ ...config, configStore: initialStore });
  const { app, port, actions, configStore, tunnelHolder, localStore } = viewer;
  const wsCleanup = new Map<object, () => void>();

  if (config.actionQueue) {
    config.actionQueue.onPrompt((prompt) => {
      config.eventStream.push({
        kind: "prompt",
        threadId: prompt.threadId,
        prompt,
      });
    });
  }

  let server: ReturnType<typeof Bun.serve>;
  try {
    await viewer.kingdomConnection?.start().catch(() => log.warn("[Kingdom] Runtime unavailable; reconnect at /kingdom"));
    server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 240,
    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        const activeTunnel = tunnelHolder.tunnel;
        if (!sameOrigin(req, activeTunnel?.url ?? undefined)) return new Response("Origin not allowed", { status: 403 });
        if (activeTunnel ? !authenticatedRequest(req, activeTunnel.token, activeTunnel.url ?? undefined)
          : !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
          return new Response("Unauthorized", { status: 401 });

        if (viewer.kingdomConnection) {
          try { await viewer.kingdomConnection.check(); }
          catch { return new Response("Kingdom runtime unavailable", { status: 503 }); }
        }
        if (server.upgrade(req, { data: undefined })) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      return app.fetch(req, server);
    },
    websocket: {
      open(ws) {
        const timer = setInterval(() => {
          void viewer.kingdomConnection?.check().catch(() => ws.close(1008, "Kingdom runtime unavailable"));
        }, 15000);
        timer?.unref();
        const unsub = config.eventStream.subscribe((event) => {
          if (viewer.kingdomConnection && !viewer.kingdomConnection.connected) { ws.close(1008, "Kingdom runtime unavailable"); return; }
          ws.send(JSON.stringify(event));
        });
        wsCleanup.set(ws, () => { if (timer) clearInterval(timer); unsub(); });
      },
      message() {},
      close(ws) {
        const unsub = wsCleanup.get(ws);
        if (unsub) unsub();
        wsCleanup.delete(ws);
      },
    },
  });

  } catch (error) {
    viewer.kingdomConnection?.stop();
    localStore?.close();
    throw error;
  }
  const stopServer = server.stop.bind(server);
  server.stop = (closeActiveConnections?: boolean) => {
    viewer.kingdomConnection?.stop();
    void tunnelHolder.tunnel?.stop();
    for (const cleanup of wsCleanup.values()) cleanup();
    wsCleanup.clear();
    return stopServer(closeActiveConnections);
  };

  log.info(`Foundry Viewer running at http://localhost:${server.port}`);

  if (tunnelHolder.tunnel) {
    try {
      await tunnelHolder.tunnel.start();
      const info = tunnelHolder.tunnel.info;
      if (info) log.info(`[Tunnel] ${info.provider} active: ${info.url}`);
    } catch (err) {
      log.warn(`[Tunnel] failed to start: ${(err as Error).message}`);
    }
  }

  return { server, actions, tunnelHolder, localStore, get kingdomConnection() { return viewer.kingdomConnection; } };
}
