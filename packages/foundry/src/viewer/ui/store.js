/**
 * Foundry UI store — data-stream socket, state management via signals.
 *
 * All state lives in signals. Components subscribe automatically.
 * Data-stream frames are applied once per animation frame.
 */

import { signal, computed, batch, effect } from "./lib.js";
import { applyTurnFrame, mergeLiveSnapshot } from './live-state.js';
import { mergeMessageHistory, updateTurnMessage, terminalMessagePatch, persistBrowserMessages,
  reconcileThreadMessages, reconcileTargets, selectedDetailTarget } from "./conversation-state.js";
import { createDataStreamSocket } from "./data-stream-socket.js";

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
export const activePanel = signal("conversation"); // center panel view: "conversation" | "graph"
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
export const prompts = signal([]);       // pending ActionPrompt[]
export const promptCounts = computed(() => { // { threadId: count }
  const counts = {};
  for (const prompt of prompts.value) counts[prompt.threadId] = (counts[prompt.threadId] ?? 0) + 1;
  return counts;
});

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
// Data streams — one socket; each panel opens exactly the stream it shows:
//   thread:<id>                     the active thread's live turns, turn terminals and
//                                   journal changes (also held for this tab's in-flight sends)
//   events | events:<id>            activity panel: runtime-wide, or the active thread's
//   threads | threads:<projectId>   thread list for the active scope
//   prompts                         pending agent→human prompts
//   flow:<id>                       graph panel, while it is visible (holdStream)
// A reconnect re-opens every held stream; each answers with a fresh snapshot.
// ---------------------------------------------------------------------------

let socket = null;
// This tab's id on the socket, stable across reconnects: the server addresses a send's full result to it.
const clientId = crypto.randomUUID();
let pendingFrames = [];
let frameScheduled = false;
let activeStream = null, eventsStream = null, threadsStream = null;
const liveTurns = new Map();    // threadId → Map(turnId → live turn) while its stream is held
const pendingSends = new Map(); // turnId → threadId: sends from this tab awaiting their terminal

function liveView(threadId) {
  const turns = liveTurns.get(threadId);
  return turns ? { buffers: [...turns.values()] } : undefined;
}

function releaseStream(stream) {
  socket.close(stream);
  if (!socket.holds(stream) && stream.startsWith("thread:")) liveTurns.delete(stream.slice("thread:".length));
}

function queueFrame(frame) {
  pendingFrames.push(frame);
  if (frameScheduled) return;
  frameScheduled = true;
  requestAnimationFrame(flushFrames);
}

function flushFrames() {
  frameScheduled = false;
  const frames = pendingFrames;
  pendingFrames = [];
  const touched = new Set();
  batch(() => { for (const frame of frames) applyFrame(frame, touched); });
  for (const threadId of touched) refreshLiveRows(threadId);
}

function applyFrame(frame, touched) {
  // Released earlier in this same flush (a settled send): its remaining frames are stale.
  if (!socket.holds(frame.stream)) return;
  const split = frame.stream.indexOf(":");
  const family = split < 0 ? frame.stream : frame.stream.slice(0, split);
  const key = split < 0 ? null : frame.stream.slice(split + 1);
  if (family === "thread") applyThreadFrame(key, frame, touched);
  else if (family === "threads") applyThreadsFrame(frame);
  else if (family === "prompts") applyPromptsFrame(frame);
  else if (family === "events") applyEventsFrame(frame);
  else heldStreams.get(frame.stream)?.(frame);
}

// Streams a panel holds for itself, with the handler that applies their frames (in the same
// per-animation-frame batch as the store's own). One holder per stream: a second open of a held
// stream would share the server subscription and never get a snapshot of its own.
const heldStreams = new Map();

/** Open `stream` for a panel while it shows it; `onFrame` gets its frames, and `{ action: "rejected" }`
 * if the server refuses it. Returns the release. */
export function holdStream(stream, onFrame) {
  if (heldStreams.has(stream)) throw new Error(`${stream} is already held`);
  heldStreams.set(stream, onFrame);
  socket.open(stream);
  return () => {
    if (heldStreams.get(stream) !== onFrame) return;
    heldStreams.delete(stream);
    socket.close(stream);
  };
}

