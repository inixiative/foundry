import { isAbsolute } from 'node:path';
import type { EventStream, Harness, InterventionLog, StreamEvent } from '@inixiative/foundry-core';
import { newId, Thread, threadTitle, timeFromId } from '@inixiative/foundry-core';
import type { Hono } from 'hono';
import type { PostgresMemory } from '../../adapters/postgres-memory';
import type { ProjectRegistry } from '../../agents/project';
import type { ThreadFactory } from '../../agents/thread-factory';
import type { ThreadNamer } from '../../agents/thread-namer';
import type { ThreadContextTracker } from '../../archives/thread-context';
import { listWorktrees } from '../../git';
import { registryForViewer } from '../../models/registry';
import type { LocalSessionStore } from '../../persistence/local-session-store';
import { TurnService } from '../../turns/turn-service';
import type { ConfigStore } from '../config';
import type { ViewerStreams } from '../data-streams';
import { threadToJSON, traceToJSON, validateId } from '../http-helpers';
import { ViewerThreadDirectory } from '../thread-directory';

export interface RuntimeRoutesDeps {
  harness: Harness;
  eventStream: EventStream;
  interventions: InterventionLog;
  db: PostgresMemory | null;
  assistProviderId?: string;
  threadFactory?: ThreadFactory;
  configStore: ConfigStore;
  deviceIdentityPath?: string;
  projectRegistry?: ProjectRegistry;
  /** Agent-maintained thread names (optional). */
  namer?: ThreadNamer;
  /** Re-derives a thread's branch/worktree/linked work when its worktree changes. */
  threadContext?: ThreadContextTracker;
  localStore?: LocalSessionStore | null;
  directory?: ViewerThreadDirectory;
  /** Data streams that carry live turns and thread-list changes to the viewer socket. */
  streams: ViewerStreams;
}

/** Opaque history cursor: base64url of {t: threadId, s: oldest seq of the issued page}. */
function encodeHistoryCursor(threadId: string, seq: number): string {
  return Buffer.from(JSON.stringify({ t: threadId, s: seq }), 'utf8').toString('base64url');
}

function decodeHistoryCursor(cursor: string): { t: string; s: number } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t?: unknown;
      s?: unknown;
    };
    if (
      typeof parsed.t !== 'string' ||
      typeof parsed.s !== 'number' ||
      !Number.isSafeInteger(parsed.s) ||
      parsed.s < 1
    )
      return null;
    return { t: parsed.t, s: parsed.s };
  } catch {
    return null;
  }
}

