import type {
  EventStream,
  Harness,
  InterventionLog,
  StreamEvent,
} from "@inixiative/foundry-core";
import { Thread } from "@inixiative/foundry-core";
import type { Hono } from "hono";
import type { ProjectRegistry } from "../../agents/project";
import type { ThreadFactory } from "../../agents/thread-factory";
import type { PostgresMemory } from "../../adapters/postgres-memory";
import { enqueueJob } from "../../jobs/enqueue";
import { serializeTrace } from "../../persistence/trace-record";
import type { ConfigStore } from "../config";
import { threadToJSON, traceToJSON, validateId } from "../http-helpers";

export interface RuntimeRoutesDeps {
  harness: Harness;
  eventStream: EventStream;
  interventions: InterventionLog;
  db: PostgresMemory | null;
  assistProviderId?: string;
  threadFactory?: ThreadFactory;
  configStore: ConfigStore;
  projectRegistry?: ProjectRegistry;
}

export function registerRuntimeRoutes(app: Hono, deps: RuntimeRoutesDeps): void {
  const {
    harness,
    eventStream,
    interventions,
    db,
    assistProviderId,
    threadFactory,
    configStore,
    projectRegistry,
  } = deps;

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

    const id = typeof body.id === "string"
      ? body.id
      : `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const threadId = typeof body.threadId === "string" ? body.threadId : harness.thread.id;

    enqueueJob("persistMessage", {
      id: `${id}_user`,
      threadId,
      role: "user",
      content: payload,
    }).catch(() => {
      db?.writeMessage({ id: `${id}_user`, threadId, role: "user", content: payload })
        .catch((err) => console.warn("[Viewer] background op failed:", err.message ?? err));
    });

    try {
      const result = await harness.send({ id, payload });
      const agentContent = typeof result.result?.output === "string"
        ? result.result.output
        : JSON.stringify(result.result?.output ?? null);

      enqueueJob("persistMessage", {
        id: `${id}_agent`,
        threadId,
        role: "agent",
        content: agentContent,
        traceId: result.trace.id,
      }).catch(() => {
        db?.writeMessage({
          id: `${id}_agent`,
          threadId,
          role: "agent",
          content: agentContent,
          traceId: result.trace.id,
        }).catch((err) => console.warn("[Viewer] background op failed:", err.message ?? err));
      });

      enqueueJob("persistTrace", {
        traceId: result.trace.id,
        messageId: id,
        trace: serializeTrace(result.trace),
      }).catch(() => {
        db?.writeTrace(result.trace)
          .catch((err) => console.warn("[Viewer] background op failed:", err.message ?? err));
      });

      return c.json({
        id,
        payload,
        classification: result.classification?.value ?? null,
        route: result.route?.value ?? null,
        output: result.result?.output ?? null,
        traceId: result.trace.id,
        trace: result.trace.summary(),
        timestamp: result.timestamp,
        invokedAgents: result.invokedAgents ?? [],
        activeLayers: result.activeLayers ?? [],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      eventStream.pushError("harness", `Execution failed: ${msg}`);
      return c.json({ error: `Execution failed: ${msg}`, id, payload }, 500);
    }
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

    const allThreads = [threadToJSON(harness.thread)];

    if (projectRegistry) {
      for (const [, project] of projectRegistry.all) {
        for (const [, thread] of project.threads) {
          allThreads.push(threadToJSON(thread));
        }
      }
    }

    return c.json({ threads: allThreads });
  });

  app.post("/api/threads", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const id = typeof body.id === "string"
      ? body.id
      : `thread_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const idErr = validateId(id, "thread id");
    if (idErr) return c.json({ error: idErr }, 400);

    const description = typeof body.description === "string" ? body.description.slice(0, 500) : "";
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 20)
      : [];
    const projectId = typeof body.projectId === "string" ? body.projectId : undefined;

    await configStore.load();

    let thread: Thread;
    if (threadFactory) {
      const effectiveConfig = projectId
        ? configStore.resolveProject(projectId) ?? configStore.config
        : configStore.config;
      const result = await threadFactory.create(id, effectiveConfig, { description, tags });
      thread = result.thread;
    } else {
      thread = new Thread(id, harness.thread.stack, { description, tags });
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

  app.get("/api/events", (c) => {
    const kind = c.req.query("kind") as StreamEvent["kind"] | undefined;
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json(eventStream.recent({ kind, limit }));
  });
}
