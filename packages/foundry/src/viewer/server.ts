import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActionQueue,
  EventStream,
  Harness,
  InterventionLog,
  LLMProvider,
  Thread,
  TokenTracker,
  ToolRegistry,
} from '@inixiative/foundry-core';
import type { Server } from 'bun';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { ThreadNamer } from '../agents/thread-namer';
import { registerArchiveRoutes } from '../archives/routes';
import { ThreadContextTracker } from '../archives/thread-context';
import { log } from '../logger';
import { KnowledgePersistence } from '../persistence/knowledge-persistence';
import { LocalSessionStore } from '../persistence/local-session-store';
import {
  KingdomInstallationConnections,
  type KingdomIntegration,
  shareViewerCredential,
} from '../providers/kingdom-installation-connection';
import { createWebSocketServer } from '../ws/handler';
import { closeAllConnections } from '../ws/lifecycle';
import type { WSData } from '../ws/types';
import { makeUnrefInterval } from '../ws/unref-interval';
import { ActionHandler } from './actions';
import { AIAssist } from './ai-assist';
import { AnalyticsStore } from './analytics';
import { ConfigStore } from './config';
import { createViewerStreams } from './data-streams';
import { authenticatedRequest, sameOrigin } from './request-auth';
import { registerControlRoutes } from './routes/control';
import { registerDeviceRoutes } from './routes/devices';
import { registerGlossRoutes } from './routes/gloss';
import { registerKingdomRoutes } from './routes/kingdom';
import { registerRuntimeRoutes } from './routes/runtime';
import { ViewerThreadDirectory } from './thread-directory';
import {
  FoundryTunnel,
  type TunnelConfig,
  type TunnelHolder,
  type TunnelInfo,
  tunnelAuth,
} from './tunnel';

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
  /** Decision provider that keeps agent thread names (optional; no naming without it). */
  namingProvider?: LLMProvider;
  /** Token tracker for analytics (optional but recommended). */
  tokenTracker?: TokenTracker;
  /** Directory for analytics data persistence. Defaults to .foundry/analytics/ */
  analyticsDir?: string;
  /** Project registry (optional — enables multi-project management). */
  projectRegistry?: import('../agents/project').ProjectRegistry;
  /** PostgresMemory for persistence (optional — enables durable traces/messages/signals). */
  db?: import('../adapters/postgres-memory').PostgresMemory;
  /** Thread factory for creating new threads with independent instances. */
  threadFactory?: import('../agents/thread-factory').ThreadFactory;
  /** Config store for resolving project configs. */
  configStore?: import('./config').ConfigStore;
  /** Action queue for agent→human prompts (optional — enables prompt UI). */
  actionQueue?: ActionQueue;
  /** Tunnel config — expose the viewer over a public URL with auth. */
  tunnel?: TunnelConfig;
  /** Every paired Kingdom integration; defaults to the saved `kingdomIntegrations`. */
  kingdomIntegrations?: KingdomIntegration[];
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
 * Open: http://localhost:4500
 */
