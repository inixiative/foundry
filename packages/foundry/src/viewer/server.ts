/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:viewer
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActionQueue,
  EventStream,
  Harness,
  InterventionLog,
  LLMProvider,
  Thread,
  ThreadSetup,
  TokenTracker,
  ToolRegistry,
} from '@inixiative/foundry-core';
import { newId } from '@inixiative/foundry-core';
import type { Server } from 'bun';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { invalidateComposition } from '../agents/role-layers';
import { ThreadNamer } from '../agents/thread-namer';
import { registerArchiveRoutes } from '../archives/routes';
import { ThreadContextTracker } from '../archives/thread-context';
import { CompositionAuditor } from '../audit/compositions';
import { feedbackRoots } from '../feedback/apply';
import { MAIN_ROLE } from '../feedback/routing';
import { FeedbackService } from '../feedback/service';
import { classifyCorrection, matchExisting } from '../feedback/sharpen';
import { log } from '../logger';
import { ImageAttachmentStore } from '../persistence/image-attachments';
import { KnowledgePersistence } from '../persistence/knowledge-persistence';
import { LocalSessionStore } from '../persistence/local-session-store';
import { KingdomHolders } from '../providers/kingdom-holder';
import {
  KingdomInstallationConnections,
  type KingdomIntegration,
  shareViewerCredential,
} from '../providers/kingdom-installation-connection';
import { ThreadLaunchSettings } from '../providers/thread-launch';
import { SubagentRecorder } from '../turns/subagents';
import {
  createToolGate,
  enforces,
  rulesFor,
  type ThreadToolGate,
  UNBOUND_GATE,
} from '../turns/tool-gate';
import type { ThreadSetupHost } from '../turns/turn-service';
import { createWebSocketServer } from '../ws/handler';
import { closeAllConnections } from '../ws/lifecycle';
import type { WSData } from '../ws/types';
import { makeUnrefInterval } from '../ws/unref-interval';
import { ActionHandler } from './actions';
import { AIAssist } from './ai-assist';
import { AnalyticsStore } from './analytics';
import { ConfigStore, DEFAULT_RAW_MIDDLEWARE_DAYS } from './config';
import { createViewerStreams } from './data-streams';
import { authenticatedRequest, sameOrigin, sameSecret } from './request-auth';
import { registerControlRoutes } from './routes/control';
import { registerDeviceRoutes } from './routes/devices';
import { registerGlossRoutes } from './routes/gloss';
import { registerKingdomRoutes } from './routes/kingdom';
import { registerModelRoutes } from './routes/models';
import { registerProfileRoutes } from './routes/profile';
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
  /** Decision provider for the feedback lifecycle (optional; no capture without it). */
  feedbackProvider?: LLMProvider;
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
  /**
   * Start the tunnel at startup when settings leave it automatic (`tunnel.enabled` absent) and a
   * paired Kingdom authorizes this Foundry. The daemon's entry point opts in.
   */
  autoTunnel?: boolean;
  /** Every paired Kingdom integration; defaults to the saved `kingdomIntegrations`. */
  kingdomIntegrations?: KingdomIntegration[];
  /** Tool registry — shared with executor agents; enables tool-use in self-chat. */
  assistTools?: ToolRegistry;
  /** Durable local journal; null opts out for an explicitly transient viewer. */
  localStore?: LocalSessionStore | null;
  /** Bearer a local ACP proxy presents (from the ACP launch file) while a tunnel is active. */
  acpCapability?: string;
  /** What hosts chose per thread (mode, model, effort, MCP servers); shared with the providers. */
  threadLaunch?: ThreadLaunchSettings;
  /**
   * In-session Wardens (docs/THREAD-TREE.md spec C): opens a thread's session ahead of its turn,
   * and reports its setup, which becomes `ThreadMeta.setup`.
   */
  threadSetup?: ThreadSetupHost & {
    onSetup(listener: (threadId: string, setup: ThreadSetup) => void): void;
  };
  /** Executor providers whose sessions report their subagents (spec A: observed child threads). */
  subagentSources?: ReadonlyArray<{
    observeSubagents(
      sink: (threadId: string, evidence: import('@inixiative/foundry-core').NativeEvidence) => void,
    ): () => void;
  }>;
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
      holders.stale();
      if (kingdomLost()) revoke();
    },
    warn: (message) => log.warn(message),
  });

  const holders = new KingdomHolders(configDir);

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

  // A local ACP proxy holds the launch file's capability; with a tunnel active it is the only
  // bearer it can present, since the tunnel token never leaves the viewer's own credential file.
  // It is honoured only on a direct loopback request: never through the tunnel, which forwards
  // the public Host and its proxy headers to this same port.
  const acpAuthorized = (request: Request) => {
    const authorization = request.headers.get('authorization');
    return (
      !!config.acpCapability &&
      !!authorization &&
      directLoopback(request) &&
      sameSecret(authorization, `Bearer ${config.acpCapability}`)
    );
  };

  // Auth middleware — checks tunnelHolder dynamically so it works
  // even when tunnel is started/stopped at runtime
  app.use('*', async (c, next) => {
    const t = tunnelHolder.tunnel;
    if (!sameOrigin(c.req.raw, t?.url ?? undefined))
      return c.json({ error: 'Origin not allowed' }, 403);
    if (t && acpAuthorized(c.req.raw)) return next();
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
        return isPage(c.req.path)
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
    feedback: () => feedback,
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
    const recovered = localStore.recoverInterrupted();
    if (recovered.interrupted || recovered.neverSent)
      log.warn(
        `[Recovery] ${recovered.interrupted} turn(s) interrupted (native outcome unknown), ${recovered.neverSent} queued turn(s) never sent`,
      );
    for (const warning of directory.restore(localStore.threads()))
      log.warn(`[Recovery] ${warning}`);
    for (const thread of directory.all()) localStore.saveThread(thread);
    // A turn a restart closed is reduced before its first capture (spec A).
    localStore.compactClosedTurns();
    const subagents = new SubagentRecorder({
      store: localStore,
      thread: (id) => directory.get(id),
      adopt: (child) => {
        directory.adoptObserved(child);
        streams.threadsChanged(child.id);
      },
      events: eventStream,
      // Every runtime: the root thread's Wardens brief a handoff when the subagent starts (the
      // subagent-spawn trigger); the brief is journalled on the parent and rides with its next turn.
      onSpawn: (rootThreadId, spawn) => {
        const root = directory.get(rootThreadId);
        if (!root) return;
        void root.signals
          .emit({
            id: newId('sig-spawn'),
            kind: 'subagent_spawn',
            source: `subagent:${spawn.node.id}`,
            content: {
              threadId: rootThreadId,
              childThreadId: spawn.node.id,
              parent: spawn.parent,
              parentTurnId: spawn.parentTurnId,
              handoffId: spawn.handoffId,
              ...(spawn.description ? { description: spawn.description } : {}),
              ...(spawn.agentType ? { agentType: spawn.agentType } : {}),
              prompt: spawn.prompt,
            },
            timestamp: Date.now(),
          })
          .catch((error: unknown) =>
            log.warn(
              `[Subagents] brief of ${spawn.node.id} not started: ${(error as Error).message}`,
            ),
          );
      },
      // In-session runtime only: a subagent's turn gets the root thread's guard Wardens once, over
      // its tool calls, when the turn ends (one pool per main thread). Subagents' own Wardens are
      // parked (docs/THREAD-TREE.md §C.10).
      onTurnEnd: !config.threadSetup
        ? undefined
        : (rootThreadId, turn) => {
            const root = directory.get(rootThreadId);
            if (!root) return;
            void root.signals
              .emit({
                id: newId('sig-subturn'),
                kind: 'subagent_turn',
                source: `subagent:${turn.node.id}`,
                content: {
                  threadId: rootThreadId,
                  node: turn.node,
                  turnId: turn.turnId,
                  outcome: turn.outcome,
                },
                timestamp: Date.now(),
              })
              .catch((error: unknown) =>
                log.warn(
                  `[Subagents] guard of ${turn.node.id} not started: ${(error as Error).message}`,
                ),
              );
          },
      observeTool: !config.threadSetup
        ? undefined
        : (rootThreadId, call) => {
            const root = directory.get(rootThreadId);
            if (!root) return;
            void root.signals
              .emit({
                id: newId('sig-tool'),
                kind: 'tool_observation',
                source: `subagent:${call.node.id}`,
                content: {
                  threadId: rootThreadId,
                  tool: call.tool,
                  input: call.input,
                  ...(call.output !== undefined ? { output: call.output } : {}),
                  ...(call.ok !== undefined ? { ok: call.ok } : {}),
                  callId: call.callId,
                  agentId: 'subagent',
                  subagent: { node: call.node, turnId: call.turnId },
                },
                timestamp: Date.now(),
              })
              .catch((error: unknown) =>
                log.warn(
                  `[Subagents] guard of ${call.node.id} not started: ${(error as Error).message}`,
                ),
              );
          },
    });
    for (const source of config.subagentSources ?? [])
      source.observeSubagents((threadId, evidence) => {
        try {
          subagents.observe(threadId, evidence);
        } catch (error) {
          log.warn(`[Subagents] ${threadId}: ${(error as Error).message}`);
        }
      });
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
  const configStore = config.configStore ?? new ConfigStore(config.configDir ?? '.foundry');
  // Raw middleware rows age out once reduced (`journal.rawMiddlewareDays`, default 30).
  if (localStore) {
    const prune = () => {
      try {
        const days = configStore.config.journal?.rawMiddlewareDays ?? DEFAULT_RAW_MIDDLEWARE_DAYS;
        const pruned = localStore.pruneRawMiddleware(Date.now() - days * 86_400_000);
        if (pruned.rows)
          log.info(
            `[Journal] pruned ${pruned.rows} raw middleware row(s), ${pruned.content} content`,
          );
      } catch (error) {
        log.warn(`[Journal] raw middleware retention failed: ${(error as Error).message}`);
      }
    };
    prune();
    const timer = setInterval(prune, 6 * 3_600_000);
    timer.unref();
    localStore.onClose(() => clearInterval(timer));
  }
  // Every Warden call journals the versions its instructions and domain knowledge were composed from.
  const compositionAuditor = localStore
    ? new CompositionAuditor(configStore.audit, localStore, {
        settingsRevision: () => configStore.revision,
      })
    : undefined;
  const knowledgePersistence =
    localStore && config.threadFactory?.runtime
      ? new KnowledgePersistence(
          config.threadFactory.runtime,
          localStore,
          eventStream,
          directory.all(),
          compositionAuditor,
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
  // Feedback, journalled: explicit items need only the journal; detection and tuning (capture → tune →
  // change) also need a decision provider.
  const feedbackProvider = config.feedbackProvider;
  const feedback: FeedbackService | null = localStore
    ? new FeedbackService({
        store: localStore,
        config: () => configStore.config,
        queue: config.actionQueue ?? null,
        thread: (id) => directory.get(id),
        cartographer: (id) => config.threadFactory?.runtime?.get(id)?.cartographer,
        ...(feedbackProvider
          ? {
              classify: (input) => classifyCorrection(feedbackProvider, input),
              match: (statement, candidates, priority) =>
                matchExisting(feedbackProvider, statement, candidates, priority),
            }
          : {}),
        // Role files compose on their next prepare; main's instructions are a stack layer of the thread.
        invalidate: (role, threadId) => {
          invalidateComposition();
          if (role === MAIN_ROLE)
            directory.get(threadId)?.stack.getLayer('instructions')?.invalidate();
        },
        roots: (thread) => feedbackRoots(thread, configStore.config),
        changed: (item) => streams.feedbackChanged(item),
        audit: configStore.audit,
        log: (message) => log.warn(message),
      })
    : null;
  registerKingdomRoutes(
    app,
    configStore,
    configDir,
    kingdom,
    () => tunnelHolder.tunnel?.token,
    holders,
  );
  registerDeviceRoutes(app, configStore, config.deviceIdentityPath);
  registerModelRoutes(app, configStore);
  registerProfileRoutes(app, configStore);
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

  const threadLaunch = config.threadLaunch ?? new ThreadLaunchSettings();
  // Access follows the host: an ACP thread whose host mode is unknown (lost to a daemon restart)
  // asks, never runs at the runtime's full-access default. Viewer threads keep their full access.
  threadLaunch.fallbackMode = (threadId) =>
    directory.get(threadId)?.meta.tags?.includes('acp') ? 'default' : undefined;
  // Settled prompts (each with its bounded tool input) leave the queue after an hour.
  if (config.actionQueue) {
    const queue = config.actionQueue;
    const pruner = setInterval(() => queue.prune(3_600_000), 600_000);
    (pruner as { unref?: () => void }).unref?.();
  }
  const { turns } = registerRuntimeRoutes(app, {
    threadLaunch,
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
    feedback,
    images: new ImageAttachmentStore(join(configDir, 'attachments', 'images')),
    ...(config.threadSetup ? { threadSetup: config.threadSetup } : {}),
  });
  // "Setting up your thread": the thread's setup streams on `threads` with its meta.
  config.threadSetup?.onSetup((threadId, setup) => {
    const thread = directory.get(threadId);
    if (!thread) return;
    thread.meta.setup = setup;
    threadChanged(thread);
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
    kingdomConnected: () => kingdom.all().some((connection) => connection.connected),
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
  // The workspace and its settings/analytics pages are one client-routed app (ui/route.js).
  const appPage = serveStatic({
    root: fileURLToPath(new URL('./', import.meta.url)),
    path: 'ui/index.html',
  });
  for (const path of [
    '/',
    '/settings',
    '/settings/*',
    '/analytics',
    '/projects/:id/settings',
    '/projects/:id/settings/*',
    '/projects/:id/analytics',
  ])
    app.get(path, appPage);

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
        ? !authenticatedRequest(req, activeTunnel.token, activeTunnel.url ?? undefined) &&
          !acpAuthorized(req)
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

  // One gate per thread: an approval at pre-use must answer the native ask for the same call.
  const gates = new Map<string, ThreadToolGate>();
  const watched = new WeakSet<object>();
  // A disposed thread drops its gate and what hosts chose for it (client MCP env/headers are secrets).
  const forgetOnDispose = (thread: { id: string; onDispose(fn: () => void): () => void }) => {
    if (watched.has(thread)) return;
    watched.add(thread);
    thread.onDispose(() => {
      gates.delete(thread.id);
      threadLaunch.clear(thread.id);
    });
  };
  threadLaunch.onChange((threadId) => {
    const thread = directory.get(threadId);
    if (thread?.disposed) threadLaunch.clear(threadId);
    else if (thread) forgetOnDispose(thread);
  });

  /** A thread's tool gate: structural rules, then asks to whoever answers first (viewer, ACP host). */
  const toolGate = (threadId: string): ThreadToolGate => {
    const thread = directory.get(threadId);
    if (!thread || thread.disposed) return { gate: UNBOUND_GATE, hasRules: () => true };
    const existing = gates.get(threadId);
    if (existing) return existing;
    const rules = () => {
      const settings = configStore.config;
      const projectId = thread.meta.projectId;
      return rulesFor(
        settings.toolRules,
        projectId ? settings.projects[projectId]?.toolRules : undefined,
      );
    };
    const gate = createToolGate({
      threadId,
      rules,
      mode: () => threadLaunch.forLaunch(threadId).permissionMode,
      queue: config.actionQueue ?? null,
      turnId: () => turns.runningTurn(threadId),
      journal: (id, phase, turnId, record) => {
        try {
          localStore?.appendPhase(thread, { id, phase, turnId, dispatchId: null, record });
          if (turnId)
            eventStream.push({
              kind: 'journal',
              threadId,
              projectId: thread.meta.projectId,
              turnId,
              timestamp: Date.now(),
            });
        } catch (error) {
          log.warn(`[Gate] ${phase} not journalled: ${(error as Error).message}`);
        }
      },
    });
    const bound: ThreadToolGate = { gate, hasRules: () => enforces(rules()) };
    gates.set(threadId, bound);
    forgetOnDispose(thread);
    return bound;
  };

  return {
    toolGate,
    threadLaunch,
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

  // Automatic tunnel: off until it can work, then on.
  if (
    !tunnelHolder.tunnel &&
    config.autoTunnel &&
    saved.tunnel?.enabled === undefined &&
    viewer.kingdom.all().some((connection) => connection.connected)
  )
    tunnelHolder.tunnel = new FoundryTunnel({
      port: server.port ?? port,
      provider: saved.tunnel?.provider,
      subdomain: saved.tunnel?.subdomain,
      configDir: config.configDir,
    });

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
    toolGate: viewer.toolGate,
    server,
    actions,
    analyticsStore,
    tunnelHolder,
    localStore,
    kingdom: viewer.kingdom,
  };
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const PROXY_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
];

/** Addressed to a loopback host and carrying no reverse-proxy headers. */
function directLoopback(request: Request): boolean {
  return (
    LOOPBACK_HOSTS.includes(new URL(request.url).hostname) &&
    !PROXY_HEADERS.some((header) => request.headers.has(header))
  );
}

/** Paths served by the client-routed app; ui/route.js parses the same shapes. */
function isPage(path: string): boolean {
  return (
    path === '/' ||
    /^\/(settings|analytics)(\/|$)/.test(path) ||
    /^\/projects\/[^/]+\/(settings|analytics)(\/|$)/.test(path)
  );
}
