import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { EventStream, StreamEvent } from "../agents/event-stream";
import type { Harness } from "../agents/harness";
import type { InterventionLog } from "../agents/intervention";
import type { Trace } from "../agents/trace";
import { ActionHandler, type OperatorAction } from "./actions";

export interface ViewerConfig {
  harness: Harness;
  eventStream: EventStream;
  interventions: InterventionLog;
  port?: number;
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

  // -- Static: UI files --
  // Serves the Preact-based UI from /ui/*

  app.get("/ui/*", serveStatic({ root: "./src/viewer/" }));

  // Root serves the HTML shell
  app.get("/", serveStatic({ path: "./src/viewer/ui/index.html" }));

  return { app, port, actions };
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
