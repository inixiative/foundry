/**
 * Foundry UI store — WebSocket connection, state management via signals.
 *
 * All state lives in signals. Components subscribe automatically.
 * WebSocket updates are batched per animation frame for performance.
 */

import { signal, computed, batch, effect } from "./lib.js";
import { acceptLiveSnapshot, mergeLiveSnapshot } from './live-state.js';
import { mergeMessageHistory, updateTurnMessage, readMessageStream, terminalMessagePatch, persistBrowserMessages,
  reconcileThreadMessages, reconcileTargets, selectedDetailTarget } from "./conversation-state.js";

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
export const selectedEvent = signal(null);
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
export const compactPanel = signal("conversation");

// Action prompts — pending agent→human interactions
export const prompts = signal([]);       // ActionPrompt[]
export const promptCounts = signal({});  // { threadId: count }

// Worktrees — detected git worktrees for thread assignment
export const worktrees = signal([]);   // GitWorktree[] from GET /api/worktrees

// Token usage — session totals + budget
export const tokenUsage = signal(null); // { usedTokens, usedCost, percentage, warning, exceeded, totalInput, totalOutput, totalCalls }

// Conversation — chat messages (user + agent responses)
// Each entry: { actor: "user"|"agent", content, timestamp, traceId?, classification?, route?, error? }
export const messages = signal([]);
/** Current owned learning inspection for the active thread: { threadId, payload, error, loadedAt }. Live, not historical. */
export const knowledgeInspection = signal(null);
export const threadContextTokens = computed(() => estimateContextTokens(messages.value));
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
  scheduleReconcile(events);
  for(const event of events)if(event.kind==='live'&&event.threadId===activeThreadId.value) requestLive(event.threadId);
}

