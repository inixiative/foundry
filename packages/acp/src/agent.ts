import { isAbsolute } from 'node:path';
import {
  type AgentContext,
  agent,
  type InitializeResponse,
  type PermissionOption,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionResponse,
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
  isModeId,
  MODES,
  type ModeId,
  modeState,
  replayHistory,
} from './session-state';
import { toolKind, toolLocations, toolTitle } from './tools';
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
  /**
   * The mode the host's configuration gives every session it opens (`--permission-mode`), for
   * hosts that keep their own permission policy to themselves. A mode the host sets on the
   * session wins; without either, a session starts in `default`.
   */
  permissionMode?: string;
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
  /** The daemon socket the launch was last applied through; null once that daemon may have lost it. */
  launchedOn: DataStreamClient | null;
  /** Prompts still connecting (daemon start, stream hold): a cancel marks them so they never send. */
  readonly connecting: Set<{ cancelled: boolean }>;
  /** Launch changes reach the daemon one at a time, in order, so a re-apply never overwrites a newer choice. */
  launching: Promise<unknown>;
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
  {
    name: 'feedback',
    description:
      'Your feedback and where it went; apply, edit or dismiss one: /feedback apply <id>',
    input: { hint: 'all | apply <id> | dismiss <id> | later <id> | edit <id> <rule>' },
  },
];

/** A feedback tuning prompt: its item and the three lines it shows. */
interface FeedbackMeta {
  itemId: string;
  blocking: boolean;
  shown: { happened: string; did: string; intend: string };
}
const feedbackMeta = (prompt: ActionPrompt): FeedbackMeta | undefined => {
  const meta = prompt.meta?.feedback as FeedbackMeta | undefined;
  return meta && typeof meta.itemId === 'string' ? meta : undefined;
};

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

/** The listener is the daemon the launch file names (asked without the bearer), or this throws. */
async function identify(http: FoundryClient, launch: AcpLaunch): Promise<void> {
  if (!processAlive(launch.pid))
    throw Error(`stale launch file: daemon process ${launch.pid} is not running`);
  const pid = await http.daemonPid();
  if (pid !== launch.pid)
    throw Error(
      `the process on ${launch.endpoint} is not the daemon that wrote the launch file (pid ${pid ?? 'unknown'}, expected ${launch.pid})`,
    );
}

/** Whether a process exists (a permission error still means it does). */
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Foundry as an ACP v1 agent. Every ACP session is a Foundry thread (`sessionId` = thread id),
 * and every prompt is a turn on the local daemon's one turn path, so the middleware runs on it
 * exactly as on a viewer turn. This process holds no thread, context or middleware of its own.
 */
