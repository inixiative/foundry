import type {
  EventStream,
  Harness,
  InterventionLog,
  StreamEvent,
  LLMProvider,
} from "@inixiative/foundry-core";
import { Thread, newId, timeFromId } from "@inixiative/foundry-core";
import type { Hono } from "hono";
import type { ProjectRegistry } from "../../agents/project";
import type { ThreadFactory } from "../../agents/thread-factory";
import type { PostgresMemory } from "../../adapters/postgres-memory";
import { enqueueJob } from "../../jobs/enqueue";
import { serializeTrace } from "../../persistence/trace-record";
import { listWorktrees } from "../../git";
import type { ConfigStore } from "../config";
import { threadToJSON, traceToJSON, validateId } from "../http-helpers";
import { StreamBufferRegistry } from "../stream-buffer";

export interface RuntimeRoutesDeps {
  harness: Harness;
  eventStream: EventStream;
  interventions: InterventionLog;
  db: PostgresMemory | null;
  assistProviderId?: string;
  threadFactory?: ThreadFactory;
  configStore: ConfigStore;
  projectRegistry?: ProjectRegistry;
  /** Lightweight LLM for auto-naming threads (optional). */
  namingProvider?: LLMProvider;
}

// Threads that have already been auto-named (don't re-name on every message)
const namedThreads = new Set<string>();

/**
 * Build layer-injection provenance for a turn.
 *
 * Joins the harness's `activeLayers` (IDs allowed by this turn's filter) against
 * the thread's stack to capture each layer's hash + token estimate at response time.
 * Oracle reads this to attribute model behavior to specific layer content.
 */
function buildInjectionProvenance(
  activeLayers: string[] | undefined,
  thread: Thread,
): Array<{ id: string; hash: string; tokens: number }> | undefined {
  if (!activeLayers?.length) return undefined;
  const records: Array<{ id: string; hash: string; tokens: number }> = [];
  for (const id of activeLayers) {
    const layer = thread.stack.getLayer(id);
    if (!layer?.isWarm) continue;
    records.push({
      id,
      hash: layer.hash,
      tokens: Math.ceil(layer.content.length / 4),
    });
  }
  return records.length > 0 ? records : undefined;
}