/** Center panel: chat or the graph panel. */
export function toggleGraphPanel() {
  activePanel.value = activePanel.value === "graph" ? "conversation" : "graph";
}

function applyThreadFrame(threadId, frame, touched) {
  const payload = frame.payload;
  if (frame.action === "append" && payload.kind === "event") { scheduleReconcile([payload.event]); return; }
  if (frame.action === "append" && (payload.kind === "done" || payload.kind === "error")) {
    // This tab's own send: the full terminal, with evidence the bounded live turn never carries.
    // Its row may be ahead of live turns applied earlier in this flush: merge them first.
    if (touched.delete(threadId)) refreshLiveRows(threadId);
    const row = (_threadMessages[threadId] ?? []).find(m => m.actor === "agent" && m.turnId === payload.turnId);
    _updateAgentMessage(threadId, payload.turnId, terminalMessagePatch({ type: payload.kind, ...payload.result }, row?.content ?? ""));
    settleSend(payload.turnId);
    return;
  }
  const previous = liveTurns.get(threadId) ?? new Map();
  const next = applyTurnFrame(previous, frame);
  if (next === previous) return;
  if (frame.action === "snapshot") {
    // A send accepted after the open this snapshot answers may be missing from it; the stream will say more.
    for (const [turnId, turn] of previous) if (turn.seededAt > frame.requestedAt && !next.has(turnId)) next.set(turnId, turn);
  }
  liveTurns.set(threadId, next);
  touched.add(threadId);
  const completed = frame.action === "snapshot" ? [...next.values()].some(turn => turn.completedAt) : payload.kind === "turn" && payload.turn.completedAt;
  if (completed) requestReconcile(threadId);
}

/** Merge the thread's live turns into its rows; a turn the stream reports is positively observed.
 * A thread whose history has not loaded yet is left alone: its first load merges the live turns,
 * and must not be raced by a live-only cache that would displace the browser copy. */
function refreshLiveRows(threadId) {
  const turns = liveTurns.get(threadId);
  const rows = _threadMessages[threadId];
  if (!turns || !rows) return;
  _persistLocal(threadId, rows.map(m => m.actor === "agent" && m.connectionStatus && turns.has(m.turnId) ? { ...m, connectionStatus: undefined } : m));
  for (const [turnId, owner] of pendingSends) {
    if (owner !== threadId) continue;
    const row = _threadMessages[threadId]?.find(m => m.actor === "agent" && m.turnId === turnId);
    if (!row?.streaming) settleSend(turnId);
  }
}

function settleSend(turnId) {
  const threadId = pendingSends.get(turnId);
  if (threadId === undefined) return;
  pendingSends.delete(turnId);
  inflight.value = Math.max(0, inflight.value - 1);
  releaseStream(`thread:${threadId}`);
  loadTraces();
  loadTokenUsage();
}

function applyThreadsFrame(frame) {
  if (frame.stream !== threadsStream) return;
  const payload = frame.payload;
  if (frame.action === "snapshot") { adoptThreadList(payload.threads); return; }
  if (payload.removed) {
    allThreads.value = allThreads.value.filter(thread => thread.threadId !== payload.removed);
    if (activeThreadId.value === payload.removed) selectThread(allThreads.value[0]?.threadId ?? null);
    return;
  }
  const list = allThreads.value;
  const i = list.findIndex(thread => thread.threadId === payload.thread.threadId);
  allThreads.value = i < 0 ? [...list, payload.thread] : list.map((thread, j) => j === i ? payload.thread : thread);
  if (payload.thread.threadId === activeThreadId.value) threadData.value = payload.thread;
}

function adoptThreadList(threads) {
  allThreads.value = threads;
  if (!threads.some(thread => thread.threadId === activeThreadId.value)) selectThread(threads[0]?.threadId ?? null);
  const active = activeThreadId.value;
  threadData.value = active ? threads.find(thread => thread.threadId === active) ?? null : null;
  // Always load messages for the active thread if we don't have them yet
  if (active && messages.value.length === 0 && !_threadMessages[active]) _loadThreadMessages(active);
}