export function createViewer(config: ViewerConfig) {
  const { harness, eventStream, interventions, port = 4500 } = config;
  const app = new Hono();
  const configDir = config.configDir ?? '.foundry';
  const kingdom = new KingdomInstallationConnections(config.kingdomIntegrations ?? [], {
    configDir,
    sessionCount: () => directory.all().length,
    // Kingdom pushes revocations; losing authorization closes every socket at once.
    onChange: () => {
      if (kingdomLost()) revoke();
    },
    warn: (message) => log.warn(message),
  });

  // Mutable tunnel holder — routes can start/stop at runtime. `changed` runs after every start or stop.
  let sharedToken: string | undefined;
  const tunnelHolder: TunnelHolder = {
    tunnel: null,
    changed: () => {
      const tunnel = tunnelHolder.tunnel;
      kingdom.advertise(tunnel?.url ?? null);
      if (!tunnel?.url || tunnel.token === sharedToken) return;
      sharedToken = tunnel.token;
      void configStore
        .load()
        .then((saved) =>
          shareViewerCredential(
            configDir,
            saved.kingdomIntegrations ?? [],
            tunnel.token,
            (message) => log.warn(message),
          ),
        )
        .catch(() => {});
    },
  };
  if (config.tunnel) {
    tunnelHolder.tunnel = new FoundryTunnel({
      configDir: config.configDir,
      ...config.tunnel,
      port,
    });
  }

  // A paired Kingdom may embed this viewer; nothing else may. Browsers refuse the
  // frame outright without this, and `frame-ancestors` is the only directive that
  // X-Frame-Options cannot express for a list of origins.
  const embedders = (config.kingdomIntegrations ?? [])
    .map((integration) => {
      try {
        return new URL(integration.url).origin;
      } catch {
        return null;
      }
    })
    .filter((origin): origin is string => !!origin);
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set(
      'Content-Security-Policy',
      `frame-ancestors 'self'${embedders.length ? ` ${[...new Set(embedders)].join(' ')}` : ''}`,
    );
  });

  // Auth middleware — checks tunnelHolder dynamically so it works
  // even when tunnel is started/stopped at runtime
  app.use('*', async (c, next) => {
    const t = tunnelHolder.tunnel;
    if (!sameOrigin(c.req.raw, t?.url ?? undefined))
      return c.json({ error: 'Origin not allowed' }, 403);
    if (!t) {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.req.url).hostname))
        return c.json({ error: 'Local viewer requires a loopback host' }, 403);
      return next();
    }
    return tunnelAuth(t.token, t.url ?? undefined)(c, next);
  });

  app.use('*', async (c, next) => {
    if (
      kingdom.size &&
      c.req.path !== '/api/health' &&
      c.req.path !== '/kingdom' &&
      !c.req.path.startsWith('/api/kingdom/') &&
      !c.req.path.startsWith('/ui/')
    ) {
      try {
        await kingdom.check();
      } catch {
        return c.req.path === '/'
          ? c.redirect('/kingdom')
          : c.json({ error: 'Kingdom authorization unavailable', recoveryUrl: '/kingdom' }, 503);
      }
    }
    return next();
  });

  const localStore =
    config.localStore === undefined
      ? new LocalSessionStore(join(config.configDir ?? '.foundry', 'sessions.sqlite'))
      : config.localStore;
  const directory = new ViewerThreadDirectory(
    harness.thread,
    config.projectRegistry,
    config.threadFactory,
  );
  const kingdomLost = () => !kingdom.authorized;
  const revoke = () =>
    closeAllConnections(socket.registry, 1008, 'Kingdom authorization unavailable');
  // `socket` is created below, once its stream families exist; delivery only happens after both do.
  const streams = createViewerStreams({
    directory,
    eventStream,
    actionQueue: config.actionQueue,
    journal: {
      store: localStore,
      learningState: (threadId) => config.threadFactory?.runtime?.get(threadId)?.learningState,
      blocked: (threadId) => knowledgePersistence?.blocked(threadId),
    },
    deliverTo: (clientId, stream, payload) => {
      if (kingdomLost()) {
        revoke();
        return;
      }
      socket.streams.appendTo(clientId, stream, payload);
    },
  });
  if (localStore) {
    localStore.recoverInterrupted();
    for (const warning of directory.restore(localStore.threads()))
      log.warn(`[Recovery] ${warning}`);
    for (const thread of directory.all()) localStore.saveThread(thread);
  }
  const threadChanged = (thread: Thread) => {
    try {
      localStore?.saveThread(thread);
      streams.threadsChanged(thread.id);
    } catch (error) {
      log.warn(`[Viewer] thread ${thread.id} metadata not saved: ${(error as Error).message}`);
    }
  };
  const namer = config.namingProvider
    ? new ThreadNamer({ provider: config.namingProvider, changed: threadChanged })
    : undefined;
  const threadContext = new ThreadContextTracker({
    thread: (id) => directory.get(id),
    changed: threadChanged,
  });
  // Archive capture covers every journalled thread at startup and after each turn.
  if (localStore)
    registerArchiveRoutes(app, localStore, eventStream, (snapshot) => {
      void threadContext.observe(snapshot);
    });
  else for (const thread of directory.all()) void threadContext.refresh(thread.id);
  const knowledgePersistence =
    localStore && config.threadFactory?.runtime
      ? new KnowledgePersistence(
          config.threadFactory.runtime,
          localStore,
          eventStream,
          directory.all(),
        )
      : null;
  app.get('/api/threads/:threadId/knowledge', (c) => {
    const id = c.req.param('threadId');
    if (!directory.get(id)) return c.json({ error: 'Thread not found' }, 404);
    if (!knowledgePersistence)
      return c.json(
        { status: 'unavailable', error: 'Durable knowledge runtime is not configured' },
        503,
      );
    const limit = Number(c.req.query('limit') ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      return c.json({ error: 'Invalid history limit' }, 400);
    try {
      return c.json(knowledgePersistence.inspect(id, limit));
    } catch (error) {
      return c.json({ status: 'blocked', error: (error as Error).message }, 503);
    }
  });
  const actions = new ActionHandler({
    harness,
    eventStream,
    interventions,
    resolveThread: (id) => directory.get(id),
    onThreadChange: (thread) => {
      localStore?.saveThread(thread);
      streams.threadsChanged(thread.id);
    },
  });
  const configStore = config.configStore ?? new ConfigStore(config.configDir ?? '.foundry');
  registerKingdomRoutes(app, configStore, configDir, kingdom, () => tunnelHolder.tunnel?.token);
  registerDeviceRoutes(app, configStore, config.deviceIdentityPath);
  registerGlossRoutes(app, configStore);
  const aiAssist = config.assistProvider
    ? new AIAssist(config.assistProvider, config.assistModel)
    : null;
  const analyticsStore = config.tokenTracker
    ? new AnalyticsStore(config.analyticsDir ?? '.foundry/analytics')
    : null;

  const analyticsReady = analyticsStore?.load() ?? Promise.resolve();
  // Retain rejection for constructors that await readiness; do not expose paths
  // or parsed private file contents in a startup diagnostic.
  analyticsReady.catch(() => log.warn('[Viewer] analytics history unavailable'));
  if (analyticsStore && config.tokenTracker) {
    analyticsStore.connectTracker(config.tokenTracker);
  }
  app.use('/api/analytics*', async (c, next) => {
    try {
      await analyticsReady;
    } catch {
      return c.json({ error: 'Analytics history unavailable' }, 503);
    }
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
    namer,
    threadContext,
    deviceIdentityPath: config.deviceIdentityPath,
    localStore,
    directory,
    streams,
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
    selfChatDir: config.configDir ?? '.foundry',
    assistTools: config.assistTools,
    threadsChanged: () => streams.threadsChanged(),
  });

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    let boardInitialized = false;
    const boardApp = new Hono();

    const initBoard = async () => {
      if (boardInitialized) return;
      try {
        const { createBullBoard } = await import('@bull-board/api');
        const { BullMQAdapter } = await import('@bull-board/api/bullMQAdapter');
        const { HonoAdapter } = await import('@bull-board/hono');
        const { Queue } = await import('bullmq');
        const Redis = (await import('ioredis')).default;

        const boardRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
        const boardQueue = new Queue('foundry-jobs', { connection: boardRedis });

        const serverAdapter = new HonoAdapter(serveStatic);
        createBullBoard({
          queues: [new BullMQAdapter(boardQueue)],
          serverAdapter,
        });
        serverAdapter.setBasePath('/jobs');
        boardApp.route('/', serverAdapter.registerPlugin());
        boardInitialized = true;
        log.info('[Viewer] BullBoard dashboard initialized at /jobs');
      } catch (err) {
        log.warn(`[Viewer] BullBoard unavailable: ${(err as Error).message}`);
        boardInitialized = true;
      }
    };

    app.all('/jobs/*', async (c) => {
      await initBoard();
      return boardApp.fetch(c.req.raw);
    });
  }

  // The browser and offline verifier execute the same import-free proof module.
  app.get('/ui/delivery-evidence.js', async (c) =>
    c.body(
      new Bun.Transpiler({ loader: 'ts' }).transformSync(
        await Bun.file(
          new URL(import.meta.resolve('@inixiative/foundry-core/delivery-evidence')),
        ).text(),
      ),
      200,
      { 'Content-Type': 'application/javascript' },
    ),
  );
  app.get('/ui/*', serveStatic({ root: fileURLToPath(new URL('./', import.meta.url)) }));
  app.get(
    '/kingdom',
    serveStatic({ root: fileURLToPath(new URL('./', import.meta.url)), path: 'ui/kingdom.html' }),
  );
  app.get(
    '/',
    serveStatic({ root: fileURLToPath(new URL('./', import.meta.url)), path: 'ui/index.html' }),
  );

  // Data-stream socket. The connection is authorized at upgrade exactly like HTTP
  // (loopback, or tunnel bearer/cookie); each open re-checks Kingdom authorization,
  // and losing Kingdom authorization closes every socket.
  const socket = createWebSocketServer({
    families: streams.families.map((family) => ({
      ...family,
      start: (stream: string, append: (payload: unknown) => void) =>
        family.start(stream, (payload) => {
          if (kingdomLost()) {
            revoke();
            return;
          }
          append(payload);
        }),
    })),
    // Losing Kingdom authorization closes the socket; the client reconnects (and is refused at upgrade until it returns).
    admit: async () => {
      try {
        await kingdom.check();
        return true;
      } catch {
        revoke();
        return false;
      }
    },
  });
  const kingdomWatch = makeUnrefInterval({
    intervalMs: 15_000,
    tick: () => {
      if (kingdom.size && socket.registry.byId.size) void kingdom.check().catch(revoke);
    },
  });

  /** Serve HTTP and the `/ws` upgrade; pass as Bun.serve's fetch with `websocket`. */
  const handleRequest = async (
    req: Request,
    server: Server<WSData>,
  ): Promise<Response | undefined> => {
    const url = new URL(req.url);
    if (url.pathname !== '/ws') return app.fetch(req, server);
    const activeTunnel = tunnelHolder.tunnel;
    if (!sameOrigin(req, activeTunnel?.url ?? undefined))
      return new Response('Origin not allowed', { status: 403 });
    if (
      activeTunnel
        ? !authenticatedRequest(req, activeTunnel.token, activeTunnel.url ?? undefined)
        : !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
      return new Response('Unauthorized', { status: 401 });
    try {
      await kingdom.check();
    } catch {
      return new Response('Kingdom authorization unavailable', { status: 503 });
    }
    return socket.accept(req, server);
  };

  return {
    app,
    fetch: handleRequest,
    websocket: socket.websocket,
    socket,
    streams,
    port,
    actions,
    configStore,
    analyticsStore,
    analyticsReady,
    tunnelHolder,
    localStore,
    directory,
    startSocket() {
      socket.startStaleSweep();
      kingdomWatch.start();
    },
    stopSocket() {
      kingdomWatch.stop();
      socket.shutdown();
    },
    kingdom,
  };
}