/** Background auto-name: generate a short description from the first message. */
async function autoNameThread(
  thread: Thread,
  message: string,
  provider: LLMProvider,
): Promise<void> {
  if (namedThreads.has(thread.id)) return;
  namedThreads.add(thread.id);

  try {
    const result = await provider.complete(
      [
        {
          role: "system",
          content:
            "Generate a short (3-6 word) title for a conversation thread based on the user's first message. Respond with ONLY the title, no quotes, no punctuation at the end.",
        },
        { role: "user", content: message.slice(0, 500) },
      ],
      { maxTokens: 32, temperature: 0.3 },
    );
    const name = result.content.trim().replace(/^["']|["']$/g, "");
    if (name && name.length > 0 && name.length < 80) {
      thread.describe(name);
    }
  } catch {
    // Non-critical — thread keeps its default name
  }
}

export function registerRuntimeRoutes(app: Hono, deps: RuntimeRoutesDeps): void {
  const {
    harness,
    eventStream,
    interventions,
    db,
    assistProviderId,
    threadFactory,
    projectRegistry,
  } = deps;
  const namingProvider = deps.namingProvider;
  const streamBuffers = new StreamBufferRegistry();

  app.get("/api/health", async (c) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    checks.harness = { ok: true, detail: `${harness.thread.agents.size} agents` };

    if (db) {
      try {
        await db.prisma.$queryRaw`SELECT 1`;
        checks.database = { ok: true };
      } catch (err) {
        checks.database = {
          ok: false,
          detail: err instanceof Error ? err.message : "unreachable",
        };
      }
    }

    if (assistProviderId) {
      checks.provider = { ok: true, detail: assistProviderId };
    }

    const allOk = Object.values(checks).every((check) => check.ok);
    return c.json({ ok: allOk, checks }, allOk ? 200 : 503);
  });

  app.post("/api/messages", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const payload = typeof body.message === "string"
      ? body.message
      : typeof body.payload === "string"
        ? body.payload
        : typeof body.content === "string"
          ? body.content
          : null;

    if (!payload) {
      return c.json({ error: "message is required (string)" }, 400);
    }

    const turnId = typeof body.id === "string" ? body.id : newId("turn");
    const userMsgId = newId("msg");
    const threadId = typeof body.threadId === "string" ? body.threadId : harness.thread.id;

    enqueueJob("persistMessage", {
      id: userMsgId,
      threadId,
      turnId,
      actor: "user",
      kind: "text",
      content: payload,
    }).catch(() => {
      db?.writeMessage({ id: userMsgId, threadId, turnId, actor: "user", kind: "text", content: payload })
        .catch((err) => console.warn("[Viewer] background op failed:", err.message ?? err));
    });

    try {
      const result = await harness.send({ id: turnId, payload });
      const agentContent = typeof result.result?.output === "string"
        ? result.result.output
        : JSON.stringify(result.result?.output ?? null);
      const agentMsgId = newId("msg");
      const injectedLayers = buildInjectionProvenance(result.activeLayers, harness.thread);
      const agentMeta = injectedLayers ? { injectedLayers } : undefined;

      enqueueJob("persistMessage", {
        id: agentMsgId,
        threadId,
        turnId,
        actor: "agent",
        kind: "text",
        content: agentContent,
        traceId: result.trace.id,
        meta: agentMeta,
      }).catch(() => {
        db?.writeMessage({
          id: agentMsgId,
          threadId,
          turnId,
          actor: "agent",
          kind: "text",
          content: agentContent,
          traceId: result.trace.id,
          meta: agentMeta,
        }).catch((err) => console.warn("[Viewer] background op failed:", err.message ?? err));
      });

      enqueueJob("persistTrace", {
        traceId: result.trace.id,
        messageId: turnId,
        trace: serializeTrace(result.trace),
      }).catch(() => {
        db?.writeTrace(result.trace)
          .catch((err) => console.warn("[Viewer] background op failed:", err.message ?? err));
      });

      // Auto-name the thread after first message (fire-and-forget)
      if (namingProvider) {
        autoNameThread(harness.thread, payload, namingProvider);
      }

      return c.json({
        id: turnId,
        payload,
        classification: result.classification?.value ?? null,
        route: result.route?.value ?? null,
        output: result.result?.output ?? null,
        traceId: result.trace.id,
        trace: result.trace.summary(),
        timestamp: result.timestamp,
        invokedAgents: result.invokedAgents ?? [],
        activeLayers: result.activeLayers ?? [],
        meta: agentMeta,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      eventStream.pushError("harness", `Execution failed: ${msg}`);
      return c.json({ error: `Execution failed: ${msg}`, id: turnId, payload }, 500);
    }
  });

  // -- Streaming message endpoint (SSE) --
  //
  // Emits incremental `data: {"type":"delta","text":...}` events as tokens
  // arrive from the executor, then a terminal `data: {"type":"done",...}`
  // with the final traceId + classification/route. The server-side buffer
  // is independent of the HTTP connection, so if the client disconnects
  // mid-stream the turn still completes and is persisted.
  app.post("/api/messages/stream", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const payload = typeof body.message === "string"
      ? body.message
      : typeof body.payload === "string"
        ? body.payload
        : typeof body.content === "string"
          ? body.content
          : null;

    if (!payload) {
      return c.json({ error: "message is required (string)" }, 400);
    }

    const turnId = typeof body.id === "string" ? body.id : newId("turn");
    const userMsgId = newId("msg");
    const threadId = typeof body.threadId === "string" ? body.threadId : harness.thread.id;

    // Persist user message (fire-and-forget)
    enqueueJob("persistMessage", {
      id: userMsgId,
      threadId,
      turnId,
      actor: "user",
      kind: "text",
      content: payload,
    }).catch(() => {
      db?.writeMessage({ id: userMsgId, threadId, turnId, actor: "user", kind: "text", content: payload })
        .catch((err) => console.warn("[Viewer] background op failed:", err.message ?? err));
    });

    const buffer = streamBuffers.open(turnId, threadId);

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const write = (obj: unknown) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          } catch { /* client gone — buffer keeps running */ }
        };

        write({ type: "start", id: turnId, threadId });

        try {
          for await (const ev of harness.sendStream({ id: turnId, payload })) {
            if (ev.kind === "delta") {
              buffer.append(ev.text);
              write({ type: "delta", text: ev.text });
            } else {
              buffer.complete();
              const result = ev.result;
              const agentContent = buffer.content.length > 0
                ? buffer.content
                : (typeof result.result?.output === "string"
                  ? result.result.output
                  : JSON.stringify(result.result?.output ?? null));
              const agentMsgId = newId("msg");
              const injectedLayers = buildInjectionProvenance(result.activeLayers, harness.thread);
              const agentMeta = injectedLayers ? { injectedLayers } : undefined;

              // Single DB write on completion
              enqueueJob("persistMessage", {
                id: agentMsgId,
                threadId,
                turnId,
                actor: "agent",
                kind: "text",
                content: agentContent,
                traceId: result.trace.id,
                meta: agentMeta,
              }).catch(() => {
                db?.writeMessage({
                  id: agentMsgId,
                  threadId,
                  turnId,
                  actor: "agent",
                  kind: "text",
                  content: agentContent,
                  traceId: result.trace.id,
                  meta: agentMeta,
                }).catch((err) => console.warn("[Viewer] background op failed:", err.message ?? err));
              });

              enqueueJob("persistTrace", {
                traceId: result.trace.id,
                messageId: turnId,
                trace: serializeTrace(result.trace),
              }).catch(() => {
                db?.writeTrace(result.trace)
                  .catch((err) => console.warn("[Viewer] background op failed:", err.message ?? err));
              });

              if (namingProvider) {
                autoNameThread(harness.thread, payload, namingProvider);
              }

              write({
                type: "done",
                id: turnId,
                content: agentContent,
                traceId: result.trace.id,
                trace: result.trace.summary(),
                classification: result.classification?.value ?? null,
                route: result.route?.value ?? null,
                timestamp: result.timestamp,
                meta: agentMeta,
              });
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          buffer.fail(msg);
          eventStream.pushError("harness", `Execution failed: ${msg}`);
          write({ type: "error", error: msg });
        } finally {
          streamBuffers.drop(turnId);
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  // Live buffers for a thread — used by the UI on reconnect to recover
  // mid-stream state (show partial content that's been accumulated so far).
  app.get("/api/messages/live", (c) => {
    const threadId = c.req.query("threadId");
    if (!threadId) return c.json({ buffers: [] });
    return c.json({ buffers: streamBuffers.forThread(threadId) });
  });

  app.get("/api/traces", async (c) => {
    const limit = Number(c.req.query("limit") ?? 50);

    if (db) {
      try {
        const dbTraces = await db.recentTraces(limit);
        return c.json(dbTraces.map((trace) => trace.summary ?? trace));
      } catch {
        // Fall back to in-memory traces.
      }
    }

    const summaries = harness.traces.slice(-limit).map((trace) => trace.summary());
    return c.json(summaries.reverse());
  });

  app.get("/api/traces/:id", async (c) => {
    const id = c.req.param("id");
    const trace = harness.getTrace(id);
    if (trace) return c.json(traceToJSON(trace));

    if (db) {
      const dbTrace = await db.getTrace(id);
      if (dbTrace) return c.json(dbTrace);
    }

    return c.json({ error: "not found" }, 404);
  });

  app.get("/api/traces/message/:id", async (c) => {
    const messageId = c.req.param("id");
    const trace = harness.getTraceForMessage(messageId);
    if (trace) return c.json(traceToJSON(trace));

    if (db) {
      const dbTrace = await db.getTraceByMessage(messageId);
      if (dbTrace) return c.json(dbTrace);
    }

    return c.json({ error: "not found" }, 404);
  });

  app.get("/api/interventions", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json(interventions.history.slice(0, limit));
  });

  app.post("/api/interventions", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    if (typeof body.traceId !== "string") {
      return c.json({ error: "traceId is required and must be a string" }, 400);
    }
    if (typeof body.spanId !== "string") {
      return c.json({ error: "spanId is required and must be a string" }, 400);
    }
    if (body.correction === undefined || body.correction === null) {
      return c.json({ error: "correction is required" }, 400);
    }

    const result = await interventions.intervene(
      body.traceId,
      body.spanId,
      body.actual,
      body.correction,
      typeof body.operator === "string" ? body.operator : "ui",
      typeof body.reason === "string" ? body.reason : undefined,
    );
    return c.json(result, 201);
  });

  app.get("/api/threads", (c) => {
    const projectId = c.req.query("project");

    if (projectId && projectRegistry) {
      const project = projectRegistry.get(projectId);
      if (project) {
        const threads = [...project.threads.values()].map(threadToJSON);
        return c.json({ threads, projectId });
      }
    }

    // Global scope = threads not owned by any project (orphan threads only).
    // Project-scoped threads show under their project view; don't double-count.
    const projectThreadIds = new Set<string>();
    if (projectRegistry) {
      for (const [, project] of projectRegistry.all) {
        for (const [id] of project.threads) projectThreadIds.add(id);
      }
    }

    const allThreads: ReturnType<typeof threadToJSON>[] = [];
    if (!projectThreadIds.has(harness.thread.id)) {
      allThreads.push(threadToJSON(harness.thread));
    }

    return c.json({ threads: allThreads });
  });

  // -- Worktrees (read-only detection of existing git worktrees) --

  app.get("/api/worktrees", async (c) => {
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

  app.post("/api/threads", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const id = typeof body.id === "string"
      ? body.id
      : newId("thread");
    const idErr = validateId(id, "thread id");
    if (idErr) return c.json({ error: idErr }, 400);

    const description = typeof body.description === "string" ? body.description.slice(0, 500) : "";
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 20)
      : [];
    const projectId = typeof body.projectId === "string" ? body.projectId : undefined;
    const worktreePath = typeof body.worktreePath === "string" ? body.worktreePath : undefined;
    const branch = typeof body.branch === "string" ? body.branch : undefined;
    const parentThreadId = typeof body.parentThreadId === "string" ? body.parentThreadId : undefined;

    let thread: Thread;
    if (threadFactory) {
      thread = threadFactory.create(id, { description, tags, cwd: worktreePath, branch, parentThreadId });
    } else {
      thread = new Thread(id, harness.thread.stack, { description, tags, cwd: worktreePath, branch, parentThreadId });
      for (const [, agent] of harness.thread.agents) {
        thread.register(agent);
      }
    }

    if (projectId && projectRegistry) {
      const project = projectRegistry.get(projectId);
      if (project) project.addThread(thread);
    }

    thread.start();

    db?.prisma.threadState.create({
      data: { id, description, tags, status: "idle" },
    }).catch((err: unknown) => console.warn("[Viewer] background op failed:", (err as Error).message ?? err));

    return c.json(threadToJSON(thread), 201);
  });

  // -- Thread update (worktree reassignment) --

  app.patch("/api/threads/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<Record<string, unknown>>();

    // Find thread across harness + project registry
    let thread: Thread | undefined;
    if (harness.thread.id === id) {
      thread = harness.thread;
    }
    if (!thread && projectRegistry) {
      for (const [, project] of projectRegistry.all) {
        const t = project.threads.get(id);
        if (t) { thread = t; break; }
      }
    }
    if (!thread) return c.json({ error: "thread not found" }, 404);

    // Update worktree assignment
    if (typeof body.worktreePath === "string") {
      thread.meta.cwd = body.worktreePath || undefined;
    } else if (body.worktreePath === null) {
      thread.meta.cwd = undefined;
    }

    if (typeof body.branch === "string") {
      thread.meta.branch = body.branch || undefined;
    } else if (body.branch === null) {
      thread.meta.branch = undefined;
    }

    if (typeof body.description === "string") {
      thread.describe(body.description);
    }

    return c.json(threadToJSON(thread));
  });

  // -- Revert thread to a message --

  app.post("/api/threads/:id/revert", async (c) => {
    const threadId = c.req.param("id");
    const body = await c.req.json<Record<string, unknown>>();
    const keepCount = typeof body.keepCount === "number" ? body.keepCount : null;

    if (keepCount == null || keepCount < 0) {
      return c.json({ error: "keepCount is required (non-negative integer)" }, 400);
    }

    if (db) {
      const allMsgs = await db.prisma.message.findMany({
        where: { threadId },
        orderBy: { id: "asc" },
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

  app.post("/api/threads/:id/fork", async (c) => {
    const sourceThreadId = c.req.param("id");
    const body = await c.req.json<Record<string, unknown>>();
    const copyCount = typeof body.copyCount === "number" ? body.copyCount : null;

    if (copyCount == null || copyCount < 1) {
      return c.json({ error: "copyCount is required (positive integer)" }, 400);
    }

    // Find source thread to inherit config
    let sourceThread: Thread | undefined;
    if (harness.thread.id === sourceThreadId) {
      sourceThread = harness.thread;
    }
    if (!sourceThread && projectRegistry) {
      for (const [, project] of projectRegistry.all) {
        const t = project.threads.get(sourceThreadId);
        if (t) { sourceThread = t; break; }
      }
    }

    const forkedThreadId = newId("thread");
    const sourceName = sourceThread?.meta.description || sourceThreadId;
    const newOpts = {
      description: `Fork of ${sourceName}`,
      cwd: sourceThread?.meta.cwd,
      branch: sourceThread?.meta.branch,
      parentThreadId: sourceThread?.id,
    };

    let newThread: Thread;
    if (threadFactory) {
      newThread = threadFactory.create(forkedThreadId, newOpts);
    } else {
      newThread = new Thread(forkedThreadId, harness.thread.stack, newOpts);
      for (const [, agent] of harness.thread.agents) {
        newThread.register(agent);
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

    // Copy messages from DB
    if (db) {
      const sourceMsgs = await db.prisma.message.findMany({
        where: { threadId: sourceThreadId },
        orderBy: { id: "asc" },
        take: copyCount,
      });

      for (const msg of sourceMsgs) {
        await db.writeMessage({
          id: newId("fork"),
          threadId: forkedThreadId,
          turnId: msg.turnId ?? undefined,
          actor: msg.actor,
          kind: msg.kind,
          content: msg.content,
          traceId: msg.traceId ?? undefined,
        });
      }

      db.prisma.threadState.create({
        data: { id: forkedThreadId, description: newOpts.description, tags: [], status: "idle" },
      }).catch((err: unknown) => console.warn("[Viewer] background op:", (err as Error).message));
    }

    return c.json(threadToJSON(newThread), 201);
  });

  app.get("/api/messages", async (c) => {
    const threadId = c.req.query("threadId");
    const limit = Number(c.req.query("limit") ?? 100);

    if (!threadId) {
      return c.json({ error: "threadId query parameter is required" }, 400);
    }

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
      } catch {
        return c.json({ messages: [] });
      }
    }

    // No DB — return empty (in-memory messages are client-side only)
    return c.json({ messages: [] });
  });

  app.get("/api/events", (c) => {
    const kind = c.req.query("kind") as StreamEvent["kind"] | undefined;
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json(eventStream.recent({ kind, limit }));
  });
}