function applyPromptsFrame(frame) {
  if (frame.action === "snapshot") { prompts.value = frame.payload.prompts; return; }
  const prompt = frame.payload.prompt;
  const rest = prompts.value.filter(p => p.id !== prompt.id);
  prompts.value = prompt.status === "pending" ? [...rest, prompt] : rest;
}

const eventTime = event => new Date(event.timestamp ?? event.signal?.timestamp ?? event.event?.timestamp
  ?? event.dispatch?.timestamp ?? event.context?.timestamp ?? Date.now()).toLocaleTimeString();

function applyEventsFrame(frame) {
  if (frame.stream !== eventsStream) return;
  if (frame.action === "snapshot") {
    liveEvents.value = frame.payload.events.slice().reverse().map(event => ({ ...event, _time: eventTime(event) }));
    return;
  }
  const event = frame.payload.event;
  eventCount.value += 1;
  // Surface error events from the backend as toasts
  if (event.kind === "error") showToast(`[${event.source}] ${event.message}`, event.severity === "warn" ? "warn" : "error");
  const next = [{ ...event, _time: new Date().toLocaleTimeString() }, ...liveEvents.value];
  liveEvents.value = next.length > 200 ? next.slice(0, 200) : next;
}

/** Re-open every held stream for fresh snapshots. */
export function resyncStreams() {
  socket?.resync();
}

function connectStreams() {
  // Browser sends cookies on the upgrade (same-origin); in tunnel mode the /auth session cookie authorizes it.
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  socket = createDataStreamSocket(`${wsProto}//${location.host}/ws?client=${clientId}`, {
    reconnectDelayMs: 2000,
    onData: queueFrame,
    onStatus: status => {
      connected.value = status === "open";
      if (status === "open") return;
      // Live work on a dropped connection is unconfirmed until a fresh snapshot says otherwise.
      for (const threadId of liveTurns.keys()) {
        const rows = _threadMessages[threadId];
        if (rows) _persistLocal(threadId, rows.map(m => m.live && m.streaming ? { ...m, connectionStatus: "unconfirmed" } : m));
      }
    },
    onReconnect: () => requestReconcile(activeThreadId.value, 0),
    // A rejection means the stream's subject is gone (losing authorization closes the socket instead).
    onRejected: stream => {
      // A project that no longer exists scopes nothing; fall back to the unscoped list.
      if (stream === threadsStream && activeProjectId.value) activeProjectId.value = null;
      heldStreams.get(stream)?.({ action: "rejected", stream });
      if (!stream.startsWith("thread:")) return;
      const threadId = stream.slice("thread:".length);
      if (stream === activeStream) activeStream = null;
      liveTurns.delete(threadId);
      // Sends on a thread that no longer exists will not report here; their outcome is unconfirmed.
      for (const [turnId, owner] of [...pendingSends]) {
        if (owner !== threadId) continue;
        _updateAgentMessage(threadId, turnId, { streaming: false, connectionStatus: "unconfirmed" });
        pendingSends.delete(turnId);
        inflight.value = Math.max(0, inflight.value - 1);
      }
    },
  });
  socket.connect();
  socket.open("prompts");
  effect(() => {
    const projectId = activeProjectId.value;
    const next = projectId ? `threads:${projectId}` : "threads";
    if (next === threadsStream) return;
    if (threadsStream) socket.close(threadsStream);
    threadsStream = next;
    socket.open(next);
  });
  effect(() => {
    const threadId = activeThreadId.value;
    const nextThread = threadId ? `thread:${threadId}` : null;
    const nextEvents = threadId ? `events:${threadId}` : "events";
    if (nextThread !== activeStream) {
      if (activeStream) releaseStream(activeStream);
      activeStream = nextThread;
      if (nextThread) socket.open(nextThread);
    }
    if (nextEvents !== eventsStream) {
      if (eventsStream) socket.close(eventsStream);
      eventsStream = nextEvents;
      liveEvents.value = [];
      socket.open(nextEvents);
    }
  });
}

