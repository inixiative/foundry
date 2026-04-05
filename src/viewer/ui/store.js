/**
 * Foundry UI store — WebSocket connection, state management via signals.
 *
 * All state lives in signals. Components subscribe automatically.
 * WebSocket updates are batched per animation frame for performance.
 */

import { signal, computed, batch } from "./lib.js";

// ---------------------------------------------------------------------------
// State signals
// ---------------------------------------------------------------------------

export const connected = signal(false);
export const eventCount = signal(0);
export const traces = signal([]);
export const currentTrace = signal(null);
export const selectedSpanId = signal(null);
export const threadData = signal(null);
export const allThreads = signal([]);   // all threads (multi-thread support)
export const liveEvents = signal([]);
export const activePanel = signal("conversation"); // "conversation" | "layers" | "events"
export const commandPaletteOpen = signal(false);
export const helpOpen = signal(false);
export const toast = signal(null); // { message, type: "ok"|"error" }

// Projects
export const projects = signal([]);     // ProjectSummary[]
export const projectTags = signal([]);  // string[]
export const activeProjectId = signal(null); // selected project ID or null (global)
export const projectSidebarOpen = signal(true); // collapsed state

// Conversation — chat messages (user + agent responses)
// Each entry: { role: "user"|"agent", content, timestamp, traceId?, classification?, route?, error? }
export const messages = signal([]);
export const sending = signal(false);

// Definitions (config-level, not runtime instances)
export const definitions = signal({ layers: [], agents: [], sources: [] });

// Derived — runtime instances
export const layers = computed(() => threadData.value?.layers ?? []);
export const agents = computed(() => threadData.value?.agents ?? []);

// Derived — merge instances with definitions
export const mergedLayers = computed(() => {
  const instances = threadData.value?.layers ?? [];
  const defs = definitions.value?.layers ?? [];
  const instanceIds = new Set(instances.map(l => l.id));
  const uninstantiated = defs.filter(d => d.enabled && !instanceIds.has(d.id));
  return { instances, uninstantiated };
});

export const mergedAgents = computed(() => {
  const instances = threadData.value?.agents ?? [];
  const defs = definitions.value?.agents ?? [];
  const instanceIds = new Set(instances.map(a => a.agentId));
  const uninstantiated = defs.filter(d => d.enabled && !instanceIds.has(d.id));
  return { instances, uninstantiated };
});

// Layer color cache — persistent color per layer ID
const _layerColors = {};
const LAYER_PALETTE = [
  "#6c9eff", "#4ade80", "#f87171", "#facc15", "#c084fc",
  "#fb923c", "#22d3ee", "#f472b6", "#a3e635", "#e879f9",
  "#38bdf8", "#fbbf24", "#34d399", "#f97316", "#a78bfa",
];

export function layerColor(layerId) {
  if (!_layerColors[layerId]) {
    // Hash the ID to pick a stable color
    let hash = 0;
    for (let i = 0; i < layerId.length; i++) {
      hash = ((hash << 5) - hash + layerId.charCodeAt(i)) | 0;
    }
    _layerColors[layerId] = LAYER_PALETTE[Math.abs(hash) % LAYER_PALETTE.length];
  }
  return _layerColors[layerId];
}

// ---------------------------------------------------------------------------
// WebSocket — batched updates per frame
// ---------------------------------------------------------------------------

let ws = null;
let pendingEvents = [];
let frameScheduled = false;

function flushEvents() {
  frameScheduled = false;
  if (pendingEvents.length === 0) return;

  const events = pendingEvents;
  pendingEvents = [];

  batch(() => {
    eventCount.value += events.length;

    // Prepend to live events, cap at 200
    const current = liveEvents.value;
    const next = [...events.map(ev => ({
      ...ev,
      _time: new Date().toLocaleTimeString(),
    })), ...current];
    liveEvents.value = next.length > 200 ? next.slice(0, 200) : next;
  });

  // Debounced data refresh
  scheduleRefresh();
}

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    loadTraces();
    loadThreads();
  }, 500);
}

export function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { connected.value = true; };
  ws.onclose = () => {
    connected.value = false;
    setTimeout(connect, 2000);
  };
  ws.onmessage = (e) => {
    pendingEvents.push(JSON.parse(e.data));
    if (!frameScheduled) {
      frameScheduled = true;
      requestAnimationFrame(flushEvents);
    }
  };
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export async function loadTraces() {
  try {
    const res = await fetch("/api/traces?limit=50");
    traces.value = await res.json();
  } catch { /* offline */ }
}

export async function loadTraceDetail(traceId) {
  try {
    const res = await fetch(`/api/traces/${encodeURIComponent(traceId)}`);
    if (res.ok) {
      currentTrace.value = await res.json();
      selectedSpanId.value = null;
    }
  } catch { /* offline */ }
}

