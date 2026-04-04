import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { EventStream, StreamEvent } from "../agents/event-stream";
import type { Harness } from "../agents/harness";
import type { InterventionLog } from "../agents/intervention";
import type { Trace } from "../agents/trace";

export interface ViewerConfig {
  harness: Harness;
  eventStream: EventStream;
  interventions: InterventionLog;
  port?: number;
}

/**
 * Minimal local viewer — Hono server with WebSocket for live events
 * and REST endpoints for traces and interventions.
 *
 * Run with: bun run src/viewer/server.ts
 * Open: http://localhost:4400
 */
export function createViewer(config: ViewerConfig) {
  const { harness, eventStream, interventions, port = 4400 } = config;
  const app = new Hono();

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

    // Validate required fields
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

  // -- Static files (the HTML viewer) --
  app.get("/", (c) => {
    return c.html(VIEWER_HTML);
  });

  return { app, port };
}

/** Start the viewer server. */
export function startViewer(config: ViewerConfig) {
  const { app, port } = createViewer(config);

  const server = Bun.serve({
    port,
    fetch: app.fetch,
    websocket: {
      open(ws) {
        (ws as any)._unsub = config.eventStream.subscribe((event) => {
          ws.send(JSON.stringify(event));
        });
      },
      message() {},
      close(ws) {
        const unsub = (ws as any)._unsub;
        if (unsub) unsub();
      },
    },
  });

  // Upgrade WebSocket on /ws path
  const originalFetch = app.fetch;
  const wrappedApp = new Hono();

  wrappedApp.get("/ws", (c) => {
    const upgraded = server.upgrade(c.req.raw);
    if (!upgraded) return c.text("WebSocket upgrade failed", 400);
    return new Response(null);
  });

  wrappedApp.route("/", app);

  // Re-assign fetch handler
  server.reload({ fetch: wrappedApp.fetch });

  console.log(`Foundry Viewer running at http://localhost:${port}`);

  return server;
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

// -- Inline HTML (single file, no build step) --

const VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Foundry Viewer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0a0a; --surface: #141414; --border: #2a2a2a;
    --text: #e0e0e0; --text-dim: #888; --accent: #6c9eff;
    --ok: #4ade80; --error: #f87171; --running: #facc15;
    --font: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  }
  body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 13px; }
  #app { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto 1fr; height: 100vh; gap: 1px; background: var(--border); }
  header { grid-column: 1 / -1; background: var(--surface); padding: 12px 20px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 14px; font-weight: 600; color: var(--accent); }
  header .status { font-size: 11px; color: var(--text-dim); }
  header .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  header .dot.connected { background: var(--ok); }
  header .dot.disconnected { background: var(--error); }

  .panel { background: var(--surface); overflow-y: auto; padding: 12px; }
  .panel h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-dim); margin-bottom: 12px; }

  .trace-item { border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; cursor: pointer; transition: border-color 0.15s; }
  .trace-item:hover { border-color: var(--accent); }
  .trace-item .msg-id { color: var(--accent); font-weight: 500; }
  .trace-item .duration { color: var(--text-dim); float: right; }
  .trace-item .stages { margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap; }
  .stage-pill { padding: 2px 8px; border-radius: 3px; font-size: 11px; }
  .stage-pill.ok { background: rgba(74,222,128,0.15); color: var(--ok); }
  .stage-pill.error { background: rgba(248,113,113,0.15); color: var(--error); }
  .stage-pill.running { background: rgba(250,204,21,0.15); color: var(--running); }

  .span-tree { font-size: 12px; }
  .span-node { border-left: 2px solid var(--border); padding: 6px 0 6px 14px; margin-left: 8px; }
  .span-node.depth-0 { border-left: 2px solid var(--accent); margin-left: 0; }
  .span-header { display: flex; gap: 8px; align-items: baseline; cursor: pointer; }
  .span-header:hover .span-name { color: var(--accent); }
  .span-name { font-weight: 500; }
  .span-kind { color: var(--text-dim); font-size: 11px; }
  .span-duration { color: var(--text-dim); font-size: 11px; }
  .span-status { font-size: 11px; }
  .span-detail { margin-top: 6px; padding: 8px; background: var(--bg); border-radius: 4px; font-size: 11px; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; display: none; }
  .span-detail.open { display: block; }

  .event-item { padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 11px; display: flex; gap: 8px; }
  .event-item .kind { color: var(--accent); min-width: 60px; }
  .event-item .time { color: var(--text-dim); min-width: 70px; }

  .layer-bar { display: flex; align-items: center; gap: 8px; padding: 6px 8px; margin-bottom: 4px; border-radius: 4px; background: var(--bg); }
  .layer-bar .state-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .layer-bar .state-dot.warm { background: var(--ok); }
  .layer-bar .state-dot.stale { background: var(--running); }
  .layer-bar .state-dot.cold { background: var(--text-dim); }
  .layer-bar .layer-id { font-weight: 500; flex: 1; }
  .layer-bar .trust { color: var(--text-dim); font-size: 11px; }

  .override-btn { background: var(--border); color: var(--text); border: 1px solid var(--border); padding: 4px 10px; border-radius: 3px; cursor: pointer; font-family: var(--font); font-size: 11px; }
  .override-btn:hover { border-color: var(--accent); color: var(--accent); }

  #detail-panel { grid-row: 2; }
  #list-panel { grid-row: 2; }
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>foundry</h1>
    <div class="status"><span class="dot disconnected" id="ws-dot"></span><span id="ws-status">connecting...</span></div>
    <div class="status" id="event-count">0 events</div>
  </header>
  <div class="panel" id="list-panel">
    <h2>Traces</h2>
    <div id="traces"></div>
    <h2 style="margin-top:16px">Layers</h2>
    <div id="layers"></div>
    <h2 style="margin-top:16px">Live Events</h2>
    <div id="events"></div>
  </div>
  <div class="panel" id="detail-panel">
    <h2>Detail</h2>
    <div id="detail"><span style="color:var(--text-dim)">Click a trace to inspect</span></div>
  </div>