// ---------------------------------------------------------------------------
// Observer reconciliation — owned events on a held thread stream name a thread
// whose durable history or learning state changed. One bounded history fetch per
// thread per burst. A thread whose stream is not held reconciles when selected;
// a reconciled cache is written in place and only the active thread is mirrored to `messages`.
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

export async function resolvePrompt(promptId, action, input) {
  try {
    const res = await fetch(`/api/prompts/${encodeURIComponent(promptId)}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, input }),
    });
    if (res.ok) {
      showToast(`Prompt resolved: ${action}`, "ok");
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
    // The thread list stream already carries the fork.
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
  // A cached thread may have received work while inactive (its stream was closed):
  // reconcile it into its own cache only, even if the user switches again before it returns.
  else if (threadId) requestReconcile(threadId, 0);
}

/** Keep write outcomes with the thread's live messages, including while inactive. */
function _persistLocal(threadId, msgs) {
  // A sender may just have applied its full terminal. Merge only the watch-owned
  // projection in that case; failed persistence does not revoke local completion.
  const observed = mergeLiveSnapshot(msgs, liveView(threadId));
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
  // If the user navigates away during the turn, its output still
  // routes back to this thread (not whatever is active when it arrives).
  const tid = activeThreadId.value;
  if (!tid) return; // no active thread — nothing to bind to

  const turnId = `turn_${crypto.randomUUID()}`;
  _appendToThread(tid, { actor: "user", turnId, content: text, timestamp: Date.now() });
  // Seed a pending agent message the thread stream progressively fills.
  _appendToThread(tid, { actor: "agent", turnId, content: "", timestamp: Date.now(), streaming: true });

  // Track in-flight (non-blocking — user can keep typing). The thread stream is
  // held until this turn's terminal arrives, even across a thread switch.
  inflight.value++;
  pendingSends.set(turnId, tid);
  socket.open(`thread:${tid}`);
  _sendInBackground(text, tid, turnId);
}

const SEND_OPEN_WAIT_MS = 5000;

async function _sendInBackground(text, tid, turnId) {
  // Hold the thread stream on the server before the turn can finish, so its full result reaches this tab.
  await socket.opened(`thread:${tid}`, SEND_OPEN_WAIT_MS);
  let res;
  try {
    res = await authFetch("/api/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The full result (with its evidence) comes back only to this tab, on its thread stream.
      body: JSON.stringify({ id: turnId, message: text, threadId: tid, clientId }),
    });
  } catch (err) {
    // The request may or may not have reached the server.
    _updateAgentMessage(tid, turnId, { content: `Connection error: ${err.message}`, connectionStatus: "unconfirmed", streaming: false, error: true });
    settleSend(turnId);
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    _updateAgentMessage(tid, turnId, { content: `Send failed: ${body?.error ?? res.status}`, streaming: false, error: true });
    settleSend(turnId);
    return;
  }
  // Accepted; output arrives on the thread stream. Seed the turn so a later
  // snapshot that no longer has it reads as unconfirmed rather than running.
  const turns = liveTurns.get(tid) ?? new Map();
  if (!pendingSends.has(turnId) || turns.has(turnId)) return;
  const projectId = allThreads.value.find(thread => thread.threadId === tid)?.meta?.projectId;
  liveTurns.set(tid, new Map(turns).set(turnId, { messageId: turnId, threadId: tid, projectId, content: "", startedAt: Date.now(),
    status: "accepted", activity: [], truncated: false, nativeDetail: "unavailable", seededAt: Date.now() }));
  refreshLiveRows(tid);
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

  connectStreams();
  loadTraces();
  loadDefinitions();
  loadProjects();
  loadWorktrees();
  loadTokenUsage();
  // Polling for state that has no data stream
  setInterval(loadTraces, 15000);
  setInterval(loadDefinitions, 30000);
  setInterval(loadProjects, 30000);
  setInterval(loadWorktrees, 30000);
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

  // Persistence happens at each mutation with its originating thread ID.
  // Combining selected-thread and message signals here can cross-write history.

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
