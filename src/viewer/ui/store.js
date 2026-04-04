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
export const liveEvents = signal([]);
export const activePanel = signal("conversation"); // "conversation" | "layers" | "events"
export const commandPaletteOpen = signal(false);
export const helpOpen = signal(false);
export const toast = signal(null); // { message, type: "ok"|"error" }

// Derived
export const layers = computed(() => threadData.value?.layers ?? []);
export const agents = computed(() => threadData.value?.agents ?? []);

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
    const res = await fetch("/api/threads");
    threadData.value = await res.json();
  } catch { /* offline */ }
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
  // Fallback polling
  setInterval(loadTraces, 15000);
  setInterval(loadThreads, 20000);
}
