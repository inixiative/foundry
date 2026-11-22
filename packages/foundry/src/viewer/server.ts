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
  TokenTracker,
  ToolRegistry,
} from '@inixiative/foundry-core';
import { newId, threadTitle } from '@inixiative/foundry-core';
import { conversationActLevel } from '@inixiative/signet';
import type { Server } from 'bun';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { invalidateComposition } from '../agents/role-layers';
import { registerArchiveRoutes } from '../archives/routes';
import { ThreadContextTracker } from '../archives/thread-context';
import { CompositionAuditor } from '../audit/compositions';
import { ConversationService } from '../conversations/service';
import { memberKey } from '../conversations/types';
import { releaseHeldPort } from '../daemon/port-handoff';
import { blockedOnPerson, RestartRoll } from '../daemon/restart-roll';
import { readLocalDevice } from '../devices/local-inventory';
import { feedbackRoots } from '../feedback/apply';
import { FeedbackService } from '../feedback/service';
import { classifyCorrection, matchExisting } from '../feedback/sharpen';
import { releaseWorktree } from '../git';
import { ModelSuccession } from '../models/model-succession';
import { ImageAttachmentStore } from '../persistence/image-attachments';
import { KnowledgePersistence } from '../persistence/knowledge-persistence';
import { LocalSessionStore } from '../persistence/local-session-store';
import { isThreadRole, MAIN_ROLE, SCOPE_ROLES } from '../prompts/instruction-settings';
import { installationNameOf } from '../providers/kingdom-cli';
import { KingdomHolders } from '../providers/kingdom-holder';
import {
  KingdomInstallationConnections,
  type KingdomIntegration,
  shareViewerCredential,
} from '../providers/kingdom-installation-connection';
import type { ProjectHostState } from '../providers/project-warden-hosts';
import { FileExternalSessionStore } from '../providers/session-adapter';
import type { TaskSink } from '../providers/session-backed';
import { ThreadLaunchSettings } from '../providers/thread-launch';
import { DraftAsks } from '../scheduler/draft-asks';
import { Scheduler } from '../scheduler/scheduler';
import { Keychain } from '../secrets/keychain';
import { resolveSecretsSettings, SecretScratch } from '../secrets/scratch';
import { kingdomPostDelivery } from '../tools/kingdom-post';
import {
  ARTIFACT_PHASE,
  type ArtifactVersionRecord,
  artifactVersionId,
  type ThreadRecords,
} from '../tools/thread-record';
import { withChorusAtCall } from '../turns/handoff-brief';
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
  actRules,
  createToolGate,
  enforces,
  rulesFor,
  type ThreadToolGate,
  UNBOUND_GATE,
} from '../turns/tool-gate';
import { createWebSocketServer } from '../ws/handler';
import { closeAllConnections } from '../ws/lifecycle';
import type { WSData } from '../ws/types';
import { makeUnrefInterval } from '../ws/unref-interval';
import { ActionHandler } from './actions';
import { AIAssist } from './ai-assist';
import { AnalyticsStore } from './analytics';
import { ConfigStore, DEFAULT_RAW_MIDDLEWARE_DAYS, threadOnMerge } from './config';
import { threadRoleOf } from './config-resolve';
import { createViewerStreams } from './data-streams';
import { authenticatedRequest, directLoopback, LOOPBACK_HOSTS, sameOrigin } from './request-auth';
import { registerControlRoutes } from './routes/control';
import { registerConversationRoutes } from './routes/conversations';
import { registerDaemonUpdateRoutes } from './routes/daemon-update';
import { registerDeviceRoutes } from './routes/devices';
import { registerGlossRoutes } from './routes/gloss';
import { registerKeychainRoutes } from './routes/keychain';
import { registerKingdomRoutes } from './routes/kingdom';
import { registerLoginRoutes } from './routes/logins';
import { registerMachineProcessRoutes } from './routes/machine-processes';
import { registerModelRoutes } from './routes/models';
import { registerProfileRoutes } from './routes/profile';
import { registerRuntimeRoutes, type WorkerSessions } from './routes/runtime';
import { registerScheduleRoutes } from './routes/schedules';
import {
  CUSTOM_UI_PATH_PREFIX,
  customThemeCss,
  customUiFile,
  discoverCustomUi,
  THEME_PATH_PREFIX,
  themeDirectory,
  themeFile,
} from './theme-files';
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
  /** Foundry's keychain; default, one on the machine's native store indexed under `configDir`. */
  keychain?: Keychain;
  /** Optional identity file for an isolated local profile. */
  deviceIdentityPath?: string;
  /** LLM provider for AI assist (optional). */
  assistProvider?: LLMProvider;
  /** Model for AI assist (optional). */
  assistModel?: string;
  /** The project Warden hosts' snapshot, for the Status view's process list (`/api/machine/processes`). */
  decisionHosts?: () => { projects: Record<string, ProjectHostState> } | undefined;
  /** Every native session binding (`FileExternalSessionStore.all`), for Status → Processes. */
  sessionBindings?: () => Promise<ReadonlyArray<{ threadId: string; externalSessionId: string }>>;
  /** Each worker's native sessions, for a thread switching worker mid-conversation. */
  workerSessions?: WorkerSessions;
  /** A project is active: a thread of it was opened here (its Warden host opens before the first turn). */
  projectActive?: (projectId: string) => void;
  /** Decision provider for the feedback lifecycle (optional; without it, corrections are recorded as said and nothing is captured). The daemon wires none. */
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
  /** The tool registry the agents share; Kingdom posts are delivered through it. */
  tools?: ToolRegistry;
  /** Durable local journal; null opts out for an explicitly transient viewer. */
  localStore?: LocalSessionStore | null;
  /** What hosts chose per thread (mode, model, effort, MCP servers); shared with the providers. */
  threadLaunch?: ThreadLaunchSettings;
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
  app.onError((error, c) => {
    console.error(`[Viewer] ${c.req.method} ${c.req.path} failed: ${error.message}`);
    return c.json({ error: error.message }, 500);
  });
  const configDir = resolve(config.configDir ?? config.configStore?.directory ?? '.foundry');
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

  // Requests a paired Kingdom forwarded over its Installation socket. Kingdom admitted the person
  // (whoever may manage this Foundry there), so these skip the loopback and tunnel checks; what only
  // this machine may change stays closed to them.
  const viaKingdom = new WeakSet<Request>();
  const machineOnly = (method: string, path: string) =>
    (method === 'POST' && path === '/api/kingdom/pair') ||
    (method === 'POST' && path === '/api/kingdom/viewer');
  // Auth middleware — checks tunnelHolder dynamically so it works
  // even when tunnel is started/stopped at runtime. The tunnel's login guards its public address;
  // a direct loopback request is this machine, tunnelled or not.
  app.use('*', async (c, next) => {
    if (viaKingdom.has(c.req.raw)) {
      if (!sameOrigin(c.req.raw)) return c.json({ error: 'Origin not allowed' }, 403);
      if (machineOnly(c.req.method, c.req.path))
        return c.json({ error: 'Change this on the machine that runs this Foundry.' }, 403);
      return next();
    }
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
      c.req.path !== '/status' &&
      c.req.path !== '/api/daemon/status' &&
      c.req.path !== '/kingdom' &&
      !c.req.path.startsWith('/api/kingdom/') &&
      (!c.req.path.startsWith('/ui/') || c.req.path.startsWith(CUSTOM_UI_PATH_PREFIX))
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
  // Schedules start runs as threads (scheduler/scheduler.ts); built once turns exist, with a journal.
  let scheduler: Scheduler | null = null;
  let draftAsks: DraftAsks | undefined;
  // `socket` is created below, once its stream families exist; delivery only happens after both do.
  // The turn service, once the runtime routes build it: a turn the session starts itself goes live there.
  let turnsReady: ReturnType<typeof registerRuntimeRoutes>['turns'] | undefined;
  const runningTasks = new RunningTasks((threadId, callId) =>
    localStore?.nativeToolUse(threadId, callId),
  );
  const streams = createViewerStreams({
    directory,
    eventStream,
    actionQueue: config.actionQueue,
    feedback: () => feedback,
    conversation: (threadId) => conversations?.summary(threadId),
    permissionMode: (threadId) => threadLaunch.forLaunch(threadId).permissionMode,
    threadRole: (thread) => threadRoleOf(configStore.config, thread.meta),
    backgroundJobsRunning: (threadId) => runningTasks.runningCount(threadId),
    ...(config.projectActive ? { projectActive: config.projectActive } : {}),
    schedules: () => scheduler?.list() ?? [],
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
    for (const subagent of directory.archiveOrphanedSubagents()) localStore.saveThread(subagent);
    // Settle what the native records already show; records still being written (a native process
    // the restart orphaned) are read again once they go quiet, and again before any next turn.
    const reported = new Map<string, string>();
    const settleLost = (atBoot = false) => {
      try {
        const pass = nativeRecovery!.settleAll();
        for (const { turnId, outcome } of pass.settled)
          console.warn(`[Recovery] turn ${turnId}: ${outcome}, read from the native record`);
        for (const { turnId, detail, recordMissing } of pass.undecided) {
          if (!atBoot && recordMissing) continue;
          if (reported.get(turnId) === detail) continue;
          reported.set(turnId, detail);
          console.warn(`[Recovery] turn ${turnId} still unsettled: ${detail}`);
        }
        return pass;
      } catch (error) {
        console.warn(`[Recovery] native outcome recovery failed: ${String(error)}`);
        return undefined;
      }
    };
    const recordStillChanging = (pass: ReturnType<typeof settleLost>) =>
      pass?.undecided.some((turn) => !turn.recordMissing) ?? false;
    if (recordStillChanging(settleLost(true))) {
      // Look again each minute until every record has gone quiet (a pending tool call waits longest).
      const started = Date.now();
      const again = setInterval(() => {
        const pass = settleLost();
        for (const turnId of new Set(pass?.settled.map((entry) => entry.turnId)))
          streams.threadsChanged(localStore.turn(turnId)?.threadId ?? '');
        if (!recordStillChanging(pass) || Date.now() - started > NATIVE_TOOL_QUIET_MS + 120_000)
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
      // A Claude handoff already briefed at its call (`withChorusAtCall`) is skipped by the runtime.
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
              ...(spawn.node.meta.spawn?.toolCallId
                ? { toolCallId: spawn.node.meta.spawn.toolCallId }
                : {}),
              ...(spawn.node.meta.spawn?.nativeTaskId
                ? { nativeTaskId: spawn.node.meta.spawn.nativeTaskId }
                : {}),
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
      // Every runtime: a subagent's turn gets the root thread's guard Wardens once, over its tool
      // calls, when the turn ends, as a main thread's turn does (Aron, 2026-11-02: subagents call the
      // Wardens; this replaces "subagents' own Wardens are parked", docs/THREAD-TREE.md §C.10).
      onTurnEnd: (rootThreadId, turn) => {
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
            console.warn(
              `[Subagents] guard of ${turn.node.id} not started: ${(error as Error).message}`,
            ),
          );
      },
      observeTool: (rootThreadId, call) => {
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
            console.warn(
              `[Subagents] guard of ${call.node.id} not started: ${(error as Error).message}`,
            ),
          );
      },
    });
    for (const source of config.taskSources ?? [])
      source.observeTasks((threadId, task, at, stop) => {
        runningTasks.observe(threadId, task, at, stop);
        streams.threadsChanged(threadId);
      });
    for (const source of config.subagentSources ?? [])
      source.observeSubagents((threadId, evidence) => {
        try {
          subagents.observe(threadId, evidence);
        } catch (error) {
          console.warn(`[Subagents] ${threadId}: ${(error as Error).message}`);
        }
      });
    // A turn the session started itself lands in its thread's journal and live stream, runs live on
    // the thread (Working, its queue held, stoppable, paused by a restart), and gets the thread's
    // Wardens over what it did: each tool call is guarded with the turn, a milestone call is advised
    // at the gate through the running turn, and its answer is handed back. When it ends, the thread
    // list sees its new last turn.
    // One chain per thread: a turn's end reaches its guard only after every call it made has.
    const nativeSignals = new Map<string, Promise<void>>();
    const emitNative = (thread: Thread, kind: string, content: Record<string, unknown>) => {
      const next = (nativeSignals.get(thread.id) ?? Promise.resolve())
        .then(() =>
          thread.signals.emit({
            id: newId(kind === 'native_turn' ? 'sig-nativeturn' : 'sig-tool'),
            kind,
            source: 'native-turn',
            content: { threadId: thread.id, ...content },
            timestamp: Date.now(),
          }),
        )
        .catch((error: unknown) =>
          console.warn(`[Native turns] ${thread.id}: ${(error as Error).message}`),
        );
      nativeSignals.set(thread.id, next);
      void next.finally(() => {
        if (nativeSignals.get(thread.id) === next) nativeSignals.delete(thread.id);
      });
    };
    const nativeTurns = new NativeTurnRecorder({
      store: localStore,
      thread: (id) => directory.get(id),
      events: eventStream,
      opened: (thread, turnId, control) =>
        turnsReady?.observeNativeTurn(thread.id, turnId, control) ?? null,
      toolCalled: (thread, turnId, call) => {
        const live = directory.get(thread.id);
        if (!live) return;
        emitNative(live, 'tool_observation', {
          tool: call.tool,
          input: call.input,
          ...(call.output !== undefined ? { output: call.output } : {}),
          ...(call.ok !== undefined ? { ok: call.ok } : {}),
          callId: call.callId,
          agentId: 'native-turn',
          nativeTurn: { turnId },
        });
      },
      ended: (thread, turnId, outcome, text) => {
        const live = directory.get(thread.id);
        if (live) emitNative(live, 'native_turn', { turnId, outcome, text });
      },
      arrived: (thread) => {
        thread.meta.lastActiveAt = Date.now();
        localStore.saveThread(thread);
        streams.threadsChanged(thread.id);
      },
    });
    for (const source of config.nativeTurnSources ?? [])
      source.observeNativeTurns((threadId, evidence, task, control) => {
        try {
          nativeTurns.observe(threadId, evidence, task, control);
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
    ? registerArchiveRoutes(
        app,
        localStore,
        eventStream,
        (snapshot) => void threadContext.observe(snapshot),
        // A thread the Archive already holds is not rebuilt; its work context is still derived.
        { unchanged: (threadId) => void threadContext.refresh(threadId) },
      ).capture
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
    reopenThread: (id) => {
      if (turns.reopen(id)) return true;
      // An observed subagent (archived with its parent) is a record: it reopens from its meta.
      const subagent = directory.reopenObserved(id);
      if (!subagent) return false;
      localStore?.saveThread(subagent);
      streams.threadsChanged(id);
      return true;
    },
    // Only a subagent (`meta.spawn`) goes with its parent; a thread started from another stays top-level.
    childrenOf: (id) => directory.all().filter((t) => t.meta.spawn && t.meta.parentThreadId === id),
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
        ...(feedbackProvider
          ? {
              classify: (input) => classifyCorrection(feedbackProvider, input),
              match: (statement, candidates, priority) =>
                matchExisting(feedbackProvider, statement, candidates, priority),
            }
          : {}),
        // Role files compose on their next prepare; a thread role's (and main's) instructions are a
        // stack layer of the thread.
        invalidate: (role, threadId) => {
          invalidateComposition();
          if (role === MAIN_ROLE || isThreadRole(configStore.config.composition, role))
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
  const keychain = config.keychain ?? new Keychain({ configDir });
  const secrets = new SecretScratch(join(configDir, '.private', 'scratch'), {
    keychain,
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
    (threadId) => {
      const thread = directory.get(threadId);
      return thread ? (threadTitle(thread.meta)?.text ?? thread.id) : undefined;
    },
  );
  registerDeviceRoutes(app, configStore, config.deviceIdentityPath);
  registerKeychainRoutes(app, keychain);
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
  // The model a thread launches on is its record's (`turns/thread-model.ts` changes it).
  threadLaunch.modelOf = (threadId) => directory.get(threadId)?.meta.model?.id;
  // Settled prompts (each with its bounded tool input) leave the queue after an hour.
  if (config.actionQueue) {
    const queue = config.actionQueue;
    const pruner = setInterval(() => queue.prune(3_600_000), 600_000);
    (pruner as { unref?: () => void }).unref?.();
  }
  // The spin-down before a restart onto an update (`daemon/restart-roll.ts`): built before the turn
  // path so a turn reaching the front of its queue can wait for it.
  const restartRoll = new RestartRoll({
    running: () => turnsReady?.runningTurns() ?? [],
    // A turn blocked on its person (its agent's approval or question) is paused without the grace.
    waitingOnPerson: (turn) => blockedOnPerson(config.actionQueue, turn),
    pause: async (turn) => turnsReady?.pauseForRestart(turn.threadId, turn.turnId) ?? 'not-yet',
    waiting: () => turnsReady?.queuedCount() ?? 0,
    background: () => runningTasks.active(),
    prepare: () => {
      const held = turnsReady?.holdQueuedForRestart() ?? 0;
      if (held) console.log(`[Restart] ${held} waiting turn(s) held; they run after the restart`);
    },
    log: (message) => console.log(`[Restart] ${message}`),
  });
  const imageStore = new ImageAttachmentStore(join(configDir, 'attachments', 'images'));
  // Retired models (`models/model-succession.ts`): at boot, settings naming one move to its
  // successor in one audited update and idle open threads move behind a marker; a busy thread
  // moves at its next turn's start, and one revived from archive asks its person.
  const modelSuccession = new ModelSuccession({
    store: localStore ?? undefined,
    launch: threadLaunch,
    queue: config.actionQueue ?? null,
    log: (line) => console.log(line),
  });
  void modelSuccession
    .succeedSettings(configStore)
    .catch((error) =>
      console.warn(`[Models] settings not moved off retired models: ${String(error)}`),
    );
  for (const thread of directory.all())
    try {
      if (modelSuccession.moveIdle(thread)) streams.threadsChanged(thread.id);
    } catch (error) {
      console.warn(`[Models] ${thread.id} not moved off its retired model: ${String(error)}`);
    }
  const { turns, fork, createThread } = registerRuntimeRoutes(app, {
    modelSuccession,
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
  });
  turnsReady = turns;
  turns.onSettled(() => restartRoll.check());
  // A schedule's run is a new thread at its Where whose first turn is the prompt, as the owner set
  // it but never counted as his message (TurnOrigin.schedule). Runs are kept in the journal store.
  if (localStore) {
    const schedules = new Scheduler({
      config: () => configStore.config,
      update: (edit, author) => configStore.update(edit, undefined, author),
      store: localStore,
      busy: (threadId) => turns.hasTurns(threadId),
      changed: () => streams.schedulesChanged(),
      startRun: async ({ schedule, where, runId, dueAt, made }) => {
        const created = await createThread({
          name: `${schedule.name} · ${new Date(dueAt).toLocaleString()}`,
          description: `Scheduled run of ${schedule.name}`,
          ...(where.kind === 'project' ? { projectId: where.projectId } : {}),
          ...(where.kind === 'scope'
            ? { role: SCOPE_ROLES[where.scope] }
            : schedule.role
              ? { role: schedule.role }
              : {}),
          ...(schedule.worker ? { worker: schedule.worker } : {}),
          start: {
            ...(schedule.model ? { model: schedule.model } : {}),
            ...(schedule.effort ? { effort: schedule.effort } : {}),
          },
          scheduledBy: { scheduleId: schedule.id, runId, dueAt },
        });
        if (!created.ok) throw Error(created.error);
        const threadId = created.thread.id;
        made(threadId);
        const accepted = turns.accept({
          threadId,
          payload: `Scheduled run of ${JSON.stringify(schedule.name)}, as the owner set it:\n\n${schedule.prompt}`,
          origin: {
            member: { kind: 'local', id: `schedule:${schedule.id}` },
            displayName: schedule.name,
            postId: runId,
            schedule: true,
          },
        });
        if (!accepted.ok)
          throw Object.assign(Error(`its first turn was refused: ${String(accepted.body.error)}`), {
            threadId,
          });
        return threadId;
      },
    });
    scheduler = schedules;
    registerScheduleRoutes(app, schedules);
    // An agent's draft asks the owner on the thread that proposed it (Accept or Reject).
    const asks = config.actionQueue
      ? new DraftAsks({
          scheduler: schedules,
          queue: config.actionQueue,
          live: (threadId) => {
            const thread = directory.get(threadId);
            return !!thread && !thread.disposed && thread.meta.status !== 'archived';
          },
          log: (line) => console.warn(line),
        })
      : undefined;
    draftAsks = asks;
    // Any settings edit (the owner's, an agent's, a file reload) may change a schedule.
    const unsubscribe = configStore.onChange(() => {
      streams.schedulesChanged();
      asks?.reconcile();
    });
    localStore.onClose(() => {
      unsubscribe();
      asks?.close();
    });
  }
  registerDaemonUpdateRoutes(
    app,
    restartRoll,
    (threadId) => {
      const thread = directory.get(threadId);
      return thread ? threadTitle(thread.meta)?.text : undefined;
    },
    configDir,
  );
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
      joining: () => configStore.config.conversations,
      hosted: () => kingdom.hostedSignets(),
      subscriptions: () => kingdom.threadSubscriptions(),
      events: eventStream,
      deliverPost: kingdomPostDelivery(config.tools),
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
      gatesEachCall: (thread) =>
        !config.threadFactory?.runtime?.sessionAdapter(thread.meta.worker)?.structuralRulesAtLaunch,
    });
    // Owner-only like the conversation controls: secrets are used only in a turn the owner's own message opened.
    const service = conversations;
    secrets.ownerInstructed = (threadId) => service.ownerInstructed(threadId);
    secrets.ownerSet = (threadId) => service.ownerSet(threadId);
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
  registerMachineProcessRoutes(app, {
    ...(config.decisionHosts ? { hosts: config.decisionHosts } : {}),
    projectLabel: (projectId) => configStore.config.projects?.[projectId]?.label,
    ...(config.sessionBindings ? { sessionBindings: config.sessionBindings } : {}),
    threadName: (threadId) => directory.get(threadId)?.meta.name?.text,
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
    configDir: config.configDir ?? '.foundry',
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

  // The browser reads Warden call outcomes with core's own import-free module.
  app.get('/ui/call-outcome-core.js', async (c) =>
    c.body(
      new Bun.Transpiler({ loader: 'ts' }).transformSync(
        await Bun.file(
          new URL(import.meta.resolve('@inixiative/foundry-core/call-outcome')),
        ).text(),
      ),
      200,
      { 'Content-Type': 'application/javascript' },
    ),
  );
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
  // The browser mints ids with the same uuidv7 package the daemon does; it ships as one import-free ES module.
  app.get('/ui/uuidv7.js', async (c) =>
    c.body(await Bun.file(new URL(import.meta.resolve('uuidv7'))).text(), 200, {
      'Content-Type': 'application/javascript',
    }),
  );
  // Agent text is Markdown (ui/markdown.js): marked ships one import-free ES module.
  app.get('/ui/marked.js', async (c) =>
    c.body(await Bun.file(new URL(import.meta.resolve('marked'))).text(), 200, {
      'Content-Type': 'application/javascript',
    }),
  );
  // Mermaid's ES build and its relative chunks, loaded only when a message holds a diagram.
  const mermaidDir = dirname(
    fileURLToPath(import.meta.resolve('mermaid/dist/mermaid.esm.min.mjs')),
  );
  app.get('/ui/mermaid/*', async (c) => {
    const file = resolve(mermaidDir, c.req.path.slice('/ui/mermaid/'.length));
    if (!file.startsWith(`${mermaidDir}${sep}`) || !file.endsWith('.mjs')) return c.notFound();
    const body = Bun.file(file);
    if (!(await body.exists())) return c.notFound();
    return new Response(body, { headers: { 'Content-Type': 'application/javascript' } });
  });
  // The look is @inixiative/config's shared theme (`theme-files.ts`).
  const themeDir = themeDirectory();
  app.get(
    `${THEME_PATH_PREFIX}*`,
    async (c) => (themeDir ? await themeFile(themeDir, c.req.path) : undefined) ?? c.notFound(),
  );
  // Personal custom themes and local extensions under `<configDir>/ui/` (strictly contained).
  app.get('/api/ui/custom', async (c) => c.json(await discoverCustomUi(configDir)));
  app.get(`${CUSTOM_UI_PATH_PREFIX}theme.css`, async () => {
    const saved = await configStore.load();
    return customThemeCss(configDir, saved.ui?.theme);
  });
  app.get(`${CUSTOM_UI_PATH_PREFIX}*`, async (c) => {
    const res = await customUiFile(configDir, c.req.path, c.req.raw.url);
    return res ?? c.notFound();
  });
  app.get('/ui/*', serveStatic({ root: fileURLToPath(new URL('./', import.meta.url)) }));
  app.get(
    '/kingdom',
    serveStatic({ root: fileURLToPath(new URL('./', import.meta.url)), path: 'ui/kingdom.html' }),
  );
  // The daemon's status page: the same file the supervisor serves while no release is booted.
  app.get(
    '/status',
    serveStatic({ root: fileURLToPath(new URL('./', import.meta.url)), path: 'ui/status.html' }),
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
  // Due schedules start their runs; a tick that overruns the next is not doubled (Scheduler.tick).
  const schedulerWatch = makeUnrefInterval({
    intervalMs: 15_000,
    tick: () => void scheduler?.tick().catch((error) => console.warn(`[Scheduler] ${error}`)),
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
  kingdom.serveViewer(
    {
      request: (request) => {
        viaKingdom.add(request);
        return app.fetch(request);
      },
      socket: async (request, peer) => {
        if (new URL(request.url).pathname !== '/ws' || !sameOrigin(request)) return null;
        try {
          await kingdom.check();
        } catch {
          return null;
        }
        return socket.acceptPeer(request, peer);
      },
    },
    () => configStore.config.kingdomViewerRefused ?? [],
  );

  // One gate per thread: an approval at pre-use must answer the native ask for the same call.
  const gates = new Map<string, ThreadToolGate>();
  const watched = new WeakSet<object>();
  // A disposed thread drops its gate and what hosts chose for it (client MCP env/headers are secrets);
  // an archived one also ends its native processes, keeping their bindings so reopening resumes.
  const forgetOnDispose = (thread: {
    id: string;
    meta: { status?: string };
    onDispose(fn: () => void): () => void;
  }) => {
    if (watched.has(thread)) return;
    watched.add(thread);
    thread.onDispose(() => {
      gates.delete(thread.id);
      threadLaunch.clear(thread.id);
      if (thread.meta.status === 'archived') void config.workerSessions?.release(thread.id);
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
      // Each other party the turn took in brings its own rules (CONVERSATIONS §4.12).
      actors: (turnId) =>
        turnId && conversations
          ? conversations
              .turnActors(threadId, turnId)
              .flatMap(({ member, displayName, permissions }) => {
                const rules = actRules(conversationActLevel(permissions));
                const root = thread.meta.cwd;
                return rules
                  ? [
                      {
                        label: displayName,
                        key: memberKey(member),
                        rules,
                        ...(root ? { readRoot: root } : {}),
                      },
                    ]
                  : [];
              })
          : [],
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
    // A call the gate allows meets the thread's chorus before it runs (Claude's pre-use): a handoff is
    // briefed so the chimes ride into what the subagent reads; a milestone gets advice beside the call.
    const briefed = withChorusAtCall(
      gate,
      {
        brief: (call) => config.threadFactory?.runtime?.get(threadId)?.briefHandoff(call),
        milestone: (call) => config.threadFactory?.runtime?.get(threadId)?.adviseMilestone(call),
      },
      {
        turnId: () => turns.runningTurn(threadId),
        warn: (line) => console.warn(`[Gate] ${threadId}: ${line}`),
      },
    );
    // A member's `act` is no launch rule: a worker that can't ask per call never takes their posts.
    const bound: ThreadToolGate = { gate: briefed, hasRules: () => enforces(rules()) };
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
    /** The feedback lifecycle: a Feedback thread's inbox tools reach it. */
    feedback,
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
      schedules:
        scheduler && conversations
          ? {
              scheduler,
              ownerInstructed: (threadId: string) =>
                conversations?.ownerInstructed(threadId) ?? false,
            }
          : undefined,
      artifacts: localStore
        ? {
            write(thread: Thread, record: ArtifactVersionRecord) {
              const turnId = turnsReady?.runningTurn(thread.id) ?? null;
              localStore.appendPhase(thread, {
                id: artifactVersionId(thread.id, record.id, record.version),
                phase: ARTIFACT_PHASE,
                turnId,
                dispatchId: null,
                record: record as unknown as Record<string, unknown>,
              });
              return { turnId };
            },
            latest(threadId: string, artifactId: string) {
              const rows = localStore.phasesOf(threadId, ARTIFACT_PHASE, {
                key: 'id',
                value: artifactId,
              });
              return rows.at(-1)?.record as unknown as ArtifactVersionRecord | undefined;
            },
          }
        : undefined,
    } satisfies ThreadRecords,
    startSocket() {
      socket.startStaleSweep();
      kingdomWatch.start();
      snoozeWatch.start();
      schedulerWatch.start();
      // Once at start too: a run missed while Foundry was off starts now, not a tick later.
      void scheduler?.tick().catch((error) => console.warn(`[Scheduler] ${error}`));
      draftAsks?.reconcile();
    },
    stopSocket() {
      kingdomWatch.stop();
      snoozeWatch.stop();
      schedulerWatch.stop();
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
    // The supervisor holds the port with its status page until this moment (`daemon/port-handoff.ts`).
    await releaseHeldPort();
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

  // why: boot never waits on the tunnel's provider
  tunnelHolder.tunnel?.keepUp(() => tunnelHolder.changed?.());

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
    feedback: viewer.feedback,
  };
}

/** Paths served by the client-routed app; ui/route.js parses the same shapes. */
function isPage(path: string): boolean {
  return (
    path === '/' ||
    /^\/(settings|analytics)(\/|$)/.test(path) ||
    /^\/projects\/[^/]+\/(settings|analytics)(\/|$)/.test(path)
  );
}
