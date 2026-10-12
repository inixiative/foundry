import { isAbsolute } from 'node:path';
import {
  type AgentContext,
  agent,
  type InitializeResponse,
  type PermissionOption,
  PROTOCOL_VERSION,
  RequestError,
  type SessionUpdate,
  type StopReason,
} from '@agentclientprotocol/sdk';
import {
  type AcpLaunch,
  type ActionPrompt,
  acpLaunchPath,
  DataStreamClient,
  defaultAcpLaunchPath,
  FoundryClient,
  FoundryHttpError,
  readAcpLaunch,
  type StreamBufferSnapshot,
  startDaemon,
  type ThreadJSON,
  type ThreadLaunchPatch,
  type ThreadLaunchView,
  type TurnAppend,
} from '@inixiative/foundry/client';
import { promptText } from './prompt';
import {
  clientMcpServers,
  configOptions,
  DEFAULT_MODE,
  MODES,
  modeState,
  replayHistory,
} from './session-state';
import { toolKind, toolTitle } from './tools';
import { TurnFailedError, TurnProjection } from './turn';

export interface FoundryAgentOptions {
  /** ACP launch file; default `FOUNDRY_ACP_LAUNCH` or `~/.foundry/acp-launch.json`. */
  launchPath?: string;
  /** Starts the daemon when it is down. Default: launchd, and only for the daemon's own launch path. */
  startDaemon?: () => Promise<unknown>;
  /** How long to wait for a started daemon to answer. */
  daemonWaitMs?: number;
  /** How long in-flight turns wait for an unreachable daemon before they fail. */
  daemonLostMs?: number;
  version?: string;
  log?: (message: string) => void;
}

interface Session {
  readonly threadId: string;
  cwd: string;
  readonly turns: Map<string, TurnProjection>;
  /** Updates go out one at a time, in order, before the prompt they belong to answers. */
  outbox: Promise<void>;
  /** This session's thread and flow streams on a socket: shared by every request that needs them. */
  holding: { streams: DataStreamClient; ready: Promise<void> } | null;
  /** What this host chose (mode, model, effort, MCP servers), re-applied to a restarted daemon. */
  launch: ThreadLaunchPatch;
  /** The daemon socket the launch was last applied through. */
  launchedOn: DataStreamClient | null;
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow in this session', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Always reject in this session', kind: 'reject_always' },
];

const COMMANDS = [
  {
    name: 'correction',
    description: 'Tell Foundry what the last turn should have done; it learns from the correction',
    input: { hint: 'what should have happened' },
  },
];

interface Daemon {
  launch: AcpLaunch;
  http: FoundryClient;
  readonly streams: DataStreamClient;
}

const DAEMON_LOST_MS = 30_000;

type ThreadPayload =
  | TurnAppend
  | { kind: 'event' }
  | { kind: 'done' | 'error'; turnId: string; result: Record<string, unknown> };

const isNetworkFailure = (error: unknown) => !(error instanceof FoundryHttpError);

/**
 * Foundry as an ACP v1 agent. Every ACP session is a Foundry thread (`sessionId` = thread id),
 * and every prompt is a turn on the local daemon's one turn path, so the middleware runs on it
 * exactly as on a viewer turn. This process holds no thread, context or middleware of its own.
 */
