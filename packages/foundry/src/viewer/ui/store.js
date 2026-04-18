/**
 * Foundry UI store — WebSocket connection, state management via signals.
 *
 * All state lives in signals. Components subscribe automatically.
 * WebSocket updates are batched per animation frame for performance.
 */

import { signal, computed, batch, effect } from "./lib.js";

// ---------------------------------------------------------------------------
// Auth — cookie-based auth handles most cases. authFetch is a fallback
// for programmatic/API access where a bearer token is passed in the URL.
// ---------------------------------------------------------------------------

/** Wrapper around fetch that includes credentials (cookies) automatically. */
export function authFetch(url, opts = {}) {
  // Always send cookies (needed for tunnel session cookie)
  opts.credentials = "same-origin";
  return fetch(url, opts);
}

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
export const activeThreadId = signal(null); // selected thread ID (null = first/default)
export const liveEvents = signal([]);
export const activePanel = signal("conversation"); // "conversation" | "layers" | "events"
export const commandPaletteOpen = signal(false);
export const helpOpen = signal(false);
export const toast = signal(null); // { message, type: "ok"|"error"|"warn", persistent?: boolean }

// Projects
export const projects = signal([]);     // ProjectSummary[]
export const projectTags = signal([]);  // string[]
export const activeProjectId = signal(null); // selected project ID or null (global)
export const projectSidebarOpen = signal(true); // collapsed state
export const detailDrawerOpen = signal(true);   // right panel collapsed state

// Action prompts — pending agent→human interactions
export const prompts = signal([]);       // ActionPrompt[]
export const promptCounts = signal({});  // { threadId: count }

// Worktrees — detected git worktrees for thread assignment
export const worktrees = signal([]);   // GitWorktree[] from GET /api/worktrees

// Token usage — session totals + budget
export const tokenUsage = signal(null); // { usedTokens, usedCost, percentage, warning, exceeded, totalInput, totalOutput, totalCalls }

// Conversation — chat messages (user + agent responses)
// Each entry: { role: "user"|"agent", content, timestamp, traceId?, classification?, route?, error? }
export const messages = signal([]);
export const inflight = signal(0); // count of in-flight API requests
export const sending = computed(() => inflight.value > 0); // backwards compat

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
let wasConnected = false; // track for live reload on server restart

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
    loadPrompts();
  }, 500);
}

export function connect() {
  // Browser sends cookies on WS upgrade automatically (same-origin).
  // For tunnel mode, the session cookie set by /auth handles auth.
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${wsProto}//${location.host}/ws`);
  ws.onopen = () => {
    if (wasConnected) {
      // Server restarted (bun --watch) — reload to pick up fresh assets
      location.reload();
      return;
    }
    wasConnected = true;
    connected.value = true;
  };
  ws.onclose = () => {
    connected.value = false;
    setTimeout(connect, 2000);
  };
  ws.onmessage = (e) => {
    const event = JSON.parse(e.data);
    // Surface error events from the backend as toasts
    if (event.kind === "error") {
      showToast(`[${event.source}] ${event.message}`, event.severity === "warn" ? "warn" : "error");
    }
    pendingEvents.push(event);
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
    const res = await authFetch("/api/traces?limit=50");
    if (!res.ok) { showToast(`Failed to load traces: ${res.status}`, "error"); return; }
    traces.value = await res.json();
  } catch (err) {
    if (connected.value) showToast(`Traces unavailable: ${err.message}`, "warn");
  }
}

export async function loadTraceDetail(traceId) {
  try {
    const res = await authFetch(`/api/traces/${encodeURIComponent(traceId)}`);
    if (res.ok) {
      currentTrace.value = await res.json();
      selectedSpanId.value = null;
    } else {
      showToast(`Failed to load trace: ${res.status}`, "error");
    }
  } catch (err) {
    if (connected.value) showToast(`Trace unavailable: ${err.message}`, "warn");
  }
}

export async function loadThreads() {
  try {
    const projectId = activeProjectId.value;
    const url = projectId
      ? `/api/threads?project=${encodeURIComponent(projectId)}`
      : "/api/threads";
    const res = await authFetch(url);
    if (!res.ok) { showToast(`Failed to load threads: ${res.status}`, "error"); return; }
    const data = await res.json();

    // New format: { threads: [...] } or legacy { threadId, meta, ... }
    if (data.threads) {
      allThreads.value = data.threads;
      // Auto-set activeThreadId if not already set (e.g. first load without hash)
      if (!activeThreadId.value && data.threads.length > 0) {
        activeThreadId.value = data.threads[0].threadId;
      }
      const active = activeThreadId.value;
      const match = active ? data.threads.find(t => t.threadId === active) : null;
      threadData.value = match ?? data.threads[0] ?? null;
      // Always load messages for active thread if we don't have them yet
      if (active && messages.value.length === 0 && !_threadMessages[active]) {
        _loadThreadMessages(active);
      }
    } else {
      // Legacy single-thread format
      threadData.value = data;
      allThreads.value = [data];
      if (!activeThreadId.value && data.threadId) {
        activeThreadId.value = data.threadId;
      }
      const active = activeThreadId.value;
      if (active && messages.value.length === 0 && !_threadMessages[active]) {
        _loadThreadMessages(active);
      }
    }
  } catch (err) {
    if (connected.value) showToast(`Threads unavailable: ${err.message}`, "warn");
  }
}