const liveSnapshots=new Map(),liveRequests=new Map(),liveTimers=new Map();
let liveRequestSequence=0;
function requestLive(threadId) {
  if(!threadId||liveTimers.has(threadId))return;
  liveTimers.set(threadId,setTimeout(()=>{liveTimers.delete(threadId);loadLive(threadId);},80));
}
async function loadLive(threadId) {
  const request=++liveRequestSequence;liveRequests.set(threadId,request);
  try {
    const response=await authFetch(`/api/messages/live?watch=1&threadId=${encodeURIComponent(threadId)}`,{cache:'no-store'});
    if(!response.ok)throw Error(`Live state unavailable (${response.status})`);
    const snapshot=await response.json();if(liveRequests.get(threadId)!==request)return;
    const thread=allThreads.value.find(t=>t.threadId===threadId);
    if(!thread)return;
    const accepted=acceptLiveSnapshot(liveSnapshots.get(threadId),snapshot,threadId,thread.meta?.projectId??thread.projectId);
    if(accepted!==snapshot)return;
    liveSnapshots.set(threadId,accepted);
    if(liveSnapshots.size>8)liveSnapshots.delete(liveSnapshots.keys().next().value);
    _persistLocal(threadId,mergeLiveSnapshot((_threadMessages[threadId]??[]).map(m=>({...m,connectionStatus:undefined})),accepted));
    if(accepted.buffers.some(b=>b.completedAt))requestReconcile(threadId);
  }catch {
    if(liveRequests.get(threadId)!==request)return;
    const rows=_threadMessages[threadId];if(rows)_persistLocal(threadId,rows.map(m=>m.live&&m.streaming?{...m,connectionStatus:'unconfirmed'}:m));
  }
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

// ---------------------------------------------------------------------------
// Observer reconciliation — owned events name a thread whose durable history
// or learning state changed. One bounded history fetch per thread per burst;
// token-level and context events never fetch. Caches of inactive threads are
// reconciled in place and only the active thread is mirrored to `messages`.
// ---------------------------------------------------------------------------

const reconcileTimers = new Map();
// Latest issued history request per thread; an older response never regresses a newer reconciliation.
const reconcileRequests = new Map();
let reconcileSequence = 0;
let knowledgeTimer = null;

function scheduleReconcile(events) {
  const targets = new Map();
  for (const event of events) {
    if (selectedDetailTarget(event, currentTrace.value?.selectedTurn, activeThreadId.value)) requestSelectedDetail();
    const target = reconcileTargets(event);
    if (!target) continue;
    const current = targets.get(target.threadId) ?? { messages: false, knowledge: false };
    targets.set(target.threadId, { messages: current.messages || target.messages, knowledge: current.knowledge || target.knowledge });
  }
  for (const [threadId, target] of targets) {
    if (target.messages) requestReconcile(threadId);
    if (target.knowledge && activeThreadId.value === threadId) requestKnowledge(threadId);
  }
}

/** Debounced per thread; a burst of events for one thread costs one fetch. */
export function requestReconcile(threadId, delay = 400) {
  if (!threadId || reconcileTimers.has(threadId)) return;
  reconcileTimers.set(threadId, setTimeout(() => {
    reconcileTimers.delete(threadId);
    _reconcileThread(threadId);
  }, delay));
}

async function _reconcileThread(threadId) {
  // Only a thread this tab has already loaded is reconciled; a first load owns
  // the legacy-history merge and must not be raced by a partial cache.
  if (!_threadMessages[threadId]) return;
  const requestId = ++reconcileSequence;
  reconcileRequests.set(threadId, requestId);
  try {
    // Newest index page only; older rows already in the cache are kept as they are.
    const result = await _fetchHistoryIndex(threadId, null);
    let rows;
    if (result.data) rows = result.data.messages;
    else if (result.unavailable) {
      // Older server without the index route: the full-detail history route still answers.
      const res = await authFetch(`/api/messages?threadId=${encodeURIComponent(threadId)}&limit=200`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data.messages)) return;
      rows = data.messages;
    } else return;
    // Ownership is checked after the body arrives: a newer request for this
    // thread was issued meanwhile, so this older observation is discarded.
    if (reconcileRequests.get(threadId) !== requestId) return;
    const cache = _threadMessages[threadId];
    if (!cache) return;
    if (result.data) _setPaging(threadId, _pagingFromPage(result.data, historyPaging.value[threadId]));
    const next = reconcileThreadMessages(cache, rows, threadId);
    if (next === cache) return;
    // Written into this thread's own cache; mirrored to `messages` only when it is active.
    _persistLocal(threadId, next);
  } catch { /* Live events stay visible; the next owned event or visibility change retries. */ }
}

// ---------------------------------------------------------------------------
// History index paging — per thread: { nextCursor, hasMore, oldestReached,
// loading, error, pages, indexUnavailable }. Older pages are owned by the thread
// they were requested for and land in that thread's cache even after a switch.
// ---------------------------------------------------------------------------

const HISTORY_PAGE = 50;
export const historyPaging = signal({});
const olderRequests = new Map();
let olderSequence = 0;

function _setPaging(threadId, patch) {
  historyPaging.value = { ...historyPaging.value, [threadId]: { ...(historyPaging.value[threadId] ?? {}), ...patch } };
}

/** The newest page decides whether older records exist; an older page only advances the cursor. */
function _pagingFromPage(page, previous, older = false) {
  if (older) return { nextCursor: page.nextCursor, hasMore: page.hasMore, oldestReached: page.oldestReached, pages: (previous?.pages ?? 1) + 1 };
  if (previous?.pages > 1 || previous?.oldestReached) return { indexUnavailable: false }; // older pages already walked; keep their cursor
  return { nextCursor: page.nextCursor, hasMore: page.hasMore, oldestReached: page.oldestReached, pages: 1, indexUnavailable: false };
}

async function _fetchHistoryIndex(threadId, cursor) {
  const url = `/api/threads/${encodeURIComponent(threadId)}/history?limit=${HISTORY_PAGE}` + (cursor ? `&before=${encodeURIComponent(cursor)}` : "");
  const res = await authFetch(url, { cache: "no-store" });
  // 404: an older server without the route; 503: no journal. Neither is an empty history.
  if (res.status === 404 || res.status === 503) return { unavailable: true, status: res.status };
  if (!res.ok) return { error: res.status };
  const data = await res.json();
  if (!Array.isArray(data.messages)) return { error: "malformed" };
  return { data };
}