export function createFoundryAgent(options: FoundryAgentOptions = {}) {
  if (options.permissionMode !== undefined && !isModeId(options.permissionMode))
    throw Error(
      `Unknown permission mode ${options.permissionMode}; expected one of ${MODES.map((mode) => mode.id).join(', ')}`,
    );
  const hostMode: ModeId = options.permissionMode ?? DEFAULT_MODE;
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
    // A launch file whose daemon is gone is stale: whatever listens on its port now is not Foundry's daemon.
    const http = new FoundryClient(launch);
    await identify(http, launch);
    // The same daemon instance: the socket re-reads the bearer whenever it reconnects.
    if (
      daemon &&
      daemon.launch.endpoint === launch.endpoint &&
      daemon.launch.pid === launch.pid &&
      daemon.launch.createdAt === launch.createdAt
    ) {
      daemon.launch = launch;
      daemon.http = http;
      return daemon;
    }
    // A new daemon instance (a restart, even on the same port) holds none of this host's launch settings.
    daemon?.streams.dispose();
    for (const session of sessions.values()) session.launchedOn = null;
    let lostTimer: ReturnType<typeof setTimeout> | undefined;
    let dropped = false;
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
      // A reconnect carries the bearer: only to the daemon the launch file names, at this origin.
      beforeReconnect: async () => {
        const current = readAcpLaunch(launchPath);
        if (current.endpoint !== launch.endpoint) throw Error('the daemon moved');
        await identify(new FoundryClient(current), current);
      },
      onStatus: (state) => {
        if (state === 'open') {
          clearTimeout(lostTimer);
          lostTimer = undefined;
          // Reconnected: the daemon may have restarted on the same port and lost every launch. The
          // next prompt re-applies it, after attach has identified the daemon.
          if (dropped && daemon?.streams === streams) {
            dropped = false;
            for (const session of sessions.values()) session.launchedOn = null;
          }
        } else if (state === 'closed' && daemon?.streams === streams) {
          dropped = true;
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
      .then(() =>
        // A failure here is retried, and then refused, by the prompt that needs it.
        relaunch(session, foundry).catch((error) =>
          log(`launch settings not re-applied: ${(error as Error).message}`),
        ),
      )
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

  /** One launch change at a time per session, in the order they were asked for. */
  const inLaunchOrder = <T>(session: Session, work: () => Promise<T>): Promise<T> => {
    const run = session.launching.then(work);
    session.launching = run.catch(() => {});
    return run;
  };

  /** Apply a host's launch choice to the daemon and remember it for a restarted daemon. */
  const applyLaunch = (
    session: Session,
    foundry: Daemon,
    patch: ThreadLaunchPatch,
  ): Promise<ThreadLaunchView> =>
    inLaunchOrder(session, async () => {
      const view = await foundry.http.updateLaunch(session.threadId, patch);
      session.launch = { ...session.launch, ...patch };
      session.launchedOn = foundry.streams;
      return view;
    });

  /** A daemon that restarted lost what this host chose; apply it again (the latest choice, in order). */
  const relaunch = (session: Session, foundry: Daemon): Promise<void> =>
    inLaunchOrder(session, async () => {
      if (session.launchedOn === foundry.streams || !Object.keys(session.launch).length) return;
      await foundry.http.updateLaunch(session.threadId, { ...session.launch });
      session.launchedOn = foundry.streams;
    });

  /**
   * Mode and config for a session response. A thread keeps its mode. An ACP thread with none (new,
   * or its mode lost to a daemon restart) takes the host's; a viewer thread with none keeps its
   * full access, because the host said nothing.
   */
  const sessionSetup = async (
    session: Session,
    foundry: Daemon,
    patch: ThreadLaunchPatch,
    thread: ThreadJSON,
  ) => {
    let view = await applyLaunch(session, foundry, patch);
    if (!view.permissionMode && thread.meta.tags.includes('acp'))
      view = await applyLaunch(session, foundry, { permissionMode: hostMode });
    if (view.permissionMode) session.launch.permissionMode = view.permissionMode as ModeId;
    setTimeout(
      () =>
        send(session, { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS }),
      0,
    );
    return { modes: modeState(view), configOptions: configOptions(view) };
  };

  // Outstanding `session/request_permission` calls by prompt id; aborted when someone else answers.
  const asking = new Map<
    string,
    { controller: AbortController; threadId: string; turnId: string | undefined }
  >();
  // Feedback cards shown per prompt id, so a settled prompt closes the card it opened.
  const feedbackCards = new Set<string>();
  /**
   * A feedback tuning prompt: always a "Foundry: feedback" card; a blocking one is also a permission
   * ask (Apply / Not a rule). A non-blocking one never opens a dialog: it is answered in the viewer
   * or with `/feedback`.
   */
  const feedbackPrompt = (session: Session, prompt: ActionPrompt, meta: FeedbackMeta) => {
    const toolCallId = `foundry-feedback:${prompt.id}`;
    if (prompt.status !== 'pending') {
      asking.get(prompt.id)?.controller.abort();
      if (!feedbackCards.delete(prompt.id)) return;
      const answer = prompt.resolution?.action ?? prompt.status;
      send(session, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: answer === 'dismiss' || prompt.status === 'expired' ? 'failed' : 'completed',
        content: [{ type: 'content', content: { type: 'text', text: `Answered: ${answer}` } }],
      });
      return;
    }
    if (feedbackCards.has(prompt.id)) return;
    feedbackCards.add(prompt.id);
    const text = [
      `What happened: ${meta.shown.happened}`,
      `What we did: ${meta.shown.did}`,
      `What we intend: ${meta.shown.intend}`,
      meta.blocking
        ? ''
        : `Answer with /feedback apply|edit|dismiss|later ${meta.itemId}, or in the Foundry viewer.`,
    ]
      .filter(Boolean)
      .join('\n');
    const card = {
      toolCallId,
      title: 'Foundry: feedback',
      kind: 'think' as const,
      status: 'pending' as const,
      content: [{ type: 'content' as const, content: { type: 'text' as const, text } }],
    };
    send(session, {
      sessionUpdate: 'tool_call',
      ...card,
      _meta: { foundry: { promptId: prompt.id, feedbackItemId: meta.itemId } },
    });
    const target = client;
    const foundry = daemon;
    if (!meta.blocking || !target || !foundry || asking.has(prompt.id)) return;
    const canApply = prompt.options?.some((option) => option.id === 'apply') ?? false;
    const controller = new AbortController();
    asking.set(prompt.id, { controller, threadId: session.threadId, turnId: undefined });
    void session.outbox
      .then(() =>
        target.request(
          'session/request_permission',
          {
            sessionId: session.threadId,
            toolCall: card,
            options: [
              ...(canApply
                ? [{ optionId: 'apply', name: 'Apply', kind: 'allow_once' as const }]
                : []),
              { optionId: 'dismiss', name: 'Not a rule', kind: 'reject_once' as const },
              { optionId: 'later', name: 'Later', kind: 'reject_once' as const },
            ],
            _meta: { foundry: { promptId: prompt.id, feedbackItemId: meta.itemId } },
          },
          { cancellationSignal: controller.signal },
        ),
      )
      .then((response) => {
        const outcome = (response as RequestPermissionResponse).outcome;
        const option = outcome.outcome === 'selected' ? outcome.optionId : 'later';
        return foundry.http.answerFeedback(meta.itemId, option, `acp:${clientName}`);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        log(`feedback ${prompt.id}: ${(error as Error).message}`);
        void foundry.http.answerFeedback(meta.itemId, 'later', `acp:${clientName}`).catch(() => {});
      })
      .finally(() => asking.delete(prompt.id));
  };

  const permission = (prompt: ActionPrompt) => {
    const session = sessions.get(prompt.threadId);
    const feedback = feedbackMeta(prompt);
    if (session && feedback) return feedbackPrompt(session, prompt, feedback);
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
    const meta = prompt.meta ?? {};
    asking.set(prompt.id, {
      controller,
      threadId: session.threadId,
      turnId: typeof meta.turnId === 'string' ? meta.turnId : undefined,
    });
    const toolName = typeof meta.toolName === 'string' ? meta.toolName : 'Tool';
    const rawInput = meta.toolInput as Record<string, unknown> | undefined;
    const callId = typeof meta.callId === 'string' ? meta.callId : undefined;
    let toolCallId = [...session.turns.values()]
      .map((turn) => turn.toolCallFor(callId))
      .find(Boolean);
    const title = toolTitle(toolName, rawInput);
    // Hosts answer by their own policy from the call's kind and paths (T3 confines edits to the workspace).
    const locations = toolLocations(rawInput, session.cwd);
    if (!toolCallId) {
      toolCallId = `foundry-gate:${prompt.id}`;
      send(session, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title,
        kind: toolKind(toolName),
        status: 'pending',
        ...(rawInput ? { rawInput } : {}),
        locations,
      });
    }
    const call = toolCallId;
    void session.outbox
      .then(() =>
        target.request(
          'session/request_permission',
          {
            sessionId: session.threadId,
            toolCall: {
              toolCallId: call,
              title,
              kind: toolKind(toolName),
              status: 'pending',
              ...(rawInput ? { rawInput } : {}),
              locations,
            },
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

  /** `/feedback`: list this thread's project feedback, or answer one item's pending tuning prompt. */
  const feedbackCommand = async (
    session: Session,
    foundry: Daemon,
    body: string,
  ): Promise<string> => {
    const [verb = 'list', itemId, ...rest] = body.split(/\s+/).filter(Boolean);
    if (verb === 'list' || verb === 'all') {
      const thread = await foundry.http.thread(session.threadId).catch(() => undefined);
      const { items } = await foundry.http.feedback(thread?.meta.projectId ?? undefined);
      if (!items.length) return 'No feedback captured yet.';
      const count = (attention: string) =>
        items.filter((item) => item.attention === attention).length;
      const shown =
        verb === 'all' ? items : items.filter((item) => item.attention === 'needs attention');
      return [
        `Feedback: ${count('needs attention')} need attention, ${count('in progress')} in progress, ${count('healthy')} healthy.`,
        ...shown.slice(0, 10).map((item) => {
          const roles = item.route?.roles.join(', ') ?? 'unrouted';
          const confidence =
            item.confidence.value === null
              ? ''
              : `, confidence ${Math.round(item.confidence.value * 100)}% (exposure-based)`;
          return `- ${item.id} [${item.stage}] ${item.statement}\n  → ${roles}${confidence}. ${item.reason}`;
        }),
        ...(verb === 'all' ? [] : ['/feedback all lists everything.']),
      ].join('\n');
    }
    if (!['apply', 'dismiss', 'later', 'edit'].includes(verb) || !itemId)
      return 'Usage: /feedback [all] | apply <id> | dismiss <id> | later <id> | edit <id> <rule>';
    const rule = rest.join(' ').trim();
    if (verb === 'edit' && !rule) return 'Usage: /feedback edit <id> <the rule, in one line>';
    await foundry.http.answerFeedback(
      itemId,
      verb,
      `acp:${clientName}`,
      verb === 'edit' ? rule : undefined,
    );
    return `${itemId}: ${verb === 'edit' ? 'edited and applied' : verb}.`;
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
      connecting: new Set(),
      launching: Promise.resolve(),
    };
    session.cwd = cwd;
    sessions.set(thread.threadId, session);
    await hold(session, foundry);
    return session;
  };

  /**
   * Asks raised before this host bound the session (a host restart mid-turn) still reach it, after
   * the session response (and a load's replayed history), so the host knows the session first.
   */
  const forwardPending = (session: Session, foundry: Daemon) =>
    setTimeout(() => {
      void session.outbox
        .then(() => foundry.http.prompts(session.threadId))
        .then(({ prompts }) => {
          for (const prompt of prompts) if (prompt.status === 'pending') permission(prompt);
        })
        .catch((error) => log(`pending prompts unavailable: ${(error as Error).message}`));
    }, 0);

  /** This host's own unsettled turns on the session are interrupted, and only their asks withdrawn. */
  const cancelSession = async (session: Session, foundry: Daemon) => {
    const own = new Set(
      [...session.turns.values()].filter((turn) => !turn.isSettled).map((turn) => turn.turnId),
    );
    for (const [promptId, { controller, threadId, turnId }] of asking) {
      if (threadId !== session.threadId || !turnId || !own.has(turnId)) continue;
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
          sessionCapabilities: { resume: {}, close: {} },
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
      const setup = await sessionSetup(
        session,
        foundry,
        {
          permissionMode: hostMode,
          mcpServers: clientMcpServers(ctx.params.mcpServers),
        },
        thread,
      ).catch(httpError);
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
      const setup = await sessionSetup(
        session,
        foundry,
        {
          mcpServers: clientMcpServers(ctx.params.mcpServers),
        },
        thread,
      ).catch(httpError);
      // The history goes out before the response, and pending asks after both.
      for (const update of await replayHistory(foundry.http, thread.threadId, ctx.params.cwd).catch(
        httpError,
      ))
        send(session, update);
      await session.outbox;
      forwardPending(session, foundry);
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
      const setup = await sessionSetup(
        session,
        foundry,
        {
          mcpServers: clientMcpServers(ctx.params.mcpServers),
        },
        thread,
      ).catch(httpError);
      forwardPending(session, foundry);
      return setup;
    })
    .onRequest('session/set_mode', async (ctx) => {
      const session = sessionFor(ctx.params.sessionId);
      const modeId = ctx.params.modeId;
      if (!isModeId(modeId)) throw RequestError.invalidParams({ modeId }, 'Unknown mode');
      const foundry = await ensureDaemon().catch(httpError);
      const view = await applyLaunch(session, foundry, { permissionMode: modeId }).catch(httpError);
      send(session, {
        sessionUpdate: 'current_mode_update',
        currentModeId: modeState(view).currentModeId,
      });
      // The `mode` config option shows the same mode.
      send(session, { sessionUpdate: 'config_option_update', configOptions: configOptions(view) });
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
      const configId = ctx.params.configId;
      if (configId === 'mode' && !isModeId(value))
        throw RequestError.invalidParams({ configId, value }, 'Unknown mode');
      const patch: ThreadLaunchPatch =
        configId === 'mode'
          ? { permissionMode: value as ModeId }
          : configId === 'model'
            ? { model: value }
            : configId === 'effort'
              ? { effort: value === 'default' ? null : (value as ThreadLaunchPatch['effort']) }
              : (() => {
                  throw RequestError.invalidParams({ configId }, 'Unknown config option');
                })();
      const foundry = await ensureDaemon().catch(httpError);
      const view = await applyLaunch(session, foundry, patch).catch(httpError);
      if (configId === 'mode')
        send(session, {
          sessionUpdate: 'current_mode_update',
          currentModeId: modeState(view).currentModeId,
        });
      return { configOptions: configOptions(view) };
    })
    .onRequest('session/prompt', async (ctx): Promise<{ stopReason: StopReason }> => {
      const session = sessionFor(ctx.params.sessionId);
      // Registered before the first await, so a cancel while the daemon starts or streams re-open counts.
      const pending = { cancelled: false };
      session.connecting.add(pending);
      let foundry: Daemon;
      try {
        foundry = await ensureDaemon().catch(httpError);
        if (pending.cancelled) return { stopReason: 'cancelled' };
        await hold(session, foundry).catch(httpError);
        // A restarted daemon lost this host's mode, model, effort and MCP servers: apply them first,
        // or refuse the turn rather than run it under settings the host did not choose.
        await relaunch(session, foundry).catch(httpError);
      } finally {
        session.connecting.delete(pending);
      }
      if (pending.cancelled) return { stopReason: 'cancelled' };
      const text = promptText(ctx.params.prompt);
      const correction = /^\/correction(?:\s+([\s\S]*))?$/.exec(text.trim());
      const feedback = /^\/feedback(?:\s+([\s\S]*))?$/.exec(text.trim());
      if (correction || feedback) {
        const reply = correction
          ? await correct(session, foundry, correction[1]?.trim() ?? '').catch(
              (error) => `Correction not recorded: ${(error as Error).message}`,
            )
          : await feedbackCommand(session, foundry, feedback?.[1]?.trim() ?? '').catch(
              (error) => `Feedback: ${(error as Error).message}`,
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
          const sent = await foundry.http.send({
            threadId: session.threadId,
            id: turnId,
            message: text,
            clientId: foundry.streams.clientId,
          });
          turn.accepted = true;
          if (sent.settingUp) turn.settingUp();
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
      if (!session) return;
      for (const pending of session.connecting) pending.cancelled = true;
      if (!daemon) return;
      await cancelSession(session, daemon);
    })
    .onRequest('session/close', async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) return {};
      for (const pending of session.connecting) pending.cancelled = true;
      sessions.delete(session.threadId);
      const foundry = daemon;
      if (!foundry) return {};
      await cancelSession(session, foundry);
      // The streams close now, so their terminals never arrive: the open turns settle here.
      for (const turn of session.turns.values())
        if (!turn.isSettled) turn.terminal('error', { cancelled: true });
      if (session.holding?.streams === foundry.streams) {
        foundry.streams.close(`thread:${session.threadId}`);
        foundry.streams.close(`flow:${session.threadId}`);
      }
      session.holding = null;
      // A probe (a host that opened a session and never prompted) leaves no thread behind.
      const [thread, history] = await Promise.all([
        foundry.http.thread(session.threadId),
        foundry.http.history(session.threadId),
      ]).catch(() => [null, null] as const);
      if (
        thread?.meta.tags.includes('acp') &&
        thread.meta.status !== 'active' &&
        history?.messages.length === 0
      )
        await foundry.http
          .archiveThread(session.threadId)
          .catch((error) => log(`archive ${session.threadId}: ${(error as Error).message}`));
      return {};
    });
}