export async function loadPrompts() {
  try {
    const res = await authFetch("/api/prompts");
    if (!res.ok) return;
    const data = await res.json();
    prompts.value = data.prompts ?? [];
  } catch { /* silent */ }

  try {
    const res = await authFetch("/api/prompts/count");
    if (!res.ok) return;
    const data = await res.json();
    promptCounts.value = data.byThread ?? {};
  } catch { /* silent */ }
}

export async function resolvePrompt(promptId, action, input) {
  try {
    const res = await fetch(`/api/prompts/${encodeURIComponent(promptId)}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, input }),
    });
    if (res.ok) {
      showToast(`Prompt resolved: ${action}`, "ok");
      loadPrompts();
      return true;
    }
    const err = await res.json();
    showToast(err.error || "Failed to resolve prompt", "error");
    return false;
  } catch (err) {
    showToast(`Prompt resolution failed: ${err.message}`, "error");
    return false;
  }
}

/** Rough token estimate — ~4 chars per token for code-mixed content. */
function estimateContextTokens(msgs) {
  let chars = 0;
  for (const m of msgs) {
    chars += (m.content || "").length;
  }
  return Math.ceil(chars / 4);
}

export async function loadTokenUsage() {
  try {
    const [budgetRes, analyticsRes, settingsRes] = await Promise.all([
      authFetch("/api/analytics/budget"),
      authFetch("/api/analytics"),
      authFetch("/api/settings"),
    ]);
    const budget = budgetRes.ok ? await budgetRes.json() : {};
    const analytics = analyticsRes.ok ? await analyticsRes.json() : {};
    const settings = settingsRes.ok ? await settingsRes.json() : {};
    const session = analytics.session ?? {};

    // Resolve active model's context window from provider config
    const provider = settings.providers?.[settings.defaults?.provider];
    const model = provider?.models?.find(m => m.id === settings.defaults?.model);
    const contextWindow = model?.contextWindow ?? null;

    // Estimate current context fill from messages
    const contextTokens = estimateContextTokens(messages.value);

    tokenUsage.value = {
      usedTokens: budget.usedTokens ?? session.totalTokens ?? 0,
      usedCost: budget.usedCost ?? session.totalCost ?? 0,
      limitTokens: budget.limitTokens,
      limitCost: budget.limitCost,
      percentage: budget.percentage ?? 0,
      warning: budget.warning ?? false,
      exceeded: budget.exceeded ?? false,
      totalInput: session.totalInput ?? 0,
      totalOutput: session.totalOutput ?? 0,
      totalCalls: session.totalCalls ?? 0,
      contextWindow,
      contextTokens,
      contextPct: contextWindow ? contextTokens / contextWindow : null,
    };
  } catch { /* silent — analytics may not be configured */ }
}

export async function loadDefinitions() {
  try {
    const res = await authFetch("/api/definitions");
    if (!res.ok) { showToast(`Failed to load definitions: ${res.status}`, "error"); return; }
    definitions.value = await res.json();
  } catch (err) {
    if (connected.value) showToast(`Definitions unavailable: ${err.message}`, "warn");
  }
}

export async function loadWorktrees() {
  try {
    const res = await authFetch("/api/worktrees");
    if (!res.ok) return;
    const data = await res.json();
    worktrees.value = data.worktrees ?? [];
  } catch { /* silent — git may not be available */ }
}

export async function loadProjects() {
  try {
    const res = await authFetch("/api/projects");
    if (!res.ok) { showToast(`Failed to load projects: ${res.status}`, "error"); return; }
    const data = await res.json();
    projects.value = data.projects ?? [];
    projectTags.value = data.tags ?? [];
  } catch (err) {
    if (connected.value) showToast(`Projects unavailable: ${err.message}`, "warn");
  }
}

export async function createProject(config) {
  try {
    const res = await authFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    if (res.ok) {
      const created = await res.json();
      showToast(`Project added: ${created.label || created.id}`, "ok");
      loadProjects();
      return true;
    }
    const err = await res.json().catch(() => ({}));
    showToast(err.error || "Failed to create project", "error");
    return false;
  } catch (err) {
    showToast(`Failed: ${err.message}`, "error");
    return false;
  }
}

export async function deleteProject(id) {
  try {
    const res = await authFetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) {
      showToast(`Removed: ${id}`, "ok");
      if (activeProjectId.value === id) activeProjectId.value = null;
      loadProjects();
      return true;
    }
    const body = await res.json().catch(() => ({}));
    showToast(`Failed to delete project: ${body.error || res.status}`, "error");
    return false;
  } catch (err) {
    showToast(`Failed to delete project: ${err.message}`, "error");
    return false;
  }
}

export async function createThread({ description, tags, worktreePath, branch } = {}) {
  try {
    const projectId = activeProjectId.value || undefined;
    const res = await authFetch("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, description, tags, worktreePath, branch }),
    });
    if (res.ok) {
      const created = await res.json();
      showToast(`Thread created: ${created.threadId}`, "ok");
      loadThreads();
      return created;
    }
    const err = await res.json().catch(() => ({}));
    showToast(err.error || "Failed to create thread", "error");
    return null;
  } catch (err) {
    showToast(`Failed: ${err.message}`, "error");
    return null;
  }
}

export async function revertThread(messageIndex) {
  const tid = activeThreadId.value;
  if (!tid) return;

  const msgs = messages.value;
  if (messageIndex < 0 || messageIndex >= msgs.length) return;

  // Truncate locally first (optimistic)
  const kept = msgs.slice(0, messageIndex + 1);
  messages.value = kept;
  _threadMessages[tid] = kept;
  _persistLocal(tid, kept);

  // Tell server to clean up DB
  try {
    const res = await authFetch(`/api/threads/${encodeURIComponent(tid)}/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keepCount: messageIndex + 1 }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || "Revert failed", "error");
      return;
    }
    showToast("Reverted", "ok");
  } catch (err) {
    showToast(`Revert failed: ${err.message}`, "error");
  }
}