/** Load the next older page for a thread; safe to call repeatedly. */
export async function loadOlderMessages(threadId = activeThreadId.value) {
  if (!threadId) return;
  const paging = historyPaging.value[threadId];
  if (!paging?.hasMore || paging.loading || !paging.nextCursor) return;
  const cursor = paging.nextCursor;
  const requestId = ++olderSequence;
  olderRequests.set(threadId, requestId);
  _setPaging(threadId, { loading: true, error: null });
  try {
    const result = await _fetchHistoryIndex(threadId, cursor);
    if (olderRequests.get(threadId) !== requestId) return;
    if (!result.data) {
      _setPaging(threadId, { loading: false, error: result.unavailable ? "Older history is unavailable from this server." : `Older history request failed (${result.error}).` });
      return;
    }
    const cache = _threadMessages[threadId] ?? [];
    // Older rows merge by identity; a repeated page adds nothing and moves nothing.
    const next = mergeMessageHistory(cache, result.data.messages);
    _persistLocal(threadId, next);
    _setPaging(threadId, { loading: false, error: null, ..._pagingFromPage(result.data, paging, true) });
  } catch (err) {
    if (olderRequests.get(threadId) !== requestId) return;
    _setPaging(threadId, { loading: false, error: `Older history unavailable: ${err.message}` });
  }
}

function requestKnowledge(threadId) {
  if (knowledgeTimer) return;
  knowledgeTimer = setTimeout(() => { knowledgeTimer = null; loadKnowledge(threadId); }, 400);
}

// Request ownership: the latest issued request per thread owns the published
// state. An older same-thread response, success or failure, that resolves later
// is dropped and counted; arrival time and revision numbers are never used to
// decide which observation is newer, so a generation change with a lower
// revision still wins when it was requested later.
const knowledgeRequests = new Map();
let knowledgeSequence = 0;
let knowledgeSuperseded = 0;

