/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:viewer
 */
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActionQueue,
  EventStream,
  Harness,
  InterventionLog,
  LLMProvider,
  Thread,
  ThreadMachine,
  ThreadSetup,
  TokenTracker,
  ToolRegistry,
} from '@inixiative/foundry-core';
import { newId, threadTitle } from '@inixiative/foundry-core';
import type { Server } from 'bun';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { PlanDrafter } from '../agents/plan-drafter';
import { invalidateComposition } from '../agents/role-layers';
import { ThreadNamer } from '../agents/thread-namer';
import { registerArchiveRoutes } from '../archives/routes';
import { ThreadContextTracker } from '../archives/thread-context';
import { CompositionAuditor } from '../audit/compositions';
import { ConversationService } from '../conversations/service';
import { blockedOnPerson, RestartRoll } from '../daemon/restart-roll';
import { readLocalDevice } from '../devices/local-inventory';
import { feedbackRoots } from '../feedback/apply';
import { MAIN_ROLE } from '../feedback/routing';
import { FeedbackService } from '../feedback/service';
import { classifyCorrection, matchExisting } from '../feedback/sharpen';
import { releaseWorktree } from '../git';
import { ImageAttachmentStore } from '../persistence/image-attachments';
import { KnowledgePersistence } from '../persistence/knowledge-persistence';
import { LocalSessionStore } from '../persistence/local-session-store';
import { installationNameOf } from '../providers/kingdom-cli';
import { KingdomHolders } from '../providers/kingdom-holder';
import {
  KingdomInstallationConnections,
  type KingdomIntegration,
  shareViewerCredential,
} from '../providers/kingdom-installation-connection';
import { FileExternalSessionStore } from '../providers/session-adapter';
import type { TaskSink } from '../providers/session-backed';
import { ThreadLaunchSettings } from '../providers/thread-launch';
import { resolveSecretsSettings, SecretScratch } from '../secrets/scratch';
import { kingdomPostDelivery } from '../tools/kingdom-post';
import type { ThreadRecords } from '../tools/thread-record';
import {
  NATIVE_RECORD_QUIET_MS,
  NATIVE_TOOL_QUIET_MS,
  NativeOutcomeRecovery,
  nativeHomes,
} from '../turns/native-outcome-recovery';
import { NativeTurnRecorder } from '../turns/native-turns';
import { RunningTasks } from '../turns/running-tasks';
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
import { ConfigStore, DEFAULT_RAW_MIDDLEWARE_DAYS, threadOnMerge } from './config';
import { createViewerStreams } from './data-streams';
import { authenticatedRequest, sameOrigin } from './request-auth';
import { registerControlRoutes } from './routes/control';
import { registerConversationRoutes } from './routes/conversations';
import { registerDaemonUpdateRoutes } from './routes/daemon-update';
import { registerDeviceRoutes } from './routes/devices';
import { registerGlossRoutes } from './routes/gloss';
import { registerKingdomRoutes } from './routes/kingdom';
import { registerLoginRoutes } from './routes/logins';
import { registerModelRoutes } from './routes/models';
import { registerProfileRoutes } from './routes/profile';
import { registerRuntimeRoutes, type WorkerSessions } from './routes/runtime';
import { ViewerThreadDirectory } from './thread-directory';
import { expireSnoozes } from './thread-snooze';
import { FoundryTunnel, type TunnelConfig, type TunnelHolder, tunnelAuth } from './tunnel';

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
  /** Each worker's native sessions, for a thread switching worker mid-conversation. */
  workerSessions?: WorkerSessions;
  /** Decision provider for the feedback lifecycle (optional; no capture without it). */
  feedbackProvider?: LLMProvider;
  /** Token tracker for analytics (optional but recommended). */
  tokenTracker?: TokenTracker;
  /** Directory for analytics data persistence. Defaults to .foundry/analytics/ */
  analyticsDir?: string;
  /** Project registry (optional — enables multi-project management). */
  projectRegistry?: import('../agents/project').ProjectRegistry;
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
  /** What hosts chose per thread (mode, model, effort, MCP servers); shared with the providers. */
  threadLaunch?: ThreadLaunchSettings;
  /**
   * In-session Wardens (docs/THREAD-TREE.md spec C): opens a thread's session ahead of its turn,
   * and reports its setup, which becomes `ThreadMeta.setup`.
   */
  threadSetup?: ThreadSetupHost & {
    onSetup(listener: (threadId: string, setup: ThreadSetup) => void): void;
  };
  /** This machine's subscription logins, their balancing and sign-ins (providers/login-pool.ts). */
  logins?: Omit<import('./routes/logins').LoginRoutesDeps, 'configStore' | 'foundryDir'>;
  /** Executor providers whose sessions report their background tasks (shells, monitors). */
  taskSources?: ReadonlyArray<{ observeTasks(sink: TaskSink): () => void }>;
  /** Executor providers whose sessions start turns on their own (Muse crons, monitors, goals). */
  nativeTurnSources?: ReadonlyArray<{
    observeNativeTurns(sink: import('../providers/session-backed').NativeTurnSink): () => void;
  }>;
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
    warn: (message) => console.warn(message),
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
            (message) => console.warn(message),
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

  // Where each paired Kingdom opens this Foundry: its devices page, else its API's /dashboard redirect.
  const kingdomEntrances = async () => {
    const urls = await Promise.all(
      ((await configStore.load()).kingdomIntegrations ?? []).map(async (integration) => {
        const described = await holders.get(integration, 1_500);
        if (described.status === 'revoked') return null;
        const url = described.holder
          ? new URL('/devices', described.holder.webUrl)
          : new URL('/dashboard', integration.url);
        return ['https:', 'http:'].includes(url.protocol) ? url.toString() : null;
      }),
    );
    return [...new Set(urls.filter((url): url is string => !!url))];
  };

  // Auth middleware — checks tunnelHolder dynamically so it works
  // even when tunnel is started/stopped at runtime. The tunnel's login guards its public address;
  // a direct loopback request is this machine, tunnelled or not.
  app.use('*', async (c, next) => {
    const t = tunnelHolder.tunnel;
    if (!sameOrigin(c.req.raw, t?.url ?? undefined))
      return c.json({ error: 'Origin not allowed' }, 403);
    if (!t) {
      if (!LOOPBACK_HOSTS.includes(new URL(c.req.url).hostname))
        return c.json({ error: 'Local viewer requires a loopback host' }, 403);
      return next();
    }
    if (directLoopback(c.req.raw)) return next();
    return tunnelAuth(t.token, t.url ?? undefined, kingdomEntrances)(c, next);
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
  // This machine: the local device identity, and the Foundry's name once settings are read.
  let installationName: string | undefined;
  const machine = (): ThreadMachine | undefined => {
    let device: ReturnType<typeof readLocalDevice> = null;
    try {
      device = readLocalDevice(config.deviceIdentityPath);
    } catch {
      return undefined;
    }
    return device
      ? {
          deviceId: device.id,
          deviceName: device.name,
          ...(installationName ? { installationName } : {}),
        }
      : undefined;
  };
  const directory = new ViewerThreadDirectory(
    harness.thread,
    config.projectRegistry,
    config.threadFactory,
    machine,
  );
  const kingdomLost = () => !kingdom.authorized;
  const revoke = () =>
    closeAllConnections(socket.registry, 1008, 'Kingdom authorization unavailable');
  // The conversation wrapper of main threads (docs/reference/CONVERSATIONS.md); built once turns exist.
  let conversations: ConversationService | null = null;
  // `socket` is created below, once its stream families exist; delivery only happens after both do.
  const streams = createViewerStreams({
    directory,
    eventStream,
    actionQueue: config.actionQueue,
    feedback: () => feedback,
    conversation: (threadId) => conversations?.summary(threadId),
    permissionMode: (threadId) => threadLaunch.forLaunch(threadId).permissionMode,
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
  const nativeRecovery = localStore
    ? new NativeOutcomeRecovery({
        store: localStore,
        bootedAt: Date.now(),
        homes: () => nativeHomes(config.configDir ?? '.foundry'),
        boundSessions: (threadId) =>
          FileExternalSessionStore.boundTo(
            join(config.configDir ?? '.foundry', 'sessions.json'),
            threadId,
          ),
      })
    : undefined;
  if (localStore) {
    const recovered = localStore.recoverInterrupted();
    if (recovered.interrupted || recovered.neverSent)
      console.warn(
        `[Recovery] ${recovered.interrupted} turn(s) interrupted (native outcome unknown), ${recovered.neverSent} queued turn(s) never sent`,
      );
    for (const warning of directory.restore(localStore.threads()))
      console.warn(`[Recovery] ${warning}`);
    // Settle what the native records already show; records still being written (a native process
    // the restart orphaned) are read again once they go quiet, and again before any next turn.
    const settleLost = () => {
      try {
        const pass = nativeRecovery!.settleAll();
        for (const { turnId, outcome } of pass.settled)
          console.warn(`[Recovery] turn ${turnId}: ${outcome}, read from the native record`);
        for (const { turnId, detail } of pass.undecided)
          console.warn(`[Recovery] turn ${turnId} still unsettled: ${detail}`);
        return pass;
      } catch (error) {
        console.warn(`[Recovery] native outcome recovery failed: ${String(error)}`);
        return undefined;
      }
    };
    if (settleLost()?.undecided.length) {
      // Look again each minute until every record has gone quiet (a pending tool call waits longest).
      const started = Date.now();
      const again = setInterval(() => {
        const pass = settleLost();
        for (const turnId of new Set(pass?.settled.map((entry) => entry.turnId)))
          streams.threadsChanged(localStore.turn(turnId)?.threadId ?? '');
        if (!pass?.undecided.length || Date.now() - started > NATIVE_TOOL_QUIET_MS + 120_000)
          clearInterval(again);
      }, NATIVE_RECORD_QUIET_MS);
      again.unref?.();
    }
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
            console.warn(
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
            // Only a thread whose worker holds its Wardens in-session; the others' are primed.
            if (!root || !config.threadSetup?.applies(rootThreadId)) return;
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
                console.warn(
                  `[Subagents] guard of ${turn.node.id} not started: ${(error as Error).message}`,
                ),
              );
          },
      observeTool: !config.threadSetup
        ? undefined
        : (rootThreadId, call) => {
            const root = directory.get(rootThreadId);
            if (!root || !config.threadSetup?.applies(rootThreadId)) return;
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
                console.warn(
                  `[Subagents] guard of ${call.node.id} not started: ${(error as Error).message}`,
                ),
              );
          },
    });
    for (const source of config.taskSources ?? [])
      source.observeTasks((threadId, task, at, stop) =>
        runningTasks.observe(threadId, task, at, stop),
      );
    for (const source of config.subagentSources ?? [])
      source.observeSubagents((threadId, evidence) => {
        try {
          subagents.observe(threadId, evidence);
        } catch (error) {
          console.warn(`[Subagents] ${threadId}: ${(error as Error).message}`);
        }
      });
    // A turn the session started itself lands in its thread's journal and live stream; when it
    // ends, the thread list sees its new last turn.
    const nativeTurns = new NativeTurnRecorder({
      store: localStore,
      thread: (id) => directory.get(id),
      events: eventStream,
      arrived: (thread) => {
        thread.meta.lastActiveAt = Date.now();
        localStore.saveThread(thread);
        streams.threadsChanged(thread.id);
      },
    });
    for (const source of config.nativeTurnSources ?? [])
      source.observeNativeTurns((threadId, evidence, task) => {
        try {
          nativeTurns.observe(threadId, evidence, task);
        } catch (error) {
          console.warn(`[Native turns] ${threadId}: ${(error as Error).message}`);
        }
      });
  }
  const threadChanged = (thread: Thread) => {
    try {
      localStore?.saveThread(thread);
      streams.threadsChanged(thread.id);
    } catch (error) {
      console.warn(`[Viewer] thread ${thread.id} metadata not saved: ${(error as Error).message}`);
    }
  };
  const namer = config.namingProvider
    ? new ThreadNamer({ provider: config.namingProvider, changed: threadChanged })
    : undefined;
  // The same decision provider drafts a plan when a turn that brought work ended without one.
  const planDrafter = config.namingProvider
    ? new PlanDrafter({
        provider: config.namingProvider,
        changed: threadChanged,
        settled: () => restartRoll.check(),
      })
    : undefined;
  const runningTasks = new RunningTasks((threadId, callId) =>
    localStore?.nativeToolUse(threadId, callId),
  );
  const threadContext = new ThreadContextTracker({
    thread: (id) => directory.get(id),
    changed: threadChanged,
    onMerged: (thread, into) => void settleMerged(thread, into),
  });
  /**
   * A thread's branch merged: `threadOnMerge` decides (project, then Foundry-wide, default `done`).
   * done: the thread shows "Merged into <base>" until its next task. auto-archive: archived, and its
   * worktree released with the project's mode (FEAT-003), never forced; a refusal stays on the record.
   */
  const settleMerged = async (thread: Thread, into: string) => {
    const mode = threadOnMerge(await configStore.load(), thread.meta.projectId);
    if (mode === 'done') {
      thread.meta.done = { kind: 'merged', text: `Merged into ${into}`, at: Date.now() };
      threadChanged(thread);
      return;
    }
    await actions.execute({
      kind: 'thread:archive',
      target: thread.id,
      operator: 'foundry',
      timestamp: Date.now(),
    });
    const context = thread.meta.context;
    const checkout = context?.checkout;
    if (!context || !checkout?.path || !checkout.root || checkout.main || checkout.mode === 'none')
      return;
    const released = await releaseWorktree({
      mode: checkout.mode,
      root: checkout.root,
      path: checkout.path,
    });
    if ('error' in released) {
      thread.meta.context = { ...context, checkout: { ...checkout, error: released.error } };
      threadChanged(thread);
    } else void threadContext.refresh(thread.id);
  };
  // Archive capture covers every journalled thread at startup and after each turn.
  const archiveCapture = localStore
    ? registerArchiveRoutes(app, localStore, eventStream, (snapshot) => {
        void threadContext.observe(snapshot);
      }).capture
    : undefined;
  if (!localStore) for (const thread of directory.all()) void threadContext.refresh(thread.id);
  const configStore = config.configStore ?? new ConfigStore(config.configDir ?? '.foundry');
  void configStore
    .load()
    .then((loaded) => {
      installationName = installationNameOf(loaded);
      // Threads stamped before settings were read get this Foundry's name on their own machine.
      for (const thread of directory.all()) {
        const here = thread.meta.machine;
        if (!here || here.installationName || here.deviceId !== machine()?.deviceId) continue;
        thread.meta.machine = { ...here, installationName };
        threadChanged(thread);
      }
    })
    .catch(() => {});
  // Raw middleware rows age out once reduced (`journal.rawMiddlewareDays`, default 30).
  if (localStore) {
    const prune = () => {
      try {
        const days = configStore.config.journal?.rawMiddlewareDays ?? DEFAULT_RAW_MIDDLEWARE_DAYS;
        const pruned = localStore.pruneRawMiddleware(Date.now() - days * 86_400_000);
        if (pruned.rows)
          console.info(
            `[Journal] pruned ${pruned.rows} raw middleware row(s), ${pruned.content} content`,
          );
      } catch (error) {
        console.warn(`[Journal] raw middleware retention failed: ${(error as Error).message}`);
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
    reopenThread: (id) => turns.reopen(id),
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
        log: (message) => console.warn(message),
      })
    : null;
  // The secret scratch pad (FEAT-005): one private directory of pads, one per thread, under this
  // Foundry's own directory. The setting is read live, global then project.
  const secrets = new SecretScratch(join(configDir, '.private', 'scratch'), {
    settings: (projectId) =>
      resolveSecretsSettings(
        configStore.config.secrets,
        projectId ? configStore.config.projects[projectId]?.secrets : undefined,
      ),
    projectOf: (threadId) => {
      const thread = directory.get(threadId);
      return thread ? thread.meta.projectId : null;
    },
  });
  // A pad whose thread was archived while nothing watched it goes now; a live thread's pad is kept.
  try {
    secrets.sweep((threadId) => directory.get(threadId)?.meta.status === 'archived');
  } catch (error) {
    console.warn(`[Secrets] scratch pads not swept: ${(error as Error).message}`);
  }
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
  analyticsReady.catch(() => console.warn('[Viewer] analytics history unavailable'));
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
  // The spin-down before a restart onto an update (`daemon/restart-roll.ts`): built before the turn
  // path so a turn reaching the front of its queue can wait for it.
  let turnsReady: ReturnType<typeof registerRuntimeRoutes>['turns'] | undefined;
  const restartRoll = new RestartRoll({
    // A turn blocked on a person (its agent's approval or question) isn't running: the restart doesn't wait for it.
    running: () =>
      (turnsReady?.runningTurns() ?? []).filter(
        (turn) => !blockedOnPerson(config.actionQueue, turn),
      ),
    waiting: () => turnsReady?.queuedCount() ?? 0,
    finishing: () => planDrafter?.drafting() ?? 0,
    background: () => runningTasks.active(),
    prepare: () => {
      const held = turnsReady?.holdQueuedForRestart() ?? 0;
      if (held) console.log(`[Restart] ${held} waiting turn(s) held; they run after the restart`);
    },
    log: (message) => console.log(`[Restart] ${message}`),
  });
  const imageStore = new ImageAttachmentStore(join(configDir, 'attachments', 'images'));
  const { turns, fork } = registerRuntimeRoutes(app, {
    nativeRecovery,
    ...(config.workerSessions ? { workerSessions: config.workerSessions } : {}),
    restartGate: restartRoll,
    threadLaunch,
    harness,
    eventStream,
    interventions,
    assistProviderId: config.assistProvider?.id,
    threadFactory: config.threadFactory,
    configStore,
    projectRegistry: config.projectRegistry,
    namer,
    planDrafter,
    threadContext,
    runningTasks,
    ...(config.tokenTracker ? { tokenTracker: config.tokenTracker } : {}),
    ...(archiveCapture ? { archiveCapture } : {}),
    deviceIdentityPath: config.deviceIdentityPath,
    localStore,
    directory,
    streams,
    feedback,
    secrets,
    images: imageStore,
    ...(config.threadSetup ? { threadSetup: config.threadSetup } : {}),
  });
  turnsReady = turns;
  turns.onSettled(() => restartRoll.check());
  registerDaemonUpdateRoutes(app, restartRoll, (threadId) => {
    const thread = directory.get(threadId);
    return thread ? threadTitle(thread.meta)?.text : undefined;
  });
  // Turns a planned restart held run again, in the order they arrived, once the daemon has booted
  // (start.ts calls it); their threads resume their native sessions through their bindings.
  const resumeHeldTurns = () =>
    turns
      .resumeHeld((ids) => imageStore.resolve(ids))
      .then(({ resumed, failed }) => {
        if (resumed)
          console.log(`[Restart] ${resumed} held turn(s) started again after the restart`);
        for (const { turnId, error } of failed)
          console.warn(`[Restart] held turn ${turnId} could not run again: ${error}`);
      })
      .catch((error) => console.warn(`[Restart] held turns not resumed: ${String(error)}`));
  // Agent conversations: Kingdom's relayed frames reach this wrapper over each Installation socket
  // (served before the sockets start), and held sends survive a restart (raised again here).
  if (localStore) {
    conversations = new ConversationService({
      store: localStore,
      thread: (id) => directory.get(id),
      threads: () => directory.all(),
      reopen: (id) => turns.reopen(id),
      canReopen: (id) => turns.canReopen(id),
      turns: () => turns,
      queue: config.actionQueue ?? null,
      project: (id) => configStore.config.projects[id],
      hosted: () => kingdom.hostedSignets(),
      subscriptions: () => kingdom.threadSubscriptions(),
      events: eventStream,
      deliverPost: kingdomPostDelivery(config.assistTools),
      changed: (threadId) => streams.threadsChanged(threadId),
      journalChanged: (thread) =>
        eventStream.push({
          kind: 'journal',
          threadId: thread.id,
          projectId: thread.meta.projectId,
          turnId: null,
          scope: 'phase',
          timestamp: Date.now(),
        }),
      fork: () => fork,
      log: (message) => console.warn(message),
    });
    // Owner-only like the conversation controls: secrets are used only in a turn the owner's own message opened.
    const service = conversations;
    secrets.ownerInstructed = (threadId) => service.ownerInstructed(threadId);
    kingdom.serveThreads(service.host(), (hosted, dropped) =>
      service.hostedChanged(hosted, dropped),
    );
    service.raisePending();
    // A settled turn frees the live slot a refused wake waited for, and lets a local member hear
    // what arrived during its own turn (CONVERSATIONS.md §4.11).
    const offSettled = turns.onSettled((threadId) => service.turnSettled(threadId));
    registerConversationRoutes(
      app,
      service,
      {
        integrations: async () => (await configStore.load()).kingdomIntegrations ?? [],
        holders,
      },
      configStore,
    );
    localStore.onClose(() => {
      offSettled();
      service.dispose();
    });
  }
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
  if (config.logins)
    registerLoginRoutes(app, {
      ...config.logins,
      configStore,
      foundryDir: config.configDir ?? '.foundry',
    });
  // A viewer without this machine's logins (API tokens, tests) has no pools to show.
  else app.get('/api/providers/pools', (c) => c.json({ pools: [], setups: [], kingdom: [] }));

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
  // The look is @inixiative/config's shared theme (public.css, status.css and the fonts they load),
  // read from the package at runtime so Foundry and Kingdom never drift apart.
  const themeDir = dirname(
    fileURLToPath(import.meta.resolve('@inixiative/config/theme/public.css')),
  );
  app.get('/ui/theme/*', async (c) => {
    const file = resolve(themeDir, c.req.path.slice('/ui/theme/'.length));
    if (!file.startsWith(`${themeDir}${sep}`)) return c.notFound();
    const body = Bun.file(file);
    if (!(await body.exists())) return c.notFound();
    return new Response(body, { headers: { 'Content-Type': body.type } });
  });
  app.get('/ui/*', serveStatic({ root: fileURLToPath(new URL('./', import.meta.url)) }));
  app.get(
    '/kingdom',
    serveStatic({ root: fileURLToPath(new URL('./', import.meta.url)), path: 'ui/kingdom.html' }),
  );
  // The workspace and its settings, analytics and search pages are one client-routed app (ui/route.js).
  const appPage = serveStatic({
    root: fileURLToPath(new URL('./', import.meta.url)),
    path: 'ui/index.html',
  });
  for (const path of [
    '/',
    '/settings',
    '/settings/*',
    '/analytics',
    '/search',
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
  // A snooze whose time passed is cleared; the thread shows as it was (thread-snooze.ts).
  const snoozeWatch = makeUnrefInterval({
    intervalMs: 15_000,
    tick: () => void expireSnoozes(directory.all(), threadChanged),
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
          !directLoopback(req)
        : !LOOPBACK_HOSTS.includes(url.hostname)
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
    // The list rows show the mode (a Dangerous mark): send the thread again.
    streams.threadsChanged(threadId);
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
      privacy: () => secrets.privacy(thread.meta.projectId),
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
          console.warn(`[Gate] ${phase} not journalled: ${(error as Error).message}`);
        }
      },
    });
    // Private paths are not structural rules: Codex and Muse still start, and get them when they ask.
    const bound: ThreadToolGate = { gate, hasRules: () => enforces(rules()) };
    gates.set(threadId, bound);
    forgetOnDispose(thread);
    secrets.watch(thread);
    return bound;
  };

  return {
    toolGate,
    threadLaunch,
    /** Turns queued or running on this daemon (a supervisor without the spin-down drains on it). */
    liveTurns: () => turns.liveCount(),
    /** The spin-down a staged update goes through (`offerUpdate` on the daemon hook). */
    restartRoll,
    resumeHeldTurns,
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
    conversations,
    /** The secret scratch pad: `secret_scratch` and `secret_pipe` reach it (FEAT-005). */
    secrets,
    /** The record tool's reach: a live thread's plan, loop, name and status, persisted and published. */
    records: {
      read(threadId: string): Thread {
        const thread = directory.get(threadId);
        if (!thread || thread.disposed) throw Error('This thread is not live here');
        return thread;
      },
      update<T>(threadId: string, change: (thread: Thread) => T): T {
        const thread = this.read(threadId);
        const result = change(thread);
        threadChanged(thread);
        return result;
      },
    } satisfies ThreadRecords,
    startSocket() {
      socket.startStaleSweep();
      kingdomWatch.start();
      snoozeWatch.start();
    },
    stopSocket() {
      kingdomWatch.stop();
      snoozeWatch.stop();
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
      console.warn(`[Kingdom] Paired Kingdom ${id} unavailable; reconnect at /kingdom`);
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

  console.info(`Foundry Viewer running at http://localhost:${server.port}`);

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
      if (info) console.info(`[Tunnel] ${info.provider} active: ${info.url}`);
      tunnelHolder.changed?.();
    } catch (err) {
      console.warn(`[Tunnel] failed to start: ${(err as Error).message}`);
    }
  }

  return {
    toolGate: viewer.toolGate,
    liveTurns: viewer.liveTurns,
    restartRoll: viewer.restartRoll,
    resumeHeldTurns: viewer.resumeHeldTurns,
    server,
    actions,
    analyticsStore,
    tunnelHolder,
    localStore,
    kingdom: viewer.kingdom,
    conversations: viewer.conversations,
    records: viewer.records,
    secrets: viewer.secrets,
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
  'true-client-ip',
  'via',
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
