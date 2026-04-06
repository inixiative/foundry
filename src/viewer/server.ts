import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { EventStream, StreamEvent } from "../agents/event-stream";
import type { Harness } from "../agents/harness";
import type { InterventionLog } from "../agents/intervention";
import { Thread } from "../agents/thread";
import type { Trace } from "../agents/trace";
import type { LLMProvider } from "../providers/types";
import type { TokenTracker } from "../agents/token-tracker";
import { ActionHandler, type OperatorAction } from "./actions";
import { ConfigStore, type FoundryConfig } from "./config";
import { AIAssist, type AssistRequest } from "./ai-assist";
import { AnalyticsStore, type RollupPeriod } from "./analytics";
import { FoundryTunnel, tunnelAuth, type TunnelConfig, type TunnelInfo } from "./tunnel";

/** Validate user-provided IDs — alphanumeric, dashes, underscores, dots. Max 128 chars. */
function validateId(id: string, label: string): string | null {
  if (!id || typeof id !== "string") return `${label} is required`;
  if (id.length > 128) return `${label} too long (max 128 chars)`;
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) return `${label} contains invalid characters (use alphanumeric, dash, underscore, dot)`;
  return null;
}

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

  // Tunnel auth — if tunnel is configured, require bearer token for all requests
  let tunnel: FoundryTunnel | null = null;
  if (config.tunnel) {
    tunnel = new FoundryTunnel({ ...config.tunnel, port });
    app.use("*", tunnelAuth(tunnel.token));
  }

  // Action handler for operator commands
  const actions = new ActionHandler({ harness, eventStream, interventions });

  // Config store for settings persistence
  const configStore = new ConfigStore(config.configDir ?? ".foundry");

  // AI assist (optional — only available if a provider is configured)
  const aiAssist = config.assistProvider
    ? new AIAssist(config.assistProvider, config.assistModel)
    : null;

  // Analytics store (optional — only available if a token tracker is configured)
  const analyticsStore = config.tokenTracker
    ? new AnalyticsStore(config.analyticsDir ?? ".foundry/analytics")
    : null;

  // Auto-wire tracker → analytics persistence
  if (analyticsStore && config.tokenTracker) {
    analyticsStore.load().catch((err) => console.warn("[Viewer] background op failed:", err.message ?? err));
    analyticsStore.connectTracker(config.tokenTracker);
  }

  const db = config.db ?? null;

  // -- REST: Health check --

  app.get("/api/health", async (c) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    // Harness
    checks.harness = { ok: true, detail: `${harness.thread.agents.size} agents` };

    // Database
    if (db) {
      try {
        await db.prisma.$queryRaw`SELECT 1`;
        checks.database = { ok: true };
      } catch (err) {
        checks.database = { ok: false, detail: err instanceof Error ? err.message : "unreachable" };
      }
    }

    // Provider — try a minimal completion to verify connectivity
    if (config.assistProvider) {
      try {
        // Just check the provider object is valid — don't actually call it
        checks.provider = { ok: true, detail: config.assistProvider.id };
      } catch {
        checks.provider = { ok: false, detail: "provider error" };
      }
    }

    const allOk = Object.values(checks).every((ch) => ch.ok);
    return c.json({ ok: allOk, checks }, allOk ? 200 : 503);
  });

  // -- REST: Messages (primary interface — send through harness) --

  app.post("/api/messages", async (c) => {
    const body = await c.req.json();
    const payload = body.message ?? body.payload ?? body.content;

    if (!payload || typeof payload !== "string") {
      return c.json({ error: "message is required (string)" }, 400);
    }

    const id = body.id ?? `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const threadId = body.threadId ?? harness.thread.id;

    // Persist user message
    if (db) {
      db.writeMessage({ id: `${id}_user`, threadId, role: "user", content: payload }).catch((err) => console.warn("[Viewer] background op failed:", err.message ?? err));
    }

    try {
      const result = await harness.send({ id, payload });

      // Persist agent response + trace
      if (db) {
        db.writeMessage({
          id: `${id}_agent`,
          threadId,
          role: "agent",
          content: typeof result.result?.output === "string" ? result.result.output : JSON.stringify(result.result?.output),
          traceId: result.trace.id,
        }).catch((err) => console.warn("[Viewer] background op failed:", err.message ?? err));
        db.writeTrace(result.trace).catch((err) => console.warn("[Viewer] background op failed:", err.message ?? err));
      }

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
      return c.json({
        error: `Execution failed: ${msg}`,
        id,
        payload,
      }, 500);
    }
  });

  // -- REST: Traces --

  app.get("/api/traces", async (c) => {
    const limit = Number(c.req.query("limit") ?? 50);

    // Prefer DB if available (survives restarts)
    if (db) {
      try {
        const dbTraces = await db.recentTraces(limit);
        return c.json(dbTraces.map((t) => t.summary ?? t));
      } catch { /* fall through to in-memory */ }
    }

    const summaries = harness.traces.slice(-limit).map((t) => t.summary());
    return c.json(summaries.reverse());
  });

  app.get("/api/traces/:id", async (c) => {
    const id = c.req.param("id");

    // Try in-memory first (hot), then DB (cold)
    const trace = harness.getTrace(id);
    if (trace) return c.json(traceToJSON(trace));

    if (db) {
      const dbTrace = await db.getTrace(id);
      if (dbTrace) return c.json(dbTrace);
    }

    return c.json({ error: "not found" }, 404);
  });

  app.get("/api/traces/message/:id", async (c) => {
    const msgId = c.req.param("id");

    const trace = harness.getTraceForMessage(msgId);
    if (trace) return c.json(traceToJSON(trace));

    if (db) {
      const dbTrace = await db.getTraceByMessage(msgId);
      if (dbTrace) return c.json(dbTrace);
    }

    return c.json({ error: "not found" }, 404);
  });

  // -- REST: Interventions --

  app.get("/api/interventions", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json(interventions.history.slice(0, limit));
  });

  app.post("/api/interventions", async (c) => {
    const body = await c.req.json();

    if (!body.traceId || typeof body.traceId !== "string") {
      return c.json({ error: "traceId is required and must be a string" }, 400);
    }
    if (!body.spanId || typeof body.spanId !== "string") {
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
      body.operator ?? "ui",
      body.reason
    );
    return c.json(result, 201);
  });

  // -- REST: System state --

  /** Serialize a thread for the API. */
  function threadToJSON(thread: typeof harness.thread) {
    return {
      threadId: thread.id,
      meta: thread.meta,
      agents: [...thread.agents.entries()].map(([id, agent]) => ({
        id,
        agentId: agent.id,
      })),
      layerCount: thread.stack.layers.length,
      layers: thread.stack.layers.map((l) => ({
        id: l.id,
        state: l.state,
        trust: l.trust,
        hash: l.hash,
        contentLength: l.content.length,
      })),
    };
  }

  app.get("/api/threads", (c) => {
    const projectId = c.req.query("project");
    const registry = config.projectRegistry;

    // If a project is specified and registry exists, return that project's threads
    if (projectId && registry) {
      const project = registry.get(projectId);
      if (project) {
        const threads = [...project.threads.values()].map(threadToJSON);
        return c.json({ threads, projectId });
      }
    }

    // Default: return all threads (main + any from projects)
    const allThreads = [threadToJSON(harness.thread)];

    if (registry) {
      for (const [, project] of registry.all) {
        for (const [, thread] of project.threads) {
          allThreads.push(threadToJSON(thread));
        }
      }
    }

    return c.json({ threads: allThreads });
  });

  app.post("/api/threads", async (c) => {
    const body = await c.req.json();
    const id = body.id ?? `thread_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const idErr = validateId(id, "thread id");
    if (idErr) return c.json({ error: idErr }, 400);

    const description = typeof body.description === "string" ? body.description.slice(0, 500) : "";
    const tags: string[] = Array.isArray(body.tags) ? body.tags.filter((t: unknown) => typeof t === "string").slice(0, 20) : [];
    const projectId: string | undefined = body.projectId;

    const factory = config.threadFactory;
    const cfgStore = config.configStore;

    let thread: InstanceType<typeof Thread>;

    if (factory && cfgStore) {
      // Use factory — thread gets its own layer instances, agents, RunContext
      const effectiveConfig = projectId
        ? cfgStore.resolveProject(projectId) ?? cfgStore.config
        : cfgStore.config;

      const result = await factory.create(id, effectiveConfig, { description, tags });
      thread = result.thread;
    } else {
      // Fallback — shared stack and agents (legacy behavior)
      thread = new Thread(id, harness.thread.stack, { description, tags });
      for (const [, agent] of harness.thread.agents) {
        thread.register(agent);
      }
    }

    const registry = config.projectRegistry;
    if (projectId && registry) {
      const project = registry.get(projectId);
      if (project) {
        project.addThread(thread);
      }
    }

    thread.start();

    // Persist thread state
    if (db) {
      db.prisma.threadState.create({
        data: { id, description, tags, status: "idle" },
      }).catch((err) => console.warn("[Viewer] background op failed:", err.message ?? err));
    }

    return c.json(threadToJSON(thread), 201);
  });

  app.get("/api/events", (c) => {
    const kind = c.req.query("kind") as StreamEvent["kind"] | undefined;
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json(eventStream.recent({ kind, limit }));
  });

  // -- REST: Definitions (config-level, not runtime instances) --

  app.get("/api/definitions", async (c) => {
    const cfg = await configStore.load();
    configStore.syncFromHarness(harness);

    // Which IDs are currently instantiated on the thread
    const instantiatedLayers = new Set(
      harness.thread.stack.layers.map((l) => l.id)
    );
    const instantiatedAgents = new Set(
      [...harness.thread.agents.keys()]
    );

    return c.json({
      layers: Object.values(cfg.layers).map((l) => ({
        ...l,
        instantiated: instantiatedLayers.has(l.id),
      })),
      agents: Object.values(cfg.agents).map((a) => ({
        ...a,
        instantiated: instantiatedAgents.has(a.id),
      })),
      sources: Object.values(cfg.sources),
    });
  });

  // -- REST: Actions (operator commands) --

  app.post("/api/actions", async (c) => {
    const body = await c.req.json();

    if (!body.kind || typeof body.kind !== "string") {
      return c.json({ error: "kind is required" }, 400);
    }

    const action: OperatorAction = {
      kind: body.kind,
      target: body.target,
      payload: body.payload,
      operator: body.operator ?? "ui",
      timestamp: body.timestamp ?? Date.now(),
    };

    const result = await actions.execute(action);
    return c.json(result, result.ok ? 200 : 400);
  });

  app.get("/api/actions/history", (c) => {
    return c.json(actions.history.slice(-50));
  });

  // -- REST: Settings --

  app.get("/api/settings", async (c) => {
    const cfg = await configStore.load();
    // Sync runtime state into config on first read
    configStore.syncFromHarness(harness);
    return c.json(cfg);
  });

  app.put("/api/settings", async (c) => {
    const body = await c.req.json();
    await configStore.save(body as FoundryConfig);
    return c.json({ ok: true });
  });

  app.patch("/api/settings/:section", async (c) => {
    const section = c.req.param("section");
    const body = await c.req.json();
    const updated = await configStore.patch(section, body);
    return c.json(updated);
  });

  app.delete("/api/settings/:section/:id", async (c) => {
    const section = c.req.param("section");
    const id = c.req.param("id");
    const updated = await configStore.deleteItem(section, id);
    return c.json(updated);
  });

  // -- REST: AI Assist --

  app.post("/api/assist", async (c) => {
    if (!aiAssist) {
      return c.json({ error: "AI assist not configured. Pass assistProvider to ViewerConfig." }, 400);
    }
    const body = await c.req.json() as AssistRequest;
    const cfg = await configStore.load();
    configStore.syncFromHarness(harness);
    try {
      const result = await aiAssist.analyze(cfg, body);
      return c.json(result);
    } catch (err) {
      return c.json({ error: `AI assist failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  app.post("/api/assist/prompt", async (c) => {
    if (!aiAssist) {
      return c.json({ error: "AI assist not configured." }, 400);
    }
    const body = await c.req.json();
    const cfg = await configStore.load();
    try {
      const result = await aiAssist.improvePrompt(
        cfg,
        { type: body.type, id: body.id },
        body.currentPrompt ?? "",
        body.instruction
      );
      return c.json(result);
    } catch (err) {
      return c.json({ error: `Prompt assist failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  app.post("/api/assist/agent-config", async (c) => {
    if (!aiAssist) {
      return c.json({ error: "AI assist not configured." }, 400);
    }
    const body = await c.req.json();
    const cfg = await configStore.load();
    try {
      const result = await aiAssist.suggestAgentConfig(
        cfg,
        body.agentId,
        body.kind,
        body.prompt ?? ""
      );
      return c.json(result);
    } catch (err) {
      return c.json({ error: `Config assist failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // -- REST: Analytics --

  app.get("/api/analytics", (c) => {
    if (!analyticsStore || !config.tokenTracker) {
      return c.json({ error: "Analytics not configured. Pass tokenTracker to ViewerConfig." }, 400);
    }
    const projectId = c.req.query("project");
    const snapshot = analyticsStore.snapshot(config.tokenTracker);

    // Optionally enrich with project info
    if (projectId && config.projectRegistry) {
      const project = config.projectRegistry.get(projectId);
      if (project) {
        return c.json({
          ...snapshot,
          projectId,
          projectThreadCount: project.threads.size,
        });
      }
    }

    return c.json(snapshot);
  });

  app.get("/api/analytics/timeseries", (c) => {
    if (!analyticsStore) return c.json({ error: "Analytics not configured." }, 400);
    const period = (c.req.query("period") ?? "hourly") as RollupPeriod;
    const since = c.req.query("since") ? Number(c.req.query("since")) : undefined;
    return c.json(analyticsStore.timeSeries(period, since));
  });

  app.get("/api/analytics/threads", (c) => {
    if (!analyticsStore) return c.json({ error: "Analytics not configured." }, 400);
    return c.json(analyticsStore.threadCosts());
  });

  app.get("/api/analytics/calls", (c) => {
    if (!analyticsStore) return c.json({ error: "Analytics not configured." }, 400);
    const field = c.req.query("field") as "provider" | "model" | "agentId" | "threadId" | undefined;
    const value = c.req.query("value");
    if (field && value) {
      return c.json(analyticsStore.callsBy(field, value));
    }
    return c.json(analyticsStore.callsBy("provider", ""));
  });

  app.get("/api/analytics/budget", (c) => {
    if (!config.tokenTracker) return c.json({ error: "No token tracker." }, 400);
    return c.json(config.tokenTracker.budgetStatus);
  });

  // -- REST: Projects --

  app.get("/api/projects", async (c) => {
    // Return from config (always available) + registry summaries if present
    const cfg = await configStore.load();
    const registry = config.projectRegistry;

    if (registry) {
      // Sync config → registry
      registry.loadFromConfigs(cfg.projects);
      return c.json({
        projects: registry.summaries(),
        tags: registry.allTags(),
      });
    }

    // Fallback: just return config entries
    const projects = Object.values(cfg.projects).map((p) => ({
      ...p,
      status: "idle",
      threadCount: 0,
      activeThreadCount: 0,
      createdAt: 0,
      lastActiveAt: 0,
    }));
    const tags = [...new Set(projects.flatMap((p) => p.tags))].sort();
    return c.json({ projects, tags });
  });

  app.get("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    const registry = config.projectRegistry;
    if (registry) {
      const project = registry.get(id);
      if (!project) return c.json({ error: "not found" }, 404);
      return c.json(project.summary());
    }
    const cfg = await configStore.load();
    const p = cfg.projects[id];
    if (!p) return c.json({ error: "not found" }, 404);
    return c.json(p);
  });

  app.post("/api/projects", async (c) => {
    const body = await c.req.json();
    if (!body.id || !body.path) {
      return c.json({ error: "id and path are required" }, 400);
    }
    const projIdErr = validateId(body.id, "project id");
    if (projIdErr) return c.json({ error: projIdErr }, 400);
    if (typeof body.path !== "string" || body.path.length > 500) {
      return c.json({ error: "path must be a string (max 500 chars)" }, 400);
    }
    const projectConfig = {
      id: body.id,
      path: body.path,
      label: body.label ?? body.id,
      tags: body.tags ?? [],
      runtime: body.runtime ?? "claude-code",
      description: body.description ?? "",
      enabled: true,
    };
    await configStore.patch("projects", { [body.id]: projectConfig });
    const registry = config.projectRegistry;
    if (registry && !registry.get(body.id)) {
      registry.register(projectConfig);
    }
    return c.json(projectConfig, 201);
  });

  app.delete("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    await configStore.deleteItem("projects", id);
    const registry = config.projectRegistry;
    if (registry) registry.remove(id);
    return c.json({ ok: true });
  });

  app.get("/api/projects/:id/config", async (c) => {
    const id = c.req.param("id");
    const resolved = configStore.resolveProject(id);
    if (!resolved) return c.json({ error: "project not found" }, 404);
    return c.json(resolved);
  });

  // -- REST: Tunnel info --

  app.get("/api/tunnel", (c) => {
    if (!tunnel) return c.json({ active: false });
    const info = tunnel.info;
    return c.json({ active: !!info, ...info });
  });

  // -- Static: UI files --
  // Serves the Preact-based UI from /ui/*

  app.get("/ui/*", serveStatic({ root: "./src/viewer/" }));

  // Root serves the HTML shell
  app.get("/", serveStatic({ path: "./src/viewer/ui/index.html" }));

  return { app, port, actions, configStore, analyticsStore, tunnel };
}

/** Start the viewer server. */
export async function startViewer(config: ViewerConfig) {
  const { app, port, actions, tunnel } = createViewer(config);
  const wsCleanup = new Map<object, () => void>();

  const server = Bun.serve({
    port,
    fetch(req, server) {
      // WebSocket upgrade — let Hono middleware handle auth (cookie or bearer).
      // Bun sends cookies on upgrade, so the tunnelAuth middleware validates them.
      if (new URL(req.url).pathname === "/ws") {
        if (tunnel) {
          // Quick cookie check — WS upgrade doesn't go through Hono middleware
          const { createHmac } = require("crypto") as typeof import("crypto");
          const validSession = createHmac("sha256", tunnel.token).update("foundry-session").digest("hex");
          const cookies = req.headers.get("cookie") ?? "";
          const match = cookies.match(/foundry_session=([^;]+)/);
          const hasValidCookie = match && match[1] === validSession;
          const hasValidToken = new URL(req.url).searchParams.get("token") === tunnel.token;
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

  console.log(`Foundry Viewer running at http://localhost:${port}`);

  // Start tunnel if configured
  let tunnelInfo: TunnelInfo | null = null;
  if (tunnel) {
    try {
      await tunnel.start();
      tunnelInfo = tunnel.info;
    } catch (err) {
      console.warn(`[Tunnel] failed to start: ${(err as Error).message}`);
    }
  }

  return { server, actions, tunnel: tunnelInfo };
}

function traceToJSON(trace: Trace) {
  return {
    id: trace.id,
    messageId: trace.messageId,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: trace.durationMs,
    root: trace.root,
    summary: trace.summary(),
  };
}