export function registerRuntimeRoutes(app: Hono, deps: RuntimeRoutesDeps): { turns: TurnService } {
  const {
    harness,
    eventStream,
    interventions,
    db,
    assistProviderId,
    threadFactory,
    projectRegistry,
  } = deps;
  const namer = deps.namer;
  const threadContext = deps.threadContext;
  const localStore = deps.localStore;
  const directory =
    deps.directory ?? new ViewerThreadDirectory(harness.thread, projectRegistry, threadFactory);
  const streams = deps.streams;
  const turns = new TurnService({
    harness,
    eventStream,
    db,
    threadFactory,
    configStore: deps.configStore,
    deviceIdentityPath: deps.deviceIdentityPath,
    namer,
    localStore,
    directory,
    streams,
  });

  app.get('/api/health', async (c) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    checks.harness = { ok: true, detail: `${harness.thread.agents.size} agents` };

    if (db) {
      try {
        await db.prisma.$queryRaw`SELECT 1`;
        checks.database = { ok: true };
      } catch (err) {
        checks.database = {
          ok: false,
          detail: err instanceof Error ? err.message : 'unreachable',
        };
      }
    }

    if (assistProviderId) {
      checks.provider = { ok: true, detail: assistProviderId };
    }

    const allOk = Object.values(checks).every((check) => check.ok);
    return c.json({ ok: allOk, checks }, allOk ? 200 : 503);
  });

  app.get('/api/models', (c) => {
    return c.json(registryForViewer());
  });

  const messagePayload = (body: Record<string, unknown>) =>
    typeof body.message === 'string'
      ? body.message
      : typeof body.payload === 'string'
        ? body.payload
        : typeof body.content === 'string'
          ? body.content
          : null;

  // Runs a turn and answers with its full result once it settles.
  app.post('/api/messages', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const payload = messagePayload(body);
    if (!payload) return c.json({ error: 'message is required (string)' }, 400);

    const accepted = turns.accept({
      threadId: typeof body.threadId === 'string' ? body.threadId : harness.thread.id,
      turnId: typeof body.id === 'string' ? body.id : undefined,
      payload,
    });
    if (!accepted.ok) return c.json(accepted.body, accepted.status);
    const outcome = await accepted.settled;
    if (outcome.kind === 'failed')
      return c.json(
        {
          error: `Execution failed: ${outcome.error}`,
          id: accepted.turnId,
          payload,
          ...outcome.evidence,
        },
        500,
      );
    if (outcome.kind === 'completed-after-failure')
      return c.json({ ...outcome.completed, payload, error: outcome.error }, 500);
    const { completed, result } = outcome;
    if (completed.meta.persistence === 'failed')
      return c.json(
        {
          ...completed,
          payload,
          error: `Completed result was not saved: ${completed.meta.persistenceError}`,
        },
        500,
      );
    return c.json({
      ...completed,
      payload,
      invokedAgents: result.invokedAgents ?? [],
      activeLayers: result.activeLayers ?? [],
    });
  });

  // -- Send endpoint --
  //
  // Accepts a turn once it is durably begun and answers 202; a busy thread runs it after the
  // turns ahead of it. Its output (deltas, live activity and the bounded turn terminal) is
  // delivered on the `thread:<threadId>` data stream; the full terminal `{ kind: "done" | "error",
  // result }` with explicit persistence status goes to the `clientId` named in the request.
  app.post('/api/messages/send', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const payload = messagePayload(body);
    if (!payload) return c.json({ error: 'message is required (string)' }, 400);

    const accepted = turns.accept({
      threadId: typeof body.threadId === 'string' ? body.threadId : harness.thread.id,
      turnId: typeof body.id === 'string' ? body.id : undefined,
      payload,
      // The requesting client (a tab's socket id, optional) receives the full result on its `thread:<threadId>` stream.
      clientId: typeof body.clientId === 'string' ? body.clientId : undefined,
    });
    if (!accepted.ok) return c.json(accepted.body, accepted.status);
    return c.json(
      {
        id: accepted.turnId,
        threadId: accepted.threadId,
        status: 'accepted',
        queued: accepted.queued,
      },
      202,
    );
  });

  // Stop a turn: a queued turn or one not yet natively dispatched is cancelled; a dispatched one is
  // stopped by its runtime. The turn's terminal still arrives on its thread stream.
  app.post('/api/threads/:threadId/turns/:turnId/interrupt', async (c) => {
    const result = await turns.interrupt(c.req.param('threadId'), c.req.param('turnId'));
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ outcome: result.outcome });
  });

  app.get('/api/traces', async (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
      return c.json({ error: 'invalid limit' }, 400);

    if (localStore) return c.json(localStore.traces(limit).map((trace) => trace.summary ?? trace));

    if (db) {
      try {
        const dbTraces = await db.recentTraces(limit);
        return c.json(dbTraces.map((trace) => trace.summary ?? trace));
      } catch {
        // Fall back to in-memory traces.
      }
    }

    const summaries = turns
      .all()
      .flatMap((scopedHarness) => scopedHarness.traces)
      .slice(-limit)
      .map((trace) => trace.summary());
    return c.json(summaries.reverse());
  });

  app.get('/api/traces/:id', async (c) => {
    const id = c.req.param('id');
    const stored = localStore?.trace(id);
    if (stored) return c.json(stored);
    for (const scopedHarness of turns.all()) {
      const trace = scopedHarness.getTrace(id);
      if (trace) return c.json(traceToJSON(trace));
    }

    if (db) {
      const dbTrace = await db.getTrace(id);
      if (dbTrace) return c.json(dbTrace);
    }

    return c.json({ error: 'not found' }, 404);
  });

  app.get('/api/traces/message/:id', async (c) => {
    const messageId = c.req.param('id');
    const stored = localStore?.traceForTurn(messageId);
    if (stored) return c.json(stored);
    for (const scopedHarness of turns.all()) {
      const trace = scopedHarness.getTraceForMessage(messageId);
      if (trace) return c.json(traceToJSON(trace));
    }

    if (db) {
      const dbTrace = await db.getTraceByMessage(messageId);
      if (dbTrace) return c.json(dbTrace);
    }

    return c.json({ error: 'not found' }, 404);
  });

  app.get('/api/interventions', (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json(interventions.history.slice(0, limit));
  });

  // A correction lands on the bus of the thread it was made in, so it is captured in that thread's scope.
  app.post('/api/threads/:threadId/interventions', async (c) => {
    const thread = directory.get(c.req.param('threadId'));
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    if (thread.disposed) return c.json({ error: 'thread is archived or disposed' }, 409);
    const body = await c.req.json<Record<string, unknown>>();
    if (typeof body.traceId !== 'string') {
      return c.json({ error: 'traceId is required and must be a string' }, 400);
    }
    if (typeof body.spanId !== 'string') {
      return c.json({ error: 'spanId is required and must be a string' }, 400);
    }
    if (body.correction === undefined || body.correction === null) {
      return c.json({ error: 'correction is required' }, 400);
    }

    const result = await interventions.intervene(
      thread,
      body.traceId,
      body.spanId,
      body.actual,
      body.correction,
      typeof body.operator === 'string' ? body.operator : 'ui',
      typeof body.reason === 'string' ? body.reason : undefined,
    );
    return c.json(result, 201);
  });

  // G6 history index: bounded summaries with opaque cursors that reach the oldest
  // record. Detail is fetched lazily per turn. `/api/messages` stays full-detail.
  app.get('/api/threads/:threadId/history', (c) => {
    if (!localStore) return c.json({ error: 'history journal unavailable', messages: [] }, 503);
    const threadId = c.req.param('threadId');
    const limit = Number(c.req.query('limit') ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      return c.json({ error: 'invalid limit (1..500)' }, 400);
    let before: number | undefined;
    const cursor = c.req.query('before');
    if (cursor !== undefined) {
      const decoded = decodeHistoryCursor(cursor);
      if (!decoded || decoded.t !== threadId)
        return c.json({ error: 'invalid or cross-thread history cursor' }, 400);
      before = decoded.s;
    }
    const page = localStore.messageIndex(threadId, { limit, before });
    return c.json({
      threadId,
      source: 'journal',
      messages: page.messages,
      hasMore: page.hasMore,
      oldestReached: page.oldestReached,
      nextCursor: page.nextBefore === null ? null : encodeHistoryCursor(threadId, page.nextBefore),
    });
  });

  app.get('/api/threads/:threadId/turns/:turnId/detail', (c) => {
    if (!localStore) return c.json({ error: 'history journal unavailable' }, 503);
    const threadId = c.req.param('threadId'),
      turnId = c.req.param('turnId');
    const detail = localStore.turnDetail(threadId, turnId);
    if (!detail) return c.json({ error: 'turn not found in this thread' }, 404);
    const base = `/api/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}`;
    const artifacts: Array<{ kind: string; id?: string; href?: string }> = [
      { kind: 'turn-detail', id: turnId, href: `${base}/detail` },
    ];
    if (detail.trace)
      artifacts.push({
        kind: 'trace',
        id: detail.trace.id,
        href: `/api/traces/${encodeURIComponent(detail.trace.id)}`,
      });
    if (detail.injection) artifacts.push({ kind: 'injection', id: turnId, href: `${base}/detail` });
    for (const index of detail.nativeHistory.keys())
      artifacts.push({ kind: 'native-event', id: `${turnId}#${index}` });
    for (const tool of detail.nativeTools)
      artifacts.push({ kind: 'native-tool', id: tool.record.id });
    for (const phase of detail.phases)
      artifacts.push({ kind: `phase:${phase.phase}`, id: phase.id });
    return c.json({ ...detail, artifacts });
  });

  app.get('/api/threads/:threadId/layers/:layerId', (c) => {
    const thread = directory.get(c.req.param('threadId'));
    const layer = thread?.stack.getLayer(c.req.param('layerId'));
    if (!thread || !layer) return c.json({ error: 'layer not found in thread' }, 404);
    const knownThreads = new Map([[harness.thread.id, harness.thread]]);
    for (const project of projectRegistry?.all.values() ?? []) {
      for (const candidate of project.threads.values()) knownThreads.set(candidate.id, candidate);
    }
    const sharedWith = [...knownThreads.values()]
      .filter(
        (candidate) => candidate.id !== thread.id && candidate.stack.getLayer(layer.id) === layer,
      )
      .map((candidate) => candidate.id);
    return c.json({
      ...layer.snapshotInstance(thread.id),
      id: layer.id,
      prompt: layer.prompt,
      sourceIds: layer.sources.map((source) => source.id),
      staleness: layer.staleness,
      maxTokens: layer.maxTokens,
      sharedWith,
    });
  });

  app.get('/api/threads', (c) => {
    const projectId = c.req.query('project');
    const projectThreads = projectId ? directory.scope(projectId) : undefined;
    if (projectThreads) return c.json({ threads: projectThreads.map(threadToJSON), projectId });

    // Global scope = threads not owned by any project (orphan threads only).
    // Project-scoped threads show under their project view; don't double-count.
    return c.json({ threads: directory.scope()!.map(threadToJSON) });
  });

  app.get('/api/threads/:id', (c) => {
    const thread = directory.get(c.req.param('id'));
    return thread ? c.json(threadToJSON(thread)) : c.json({ error: 'thread not found' }, 404);
  });

  // -- Worktrees (read-only detection of existing git worktrees) --

  app.get('/api/worktrees', async (c) => {
    // Use first project's path, or fall back to cwd
    let repoRoot = process.cwd();
    if (projectRegistry) {
      const first = [...projectRegistry.all.values()][0];
      if (first) repoRoot = first.path;
    }

    const worktrees = await listWorktrees(repoRoot);
    return c.json({ worktrees });
  });

  // -- Thread creation --

  app.post('/api/threads', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const id = typeof body.id === 'string' ? body.id : newId('thread');
    const idErr = validateId(id, 'thread id');
    if (idErr) return c.json({ error: idErr }, 400);

    const description = typeof body.description === 'string' ? body.description.slice(0, 500) : '';
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20)
      : [];
    // A working directory names where the work is; its project (if any) is resolved from it. A
    // directory outside every registered project is a global-scope thread working there.
    const workingDirectory = typeof body.cwd === 'string' ? body.cwd : undefined;
    if (workingDirectory !== undefined && !isAbsolute(workingDirectory))
      return c.json({ error: 'cwd must be an absolute path' }, 400);
    const projectId =
      typeof body.projectId === 'string'
        ? body.projectId
        : workingDirectory
          ? (await projectRegistry?.forDirectory(workingDirectory))?.id
          : undefined;
    const worktreePath =
      typeof body.worktreePath === 'string' ? body.worktreePath : workingDirectory;
    const branch = typeof body.branch === 'string' ? body.branch : undefined;
    const parentThreadId =
      typeof body.parentThreadId === 'string' ? body.parentThreadId : undefined;

    // Resolve ownership before building anything: an unknown project or a
    // live duplicate id must not leave an unreachable thread and runtime.
    const project = projectId ? projectRegistry?.get(projectId) : undefined;
    if (projectId && !project) {
      return c.json({ error: `project not found: ${projectId}` }, 404);
    }
    if (directory.get(id) || threadFactory?.runtime?.has(id)) {
      return c.json({ error: `thread already exists: ${id}` }, 409);
    }

    // A project thread works in its project's directory unless a worktree is given.
    const cwd = worktreePath ?? project?.path;

    let thread: Thread;
    if (threadFactory) {
      thread = threadFactory.create(id, {
        description,
        tags,
        cwd,
        branch,
        parentThreadId,
        projectId: project?.id,
      });
    } else {
      // No factory: still never share the main thread's stack or agent
      // instances, and rebind scope-aware sources (memory) to the new thread
      // so main's private captures never reach it.
      const stack = harness.thread.stack.clone({ threadId: id, projectId: project?.id, cwd });
      thread = new Thread(id, stack, {
        description,
        tags,
        cwd,
        branch,
        parentThreadId,
        projectId: project?.id,
      });
      for (const [, agent] of harness.thread.agents) {
        thread.register(agent.withStack(stack));
      }
    }

    if (typeof body.name === 'string') thread.rename(body.name.slice(0, 200));
    if (project) project.addThread(thread);
    directory.add(thread);

    thread.start();
    localStore?.saveThread(thread);
    streams.threadsChanged(thread.id);
    void threadContext?.refresh(thread.id);

    db?.prisma.threadState
      .create({
        data: { id, description, tags, status: 'idle' },
      })
      .catch((err: unknown) =>
        console.warn('[Viewer] background op failed:', (err as Error).message ?? err),
      );

    return c.json(threadToJSON(thread), 201);
  });

  // -- Thread update (worktree reassignment) --

  app.patch('/api/threads/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<Record<string, unknown>>();

    const thread = directory.get(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);

    // Update worktree assignment
    const priorCwd = thread.meta.cwd;
    if (typeof body.worktreePath === 'string') {
      thread.meta.cwd = body.worktreePath || undefined;
    } else if (body.worktreePath === null) {
      thread.meta.cwd = undefined;
    }
    // Instruction files are discovered from the cwd: re-read them on the next turn.
    if (thread.meta.cwd !== priorCwd) for (const layer of thread.stack.layers) layer.invalidate();

    if (typeof body.branch === 'string') {
      thread.meta.branch = body.branch || undefined;
    } else if (body.branch === null) {
      thread.meta.branch = undefined;
    }

    // A person's name is a hard override; an empty string or null clears it.
    if (typeof body.name === 'string') thread.rename(body.name.slice(0, 200));
    else if (body.name === null) thread.rename('');

    localStore?.saveThread(thread);
    streams.threadsChanged(thread.id);
    if ('worktreePath' in body || 'branch' in body) void threadContext?.refresh(thread.id);

    return c.json(threadToJSON(thread));
  });

  // -- Revert thread to a message --

  app.post('/api/threads/:id/revert', async (c) => {
    const threadId = c.req.param('id');
    const body = await c.req.json<Record<string, unknown>>();
    const keepCount = typeof body.keepCount === 'number' ? body.keepCount : null;

    if (keepCount == null || !Number.isSafeInteger(keepCount) || keepCount < 0) {
      return c.json({ error: 'keepCount is required (non-negative integer)' }, 400);
    }
    if (!directory.get(threadId)) return c.json({ error: 'thread not found' }, 404);
    if (localStore)
      return c.json(
        { error: 'Native session rewind is not yet supported; history was not changed' },
        501,
      );

    if (db) {
      const allMsgs = await db.prisma.message.findMany({
        where: { threadId },
        orderBy: { id: 'asc' },
        select: { id: true },
      });

      if (keepCount < allMsgs.length) {
        const toDelete = allMsgs.slice(keepCount).map((m: { id: string }) => m.id);
        await db.prisma.message.deleteMany({
          where: { id: { in: toDelete } },
        });
      }
    }

    return c.json({ ok: true, kept: keepCount });
  });

  // -- Fork thread from a message --

  app.post('/api/threads/:id/fork', async (c) => {
    const sourceThreadId = c.req.param('id');
    const body = await c.req.json<Record<string, unknown>>();
    const copyCount = typeof body.copyCount === 'number' ? body.copyCount : null;

    if (copyCount == null || !Number.isSafeInteger(copyCount) || copyCount < 1) {
      return c.json({ error: 'copyCount is required (positive integer)' }, 400);
    }

    const sourceThread = directory.get(sourceThreadId);

    if (!sourceThread) {
      return c.json({ error: `source thread not found: ${sourceThreadId}` }, 404);
    }
    if (localStore)
      return c.json(
        { error: 'Native session fork is not yet supported; no child thread was created' },
        501,
      );

    const forkedThreadId = newId('thread');
    const sourceName = threadTitle(sourceThread.meta)?.text ?? sourceThreadId;
    const newOpts = {
      description: `Fork of ${sourceName}`,
      cwd: sourceThread?.meta.cwd,
      branch: sourceThread?.meta.branch,
      parentThreadId: sourceThread?.id,
      projectId: sourceThread.meta.projectId,
    };

    let newThread: Thread;
    if (threadFactory) {
      newThread = threadFactory.create(forkedThreadId, newOpts);
    } else {
      // No factory: still never share the main thread's stack or agent
      // instances, and rebind scope-aware sources (memory) to the fork.
      const stack = harness.thread.stack.clone({
        threadId: forkedThreadId,
        projectId: sourceThread.meta.projectId,
        cwd: newOpts.cwd,
      });
      newThread = new Thread(forkedThreadId, stack, {
        ...newOpts,
        projectId: sourceThread.meta.projectId,
      });
      for (const [, agent] of harness.thread.agents) {
        newThread.register(agent.withStack(stack));
      }
    }

    // Add to same project as source
    if (projectRegistry) {
      for (const [, project] of projectRegistry.all) {
        if (project.threads.has(sourceThreadId)) {
          project.addThread(newThread);
          break;
        }
      }
    }

    newThread.start();
    directory.add(newThread);
    streams.threadsChanged(newThread.id);

    // Copy messages from DB
    if (db) {
      const sourceMsgs = await db.prisma.message.findMany({
        where: { threadId: sourceThreadId },
        orderBy: { id: 'asc' },
        take: copyCount,
      });

      for (const msg of sourceMsgs) {
        await db.writeMessage({
          id: newId('fork'),
          threadId: forkedThreadId,
          turnId: msg.turnId ?? undefined,
          actor: msg.actor,
          kind: msg.kind,
          content: msg.content,
          traceId: msg.traceId ?? undefined,
        });
      }

      db.prisma.threadState
        .create({
          data: { id: forkedThreadId, description: newOpts.description, tags: [], status: 'idle' },
        })
        .catch((err: unknown) => console.warn('[Viewer] background op:', (err as Error).message));
    }

    return c.json(threadToJSON(newThread), 201);
  });

  app.get('/api/messages', async (c) => {
    const threadId = c.req.query('threadId');
    const limit = Number(c.req.query('limit') ?? 100);

    if (!threadId) {
      return c.json({ error: 'threadId query parameter is required' }, 400);
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
      return c.json({ error: 'invalid limit' }, 400);
    if (localStore)
      return c.json({
        nativeTools: localStore.nativeTools(threadId),
        nativeToolRetention: localStore.nativeToolRetention(threadId),
        messages: localStore.messages(threadId, limit).map((message) => ({
          ...message,
          ...(message.traceId ? { trace: localStore.trace(message.traceId)?.summary } : {}),
        })),
      });

    if (db) {
      try {
        const rows = await db.threadMessages(threadId, limit);
        const msgs = rows.map((r: any) => ({
          actor: r.actor,
          kind: r.kind,
          turnId: r.turnId ?? undefined,
          content: r.content,
          timestamp: timeFromId(r.id),
          traceId: r.traceId ?? undefined,
          meta: r.meta ?? undefined,
        }));
        return c.json({ messages: msgs });
      } catch (err) {
        // A failed database read is not an empty history; callers must keep their own copy.
        return c.json(
          {
            error: `history unavailable: ${(err as Error).message}`,
            unavailable: true,
            messages: [],
          },
          503,
        );
      }
    }

    // No DB — return empty (in-memory messages are client-side only)
    return c.json({ messages: [] });
  });

  app.get('/api/events', (c) => {
    const kind = c.req.query('kind') as StreamEvent['kind'] | undefined;
    const limit = Number(c.req.query('limit') ?? 100);
    return c.json(eventStream.recent({ kind, limit }));
  });
  return { turns };
}