export function createFoundryAgent(options: FoundryAgentOptions = {}) {
  const launchPath = options.launchPath ?? acpLaunchPath();
  // launchd owns only the daemon that publishes the default launch file; any other path is someone else's Foundry.
  const start =
    options.startDaemon ?? (launchPath === defaultAcpLaunchPath() ? startDaemon : undefined);
  const log =
    options.log ?? ((message: string) => process.stderr.write(`foundry-acp: ${message}\n`));
  const sessions = new Map<string, Session>();
  let daemon: Daemon | null = null;
  let connecting: Promise<Daemon> | null = null;
  let client: AgentContext | null = null;
  let clientName = 'unknown';

  const lostMs = options.daemonLostMs ?? DAEMON_LOST_MS;
  const lose = () => {
    for (const session of sessions.values())
      for (const turn of session.turns.values())
        turn.lost(
          `Lost the connection to the Foundry daemon for ${lostMs / 1000}s; the turn's outcome is in its thread journal.`,
        );
  };

  const attach = async (): Promise<Daemon> => {
    const launch = readAcpLaunch(launchPath);
    const http = new FoundryClient(launch);
    await http.health().catch((error) => {
      // An unhealthy daemon still answers; only an unreachable one is down.
      if (isNetworkFailure(error)) throw error;
    });
    // Same daemon origin: the socket re-reads the bearer whenever it reconnects.
    if (daemon && daemon.launch.endpoint === launch.endpoint) {
      daemon.launch = launch;
      daemon.http = http;
      return daemon;
    }
    daemon?.streams.dispose();
    let lostTimer: ReturnType<typeof setTimeout> | undefined;
    const streams = new DataStreamClient({
      endpoint: launch.endpoint,
      capability: launch.capability,
      refreshCapability: () => {
        try {
          return readAcpLaunch(launchPath).capability;
        } catch {
          return undefined;
        }
      },
      onStatus: (state) => {
        if (state === 'open') {
          clearTimeout(lostTimer);
          lostTimer = undefined;
        } else if (state === 'closed' && daemon?.streams === streams) {
          log('daemon socket dropped; reconnecting');
          // Only the socket in use can lose turns; a replaced one is disposed and ignored.
          lostTimer ??= setTimeout(() => {
            if (daemon?.streams === streams) lose();
          }, lostMs);
        }
      },
    });
    await streams.connect();
    const attached: Daemon = { launch, http, streams };
    daemon = attached;
    // Permission asks for this host's threads: the viewer and the host both see them, first answer wins.
    await streams
      .open('prompts', {
        snapshot: (payload) => {
          for (const prompt of (payload as { prompts?: ActionPrompt[] }).prompts ?? [])
            permission(prompt);
        },
        append: (payload) => {
          const prompt = (payload as { prompt?: ActionPrompt }).prompt;
          if (prompt) permission(prompt);
        },
      })
      .catch((error) => log(`prompts stream unavailable: ${(error as Error).message}`));
    // Sessions with turns in flight follow the daemon to its new origin.
    for (const session of sessions.values()) if (session.turns.size) await hold(session, attached);
    return attached;
  };

  /** The running daemon, started through launchd when it is down. */
  const ensureDaemon = (): Promise<Daemon> => {
    connecting ??= (async () => {
      try {
        return await attach();
      } catch (first) {
        if (!start)
          throw RequestError.internalError(
            { launchPath },
            `Foundry is not reachable through ${launchPath}: ${(first as Error).message}`,
          );
        log(`daemon unavailable (${(first as Error).message}); starting it`);
        await start();
        const deadline = Date.now() + (options.daemonWaitMs ?? 60_000);
        let last = first;
        while (Date.now() < deadline) {
          await Bun.sleep(250);
          try {
            return await attach();
          } catch (error) {
            last = error;
          }
        }
        throw RequestError.internalError(
          { launchPath },
          `Foundry daemon did not start: ${(last as Error).message}`,
        );
      }
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  };

  const httpError = (error: unknown): never => {
    if (error instanceof RequestError) throw error;
    if (error instanceof FoundryHttpError) {
      const recovery =
        typeof error.body.recoveryUrl === 'string' && daemon
          ? ` Reconnect at ${daemon.launch.endpoint.replace('127.0.0.1', 'localhost')}${error.body.recoveryUrl}`
          : '';
      throw RequestError.internalError(error.body, `Foundry: ${error.message}.${recovery}`);
    }
    throw RequestError.internalError(undefined, `Foundry: ${(error as Error).message}`);
  };

  const send = (session: Session, update: SessionUpdate) => {
    const target = client;
    if (!target) return;
    session.outbox = session.outbox
      .then(() => target.notify('session/update', { sessionId: session.threadId, update }))
      .catch((error) => log(`session/update failed: ${(error as Error).message}`));
  };

  /** Hold the session's thread and flow streams; every live turn of the session reads them. */
  const hold = (session: Session, foundry: Daemon): Promise<void> => {
    if (session.holding?.streams === foundry.streams) return session.holding.ready;
    const ready = openStreams(session, foundry)
      .then(() => relaunch(session, foundry))
      .catch((error) => {
        if (session.holding?.ready === ready) session.holding = null;
        throw error;
      });
    session.holding = { streams: foundry.streams, ready };
    return ready;
  };

  const openStreams = async (session: Session, foundry: Daemon) => {
    const forTurn = (turnId: string) => session.turns.get(turnId);
    await foundry.streams.open(`thread:${session.threadId}`, {
      snapshot: (payload) => {
        const turns = (payload as { turns?: StreamBufferSnapshot[] }).turns ?? [];
        for (const turn of session.turns.values())
          turn.snapshot(turns.find((t) => t.messageId === turn.turnId));
      },
      append: (payload) => {
        const frame = payload as ThreadPayload;
        if (frame.kind === 'event') return;
        if (frame.kind === 'turn') return forTurn(frame.turn.messageId)?.snapshot(frame.turn);
        if (frame.kind === 'delta') return forTurn(frame.turnId)?.delta(frame.text);
        if (frame.kind === 'activity')
          return forTurn(frame.turnId)?.activity(frame.row, frame.appended);
        forTurn(frame.turnId)?.terminal(frame.kind, frame.result);
      },
      rejected: () => {
        session.holding = null;
        for (const turn of session.turns.values())
          turn.lost('Foundry no longer holds this thread (the daemon restarted without it).');
      },
    });
    await foundry.streams.open(`flow:${session.threadId}`, {
      snapshot: (payload) => {
        for (const flowTurn of (payload as { turns?: unknown[] }).turns ?? [])
          for (const turn of session.turns.values()) turn.flowTurn(flowTurn);
      },
      append: (payload) => {
        const frame = payload as { kind?: string; turn?: unknown };
        if (frame.kind !== 'turn') return;
        for (const turn of session.turns.values()) turn.flowTurn(frame.turn);
      },
    });
  };

  /** Apply a host's launch choice to the daemon and remember it for a restarted daemon. */
  const applyLaunch = async (
    session: Session,
    foundry: Daemon,
    patch: ThreadLaunchPatch,
  ): Promise<ThreadLaunchView> => {
    const view = await foundry.http.updateLaunch(session.threadId, patch);
    session.launch = { ...session.launch, ...patch };
    session.launchedOn = foundry.streams;
    return view;
  };

  /** A daemon that restarted lost what this host chose; apply it again. */
  const relaunch = async (session: Session, foundry: Daemon) => {
    if (session.launchedOn === foundry.streams || !Object.keys(session.launch).length) return;
    await applyLaunch(session, foundry, session.launch).catch((error) =>
      log(`launch settings not re-applied: ${(error as Error).message}`),
    );
  };

  /** Mode and config for a session response; an ACP session without a mode starts in the host default. */
  const sessionSetup = async (session: Session, foundry: Daemon, patch: ThreadLaunchPatch) => {
    let view = await applyLaunch(session, foundry, patch);
    if (!view.permissionMode)
      view = await applyLaunch(session, foundry, { permissionMode: DEFAULT_MODE });
    session.launch.permissionMode = view.permissionMode as ThreadLaunchPatch['permissionMode'];
    setTimeout(
      () =>
        send(session, { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS }),
      0,
    );
    return { modes: modeState(view), configOptions: configOptions(view) };
  };

  // Outstanding `session/request_permission` calls by prompt id; aborted when someone else answers.
  const asking = new Map<string, { controller: AbortController; threadId: string }>();
  const permission = (prompt: ActionPrompt) => {
    const session = sessions.get(prompt.threadId);
    // Only the tool gate's approval asks belong to the host.
    if (!session || prompt.kind !== 'approval' || typeof prompt.meta?.toolName !== 'string') return;
    if (prompt.status !== 'pending') {
      asking.get(prompt.id)?.controller.abort();
      return;
    }
    const target = client;
    const foundry = daemon;
    if (asking.has(prompt.id) || !target || !foundry) return;
    const controller = new AbortController();
    asking.set(prompt.id, { controller, threadId: session.threadId });
    const meta = prompt.meta ?? {};
    const toolName = typeof meta.toolName === 'string' ? meta.toolName : 'Tool';
    const rawInput = meta.toolInput as Record<string, unknown> | undefined;
    const callId = typeof meta.callId === 'string' ? meta.callId : undefined;
    let toolCallId = [...session.turns.values()]
      .map((turn) => turn.toolCallFor(callId))
      .find(Boolean);
    const title = toolTitle(toolName, rawInput);
    if (!toolCallId) {
      toolCallId = `foundry-gate:${prompt.id}`;
      send(session, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title,
        kind: toolKind(toolName),
        status: 'pending',
        ...(rawInput ? { rawInput } : {}),
      });
    }
    const call = toolCallId;
    void session.outbox
      .then(() =>
        target.request(
          'session/request_permission',
          {
            sessionId: session.threadId,
            toolCall: { toolCallId: call, title, kind: toolKind(toolName), status: 'pending' },
            options: PERMISSION_OPTIONS,
            _meta: { foundry: { promptId: prompt.id, capability: prompt.capability ?? null } },
          },
          { cancellationSignal: controller.signal },
        ),
      )
      .then((response) => {
        const outcome = response.outcome;
        const option = outcome.outcome === 'selected' ? outcome.optionId : 'reject_once';
        const allowed = option.startsWith('allow');
        // A card Foundry opened for the ask settles with the answer.
        if (call.startsWith('foundry-gate:'))
          send(session, {
            sessionUpdate: 'tool_call_update',
            toolCallId: call,
            status: allowed ? 'completed' : 'failed',
          });
        return foundry.http.resolvePrompt(
          prompt.id,
          allowed ? 'approved' : 'rejected',
          option.endsWith('always'),
        );
      })
      .catch((error) => {
        // Answered elsewhere first, or withdrawn: nothing to resolve. Otherwise the host could not
        // answer (an error, or the connection closed): reject it so the turn is not left waiting.
        if (controller.signal.aborted) return;
        log(`permission ${prompt.id}: ${(error as Error).message}`);
        void foundry.http.resolvePrompt(prompt.id, 'rejected').catch(() => {});
      })
      .finally(() => asking.delete(prompt.id));
  };

  /** `/correction <text>`: a correction against the session's last turn, into feedback capture. */
  const correct = async (session: Session, foundry: Daemon, body: string): Promise<string> => {
    if (!body) return 'Usage: /correction <what the last turn should have done>';
    const page = await foundry.http.history(session.threadId);
    const last = [...page.messages].reverse().find((m) => m.actor === 'agent' && m.traceId);
    if (!last?.traceId) return 'Nothing to correct yet: this session has no recorded turn.';
    const detail = (await foundry.http.turnDetail(session.threadId, last.turnId)) as {
      trace?: { spans?: Array<{ id?: string; kind?: string }> } | null;
    };
    const span =
      detail.trace?.spans?.findLast((s) => s.kind === 'execute') ?? detail.trace?.spans?.[0];
    await foundry.http.intervene(session.threadId, {
      traceId: last.traceId,
      spanId: span?.id ?? last.traceId,
      correction: body,
      reason: `correction typed in ${clientName} over ACP`,
      operator: `acp:${clientName}`,
    });
    return 'Correction recorded. Foundry will learn from it.';
  };

  const bind = async (thread: ThreadJSON, cwd: string): Promise<Session> => {
    const foundry = await ensureDaemon();
    const existing = sessions.get(thread.threadId);
    const session: Session = existing ?? {
      threadId: thread.threadId,
      cwd,
      turns: new Map(),
      outbox: Promise.resolve(),
      holding: null,
      launch: {},
      launchedOn: null,
    };
    session.cwd = cwd;
    sessions.set(thread.threadId, session);
    await hold(session, foundry);
    // Asks raised before this host bound the session (a host restart mid-turn) still reach it.
    void foundry.http
      .prompts(thread.threadId)
      .then(({ prompts }) => {
        for (const prompt of prompts) if (prompt.status === 'pending') permission(prompt);
      })
      .catch((error) => log(`pending prompts unavailable: ${(error as Error).message}`));
    return session;
  };

  const sessionFor = (sessionId: string): Session => {
    const session = sessions.get(sessionId);
    if (!session)
      throw RequestError.invalidParams({ sessionId }, 'Unknown session; resume it first');
    return session;
  };

  return agent({ name: 'foundry' })
    .onConnect((connection) => {
      client = connection.client;
      void connection.closed.then(async () => {
        // Nobody is left to answer this host's open asks: reject them so their turns can proceed.
        const foundry = daemon;
        await Promise.all(
          [...asking.keys()].map((promptId) =>
            foundry?.http.resolvePrompt(promptId, 'rejected').catch(() => {}),
          ),
        );
        daemon?.streams.dispose();
        daemon = null;
      });
    })
    .onRequest('initialize', async (ctx): Promise<InitializeResponse> => {
      clientName = ctx.params.clientInfo?.name?.trim() || 'unknown';
      await ensureDaemon().catch(httpError);
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'foundry', title: 'Foundry', version: options.version ?? '0.1.0' },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {} },
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: false },
        },
        authMethods: [],
      };
    })
    .onRequest('session/new', async (ctx) => {
      const foundry = await ensureDaemon().catch(httpError);
      const thread = await foundry.http
        .createThread({ cwd: ctx.params.cwd, tags: ['acp', `acp:${clientName}`] })
        .catch(httpError);
      const session = await bind(thread, ctx.params.cwd);
      const setup = await sessionSetup(session, foundry, {
        permissionMode: DEFAULT_MODE,
        mcpServers: clientMcpServers(ctx.params.mcpServers),
      }).catch(httpError);
      return {
        sessionId: thread.threadId,
        ...setup,
        _meta: { foundry: { threadId: thread.threadId, projectId: thread.meta.projectId ?? null } },
      };
    })
    .onRequest('session/load', async (ctx) => {
      const foundry = await ensureDaemon().catch(httpError);
      let thread = await foundry.http.thread(ctx.params.sessionId).catch(httpError);
      if (isAbsolute(ctx.params.cwd) && thread.meta.cwd !== ctx.params.cwd)
        thread = await foundry.http
          .updateThread(thread.threadId, { worktreePath: ctx.params.cwd })
          .catch(httpError);
      const session = await bind(thread, ctx.params.cwd);
      const setup = await sessionSetup(session, foundry, {
        mcpServers: clientMcpServers(ctx.params.mcpServers),
      }).catch(httpError);
      // The history goes out before the response.
      for (const update of await replayHistory(foundry.http, thread.threadId, ctx.params.cwd).catch(
        httpError,
      ))
        send(session, update);
      await session.outbox;
      return setup;
    })
    .onRequest('session/resume', async (ctx) => {
      const foundry = await ensureDaemon().catch(httpError);
      let thread = await foundry.http.thread(ctx.params.sessionId).catch(httpError);
      if (isAbsolute(ctx.params.cwd) && thread.meta.cwd !== ctx.params.cwd)
        thread = await foundry.http
          .updateThread(thread.threadId, { worktreePath: ctx.params.cwd })
          .catch(httpError);
      const session = await bind(thread, ctx.params.cwd);
      return sessionSetup(session, foundry, {
        mcpServers: clientMcpServers(ctx.params.mcpServers),
      }).catch(httpError);
    })
    .onRequest('session/set_mode', async (ctx) => {
      const session = sessionFor(ctx.params.sessionId);
      if (!MODES.some((mode) => mode.id === ctx.params.modeId))
        throw RequestError.invalidParams({ modeId: ctx.params.modeId }, 'Unknown mode');
      const foundry = await ensureDaemon().catch(httpError);
      const view = await applyLaunch(session, foundry, {
        permissionMode: ctx.params.modeId as ThreadLaunchPatch['permissionMode'],
      }).catch(httpError);
      send(session, {
        sessionUpdate: 'current_mode_update',
        currentModeId: modeState(view).currentModeId,
      });
      return {};
    })
    .onRequest('session/set_config_option', async (ctx) => {
      const session = sessionFor(ctx.params.sessionId);
      const value = 'value' in ctx.params ? ctx.params.value : undefined;
      if (typeof value !== 'string')
        throw RequestError.invalidParams(
          { configId: ctx.params.configId },
          'Expected a select value',
        );
      const patch: ThreadLaunchPatch =
        ctx.params.configId === 'model'
          ? { model: value }
          : ctx.params.configId === 'effort'
            ? { effort: value === 'default' ? null : (value as ThreadLaunchPatch['effort']) }
            : (() => {
                throw RequestError.invalidParams(
                  { configId: ctx.params.configId },
                  'Unknown config option',
                );
              })();
      const foundry = await ensureDaemon().catch(httpError);
      const view = await applyLaunch(session, foundry, patch).catch(httpError);
      return { configOptions: configOptions(view) };
    })
    .onRequest('session/prompt', async (ctx): Promise<{ stopReason: StopReason }> => {
      const session = sessionFor(ctx.params.sessionId);
      const foundry = await ensureDaemon().catch(httpError);
      await hold(session, foundry).catch(httpError);
      const text = promptText(ctx.params.prompt);
      const correction = /^\/correction(?:\s+([\s\S]*))?$/.exec(text.trim());
      if (correction) {
        const reply = await correct(session, foundry, correction[1]?.trim() ?? '').catch(
          (error) => `Correction not recorded: ${(error as Error).message}`,
        );
        send(session, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: reply },
        });
        await session.outbox;
        return { stopReason: 'end_turn' };
      }
      const turnId = `turn_${crypto.randomUUID()}`;
      const turn = new TurnProjection(
        turnId,
        session.threadId,
        (update) => send(session, update),
        session.cwd,
        () => foundry.http.turnDetail(session.threadId, turnId),
      );
      session.turns.set(turnId, turn);
      try {
        turn.open();
        try {
          await foundry.http.send({
            threadId: session.threadId,
            id: turnId,
            message: text,
            clientId: foundry.streams.clientId,
          });
          turn.accepted = true;
          // A cancel that arrived while the send was in flight could not name an accepted turn.
          if (turn.cancelRequested)
            void foundry.http
              .interrupt(session.threadId, turnId)
              .catch((error) => log(`interrupt ${turnId}: ${(error as Error).message}`));
        } catch (error) {
          turn.abort(error as Error);
        }
        const stopReason = await turn.done.catch((error) => {
          if (error instanceof TurnFailedError)
            throw RequestError.internalError(
              { threadId: session.threadId, turnId },
              `Foundry turn failed: ${error.message}`,
            );
          return httpError(error);
        });
        return { stopReason };
      } finally {
        await session.outbox;
        session.turns.delete(turnId);
      }
    })
    .onNotification('session/cancel', async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session || !daemon) return;
      const foundry = daemon;
      // A cancelled turn's open asks are withdrawn and their prompts rejected.
      for (const [promptId, { controller, threadId }] of asking) {
        if (threadId !== session.threadId) continue;
        controller.abort();
        void foundry.http.resolvePrompt(promptId, 'rejected').catch(() => {});
      }
      await Promise.all(
        [...session.turns.values()]
          .filter((turn) => !turn.isSettled)
          .map((turn) => {
            turn.cancelRequested = true;
            if (!turn.accepted) return undefined;
            return foundry.http
              .interrupt(session.threadId, turn.turnId)
              .catch((error) => log(`interrupt ${turn.turnId}: ${(error as Error).message}`));
          }),
      );
    });
}
