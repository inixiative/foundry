import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import {
  ActionQueue,
  type EventStream,
  type Harness,
  type InterventionLog,
  type LLMProvider,
  type TokenTracker,
} from "@inixiative/foundry-core";
import { ActionHandler } from "./actions";
import { AIAssist } from "./ai-assist";
import { AnalyticsStore } from "./analytics";
import { ConfigStore } from "./config";
import { log } from "../logger";
import {
  FoundryTunnel,
  SESSION_COOKIE,
  sessionValue,
  tunnelAuth,
  type TunnelConfig,
  type TunnelInfo,
} from "./tunnel";
import { registerControlRoutes } from "./routes/control";
import { registerRuntimeRoutes } from "./routes/runtime";

export interface ViewerConfig {
  harness: Harness;
  eventStream: EventStream;
  interventions: InterventionLog;
  port?: number;
  /** Directory for persisting settings. Defaults to .foundry/ */
  configDir?: string;
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
  const app = new Hono();

  // Mutable tunnel holder — routes can start/stop at runtime
  const tunnelHolder: { tunnel: FoundryTunnel | null } = { tunnel: null };
  if (config.tunnel) {
    tunnelHolder.tunnel = new FoundryTunnel({ ...config.tunnel, port });
  }

  // Auth middleware — checks tunnelHolder dynamically so it works
  // even when tunnel is started/stopped at runtime
  app.use("*", async (c, next) => {
    const t = tunnelHolder.tunnel;
    if (!t) return next(); // no tunnel → no auth needed
    return tunnelAuth(t.token)(c, next);
  });

  const actions = new ActionHandler({ harness, eventStream, interventions });
  const configStore = config.configStore ?? new ConfigStore(config.configDir ?? ".foundry");
  const aiAssist = config.assistProvider
    ? new AIAssist(config.assistProvider, config.assistModel)
    : null;
  const analyticsStore = config.tokenTracker
    ? new AnalyticsStore(config.analyticsDir ?? ".foundry/analytics")
    : null;

  if (analyticsStore && config.tokenTracker) {
    analyticsStore.load().catch((err) => log.warn("[Viewer] background op failed:", err.message ?? err));
    analyticsStore.connectTracker(config.tokenTracker);
  }

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

  app.get("/ui/*", serveStatic({ root: "./packages/foundry/src/viewer/" }));
  app.get("/", serveStatic({ path: "./packages/foundry/src/viewer/ui/index.html" }));

  return { app, port, actions, configStore, analyticsStore, tunnelHolder };
}

/** Start the viewer server. */
export async function startViewer(config: ViewerConfig) {
  const { app, port, actions, configStore, tunnelHolder } = createViewer(config);
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

  const server = Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        // Check tunnel auth dynamically — tunnel may be started/stopped at runtime
        const activeTunnel = tunnelHolder.tunnel;
        if (activeTunnel) {
          const validSession = sessionValue(activeTunnel.token);
          const cookies = req.headers.get("cookie") ?? "";
          const match = cookies.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
          const hasValidCookie = match?.[1] === validSession;
          const hasValidToken = url.searchParams.get("authorization") === activeTunnel.token;
          if (!hasValidCookie && !hasValidToken) {
            return new Response("Unauthorized", { status: 401 });
          }
        }

        if (server.upgrade(req)) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      return app.fetch(req, server);
    },
    websocket: {
      open(ws) {
        const unsub = config.eventStream.subscribe((event) => {
          ws.send(JSON.stringify(event));
        });
        wsCleanup.set(ws, unsub);
      },
      message() {},
      close(ws) {
        const unsub = wsCleanup.get(ws);
        if (unsub) unsub();
        wsCleanup.delete(ws);
      },
    },
  });

  log.info(`Foundry Viewer running at http://localhost:${port}`);

  // Auto-start tunnel from persisted config (survives restarts)
  if (!tunnelHolder.tunnel) {
    try {
      const cfg = await configStore.load();
      if (cfg.tunnel?.enabled) {
        tunnelHolder.tunnel = new FoundryTunnel({
          port,
          provider: cfg.tunnel.provider ?? "localtunnel",
          subdomain: cfg.tunnel.subdomain,
          token: cfg.tunnel.password || undefined,
        });
      }
    } catch (err) {
      log.warn(`[Tunnel] failed to load config: ${(err as Error).message}`);
    }
  }

  if (tunnelHolder.tunnel) {
    try {
      await tunnelHolder.tunnel.start();
      const info = tunnelHolder.tunnel.info;
      if (info) log.info(`[Tunnel] ${info.provider} active: ${info.url}`);
    } catch (err) {
      log.warn(`[Tunnel] failed to start: ${(err as Error).message}`);
    }
  }

  return { server, actions, tunnelHolder };
}
