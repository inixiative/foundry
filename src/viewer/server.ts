import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { EventStream, StreamEvent } from "../agents/event-stream";
import type { Harness } from "../agents/harness";
import type { InterventionLog } from "../agents/intervention";
import type { Trace } from "../agents/trace";
import type { LLMProvider } from "../providers/types";
import type { TokenTracker } from "../agents/token-tracker";
import { ActionHandler, type OperatorAction } from "./actions";
import { ConfigStore, type FoundryConfig } from "./config";
import { AIAssist, type AssistRequest } from "./ai-assist";
import { AnalyticsStore, type RollupPeriod } from "./analytics";

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
    analyticsStore.load().catch(() => {});
    analyticsStore.connectTracker(config.tokenTracker);
  }

  // -- REST: Traces --

  app.get("/api/traces", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const summaries = harness.traces.slice(-limit).map((t) => t.summary());
    return c.json(summaries.reverse());
  });

  app.get("/api/traces/:id", (c) => {
    const trace = harness.getTrace(c.req.param("id"));
    if (!trace) return c.json({ error: "not found" }, 404);
    return c.json(traceToJSON(trace));
  });

  app.get("/api/traces/message/:id", (c) => {
    const trace = harness.getTraceForMessage(c.req.param("id"));
    if (!trace) return c.json({ error: "not found" }, 404);
    return c.json(traceToJSON(trace));
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

  app.get("/api/threads", (c) => {
    const threads = [...harness.thread.agents.entries()].map(([id, agent]) => ({
      id,
      agentId: agent.id,
    }));
    return c.json({
      threadId: harness.thread.id,
      meta: harness.thread.meta,
      agents: threads,
      layerCount: harness.thread.stack.layers.length,
      layers: harness.thread.stack.layers.map((l) => ({
        id: l.id,
        state: l.state,
        trust: l.trust,
        hash: l.hash,
        contentLength: l.content.length,
      })),
    });
  });

  app.get("/api/events", (c) => {
    const kind = c.req.query("kind") as StreamEvent["kind"] | undefined;
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json(eventStream.recent({ kind, limit }));
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
    return c.json(analyticsStore.snapshot(config.tokenTracker));
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

  // -- Static: UI files --
  // Serves the Preact-based UI from /ui/*

  app.get("/ui/*", serveStatic({ root: "./src/viewer/" }));

  // Root serves the HTML shell
  app.get("/", serveStatic({ path: "./src/viewer/ui/index.html" }));

  return { app, port, actions, configStore, analyticsStore };
}

/** Start the viewer server. */
export function startViewer(config: ViewerConfig) {
  const { app, port, actions } = createViewer(config);
  const wsCleanup = new Map<object, () => void>();

  const server = Bun.serve({
    port,
    fetch: app.fetch,
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

  // Upgrade WebSocket on /ws path
  const wrappedApp = new Hono();

  wrappedApp.get("/ws", (c) => {
    const upgraded = server.upgrade(c.req.raw);
    if (!upgraded) return c.text("WebSocket upgrade failed", 400);
    return new Response(null);
  });

  wrappedApp.route("/", app);

  server.reload({ fetch: wrappedApp.fetch });

  console.log(`Foundry Viewer running at http://localhost:${port}`);

  return { server, actions };
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