</div>
<script>
const $ = (s) => document.querySelector(s);
let ws, eventCount = 0, traces = [], currentTrace = null;

function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }

function connect() {
  ws = new WebSocket(\`ws://\${location.host}/ws\`);
  ws.onopen = () => { $('#ws-dot').className = 'dot connected'; $('#ws-status').textContent = 'connected'; };
  ws.onclose = () => { $('#ws-dot').className = 'dot disconnected'; $('#ws-status').textContent = 'reconnecting...'; setTimeout(connect, 2000); };
  ws.onmessage = (e) => { eventCount++; $('#event-count').textContent = eventCount + ' events'; addEvent(JSON.parse(e.data)); };
}

function addEvent(ev) {
  const el = document.createElement('div');
  el.className = 'event-item';
  el.innerHTML = '<span class="kind">' + esc(ev.kind) + '</span><span class="time">' + new Date().toLocaleTimeString() + '</span><span>' + esc(ev.threadId || ev.event?.threadId || '') + '</span>';
  const container = $('#events');
  container.prepend(el);
  if (container.children.length > 200) container.lastChild.remove();
}

async function loadTraces() {
  const res = await fetch('/api/traces?limit=50');
  traces = await res.json();
  renderTraces();
}

function renderTraces() {
  const container = $('#traces');
  container.innerHTML = '';
  for (const t of traces) {
    const el = document.createElement('div');
    el.className = 'trace-item';
    el.innerHTML = '<span class="msg-id">' + esc(t.messageId) + '</span>'
      + '<span class="duration">' + (t.totalDurationMs ? t.totalDurationMs.toFixed(1) + 'ms' : '...') + '</span>'
      + '<div class="stages">' + t.stages.map(s =>
        '<span class="stage-pill ' + esc(s.status) + '">' + esc(s.name) + (s.durationMs ? ' ' + s.durationMs.toFixed(0) + 'ms' : '') + '</span>'
      ).join('') + '</div>';
    el.onclick = () => loadTraceDetail(t.traceId);
    container.appendChild(el);
  }
}

async function loadTraceDetail(traceId) {
  const res = await fetch('/api/traces/' + traceId);
  if (!res.ok) return;
  currentTrace = await res.json();
  renderDetail();
}

function renderDetail() {
  if (!currentTrace) return;
  const t = currentTrace;
  let html = '<div style="margin-bottom:12px"><strong>' + esc(t.messageId) + '</strong> <span style="color:var(--text-dim)">' + (t.durationMs ? t.durationMs.toFixed(1) + 'ms' : '') + '</span></div>';
  html += '<div class="span-tree">' + renderSpan(t.root, 0) + '</div>';
  $('#detail').innerHTML = html;

  // Wire up click handlers for span detail toggle
  document.querySelectorAll('.span-header').forEach(el => {
    el.onclick = () => {
      const detail = el.nextElementSibling;
      if (detail && detail.classList.contains('span-detail')) {
        detail.classList.toggle('open');
      }
    };
  });
}

function renderSpan(span, depth) {
  const statusClass = span.status || 'ok';
  const dur = span.durationMs ? span.durationMs.toFixed(1) + 'ms' : '';
  const agent = span.agentId ? ' → ' + span.agentId : '';
  const layers = span.layerIds ? ' [' + span.layerIds.join(', ') + ']' : '';

  let html = '<div class="span-node depth-' + depth + '">';
  html += '<div class="span-header">';
  html += '<span class="span-name">' + esc(span.name) + '</span>';
  html += '<span class="span-kind">' + esc(span.kind) + '</span>';
  html += '<span class="span-status ' + esc(statusClass) + '">' + esc(statusClass) + '</span>';
  html += '<span class="span-duration">' + dur + '</span>';
  html += '</div>';

  // Detail (input/output, click to expand)
  const detail = {
    agent: span.agentId,
    layers: span.layerIds,
    contextHash: span.contextHash,
    input: span.input,
    output: span.output,
    error: span.error,
    annotations: span.annotations && Object.keys(span.annotations).length ? span.annotations : undefined,
  };
  html += '<div class="span-detail">' + JSON.stringify(detail, null, 2) + '</div>';

  // Children
  if (span.children && span.children.length > 0) {
    for (const child of span.children) {
      html += renderSpan(child, depth + 1);
    }
  }

  // Override button for route/classify spans
  if (span.kind === 'route' || span.kind === 'classify') {
    html += '<button class="override-btn" onclick="showOverride(\\'' + currentTrace.id + '\\', \\'' + span.id + '\\', this)">override</button>';
  }

  html += '</div>';
  return html;
}

window.showOverride = function(traceId, spanId, btn) {
  const correction = prompt('What should this have been? (JSON or text)');
  if (!correction) return;
  fetch('/api/interventions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      traceId, spanId,
      actual: null,
      correction,
      operator: 'ui',
      reason: 'manual override from viewer'
    })
  }).then(() => { btn.textContent = 'overridden ✓'; btn.disabled = true; });
};

async function loadLayers() {
  const res = await fetch('/api/threads');
  const data = await res.json();
  const container = $('#layers');
  container.innerHTML = '';
  for (const l of data.layers) {
    const el = document.createElement('div');
    el.className = 'layer-bar';
    el.innerHTML = '<span class="state-dot ' + esc(l.state) + '"></span>'
      + '<span class="layer-id">' + esc(l.id) + '</span>'
      + '<span class="trust">trust:' + esc(l.trust) + '</span>'
      + '<span style="color:var(--text-dim);font-size:11px">' + (l.contentLength / 4 | 0) + ' tok</span>';
    container.appendChild(el);
  }
}

connect();
loadTraces();
loadLayers();
setInterval(loadTraces, 3000);
setInterval(loadLayers, 5000);
</script>
</body>
</html>`;