/** Current owned learning from the existing knowledge endpoint. Only the latest request for the active thread may publish. */
export async function loadKnowledge(threadId) {
  if (!threadId) return;
  const requestId = ++knowledgeSequence;
  knowledgeRequests.set(threadId, requestId);
  const current = knowledgeInspection.value;
  if (current?.threadId === threadId) knowledgeInspection.value = { ...current, pending: true };
  else if (activeThreadId.value === threadId) {
    knowledgeInspection.value = { threadId, payload: null, error: null, loadedAt: null, pending: true, superseded: knowledgeSuperseded };
  }
  let outcome;
  try {
    // Live state bypasses the HTTP cache: Chromium serializes identical cacheable
    // GETs behind a cache lock (up to 20 s), which would let a stalled older
    // request delay the newer one it is supposed to lose to.
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/knowledge`, { cache: "no-store" });
    const payload = await res.json().catch(() => null);
    const usable = res.ok ? payload : (payload && typeof payload.status === "string" ? payload
      : { status: "unavailable", error: payload?.error ?? `HTTP ${res.status}` });
    outcome = { payload: usable, error: res.ok ? null : (payload?.error ?? `HTTP ${res.status}`) };
  } catch (err) {
    outcome = { payload: { status: "unavailable", error: err.message }, error: err.message };
  }
  if (knowledgeRequests.get(threadId) !== requestId) {
    knowledgeSuperseded += 1;
    const latest = knowledgeInspection.value;
    if (latest?.threadId === threadId) knowledgeInspection.value = { ...latest, superseded: knowledgeSuperseded };
    return;
  }
  if (activeThreadId.value !== threadId) return;
  knowledgeInspection.value = { threadId, ...outcome, loadedAt: Date.now(), pending: false, superseded: knowledgeSuperseded, requestId };
}

export function connect() {
  // Browser sends cookies on WS upgrade automatically (same-origin).
  // For tunnel mode, the session cookie set by /auth handles auth.
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${wsProto}//${location.host}/ws`);
  ws.onopen = () => {
    wasConnected = true;
    connected.value = true;
    requestLive(activeThreadId.value);
    requestReconcile(activeThreadId.value,0);
  };
  ws.onclose = () => {
    connected.value = false;
    const tid=activeThreadId.value, rows=_threadMessages[tid];
    if(rows)_persistLocal(tid,rows.map(m=>m.live&&m.streaming?{...m,connectionStatus:'unconfirmed'}:m));
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

// Latest trace request owns the drawer; an older response never replaces a newer selection.
let traceSequence = 0;
let detailSequence = 0;
let selectedDetailTimer = null;
function requestSelectedDetail() {
  if (selectedDetailTimer) return;
  const requestId = traceSequence, trace = currentTrace.value;
  selectedDetailTimer = setTimeout(() => {
    selectedDetailTimer = null;
    if (!trace?.selectedTurn?.turnId || !ownsTraceRequest(requestId, trace.selectedTurn.threadId) || currentTrace.value?.id !== trace.id) return;
    _loadTurnDetail(trace.selectedTurn.threadId, trace.selectedTurn.turnId, trace.id, requestId);
  }, 400);
}

/** Dismiss the historical selection and invalidate every pending trace/turn-detail request. A response
 * that resolves after this never publishes, re-opens the panel or toasts. */
export function dismissTraceSelection() {
  traceSequence++;
  currentTrace.value = null;
  selectedSpanId.value = null;
}

/** A request may publish only if it is still the newest and the operator is still on its thread. */
function ownsTraceRequest(requestId, threadId) {
  return traceSequence === requestId && activeThreadId.value === threadId;
}

export async function loadTraceDetail(traceId) {
  const threadId = activeThreadId.value;
  const message = messages.value.find(message => message.traceId === traceId);
  const requestId = ++traceSequence;
  currentTrace.value = null;
  selectedEvent.value = null;
  detailDrawerOpen.value = true;
  compactPanel.value = "detail";
  const selectedTurn = message ? { threadId, turnId: message.turnId ?? null, messageId: message.id ?? null, actor: message.actor, timestamp: message.timestamp ?? null,
    // What the index row carries versus what only the journal detail holds (names only; no payloads).
    summaryMeta: Object.keys(message.meta ?? {}), detailOnlyMeta: Array.isArray(message.detail?.detailOnlyMeta) ? message.detail.detailOnlyMeta : null } : { threadId, turnId: null, messageId: null };
  try {
    const res = await authFetch(`/api/traces/${encodeURIComponent(traceId)}`);
    if (!ownsTraceRequest(requestId, threadId)) return;
    let trace;
    if (res.ok) {
      trace = { ...(await res.json()), injection: message?.meta?.injection };
      if (!ownsTraceRequest(requestId, threadId)) return;
    } else if (message?.trace) {
      trace = { id: traceId, summary: message.trace, injection: message.meta?.injection, detailUnavailable: true };
    } else {
      showToast(`Failed to load trace: ${res.status}`, "error");
      return;
    }
    currentTrace.value = { ...trace, selectedTurn, detailStatus: message?.meta?.injection ? "inline" : "none" };
    selectedSpanId.value = null;
    // Index rows carry no injection or native payloads; fetch the owned turn detail lazily.
    // Browser-only rows (unsaved completions, legacy history) have no journal detail to fetch.
    const journalled = message?.detail || message?.storage === "server" || message?.meta?.persistence === "committed";
    if (message?.turnId && !message.meta?.injection && journalled) await _loadTurnDetail(threadId, message.turnId, traceId, requestId);
  } catch (err) {
    if (ownsTraceRequest(requestId, threadId) && connected.value) showToast(`Trace unavailable: ${err.message}`, "warn");
  }
}

/** Open any owned turn directly through the journal detail route, whether or not its row is in the loaded page. */
export async function openTurnDetail(threadId, turnId) {
  const requestId = ++traceSequence;
  currentTrace.value = null; selectedEvent.value = null; detailDrawerOpen.value = true; compactPanel.value = "detail";
  try {
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/detail`, { cache: "no-store" });
    // Superseded by a thread switch, a newer selection or a dismissal: publish nothing, re-open nothing, toast nothing.
    if (!ownsTraceRequest(requestId, threadId)) return;
    if (res.status === 404) { showToast(`Turn ${turnId} is not in this thread's journal`, "warn"); return; }
    if (!res.ok) { showToast(`Turn detail unavailable (${res.status})`, res.status === 503 ? "warn" : "error"); return; }
    const detail = await res.json();
    if (!ownsTraceRequest(requestId, threadId)) return;
    const agent = Array.isArray(detail.messages) ? detail.messages.find(m => m.actor === "agent") : null;
    const selectedTurn = { threadId, turnId, messageId: agent?.id ?? null, actor: agent ? "agent" : null, timestamp: agent?.timestamp ?? null,
      summaryMeta: [], detailOnlyMeta: Object.keys(agent?.meta ?? {}) };
    const base = detail.trace ?? { id: `turn:${turnId}`, messageId: turnId, summary: null, detailUnavailable: true };
    currentTrace.value = { ...base, injection: detail.injection ?? undefined, detail, detailStatus: "loaded", selectedTurn };
    selectedSpanId.value = null;
  } catch (err) {
    if (ownsTraceRequest(requestId, threadId) && connected.value) showToast(`Turn detail unavailable: ${err.message}`, "warn");
  }
}

/** Historical detail for one turn: recorded injection, native events, tool records, artifacts. Never cached in browser storage. */
async function _loadTurnDetail(threadId, turnId, traceId, requestId) {
  const detailRequest = ++detailSequence;
  const patch = value => {
    if (detailRequest !== detailSequence || !ownsTraceRequest(requestId, threadId) || currentTrace.value?.id !== traceId) return;
    currentTrace.value = { ...currentTrace.value, ...value };
  };
  patch({ detailStatus: "loading" });
  try {
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/detail`, { cache: "no-store" });
    if (!ownsTraceRequest(requestId, threadId)) return;
    if (!res.ok) { patch({ detailStatus: res.status === 404 ? "not-journalled" : `unavailable (${res.status})` }); return; }
    const detail = await res.json();
    patch({ detail, injection: detail.injection ?? currentTrace.value?.injection, detailStatus: "loaded" });
  } catch (err) {
    patch({ detailStatus: `unavailable (${err.message})` });
  }
}

async function loadActivity() {
  try {
    const res = await authFetch("/api/events?limit=200");
    if (!res.ok) return;
    const history = await res.json();
    const key = event => JSON.stringify(Object.fromEntries(Object.entries(event).filter(([name]) => name !== "_time")));
    const seen = new Set(liveEvents.value.map(key));
    const earlier = history.reverse().filter(event => !seen.has(key(event))).map(event => ({
      ...event,
      _time: new Date(event.timestamp ?? event.signal?.timestamp ?? event.event?.timestamp ?? event.dispatch?.timestamp ?? event.context?.timestamp ?? Date.now()).toLocaleTimeString(),
    }));
    liveEvents.value = [...liveEvents.value, ...earlier].slice(0, 200);
  } catch { /* Live connection remains available when history cannot be loaded. */ }
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
      if (activeProjectId.value !== projectId) return;
      allThreads.value = data.threads;
      if (!data.threads.some(thread => thread.threadId === activeThreadId.value)) {
        selectThread(data.threads[0]?.threadId ?? null);
      }
      const active = activeThreadId.value;
      const match = active ? data.threads.find(t => t.threadId === active) : null;
      threadData.value = match ?? null;
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
      usageUnavailable: analytics.observations?.unavailableUsageCalls ?? 0,
      costUnavailable: analytics.observations?.unavailableCostCalls ?? 0,
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
    _persistLocal(newThread.threadId, forkedMessages.map(msg => ({ ...msg, browserStorage: undefined })));

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
  compactPanel.value = "conversation";
  const prev = activeThreadId.value;
  if (prev === threadId) return;

  // Always save current messages (even if prev is the initial default)
  const saveKey = prev ?? "_default";
  _threadMessages[saveKey] = messages.value;

  batch(() => {
    activeThreadId.value = threadId;
    // A thread switch is a new selection generation: pending detail requests for the old view are void.
    dismissTraceSelection();
    selectedEvent.value = null;
    messages.value = _threadMessages[threadId] ?? [];
    threadData.value = allThreads.value.find(t => t.threadId === threadId) ?? null;
  });
  if (threadId && !_threadMessages[threadId]) _loadThreadMessages(threadId);
  // A cached thread may have received work while inactive: reconcile it late,
  // into its own cache only, even if the user switches again before it returns.
  else if (threadId) requestReconcile(threadId, 0);
  requestLive(threadId);
}

/** Keep write outcomes with the thread's live messages, including while inactive. */
function _persistLocal(threadId, msgs) {
  // A sender may just have applied its full terminal. Merge only the watch-owned
  // projection in that case; failed persistence does not revoke local completion.
  const observed = mergeLiveSnapshot(msgs, liveSnapshots.get(threadId));
  const next = persistBrowserMessages(observed, value => localStorage.setItem(`foundry:msgs:${threadId}`, value));
  _threadMessages[threadId] = next;
  if (activeThreadId.value === threadId) messages.value = next;
}

/** Read messages from localStorage fallback. */
function _loadLocal(threadId) {
  try {
    const raw = localStorage.getItem(`foundry:msgs:${threadId}`);
    const cached = raw ? JSON.parse(raw) : [];
    // Reading this snapshot establishes a browser copy, never a server commit.
    return Array.isArray(cached) ? cached.map(msg => ({ ...msg, browserStorage: { status: "saved" } })) : [];
  } catch { return []; }
}

/** Reconcile durable history without erasing pre-journal browser-only messages. */
async function _loadThreadMessages(threadId) {
  const initial = _threadMessages[threadId];
  const local = _loadLocal(threadId);
  const adopt = (serverRows, paging) => {
    // Keep the original cache before its first reconciliation with server records.
    try {
      const backupKey = `foundry:msgs:legacy-backup:${threadId}`;
      if (Array.isArray(local) && local.length && localStorage.getItem(backupKey) === null) {
        localStorage.setItem(backupKey, JSON.stringify(local));
      }
    } catch { showToast("Browser history backup could not be saved", "warn"); }
    _setPaging(threadId, paging);
    _persistLocal(threadId, mergeMessageHistory(_threadMessages[threadId]??local, serverRows));
  };
  try {
    // Newest index page: identity, content and status only. Detail is fetched per turn on demand.
    const result = await _fetchHistoryIndex(threadId, null);
    if (_threadMessages[threadId] !== initial) {requestReconcile(threadId,0);return;}
    if (result.data) {
      adopt(result.data.messages, { ..._pagingFromPage(result.data, undefined), loading: false, error: null });
      return;
    }
    if (result.unavailable) {
      // Older server or no journal: the full-detail route is the only history source.
      const res = await authFetch(`/api/messages?threadId=${encodeURIComponent(threadId)}`);
      if (_threadMessages[threadId] !== initial) return;
      if (res.ok) {
        const data = await res.json();
        if (_threadMessages[threadId] !== initial) return;
        if (Array.isArray(data.messages)) { adopt(data.messages, { indexUnavailable: true, hasMore: false, oldestReached: false, loading: false }); return; }
      }
    }
  } catch { /* fall through to localStorage */ }

  // Fallback: localStorage. The server did not answer; this is the browser's copy, not an empty history.
  if (_threadMessages[threadId] !== initial) return;
  _setPaging(threadId, { offline: true, hasMore: false, oldestReached: false, loading: false });
  const fallback = mergeMessageHistory(local, []);
  if (fallback.length > 0) {
    _threadMessages[threadId] = fallback;
    if (activeThreadId.value === threadId) messages.value = fallback;
  }
}

/** Append a message to a specific thread's cache, and mirror to `messages` if that thread is active. */
function _appendToThread(threadId, msg) {
  const existing = _threadMessages[threadId] ?? (activeThreadId.value === threadId ? messages.value : []);
  const next = [...existing, msg];
  _persistLocal(threadId, next);
}

/** Update only the response owned by this request, including overlapping sends. */
function _updateAgentMessage(threadId, turnId, patch) {
  const list = _threadMessages[threadId] ?? (activeThreadId.value === threadId ? messages.value : []);
  const next = updateTurnMessage(list, turnId, patch);
  if (next === list) return;
  _persistLocal(threadId, next);
}

export async function sendMessage(text) {
  if (!text.trim()) return;

  // Bind this send to the thread that was active at submit time.
  // If the user navigates away during the request, the response still
  // routes back to this thread (not whatever is active when it returns).
  const tid = activeThreadId.value;
  if (!tid) return; // no active thread — nothing to bind to

  const turnId = `turn_${crypto.randomUUID()}`;
  _appendToThread(tid, { actor: "user", turnId, content: text, timestamp: Date.now() });

  // Track in-flight (non-blocking — user can keep typing)
  inflight.value++;

  // Fire streaming API call in background — don't await in caller
  _streamMessageInBackground(text, tid, turnId);
}

async function _streamMessageInBackground(text, tid, turnId) {
  // Seed a pending agent message we'll progressively fill as deltas arrive.
  _appendToThread(tid, {
    actor: "agent",
    turnId,
    content: "",
    timestamp: Date.now(),
    streaming: true,
  });

  let acc = "";
  try {
    const res = await fetch("/api/messages/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: turnId, message: text, threadId: tid }),
    });

    if (!res.ok || !res.body) {
      // A failed HTTP journal write can still carry the completed executor result.
      const outcome = await res.json().catch(() => null);
      if (outcome?.meta) {
        _updateAgentMessage(tid, turnId, terminalMessagePatch(outcome, acc));
        return;
      }
      const errText = res.ok ? "no stream body" : `${res.status}`;
      _updateAgentMessage(tid, turnId, { content: `Connection error: ${errText}`, streaming: false, error: true });
      return;
    }

    await readMessageStream(res.body, ev => {
        if(ev.type==='delta'&&liveSnapshots.get(tid)?.buffers.some(b=>b.messageId===turnId)) {requestLive(tid);return;}
        if (ev.type === "delta") {
          acc += ev.text;
          _updateAgentMessage(tid, turnId, { content: acc });
        } else if (ev.type === "done" || ev.type === "error") {
          _updateAgentMessage(tid, turnId, terminalMessagePatch(ev, acc));
        }
    });

    Promise.all([loadTraces(), loadThreads(), loadTokenUsage()]);
  } catch (err) {
    _updateAgentMessage(tid, turnId, {
      content: acc || `Connection error: ${err.message}`,
      connectionStatus: "unconfirmed",
      streaming: false,
      error: true,
    });
  } finally {
    inflight.value = Math.max(0, inflight.value - 1);
  }
}

export async function executeAction(kind, target, payload) {
  try {
    const res = await fetch("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, target, payload,
        threadId: kind.startsWith("thread:") && target ? target : activeThreadId.value ?? threadData.value?.threadId,
        timestamp: Date.now() }),
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
  if (h.thread) selectThread(h.thread);
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
  loadActivity();
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
  // One bounded selected-thread recovery poll covers missed invalidation/upgrade races.
  setInterval(()=>{if(!document.hidden)requestLive(activeThreadId.value);},2000);

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

  // Persistence happens at each mutation with its originating thread ID.
  // Combining selected-thread and message signals here can cross-write history.

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

  // A tab returning to the foreground may have missed owned events while
  // hidden; reconcile the active thread once, not the whole history set.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const active = activeThreadId.value;
    if (!active) return;
    requestReconcile(active, 0);
    requestKnowledge(active);
  });
}