export async function forkThread(messageIndex) {
  const tid = activeThreadId.value;
  if (!tid) return;

  const msgs = messages.value;
  if (messageIndex < 0 || messageIndex >= msgs.length) return;

  const forkedMessages = msgs.slice(0, messageIndex + 1);

  try {
    const res = await authFetch(`/api/threads/${encodeURIComponent(tid)}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ copyCount: messageIndex + 1 }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || "Fork failed", "error");
      return;
    }
    const newThread = await res.json();
    showToast(`Forked → ${newThread.meta?.description || newThread.threadId}`, "ok");

    // Pre-populate new thread's messages so switching is instant
    _threadMessages[newThread.threadId] = forkedMessages;

    await loadThreads();
    selectThread(newThread.threadId);
  } catch (err) {
    showToast(`Fork failed: ${err.message}`, "error");
  }
}

export async function updateThreadWorktree(threadId, worktreePath, branch) {
  try {
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreePath, branch }),
    });
    if (res.ok) {
      showToast("Worktree updated", "ok");
      loadThreads();
      return true;
    }
    const err = await res.json().catch(() => ({}));
    showToast(err.error || "Failed to update worktree", "error");
    return false;
  } catch (err) {
    showToast(`Failed: ${err.message}`, "error");
    return false;
  }
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
    const body = await res.json().catch(() => ({}));
    showToast(`Failed to delete ${id}: ${body.error || res.status}`, "error");
    return false;
  } catch (err) {
    showToast(`Failed to delete ${id}: ${err.message}`, "error");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Chat — send messages through harness
// ---------------------------------------------------------------------------

// Per-thread message store — keeps messages when switching threads
const _threadMessages = {};

/** Select a thread by ID — switches active thread, restores its messages. */
export function selectThread(threadId) {
  const prev = activeThreadId.value;
  if (prev === threadId) return;

  // Always save current messages (even if prev is the initial default)
  const saveKey = prev ?? "_default";
  _threadMessages[saveKey] = messages.value;

  // Switch
  activeThreadId.value = threadId;

  // Restore from cache or load from server
  if (_threadMessages[threadId]) {
    messages.value = _threadMessages[threadId];
  } else {
    messages.value = [];
    // Load history from server (fire-and-forget, updates when ready)
    _loadThreadMessages(threadId);
  }

  // Update threadData from allThreads
  const match = allThreads.value.find(t => t.threadId === threadId);
  if (match) threadData.value = match;
}

/** Save messages to localStorage as fallback (no-DB setups). */
function _persistLocal(threadId, msgs) {
  try {
    localStorage.setItem(`foundry:msgs:${threadId}`, JSON.stringify(msgs));
  } catch { /* quota exceeded or private browsing — skip */ }
}

/** Read messages from localStorage fallback. */
function _loadLocal(threadId) {
  try {
    const raw = localStorage.getItem(`foundry:msgs:${threadId}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

/** Load persisted messages for a thread — server first, localStorage fallback. */
async function _loadThreadMessages(threadId) {
  try {
    const res = await authFetch(`/api/messages?threadId=${encodeURIComponent(threadId)}`);
    if (res.ok) {
      const data = await res.json();
      const msgs = data.messages ?? [];
      if (msgs.length > 0) {
        _threadMessages[threadId] = msgs;
        if (activeThreadId.value === threadId) messages.value = msgs;
        return;
      }
    }
  } catch { /* fall through to localStorage */ }

  // Fallback: localStorage
  const local = _loadLocal(threadId);
  if (local.length > 0) {
    _threadMessages[threadId] = local;
    if (activeThreadId.value === threadId) messages.value = local;
  }
}

export async function sendMessage(text) {
  if (!text.trim()) return;

  // Add user message immediately — input stays interactive
  const userMsg = { role: "user", content: text, timestamp: Date.now() };
  messages.value = [...messages.value, userMsg];

  // Track in-flight (non-blocking — user can keep typing)
  inflight.value++;

  // Fire API call in background — don't await in caller
  _processMessageInBackground(text);
}

async function _processMessageInBackground(text) {
  try {
    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, threadId: activeThreadId.value || undefined }),
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

    // Refresh in parallel after response
    Promise.all([loadTraces(), loadThreads(), loadTokenUsage()]);
  } catch (err) {
    messages.value = [...messages.value, {
      role: "agent",
      content: `Connection error: ${err.message}`,
      timestamp: Date.now(),
      error: true,
    }];
  } finally {
    inflight.value = Math.max(0, inflight.value - 1);
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
/**
 * Show a toast notification.
 *
 * - "ok" toasts auto-dismiss after 3s
 * - "warn" toasts auto-dismiss after 6s
 * - "error" toasts are persistent — user must dismiss manually
 *
 * @param {string} message
 * @param {"ok"|"error"|"warn"} type
 */
export function showToast(message, type = "ok") {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  const persistent = type === "error";
  toast.value = { message, type, persistent };
  if (!persistent) {
    const delay = type === "warn" ? 6000 : 3000;
    toastTimer = setTimeout(() => { toast.value = null; }, delay);
  }
}

export function dismissToast() {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  toast.value = null;
}

// ---------------------------------------------------------------------------
// View state — persist to URL hash so refresh restores position
// ---------------------------------------------------------------------------

const VIEW_KEYS = ["project", "thread", "panel", "sidebar", "detail"];

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  return Object.fromEntries(VIEW_KEYS.map(k => [k, params.get(k)]));
}

function writeHash() {
  const params = new URLSearchParams();
  if (activeProjectId.value) params.set("project", activeProjectId.value);
  if (activeThreadId.value) params.set("thread", activeThreadId.value);
  if (activePanel.value !== "conversation") params.set("panel", activePanel.value);
  if (!projectSidebarOpen.value) params.set("sidebar", "0");
  if (!detailDrawerOpen.value) params.set("detail", "0");
  const hash = params.toString();
  // Replace silently — no history entry per state change
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname);
}

function restoreFromHash() {
  const h = readHash();
  if (h.project) activeProjectId.value = h.project;
  if (h.thread) activeThreadId.value = h.thread;
  if (h.panel) activePanel.value = h.panel;
  if (h.sidebar === "0") projectSidebarOpen.value = false;
  if (h.detail === "0") detailDrawerOpen.value = false;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function init() {
  // Restore view state from URL hash before loading data
  restoreFromHash();

  connect();
  loadTraces();
  loadThreads();
  loadDefinitions();
  loadProjects();
  loadWorktrees();
  loadPrompts();
  loadTokenUsage();
  // Fallback polling
  setInterval(loadTraces, 15000);
  setInterval(loadThreads, 20000);
  setInterval(loadDefinitions, 30000);
  setInterval(loadProjects, 30000);
  setInterval(loadWorktrees, 30000);
  setInterval(loadPrompts, 5000); // prompts poll faster — they're time-sensitive
  setInterval(loadTokenUsage, 10000); // token usage updates after each message + periodic

  // Sync view state → URL hash on any change
  effect(() => {
    // Touch all signals to subscribe
    activeProjectId.value;
    activeThreadId.value;
    activePanel.value;
    projectSidebarOpen.value;
    detailDrawerOpen.value;
    writeHash();
  });

  // Persist messages to localStorage on every change (fallback for no-DB setups)
  effect(() => {
    const tid = activeThreadId.value;
    const msgs = messages.value;
    if (tid && msgs.length > 0) {
      _persistLocal(tid, msgs);
    }
  });

  // Reload threads when active project changes
  let prevProject = activeProjectId.value;
  effect(() => {
    const cur = activeProjectId.value;
    if (cur !== prevProject) {
      prevProject = cur;
      loadThreads();
    }
  });

  // Handle back/forward navigation
  window.addEventListener("hashchange", () => {
    restoreFromHash();
  });
}