export async function loadThreads() {
  try {
    const projectId = activeProjectId.value;
    const url = projectId
      ? `/api/threads?project=${encodeURIComponent(projectId)}`
      : "/api/threads";
    const res = await fetch(url);
    const data = await res.json();

    // New format: { threads: [...] } or legacy { threadId, meta, ... }
    if (data.threads) {
      // Multi-thread format — store first thread as primary for backwards compat
      threadData.value = data.threads[0] ?? null;
      allThreads.value = data.threads;
    } else {
      // Legacy single-thread format
      threadData.value = data;
      allThreads.value = [data];
    }
  } catch { /* offline */ }
}

export async function loadDefinitions() {
  try {
    const res = await fetch("/api/definitions");
    definitions.value = await res.json();
  } catch { /* offline */ }
}

export async function loadProjects() {
  try {
    const res = await fetch("/api/projects");
    const data = await res.json();
    projects.value = data.projects ?? [];
    projectTags.value = data.tags ?? [];
  } catch { /* offline */ }
}

export async function createProject(config) {
  try {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    if (res.ok) {
      showToast(`Project added: ${config.label || config.id}`, "ok");
      loadProjects();
      return true;
    }
    showToast("Failed to create project", "error");
    return false;
  } catch (err) {
    showToast(`Failed: ${err.message}`, "error");
    return false;
  }
}

export async function deleteProject(id) {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) {
      showToast(`Removed: ${id}`, "ok");
      if (activeProjectId.value === id) activeProjectId.value = null;
      loadProjects();
      return true;
    }
    return false;
  } catch { return false; }
}

export async function createDefinition(section, id, data) {
  try {
    const res = await fetch(`/api/settings/${section}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [id]: data }),
    });
    if (res.ok) {
      showToast(`Created ${section.slice(0, -1)}: ${id}`, "ok");
      loadDefinitions();
      return true;
    }
    showToast("Creation failed", "error");
    return false;
  } catch (err) {
    showToast(`Failed: ${err.message}`, "error");
    return false;
  }
}

export async function deleteDefinition(section, id) {
  try {
    const res = await fetch(`/api/settings/${section}/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      showToast(`Deleted: ${id}`, "ok");
      loadDefinitions();
      return true;
    }
    return false;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Chat — send messages through harness
// ---------------------------------------------------------------------------

export async function sendMessage(text) {
  if (!text.trim() || sending.value) return;

  // Add user message immediately
  const userMsg = { role: "user", content: text, timestamp: Date.now() };
  messages.value = [...messages.value, userMsg];
  sending.value = true;

  try {
    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const result = await res.json();

    if (result.error) {
      messages.value = [...messages.value, {
        role: "agent",
        content: result.error,
        timestamp: Date.now(),
        error: true,
      }];
    } else {
      messages.value = [...messages.value, {
        role: "agent",
        content: result.output,
        timestamp: result.timestamp || Date.now(),
        traceId: result.traceId,
        classification: result.classification,
        route: result.route,
        trace: result.trace,
      }];
    }

    // Refresh traces so the new trace appears
    loadTraces();
    loadThreads();
  } catch (err) {
    messages.value = [...messages.value, {
      role: "agent",
      content: `Connection error: ${err.message}`,
      timestamp: Date.now(),
      error: true,
    }];
  } finally {
    sending.value = false;
  }
}

export async function executeAction(kind, target, payload) {
  try {
    const res = await fetch("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, target, payload, timestamp: Date.now() }),
    });
    const result = await res.json();
    showToast(result.message, result.ok ? "ok" : "error");
    // Refresh state after action
    loadThreads();
    return result;
  } catch (err) {
    showToast(`Action failed: ${err.message}`, "error");
    return { ok: false, message: err.message };
  }
}

export async function submitIntervention(traceId, spanId, correction, reason) {
  try {
    const res = await fetch("/api/interventions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        traceId, spanId,
        actual: null,
        correction,
        operator: "ui",
        reason: reason || "manual override from viewer",
      }),
    });
    const result = await res.json();
    showToast("Correction submitted", "ok");
    return result;
  } catch (err) {
    showToast(`Override failed: ${err.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;
export function showToast(message, type = "ok") {
  toast.value = { message, type };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = null; }, 3000);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function init() {
  connect();
  loadTraces();
  loadThreads();
  loadDefinitions();
  loadProjects();
  // Fallback polling
  setInterval(loadTraces, 15000);
  setInterval(loadThreads, 20000);
  setInterval(loadDefinitions, 30000);
  setInterval(loadProjects, 30000);
}