/** Start the viewer server. */
export async function startViewer(config: ViewerConfig) {
  const initialStore = config.configStore ?? new ConfigStore(config.configDir ?? '.foundry');
  const saved = await initialStore.load();
  config = {
    ...config,
    kingdomIntegrations: config.kingdomIntegrations ?? saved.kingdomIntegrations,
  };
  if (!config.tunnel && saved.tunnel?.enabled)
    config = {
      ...config,
      tunnel: {
        port: config.port ?? 4500,
        provider: saved.tunnel.provider,
        subdomain: saved.tunnel.subdomain,
        configDir: config.configDir,
      },
    };
  const viewer = createViewer({ ...config, configStore: initialStore });
  const { port, actions, analyticsStore, tunnelHolder, localStore } = viewer;

  if (config.actionQueue) {
    config.actionQueue.onPrompt((prompt) => {
      config.eventStream.push({
        kind: 'prompt',
        threadId: prompt.threadId,
        prompt,
      });
    });
  }

  let server: ReturnType<typeof Bun.serve<WSData>>;
  try {
    for (const id of await viewer.kingdom.start())
      log.warn(`[Kingdom] Paired Kingdom ${id} unavailable; reconnect at /kingdom`);
    server = Bun.serve<WSData>({
      port,
      hostname: '127.0.0.1',
      idleTimeout: 240,
      fetch: viewer.fetch,
      websocket: viewer.websocket,
    });
  } catch (error) {
    viewer.kingdom.stop();
    localStore?.close();
    throw error;
  }
  viewer.startSocket();
  const stopServer = server.stop.bind(server);
  server.stop = (closeActiveConnections?: boolean) => {
    viewer.kingdom.stop();
    void tunnelHolder.tunnel?.stop();
    viewer.stopSocket();
    return stopServer(closeActiveConnections);
  };

  log.info(`Foundry Viewer running at http://localhost:${server.port}`);

  if (tunnelHolder.tunnel) {
    try {
      await tunnelHolder.tunnel.start();
      const info = tunnelHolder.tunnel.info;
      if (info) log.info(`[Tunnel] ${info.provider} active: ${info.url}`);
      tunnelHolder.changed?.();
    } catch (err) {
      log.warn(`[Tunnel] failed to start: ${(err as Error).message}`);
    }
  }

  return {
    server,
    actions,
    analyticsStore,
    tunnelHolder,
    localStore,
    kingdom: viewer.kingdom,
  };
}
