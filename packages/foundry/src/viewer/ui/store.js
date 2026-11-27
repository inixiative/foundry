/**
 * @atlas
 * @kind store
 * @partOf feature:viewer
 */
/**
 * Foundry UI store — data-stream socket, state management via signals.
 *
 * All state lives in signals. Components subscribe automatically.
 * Data-stream frames are applied once per animation frame.
 */

import {
  mergeMessageHistory,
  reconcileTargets,
  reconcileThreadMessages,
  selectedDetailTarget,
  terminalMessagePatch,
  updateTurnMessage,
} from './conversation-state.js';
import { createDataStreamSocket } from './data-stream-socket.js';
import { batch, computed, effect, signal } from './lib.js';
import { applyTurnFrame, mergeLiveSnapshot } from './live-state.js';
import { route, withSafeUi } from './route.js';
import { categoryOf, threadState } from './thread-status.js';
import {
  effectiveTabSide,
  extensionsReady,
  leftTabs,
  mainViews,
  resolveActiveId,
  rightTabs,
} from './ui-registry.js';
import { uuidv7 } from './uuidv7.js';

// ---------------------------------------------------------------------------
// Auth — cookie-based auth handles most cases. authFetch is a fallback
// for programmatic/API access where a bearer token is passed in the URL.
// ---------------------------------------------------------------------------

/** Wrapper around fetch that includes credentials (cookies) automatically. */
export function authFetch(url, opts = {}) {
  opts.credentials = 'same-origin';
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
export const allThreads = signal([]); // all threads (multi-thread support)
export const activeThreadId = signal(null); // selected thread ID (null = first/default)
export const liveEvents = signal([]);
/** What the system is doing around the open thread: the latest activity of each key. */
export const systemActivity = signal([]);
/** Every activity event heard, newest first: the strip's expanded log. */
export const systemActivityLog = signal([]);
/**
 * The centre's tab: conversation (Thread, key 1) | graph (the turn graph, key g). Plan, Loop and
 * Artifacts are right-panel tabs (Aron 11-15), so the thread stays open beside them.
 */
export const CENTER_PANELS = ['conversation', 'graph'];
export const activePanel = signal('conversation');
/** The artifact the Artifacts tab shows ({ id, version? }; no version: the newest). */
export const artifactSelection = signal(null);
/** Open the right panel's Artifacts tab on one artifact, at a version or its newest. */
export function openArtifact(id, version) {
  artifactSelection.value = { id, ...(version ? { version } : {}) };
  openRightTab('artifacts');
}
export const commandPaletteOpen = signal(false);
export const helpOpen = signal(false);
// Two places (Aron 11-15): a system toast sits at the bottom left; a thread's toast sits at the top of
// that thread, full width, pushing its messages down. Each is { message, type, persistent, undo? }.
export const toast = signal(null);
export const threadToast = signal(null); // also { threadId }
/** The thread whose conversation is on screen (ThreadToast sets it); a thread's toast shows only there. */
export const threadToastHost = signal(null);

// Projects
export const projects = signal([]); // ProjectSummary[]
export const projectTags = signal([]); // string[]
export const activeProjectId = signal(null); // selected project ID or null (global: unscoped threads)
/** The Forge Master scope is selected: its threads, about this Foundry and its settings. */
export const forgeMasterOpen = signal(false);
/** The Feedback scope is selected: its threads, with the feedback inbox beside them. */
export const feedbackInboxOpen = signal(false);
/**
 * Foundry's own scopes (Aron, 2026-11-14: "Forge Master and Feedback should just be threads"): a
 * thread whose role holds one lives in it, never in a project. The daemon owns which role holds
 * which scope; a thread arrives with its `scope` (`forge`, `feedback`) and a new one is started with
 * one, so the viewer never names a role id.
 */
// Keyed `@forge` / `@feedback`, as the daemon's streams are: no project id can hold an `@`, so a
// project named forge or feedback is never taken for the scope.
export const SCOPES = Object.freeze(['@forge', '@feedback']);
/** Whether `where` is one of Foundry's scopes. */
export const isScope = (where) => where != null && SCOPES.includes(where);
/** The scope a thread lives in (`@forge`, `@feedback`), if any, from the daemon's `scope`. */
export const scopeOfThread = (thread) => (thread?.scope ? `@${thread.scope}` : null);
/** Where the workspace is: '@forge', '@feedback', a project id, or null (Global); `selectScope`'s argument. */
export function currentScope() {
  if (forgeMasterOpen.value) return '@forge';
  if (feedbackInboxOpen.value) return '@feedback';
  return activeProjectId.value ?? null;
}
/** Every feedback item (the `feedback` stream), newest first; the inbox, project strips and threads read it. */
export const feedbackItems = signal([]);
/** Every schedule (the `schedules` stream): its Where, next run and last result. The Scheduled rail reads it. */
export const schedules = signal([]);
/** The schedule open in the Scheduled rail (its runs and actions), or null. */
export const openScheduleId = signal(null);
/** A turn to bring into view once its thread's messages show (a feedback item's provenance link). */
export const focusTurnId = signal(null);

/** The project the operator is looking at: the page's on settings/analytics, else the workspace's (none for Global and Forge Master). */
export function scopeProjectId() {
  const { page, projectId } = route.value;
  if (page !== 'workspace') return projectId;
  return forgeMasterOpen.value || feedbackInboxOpen.value ? null : activeProjectId.value;
}
export const projectSidebarOpen = signal(true); // collapsed state
export const detailDrawerOpen = signal(true); // right panel collapsed state
/** What the detail drawer inspects besides a trace: `{ kind: 'layer', id }` or null. */
export const inspectTarget = signal(null);
/**
 * The right panel's tabs: what the thread is doing (Plan, Loop, Artifacts, Work) and what it runs
 * with (Context, Participants, Permissions, Heralds, Reminders, Feedback), beside the thread.
 */
export const RIGHT_TABS = [
  'plan',
  'loop',
  'artifacts',
  'work',
  'context',
  'participants',
  'permissions',
  'heralds',
  'pointers',
  'feedback',
];
/**
 * Each right tab's number key (Aron 11-02), plain, ⌘ or ⌥: 1 is the centre's Thread; Plan and Loop
 * keep 2 and 3 from when they were centre tabs. Artifacts has none (it had none in the centre).
 */
/** Each right tab's label, the one table the panel, its strip and the key help read. */
export const RIGHT_TAB_LABELS = {
  plan: 'Plan',
  loop: 'Loop',
  artifacts: 'Artifacts',
  work: 'Work',
  context: 'Context',
  participants: 'Participants',
  permissions: 'Permissions',
  heralds: 'Heralds',
  pointers: 'Reminders',
  feedback: 'Feedback',
};
export const RIGHT_TAB_KEYS = {
  plan: '2',
  loop: '3',
  work: '4',
  context: '5',
  participants: '6',
  permissions: '7',
  heralds: '8',
  pointers: '9',
  feedback: '0',
};
/** The right panel widened (for Work's diffs and file lists). */
/** The side panels' size levels (panel-sizes.js steps and renders them). */
export const leftSize = signal('normal'); // hidden · strip · normal · wide
export const rightSize = signal('normal'); // hidden · icons · normal · wide
export const rightTab = signal('context');
/**
 * The left rail's views, as its toggle shows them in two rows: 'attention' (open threads that need
 * you: orange or red, attention.js), 'open' (every open thread, Yours over Shared), 'projects' (the
 * projects beside a scope's threads); then 'scheduled' (schedules, triggers and running loops) and
 * 'status' (this machine and its connections). ⌥, ⌥. step through them in this order.
 */
export const RAIL_ROWS = [
  ['attention', 'open', 'projects'],
  ['scheduled', 'status'],
];
export const RAIL_VIEWS = RAIL_ROWS.flat();
export const railView = signal('attention');
/** Attention and Open list threads across every project; Projects lists one scope's. */
export const railSpansProjects = (view) => view !== 'projects';
const CROSS_PROJECT_TABS = new Set(['attention', 'open', 'scheduled']);

/** Whether a registered side-panel tab is currently open and active on its effective side. */
export function isTabActive(id, { peek = false } = {}) {
  const side = effectiveTabSide(id);
  if (side === 'left') {
    const open = peek ? projectSidebarOpen.peek() : projectSidebarOpen.value;
    const view = peek ? railView.peek() : railView.value;
    return open && view === id;
  }
  if (side === 'right') {
    const open = peek ? detailDrawerOpen.peek() : detailDrawerOpen.value;
    const tab = peek ? rightTab.peek() : rightTab.value;
    return open && tab === id;
  }
  return false;
}
/** Step the rail one view left (-1) or right (1), wrapping across reconciled rail tabs. */
export function stepRailView(d) {
  const registered = leftTabs().map((t) => t.id);
  const views = registered.length ? registered : RAIL_VIEWS;
  const at = views.indexOf(railView.value);
  const base = at === -1 ? 0 : at;
  railView.value = views[(base + d + views.length) % views.length];
}
/**
 * The thread Attention keeps listed after it stops needing you: the one you opened, until you
 * navigate (another thread, a project page, the board, the Watchtower, Settings, another rail tab).
 * Why: keyed on the open thread, the last one in Attention never left (Aron, 2026-11-15).
 */
export const attentionHold = signal(null);
/** `afterProjectStart` (Settings › Threads), mirrored from the loaded settings: where the rail goes once a thread starts from Projects. */
export const afterProjectStart = signal('attention');
/** The attention board fills the centre (key b). */
export const boardOpen = signal(false);
/** The actions palette by Send (⌥/, or "/" typed into an empty message box). */
export const actionPaletteOpen = signal(false);
/** Text to put back into the message box (a queued message taken out to edit); the box consumes it. */
export const composerFill = signal(null);
/** The Watchtower fills the centre (key h); the board and it are never both open. */
export const watchtowerOpen = signal(false);
/** Active extension workspace view id (`scope: 'workspace'`), or null when Threads/Board/Watchtower is active. */
export const activeCustomView = signal(null);
/** A page fills the centre: the selected project's home (or Global's), or a machine's page. */
export const projectHomeOpen = signal(false);
/** Which page is open: a project's home, its Knowledge and chorus page, or a machine's page ('device'). */
export const projectPage = signal('home');
/** The machine whose page is open (projectPage 'device'): its device id, or 'here' for this one. */
export const devicePageId = signal(null);
/** The board's chip filter: { project?: Set, kingdom?: Set, device?: Set } (FilterChips' selection). */
export const boardFilter = signal({});
/** The Watchtower's chip filter, same shape; a machine's page opens it filtered to that machine. */
export const watchtowerFilter = signal({});

/** Open a machine's page ('here' = this machine): its threads and checkouts. */
export function openDevicePage(deviceId) {
  batch(() => {
    boardOpen.value = false;
    watchtowerOpen.value = false;
    activeCustomView.value = null;
    incomingOpenId.value = null;
    devicePageId.value = deviceId;
    projectPage.value = 'device';
    projectHomeOpen.value = true;
  });
}

/** Open the board filtered to one machine (by the name its cards carry). */
export function openMachineBoard(machineName) {
  batch(() => {
    boardFilter.value = { device: new Set([machineName]) };
    projectHomeOpen.value = false;
    watchtowerOpen.value = false;
    activeCustomView.value = null;
    boardOpen.value = true;
  });
}

/** Open the Watchtower filtered to one machine. */
export function openMachineWatchtower(machineName) {
  batch(() => {
    watchtowerFilter.value = { device: new Set([machineName]) };
    projectHomeOpen.value = false;
    boardOpen.value = false;
    activeCustomView.value = null;
    watchtowerOpen.value = true;
  });
}

/** Open the board filtered to one project. */
export function openProjectBoard(projectId) {
  batch(() => {
    boardFilter.value = { project: new Set([projectId]) };
    projectHomeOpen.value = false;
    watchtowerOpen.value = false;
    activeCustomView.value = null;
    boardOpen.value = true;
  });
}

/** Open a project's Knowledge and chorus page (Esc returns to its home). */
export function openProjectKnowledge(projectId) {
  openProjectHome(projectId);
  projectPage.value = 'knowledge';
}

/** Open a project's home page (null = Global, threads outside any project). */
export function openProjectHome(projectId) {
  batch(() => {
    selectScope(projectId);
    boardOpen.value = false;
    watchtowerOpen.value = false;
    activeCustomView.value = null;
    incomingOpenId.value = null;
    projectPage.value = 'home';
    projectHomeOpen.value = true;
  });
}
/** One turn open in the turn view ({ threadId, turnId }), or null. It opens in the right panel at its
 * widest step and never replaces the centre; closing returns the panel to the size it had. */
export const turnViewTarget = signal(null);
let sizeBeforeTurnView = null;

export function openTurnView(threadId, turnId) {
  if (!turnViewTarget.peek()) sizeBeforeTurnView = rightSize.peek();
  rightSize.value = 'wide';
  turnViewTarget.value = { threadId, turnId };
}

export function closeTurnView() {
  if (!turnViewTarget.peek()) return;
  turnViewTarget.value = null;
  if (sizeBeforeTurnView) rightSize.value = sizeBeforeTurnView;
  sizeBeforeTurnView = null;
}
/** Threads the rail shows expanded (their subagents listed), asked for from outside the row. */
export const railExpanded = signal(new Set());
/** What's typed in the open thread's message box: it goes with a waiting card's answer. */
export const composerNote = signal('');
/**
 * What the next message is about (a Plan step or Loop item), set by its Comment button: the message box
 * shows an About chip, the sent message starts "Re: <label>", and /feedback records it as the target.
 */
export const aboutTarget = signal(null); // { kind: 'plan-step' | 'loop-item', label, turnId? } | null

export function commentOn(target) {
  aboutTarget.value = target;
  requestAnimationFrame(() => document.querySelector('textarea.chat-input')?.focus());
}

/**
 * Focus any registered side-panel tab on its effective side (Left Rail or Right Panel).
 * Full-workspace overlays (Board, Watchtower, custom workspace views) give way. With `toggle`,
 * repeating the key for the tab already showing folds that side panel (except on narrow screens
 * where that panel is hidden behind another compact tab, in which case it switches to it).
 */
export function focusTab(tab, { toggle = false } = {}) {
  const side = effectiveTabSide(tab);
  if (!side) return;
  const isNarrow = typeof window !== 'undefined' && window.innerWidth < 1100;
  if (side === 'left') {
    const narrowHidden = isNarrow && compactPanel.peek() !== 'projects';
    const showingLeft =
      !narrowHidden &&
      projectSidebarOpen.peek() &&
      railView.peek() === tab &&
      !boardOpen.peek() &&
      !watchtowerOpen.peek() &&
      !activeCustomView.peek();
    batch(() => {
      if (toggle && showingLeft) {
        projectSidebarOpen.value = false;
        return;
      }
      boardOpen.value = false;
      watchtowerOpen.value = false;
      activeCustomView.value = null;
      railView.value = tab;
      projectSidebarOpen.value = true;
      compactPanel.value = 'projects';
    });
    return;
  }
  const narrowHidden = isNarrow && compactPanel.peek() !== 'detail';
  const showing =
    !narrowHidden &&
    detailDrawerOpen.peek() &&
    rightTab.peek() === tab &&
    !turnViewTarget.peek() &&
    !inspectTarget.peek() &&
    !boardOpen.peek() &&
    !watchtowerOpen.peek() &&
    !activeCustomView.peek();
  batch(() => {
    if (toggle && showing) {
      detailDrawerOpen.value = false;
      return;
    }
    closeTurnView();
    dismissTraceSelection();
    selectedEvent.value = null;
    inspectTarget.value = null;
    boardOpen.value = false;
    watchtowerOpen.value = false;
    activeCustomView.value = null;
    rightTab.value = tab;
    detailDrawerOpen.value = true;
    compactPanel.value = 'detail';
  });
}

/**
 * Open a tab on its effective side (Right Panel by default, or Left Rail if moved via `ui.panelPlacement`).
 * Kept as a convenience alias over `focusTab` for existing callers and extensions.
 */
export function openRightTab(tab, opts) {
  focusTab(tab, opts);
}

/** Show the thread in the centre, and on a narrow screen switch to it from the right panel. */
export function showThreadView() {
  batch(() => {
    activePanel.value = 'conversation';
    compactPanel.value = 'conversation';
  });
}

/** Return to the Threads workspace view (closing Board, Watchtower, or any custom workspace view). */
export function showThreadsWorkspace() {
  batch(() => {
    boardOpen.value = false;
    watchtowerOpen.value = false;
    activeCustomView.value = null;
  });
}

/** Open a custom extension workspace view (`scope: 'workspace'`). */
export function openCustomView(viewId) {
  if (route.peek().page !== 'workspace') return;
  batch(() => {
    boardOpen.value = false;
    watchtowerOpen.value = false;
    incomingOpenId.value = null;
    activeCustomView.value = viewId;
  });
}

/** Whether an active custom workspace view is registered and fills the full workspace width. */
export function isFullWidthCustomView() {
  const id = activeCustomView.value;
  if (!id) return false;
  const def = mainViews('workspace').find((v) => v.extId && v.id === id);
  return Boolean(def && def.fullWidth !== false);
}

/** The board is a workspace view: it toggles only there. */
export function toggleBoard() {
  if (route.peek().page !== 'workspace') return;
  watchtowerOpen.value = false;
  activeCustomView.value = null;
  boardOpen.value = !boardOpen.value;
}

export function toggleWatchtower() {
  if (route.peek().page !== 'workspace') return;
  boardOpen.value = false;
  activeCustomView.value = null;
  watchtowerOpen.value = !watchtowerOpen.value;
}

/** The open thread's launch settings (GET /api/threads/:id/launch): provider, model, effort, permission mode. */
export const threadLaunch = signal(null);
/** The model registry (GET /api/models), once read: providers and their models with context windows. */
export const modelRegistry = signal(null);

/** A model's context window from the registry, or null when unknown. */
export function contextWindowOf(provider, model) {
  const entry = modelRegistry.value?.providers?.find((p) => p.id === provider);
  return entry?.models?.find((m) => m.id === model)?.contextWindow ?? null;
}
/** Display names for a provider and model from the registry; the raw ids until it has loaded. */
/**
 * The vendor a provider id belongs to, by its short name ("Anthropic", "OpenAI"): Claude Code and
 * the Anthropic API are both Anthropic, Codex and the OpenAI API both OpenAI. The harness is detail.
 */
export function vendorName(provider, registry = modelRegistry.value) {
  if (!provider) return null;
  const vendor = registry?.vendors?.find((v) =>
    Object.values(v.modes ?? {}).some((m) => m?.provider === provider),
  );
  return vendor ? vendor.label.replace(/\s*\(.*\)\s*$/, '') : null;
}

export function launchLabels(provider, model) {
  const entry = modelRegistry.value?.providers?.find((p) => p.id === provider);
  return {
    // Only names the registry knows: an unknown provider or model shows nothing, never its raw id.
    provider: vendorName(provider) ?? entry?.label ?? null,
    model: entry ? (entry.models?.find((m) => m.id === model)?.label ?? model ?? null) : null,
  };
}
/**
 * A model id's display name from the registry ("claude-opus-5-5", or the alias "opus", both read
 * "Opus 5.5"), across every provider; null until the registry loads or for an id it does not know.
 */
export function modelLabel(model, registry = modelRegistry.value) {
  if (!model) return null;
  if (!registry) {
    void modelRegistryOnce().then((loaded) => {
      if (loaded && !modelRegistry.value) modelRegistry.value = loaded;
    });
    return null;
  }
  for (const provider of registry.providers ?? []) {
    const entry = provider.models?.find((m) => m.id === model);
    if (entry?.label) return entry.label;
  }
  return null;
}
export const compactPanel = signal('conversation');

// Action prompts — pending agent→human interactions
export const prompts = signal([]); // pending ActionPrompt[]
/** What's waiting on you in one thread: its pending prompts. The one source for the waiting stack,
 * the rail row's badge and Plan's "Needs you", so the three never disagree. */
export function waitingFor(threadId, pending = prompts.value) {
  if (!threadId || !Array.isArray(pending)) return [];
  return pending.filter((p) => p.threadId === threadId);
}

export const promptCounts = computed(() => {
  // { threadId: count }, from the same filter as `waitingFor`
  const counts = {};
  for (const id of new Set(prompts.value.map((p) => p.threadId)))
    counts[id] = waitingFor(id).length;
  return counts;
});

// Worktrees — detected git worktrees for thread assignment
export const worktrees = signal([]); // GitWorktree[] from GET /api/worktrees

// Token usage — per-thread recorded usage (analytics.threads) plus the Foundry session budget
export const tokenUsage = signal(null);

// Conversation — chat messages (user + agent responses)
// Each entry: { actor: "user"|"agent", content, timestamp, traceId?, error? }
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
  const instanceIds = new Set(instances.map((l) => l.id));
  const uninstantiated = defs.filter((d) => d.enabled && !instanceIds.has(d.id));
  return { instances, uninstantiated };
});

export const mergedAgents = computed(() => {
  const instances = threadData.value?.agents ?? [];
  const defs = definitions.value?.agents ?? [];
  const instanceIds = new Set(instances.map((a) => a.agentId));
  const uninstantiated = defs.filter((d) => d.enabled && !instanceIds.has(d.id));
  return { instances, uninstantiated };
});

// Layer color cache — persistent color per layer ID
const _layerColors = {};
// Categorical, not status: one hue per layer id. Values live in styles.css (--layer-0 … --layer-11).
const LAYER_PALETTE = Array.from({ length: 12 }, (_, i) => `var(--layer-${i})`);

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
const clientId = uuidv7();
let pendingFrames = [];
let frameScheduled = false;
let activeStream = null,
  eventsStream = null,
  threadsStream = null;
const liveTurns = new Map(); // threadId → Map(turnId → live turn) while its stream is held
const pendingSends = new Map(); // turnId → threadId: sends from this tab awaiting their terminal

function liveView(threadId) {
  const turns = liveTurns.get(threadId);
  return turns ? { buffers: [...turns.values()] } : undefined;
}

function releaseStream(stream) {
  socket.close(stream);
  if (!socket.holds(stream) && stream.startsWith('thread:'))
    liveTurns.delete(stream.slice('thread:'.length));
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
  batch(() => {
    for (const frame of frames) applyFrame(frame, touched);
  });
  for (const threadId of touched) refreshLiveRows(threadId);
}

function applyFrame(frame, touched) {
  // Released earlier in this same flush (a settled send): its remaining frames are stale.
  if (!socket.holds(frame.stream)) return;
  const split = frame.stream.indexOf(':');
  const family = split < 0 ? frame.stream : frame.stream.slice(0, split);
  const key = split < 0 ? null : frame.stream.slice(split + 1);
  if (family === 'thread') applyThreadFrame(key, frame, touched);
  else if (family === 'threads') applyThreadsFrame(frame);
  else if (family === 'prompts') applyPromptsFrame(frame);
  else if (family === 'events') applyEventsFrame(frame);
  else for (const onFrame of heldStreams.get(frame.stream) ?? []) onFrame(frame);
}

// Streams panels hold for themselves, each with the handlers that apply their frames (in the same
// per-animation-frame batch as the store's own). Several panels may hold one stream (Plan and the
// right panel's Work both read `flow:<id>`): a holder that joins asks for a fresh snapshot, which
// every holder takes, so each starts from a snapshot of its own.
const heldStreams = new Map();

/** Open `stream` for a panel while it shows it; `onFrame` gets its frames, and `{ action: "rejected" }`
 * if the server refuses it. Returns the release. */
export function holdStream(stream, onFrame) {
  const holders = heldStreams.get(stream);
  if (holders) holders.add(onFrame);
  else heldStreams.set(stream, new Set([onFrame]));
  socket.open(stream);
  if (holders) socket.snapshot(stream);
  return () => {
    const current = heldStreams.get(stream);
    if (!current?.delete(onFrame)) return;
    if (!current.size) heldStreams.delete(stream);
    socket.close(stream);
  };
}

/** Hold the `schedules` stream for the whole workspace: the Scheduled rail and its draft count read it. */
function holdSchedules() {
  holdStream('schedules', (frame) => {
    if (frame.action === 'rejected') return;
    schedules.value = frame.payload?.schedules ?? [];
  });
}

const newestFeedbackFirst = (a, b) => b.origin.at - a.origin.at || (a.id < b.id ? 1 : -1);

/** Hold the `feedback` stream for the whole workspace: one list, three scopes (inbox, project, thread). */
function holdFeedback() {
  holdStream('feedback', (frame) => {
    if (frame.action === 'rejected') return;
    if (frame.action === 'snapshot')
      feedbackItems.value = [...(frame.payload.items ?? [])].sort(newestFeedbackFirst);
    else if (frame.payload?.item)
      feedbackItems.value = [
        frame.payload.item,
        ...feedbackItems.value.filter((item) => item.id !== frame.payload.item.id),
      ].sort(newestFeedbackFirst);
  });
}

/** Select a pinned scope or a project: Global (`null`), a project id, Forge Master or the Feedback inbox. */
export function selectScope(scope) {
  batch(() => {
    const pinned = isScope(scope);
    forgeMasterOpen.value = scope === '@forge';
    feedbackInboxOpen.value = scope === '@feedback';
    if (!pinned) activeProjectId.value = scope;
    if (pinned) compactPanel.value = 'conversation';
    if (pinned) projectHomeOpen.value = false;
  });
}

/** `/feedback <text>`: record feedback on a thread (its last turn unless one is named). Never a turn. */
export async function giveFeedback(threadId, text, { turnId, messageId, about, tags } = {}) {
  if (!threadId) {
    showToast('Open a thread to give feedback on it', 'warn', { thread: threadId });
    return false;
  }
  try {
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        surface: 'viewer',
        ...(turnId ? { turnId } : {}),
        ...(messageId ? { messageId } : {}),
        ...(about ? { about: { kind: about.kind, label: about.label } } : {}),
        ...(tags?.length ? { tags } : {}),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(body.error || 'Feedback not recorded', 'error', { thread: threadId });
      return false;
    }
    showToast('Feedback recorded', 'ok', { thread: threadId });
    return true;
  } catch (err) {
    showToast(`Feedback not recorded: ${err.message}`, 'error', { thread: threadId });
    return false;
  }
}

/** Archive feedback items, or put them back in the inbox. */
export async function setFeedbackStatus(itemIds, status) {
  if (!itemIds.length) return false;
  try {
    const res = await authFetch('/api/feedback/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds, status }),
    });
    if (res.ok) return true;
    showToast((await res.json().catch(() => ({}))).error || 'Feedback not updated', 'error');
  } catch (err) {
    showToast(`Feedback not updated: ${err.message}`, 'error');
  }
  return false;
}

/** Go to where a feedback item was given: its project, its thread, its turn. */
export function openFeedbackSource(item) {
  batch(() => {
    forgeMasterOpen.value = false;
    feedbackInboxOpen.value = false;
    activeProjectId.value = item.projectId ?? null;
    activePanel.value = 'conversation';
    focusTurnId.value = item.origin.turnId ?? null;
  });
  selectThread(item.origin.threadId);
}

/** Open a layer in the detail drawer (from the chat or the graph). */
export function inspectLayer(layerId) {
  selectedEvent.value = null;
  dismissTraceSelection();
  inspectTarget.value = { kind: 'layer', id: layerId };
  detailDrawerOpen.value = true;
  compactPanel.value = 'detail';
}

/** The centre: the thread or the turn graph. */
export function toggleGraphPanel() {
  activePanel.value = activePanel.value === 'graph' ? 'conversation' : 'graph';
}

function applyThreadFrame(threadId, frame, touched) {
  const payload = frame.payload;
  if (frame.action === 'append' && payload.kind === 'event') {
    scheduleReconcile([payload.event]);
    return;
  }
  // This tab's send went into the running turn (CORE-001): it gets no answer of its own.
  if (frame.action === 'append' && payload.kind === 'steered') {
    _markSteered(threadId, payload.turnId, payload.result?.into);
    settleSend(payload.turnId);
    return;
  }
  if (frame.action === 'append' && (payload.kind === 'done' || payload.kind === 'error')) {
    // This tab's own send: the full terminal, with evidence the bounded live turn never carries.
    // Its row may be ahead of live turns applied earlier in this flush: merge them first.
    if (touched.delete(threadId)) refreshLiveRows(threadId);
    const row = (_threadMessages[threadId] ?? []).find(
      (m) => m.actor === 'agent' && m.turnId === payload.turnId,
    );
    _updateAgentMessage(
      threadId,
      payload.turnId,
      terminalMessagePatch({ type: payload.kind, ...payload.result }, row?.content ?? ''),
    );
    settleSend(payload.turnId);
    return;
  }
  const previous = liveTurns.get(threadId) ?? new Map();
  const next = applyTurnFrame(previous, frame);
  if (next === previous) return;
  if (frame.action === 'snapshot') {
    // A send accepted after the open this snapshot answers may be missing from it; the stream will say more.
    for (const [turnId, turn] of previous)
      if (turn.seededAt > frame.requestedAt && !next.has(turnId)) next.set(turnId, turn);
  }
  liveTurns.set(threadId, next);
  touched.add(threadId);
  const completed =
    frame.action === 'snapshot'
      ? [...next.values()].some((turn) => turn.completedAt)
      : payload.kind === 'turn' && payload.turn.completedAt;
  if (completed) requestReconcile(threadId);
}

/** Merge the thread's live turns into its rows; a turn the stream reports is positively observed.
 * A thread whose history has not loaded yet is left alone: its first load merges the live turns,
 * and must not be raced by a live-only cache that would displace the browser copy. */
function refreshLiveRows(threadId) {
  const turns = liveTurns.get(threadId);
  const rows = _threadMessages[threadId];
  if (!turns || !rows) return;
  _setThreadMessages(
    threadId,
    rows.map((m) =>
      m.actor === 'agent' && m.connectionStatus && turns.has(m.turnId)
        ? { ...m, connectionStatus: undefined }
        : m,
    ),
  );
  for (const [turnId, owner] of pendingSends) {
    if (owner !== threadId) continue;
    const row = _threadMessages[threadId]?.find((m) => m.actor === 'agent' && m.turnId === turnId);
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

/**
 * Completions this tab has shown its person on the open thread (threadId → completedAt), until the
 * server's seen mark catches up. A list push carries the server's `seenAt`, older while the mark is
 * on its way, so each entry that arrives keeps this tab's knowledge: the thread being read is never
 * a new arrival to the person reading it.
 */
const seenHere = new Map();
function withSeenHere(thread) {
  const completedAt = seenHere.get(thread?.threadId);
  if (completedAt === undefined) return thread;
  if ((thread.meta?.seenAt ?? 0) >= completedAt) {
    seenHere.delete(thread.threadId);
    return thread;
  }
  return { ...thread, meta: { ...thread.meta, seenAt: completedAt } };
}

function applyThreadsFrame(frame) {
  if (frame.stream !== threadsStream) return;
  const payload = frame.payload;
  if (frame.action === 'snapshot') {
    adoptThreadList(payload.threads.map(withSeenHere));
    return;
  }
  if (payload.removed) {
    allThreads.value = allThreads.value.filter((thread) => thread.threadId !== payload.removed);
    if (activeThreadId.value === payload.removed)
      selectThreadQuietly(allThreads.value[0]?.threadId ?? null);
    return;
  }
  const listed = withSeenHere(payload.thread);
  const list = allThreads.value;
  const i = list.findIndex((thread) => thread.threadId === listed.threadId);
  allThreads.value =
    i < 0 ? [...list, listed] : list.map((thread, j) => (j === i ? listed : thread));
  if (listed.threadId === activeThreadId.value) threadData.value = listed;
}

// First load only: an empty global scope opens the first project that has threads.
let initialScopeOpen = true,
  globalListed = false,
  projectsListed = false;
function settleInitialScope() {
  if (!initialScopeOpen || !globalListed || !projectsListed) return;
  initialScopeOpen = false;
  if (activeProjectId.value || activeThreadId.value) return;
  const project = projects.value.find((p) => p.threadCount > 0);
  if (project) activeProjectId.value = project.id;
}

/** On the Active rail the scope follows the open thread: its project, Global, or its Foundry scope. */
function followActiveProject() {
  if (isTabActive('projects', { peek: true }) || !railSpansProjects(railView.peek())) return;
  const listed = allThreads.peek().find((t) => t.threadId === activeThreadId.peek());
  if (!listed) return;
  const scope = scopeOfThread(listed);
  batch(() => {
    forgeMasterOpen.value = scope === '@forge';
    feedbackInboxOpen.value = scope === '@feedback';
    if (!scope) activeProjectId.value = listed.meta?.projectId ?? null;
  });
}

function adoptThreadList(threads) {
  if (threadsStream === 'threads') {
    globalListed = true;
    settleInitialScope();
  } else initialScopeOpen = false; // the first load opened somewhere else: a later Global stays Global
  allThreads.value = threads;
  followActiveProject();
  if (!threads.some((thread) => thread.threadId === activeThreadId.value))
    selectThreadQuietly(threads[0]?.threadId ?? null);
  const active = activeThreadId.value;
  threadData.value = active ? (threads.find((thread) => thread.threadId === active) ?? null) : null;
  // Always load messages for the active thread if we don't have them yet
  if (active && messages.value.length === 0 && !_threadMessages[active])
    _loadThreadMessages(active);
}

function applyPromptsFrame(frame) {
  if (frame.action === 'snapshot') {
    prompts.value = frame.payload.prompts;
    return;
  }
  const prompt = frame.payload.prompt;
  const rest = prompts.value.filter((p) => p.id !== prompt.id);
  prompts.value = prompt.status === 'pending' ? [...rest, prompt] : rest;
}

const eventTime = (event) =>
  new Date(
    event.timestamp ??
      event.signal?.timestamp ??
      event.event?.timestamp ??
      event.dispatch?.timestamp ??
      event.context?.timestamp ??
      Date.now(),
  ).toLocaleTimeString();

function applyEventsFrame(frame) {
  if (frame.stream !== eventsStream) return;
  if (frame.action === 'snapshot') {
    liveEvents.value = frame.payload.events
      .slice()
      .reverse()
      .map((event) => ({ ...event, _time: eventTime(event) }));
    const activities = frame.payload.activities ?? [];
    systemActivity.value = activities;
    systemActivityLog.value = activities.slice().reverse();
    return;
  }
  const event = frame.payload.event;
  // System activity shows in the strip above the composer, never as a toast.
  if (event.kind === 'activity') {
    systemActivity.value = [...systemActivity.value.filter((a) => a.key !== event.key), event];
    systemActivityLog.value = [event, ...systemActivityLog.value].slice(0, 100);
    return;
  }
  eventCount.value += 1;
  // Surface error events from the backend as toasts
  if (event.kind === 'error')
    showToast(`[${event.source}] ${event.message}`, event.severity === 'warn' ? 'warn' : 'error', {
      thread: event.threadId,
    });
  const next = [{ ...event, _time: new Date().toLocaleTimeString() }, ...liveEvents.value];
  liveEvents.value = next.length > 200 ? next.slice(0, 200) : next;
}

/** Re-open every held stream for fresh snapshots. */
export function resyncStreams() {
  socket?.resync();
}

function connectStreams() {
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = createDataStreamSocket(`${wsProto}//${location.host}/ws?client=${clientId}`, {
    reconnectDelayMs: 2000,
    onData: queueFrame,
    onStatus: (status) => {
      connected.value = status === 'open';
      if (status === 'open') return;
      // While the daemon is gone its port serves the status page, whose boot id reloads this page there.
      void loadUpdateState();
      // Live work on a dropped connection is unconfirmed until a fresh snapshot says otherwise.
      for (const threadId of liveTurns.keys()) {
        const rows = _threadMessages[threadId];
        if (rows)
          _setThreadMessages(
            threadId,
            rows.map((m) =>
              m.live && m.streaming ? { ...m, connectionStatus: 'unconfirmed' } : m,
            ),
          );
      }
    },
    onReconnect: () => {
      requestReconcile(activeThreadId.value, 0);
      // The socket came back: if the daemon restarted, the update poll reloads the page.
      void loadUpdateState();
    },
    // A rejection means the stream's subject is gone (losing authorization closes the socket instead).
    onRejected: (stream) => {
      // A project that no longer exists scopes nothing; fall back to the unscoped list.
      if (stream === threadsStream && activeProjectId.value) activeProjectId.value = null;
      for (const onFrame of heldStreams.get(stream) ?? []) onFrame({ action: 'rejected', stream });
      if (!stream.startsWith('thread:')) return;
      const threadId = stream.slice('thread:'.length);
      if (stream === activeStream) activeStream = null;
      liveTurns.delete(threadId);
      // Sends on a thread that no longer exists will not report here; their outcome is unconfirmed.
      for (const [turnId, owner] of [...pendingSends]) {
        if (owner !== threadId) continue;
        _updateAgentMessage(threadId, turnId, {
          streaming: false,
          connectionStatus: 'unconfirmed',
        });
        pendingSends.delete(turnId);
        inflight.value = Math.max(0, inflight.value - 1);
      }
    },
  });
  socket.connect();
  socket.open('prompts');
  effect(() => {
    const projectId = activeProjectId.value;
    const projectsActive = isTabActive('projects');
    const rightCrossProject = detailDrawerOpen.value && CROSS_PROJECT_TABS.has(rightTab.value);
    const leftCrossProject =
      railSpansProjects(railView.value) && (!projectsActive || projectSidebarOpen.value);
    const next =
      boardOpen.value || rightCrossProject || leftCrossProject
        ? 'threads:all'
        : forgeMasterOpen.value
          ? 'threads:@forge'
          : feedbackInboxOpen.value
            ? 'threads:@feedback'
            : projectId
              ? `threads:${projectId}`
              : 'threads';
    if (next === threadsStream) return;
    if (threadsStream) socket.close(threadsStream);
    threadsStream = next;
    socket.open(next);
  });
  effect(() => {
    const threadId = activeThreadId.value;
    const nextThread = threadId ? `thread:${threadId}` : null;
    const nextEvents = threadId ? `events:${threadId}` : 'events';
    if (nextThread !== activeStream) {
      if (activeStream) releaseStream(activeStream);
      activeStream = nextThread;
      if (nextThread) socket.open(nextThread);
    }
    if (nextEvents !== eventsStream) {
      if (eventsStream) socket.close(eventsStream);
      eventsStream = nextEvents;
      liveEvents.value = [];
      systemActivity.value = [];
      systemActivityLog.value = [];
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
    if (selectedDetailTarget(event, currentTrace.value?.selectedTurn, activeThreadId.value))
      requestSelectedDetail();
    const target = reconcileTargets(event);
    if (!target) continue;
    const current = targets.get(target.threadId) ?? { messages: false, knowledge: false };
    targets.set(target.threadId, {
      messages: current.messages || target.messages,
      knowledge: current.knowledge || target.knowledge,
    });
  }
  for (const [threadId, target] of targets) {
    if (target.messages) requestReconcile(threadId);
    if (target.knowledge && activeThreadId.value === threadId) requestKnowledge(threadId);
  }
}

/** Debounced per thread; a burst of events for one thread costs one fetch. */
export function requestReconcile(threadId, delay = 400) {
  if (!threadId || reconcileTimers.has(threadId)) return;
  reconcileTimers.set(
    threadId,
    setTimeout(() => {
      reconcileTimers.delete(threadId);
      _reconcileThread(threadId);
    }, delay),
  );
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
      const res = await authFetch(
        `/api/messages?threadId=${encodeURIComponent(threadId)}&limit=200`,
        { cache: 'no-store' },
      );
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
    if (result.data)
      _setPaging(threadId, _pagingFromPage(result.data, historyPaging.value[threadId]));
    const next = reconcileThreadMessages(cache, rows, threadId);
    if (next === cache) return;
    // Written into this thread's own cache; mirrored to `messages` only when it is active.
    _setThreadMessages(threadId, next);
  } catch {
    /* Live events stay visible; the next owned event or visibility change retries. */
  }
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
  historyPaging.value = {
    ...historyPaging.value,
    [threadId]: { ...(historyPaging.value[threadId] ?? {}), ...patch },
  };
}

/** The newest page decides whether older records exist; an older page only advances the cursor. */
function _pagingFromPage(page, previous, older = false) {
  if (older)
    return {
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      oldestReached: page.oldestReached,
      pages: (previous?.pages ?? 1) + 1,
    };
  if (previous?.pages > 1 || previous?.oldestReached) return { indexUnavailable: false }; // older pages already walked; keep their cursor
  return {
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    oldestReached: page.oldestReached,
    pages: 1,
    indexUnavailable: false,
  };
}

async function _fetchHistoryIndex(threadId, cursor) {
  const url =
    `/api/threads/${encodeURIComponent(threadId)}/history?limit=${HISTORY_PAGE}` +
    (cursor ? `&before=${encodeURIComponent(cursor)}` : '');
  const res = await authFetch(url, { cache: 'no-store' });
  // 404: an older server without the route; 503: no journal. Neither is an empty history.
  if (res.status === 404 || res.status === 503) return { unavailable: true, status: res.status };
  if (!res.ok) return { error: res.status };
  const data = await res.json();
  if (!Array.isArray(data.messages)) return { error: 'malformed' };
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
      _setPaging(threadId, {
        loading: false,
        error: result.unavailable
          ? 'Older history is unavailable from this server.'
          : `Older history request failed (${result.error}).`,
      });
      return;
    }
    const cache = _threadMessages[threadId] ?? [];
    // Older rows merge by identity; a repeated page adds nothing and moves nothing.
    const next = mergeMessageHistory(cache, result.data.messages);
    _setThreadMessages(threadId, next);
    _setPaging(threadId, {
      loading: false,
      error: null,
      ..._pagingFromPage(result.data, paging, true),
    });
  } catch (err) {
    if (olderRequests.get(threadId) !== requestId) return;
    _setPaging(threadId, { loading: false, error: `Older history unavailable: ${err.message}` });
  }
}

function requestKnowledge(threadId) {
  if (knowledgeTimer) return;
  knowledgeTimer = setTimeout(() => {
    knowledgeTimer = null;
    loadKnowledge(threadId);
  }, 400);
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
    knowledgeInspection.value = {
      threadId,
      payload: null,
      error: null,
      loadedAt: null,
      pending: true,
      superseded: knowledgeSuperseded,
    };
  }
  let outcome;
  try {
    // Live state bypasses the HTTP cache: Chromium serializes identical cacheable
    // GETs behind a cache lock (up to 20 s), which would let a stalled older
    // request delay the newer one it is supposed to lose to.
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/knowledge`, {
      cache: 'no-store',
    });
    const payload = await res.json().catch(() => null);
    const usable = res.ok
      ? payload
      : payload && typeof payload.status === 'string'
        ? payload
        : { status: 'unavailable', error: payload?.error ?? `HTTP ${res.status}` };
    outcome = { payload: usable, error: res.ok ? null : (payload?.error ?? `HTTP ${res.status}`) };
  } catch (err) {
    outcome = { payload: { status: 'unavailable', error: err.message }, error: err.message };
  }
  if (knowledgeRequests.get(threadId) !== requestId) {
    knowledgeSuperseded += 1;
    const latest = knowledgeInspection.value;
    if (latest?.threadId === threadId)
      knowledgeInspection.value = { ...latest, superseded: knowledgeSuperseded };
    return;
  }
  if (activeThreadId.value !== threadId) return;
  knowledgeInspection.value = {
    threadId,
    ...outcome,
    loadedAt: Date.now(),
    pending: false,
    superseded: knowledgeSuperseded,
    requestId,
  };
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export async function loadTraces() {
  try {
    const res = await authFetch('/api/traces?limit=50');
    if (!res.ok) {
      showToast(`Failed to load traces: ${res.status}`, 'error');
      return;
    }
    traces.value = await res.json();
  } catch (err) {
    if (connected.value) showToast(`Traces unavailable: ${err.message}`, 'warn');
  }
}

// Latest trace request owns the drawer; an older response never replaces a newer selection.
let traceSequence = 0;
let detailSequence = 0;
let selectedDetailTimer = null;
function requestSelectedDetail() {
  if (selectedDetailTimer) return;
  const requestId = traceSequence,
    trace = currentTrace.value;
  selectedDetailTimer = setTimeout(() => {
    selectedDetailTimer = null;
    if (
      !trace?.selectedTurn?.turnId ||
      !ownsTraceRequest(requestId, trace.selectedTurn.threadId) ||
      currentTrace.value?.id !== trace.id
    )
      return;
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
  const message = messages.value.find((message) => message.traceId === traceId);
  const requestId = ++traceSequence;
  currentTrace.value = null;
  selectedEvent.value = null;
  detailDrawerOpen.value = true;
  compactPanel.value = 'detail';
  const selectedTurn = message
    ? {
        threadId,
        turnId: message.turnId ?? null,
        messageId: message.id ?? null,
        actor: message.actor,
        timestamp: message.timestamp ?? null,
        // What the index row carries versus what only the journal detail holds (names only; no payloads).
        summaryMeta: Object.keys(message.meta ?? {}),
        detailOnlyMeta: Array.isArray(message.detail?.detailOnlyMeta)
          ? message.detail.detailOnlyMeta
          : null,
      }
    : { threadId, turnId: null, messageId: null };
  try {
    const res = await authFetch(`/api/traces/${encodeURIComponent(traceId)}`);
    if (!ownsTraceRequest(requestId, threadId)) return;
    let trace;
    if (res.ok) {
      trace = { ...(await res.json()), injection: message?.meta?.injection };
      if (!ownsTraceRequest(requestId, threadId)) return;
    } else if (message?.trace) {
      trace = {
        id: traceId,
        summary: message.trace,
        injection: message.meta?.injection,
        detailUnavailable: true,
      };
    } else {
      showToast(`Failed to load trace: ${res.status}`, 'error');
      return;
    }
    currentTrace.value = {
      ...trace,
      selectedTurn,
      detailStatus: message?.meta?.injection ? 'inline' : 'none',
    };
    selectedSpanId.value = null;
    // Index rows carry no injection or native payloads; fetch the owned turn detail lazily.
    // Browser-only rows (unsaved completions, legacy history) have no journal detail to fetch.
    const journalled =
      message?.detail ||
      message?.storage === 'server' ||
      message?.meta?.persistence === 'committed';
    if (message?.turnId && !message.meta?.injection && journalled)
      await _loadTurnDetail(threadId, message.turnId, traceId, requestId);
  } catch (err) {
    if (ownsTraceRequest(requestId, threadId) && connected.value)
      showToast(`Trace unavailable: ${err.message}`, 'warn');
  }
}

/** Open any owned turn directly through the journal detail route, whether or not its row is in the loaded page. */
export async function openTurnDetail(threadId, turnId) {
  const requestId = ++traceSequence;
  currentTrace.value = null;
  selectedEvent.value = null;
  detailDrawerOpen.value = true;
  compactPanel.value = 'detail';
  try {
    const res = await authFetch(
      `/api/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/detail`,
      { cache: 'no-store' },
    );
    // Superseded by a thread switch, a newer selection or a dismissal: publish nothing, re-open nothing, toast nothing.
    if (!ownsTraceRequest(requestId, threadId)) return;
    if (res.status === 404) {
      showToast(`Turn ${turnId} is not in this thread's journal`, 'warn', { thread: threadId });
      return;
    }
    if (!res.ok) {
      showToast(`Turn detail unavailable (${res.status})`, res.status === 503 ? 'warn' : 'error');
      return;
    }
    const detail = await res.json();
    if (!ownsTraceRequest(requestId, threadId)) return;
    const agent = Array.isArray(detail.messages)
      ? detail.messages.find((m) => m.actor === 'agent')
      : null;
    const selectedTurn = {
      threadId,
      turnId,
      messageId: agent?.id ?? null,
      actor: agent ? 'agent' : null,
      timestamp: agent?.timestamp ?? null,
      summaryMeta: [],
      detailOnlyMeta: Object.keys(agent?.meta ?? {}),
    };
    const base = detail.trace ?? {
      id: `turn:${turnId}`,
      messageId: turnId,
      summary: null,
      detailUnavailable: true,
    };
    currentTrace.value = {
      ...base,
      injection: detail.injection ?? undefined,
      detail,
      detailStatus: 'loaded',
      selectedTurn,
    };
    selectedSpanId.value = null;
  } catch (err) {
    if (ownsTraceRequest(requestId, threadId) && connected.value)
      showToast(`Turn detail unavailable: ${err.message}`, 'warn');
  }
}

/** Historical detail for one turn: recorded injection, native events, tool records, artifacts. Never cached in browser storage. */
async function _loadTurnDetail(threadId, turnId, traceId, requestId) {
  const detailRequest = ++detailSequence;
  const patch = (value) => {
    if (
      detailRequest !== detailSequence ||
      !ownsTraceRequest(requestId, threadId) ||
      currentTrace.value?.id !== traceId
    )
      return;
    currentTrace.value = { ...currentTrace.value, ...value };
  };
  patch({ detailStatus: 'loading' });
  try {
    const res = await authFetch(
      `/api/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/detail`,
      { cache: 'no-store' },
    );
    if (!ownsTraceRequest(requestId, threadId)) return;
    if (!res.ok) {
      patch({
        detailStatus: res.status === 404 ? 'not-journalled' : `unavailable (${res.status})`,
      });
      return;
    }
    const detail = await res.json();
    patch({
      detail,
      injection: detail.injection ?? currentTrace.value?.injection,
      detailStatus: 'loaded',
    });
  } catch (err) {
    patch({ detailStatus: `unavailable (${err.message})` });
  }
}

const REJECTING = new Set(['rejected', 'reject', 'not-now', 'dismiss', 'withdraw']);

export async function resolvePrompt(promptId, action, input, { always, note: given } = {}) {
  // Text in the message box goes with the answer: a rejected approval carries it in its message to
  // the agent; any other answer posts it to the thread right after, through the normal send.
  const note = (given ?? composerNote.peek()).trim();
  const prompt = prompts.peek().find((p) => p.id === promptId);
  try {
    const res = await fetch(`/api/prompts/${encodeURIComponent(promptId)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        input,
        ...(note ? { note } : {}),
        ...(always ? { always: true } : {}),
      }),
    });
    if (res.ok) {
      if (prompt?.threadId) void leaveFinishedAttention(prompt.threadId, promptId);
      if (note) {
        // The note went with the answer: empty the box (its mirror empties composerNote).
        if (!given) composerFill.value = '';
        const carried = REJECTING.has(action) && prompt?.kind === 'approval';
        if (!carried) await sendMessage(note);
        showToast(`${action} · your note went with it`, 'ok', { thread: prompt?.threadId });
      } else showToast(`Prompt resolved: ${action}`, 'ok', { thread: prompt?.threadId });
      return true;
    }
    const err = await res.json();
    showToast(err.error || 'Failed to resolve prompt', 'error', { thread: prompt?.threadId });
    return false;
  } catch (err) {
    showToast(`Prompt resolution failed: ${err.message}`, 'error', { thread: prompt?.threadId });
    return false;
  }
}

/** Rough token estimate — ~4 chars per token for code-mixed content. */
function estimateContextTokens(msgs) {
  let chars = 0;
  for (const m of msgs) {
    chars += (m.content || '').length;
  }
  return Math.ceil(chars / 4);
}

/** The model registry is static for a daemon's life: read once, retried after a failure. */
let registryRequest = null;
export function modelRegistryOnce() {
  registryRequest ??= authFetch('/api/models')
    .then((res) => (res.ok ? res.json() : Promise.reject(Error('models unavailable'))))
    .catch(() => {
      registryRequest = null;
      return null;
    });
  return registryRequest;
}

export async function loadTokenUsage() {
  try {
    const [budgetRes, analyticsRes, settingsRes, modelsRes] = await Promise.all([
      authFetch('/api/analytics/budget'),
      authFetch('/api/analytics'),
      authFetch('/api/settings'),
      modelRegistryOnce(),
    ]);
    const budget = budgetRes.ok ? await budgetRes.json() : {};
    const analytics = analyticsRes.ok ? await analyticsRes.json() : {};
    const settings = settingsRes.ok ? await settingsRes.json() : {};
    const registry = modelsRes ?? {};
    if (modelsRes) modelRegistry.value = modelsRes;
    const provider = registry.providers?.find((p) => p.id === settings.defaults?.provider);
    const model = provider?.models?.find((m) => m.id === settings.defaults?.model);
    tokenUsage.value = {
      // The default model's context window (configuration, not an observed fill).
      contextWindow: model?.contextWindow ?? null,
      // Recorded usage per thread id; a thread's decision calls run under `<threadId>:aux:<role>`.
      threads: Array.isArray(analytics.threads) ? analytics.threads : [],
      // Without API tokens every call runs on a subscription login: there is no per-call cost.
      subscription: settings.apiTokens !== true,
      usedCost: budget.usedCost ?? 0,
      limitCost: budget.limitCost,
      percentage: budget.percentage ?? 0,
      warning: budget.warning ?? false,
      exceeded: budget.exceeded ?? false,
    };
  } catch {
    /* silent — analytics may not be configured */
  }
}

/** The recorded usage of one thread (its own calls and its decision calls), or null when none is recorded. */
export function threadUsage(usage, threadId) {
  if (!usage || !threadId) return null;
  const rows = usage.threads.filter(
    (row) => row.threadId === threadId || row.threadId?.startsWith(`${threadId}:`),
  );
  if (!rows.length) return null;
  const sum = (key) => rows.reduce((n, row) => n + (row[key] ?? 0), 0);
  const input = sum('input'),
    output = sum('output'),
    cacheRead = sum('cacheRead'),
    cacheWrite = sum('cacheWrite');
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    cost: sum('cost'),
    calls: sum('calls'),
  };
}

export async function loadDefinitions() {
  try {
    const res = await authFetch('/api/definitions');
    if (!res.ok) {
      showToast(`Failed to load definitions: ${res.status}`, 'error');
      return;
    }
    definitions.value = await res.json();
  } catch (err) {
    if (connected.value) showToast(`Definitions unavailable: ${err.message}`, 'warn');
  }
}

export async function loadWorktrees() {
  try {
    const res = await authFetch('/api/worktrees');
    if (!res.ok) return;
    const data = await res.json();
    worktrees.value = data.worktrees ?? [];
  } catch {
    /* silent — git may not be available */
  }
}

/**
 * Incoming: parties asking to join this Foundry's threads through a Signet (Kingdom's pending
 * requests). Not prompts: nothing runs until the owner accepts in Kingdom.
 */
export const incoming = signal([]);
/** The incoming request open in the centre (its request view), or null. */
export const incomingOpenId = signal(null);

export async function loadIncoming() {
  try {
    const res = await authFetch('/api/kingdom/incoming');
    if (!res.ok) return;
    const data = await res.json();
    incoming.value = Array.isArray(data.requests) ? data.requests : [];
  } catch {
    /* silent — no Kingdom paired, or the daemon is restarting */
  }
}

/** Paired Kingdoms as /api/kingdom/status describes them (owners, holders); null until read. */
export const kingdomStatus = signal(null);

/** The daemon's update state (`/api/daemon/update`): idle, spinning down for a restart, postponed, restarting. */
export const updateState = signal(null);

/** The pause time on this page's clock, from the daemon's time left (never its clock). */
const withLocalPause = (state) =>
  state && typeof state.pauseInMs === 'number'
    ? { ...state, pauseAtLocal: Date.now() + state.pauseInMs }
    : state;

/** Whether turns that would start now wait for a restart. */
export const restartHolding = computed(
  () => updateState.value?.phase === 'spinning-down' || updateState.value?.phase === 'restarting',
);

let updatePoll = null;
/** The daemon process this page loaded against: a new one (a restart) reloads the page onto its build. */
let seenBootId = null;
export async function loadUpdateState() {
  try {
    const res = await authFetch('/api/daemon/update');
    if (res.ok) {
      const state = await res.json();
      if (seenBootId && state.bootId && state.bootId !== seenBootId) {
        window.location.reload();
        return;
      }
      seenBootId ??= state.bootId ?? null;
      updateState.value = withLocalPause(state);
    }
  } catch {
    /* restarting: the next poll after reconnect reads the new daemon */
  }
  // Every few seconds while a restart is coming or the connection is down, so the count and the
  // reconnect follow it, and a daemon that went away hands this tab to its status page.
  const fast = restartHolding.value || !connected.value;
  if (!updatePoll || fast !== updatePoll.fast) {
    if (updatePoll) clearInterval(updatePoll.timer);
    updatePoll = { fast, timer: setInterval(loadUpdateState, fast ? 3000 : 30000) };
  }
}

/**
 * The owner's choice on the restart: `restart` (one with no update), `pause-now`, `restart-now`,
 * `postpone` (cancels a plain restart) or `update-now`.
 */
export async function updateAction(action) {
  const plain = !!updateState.value?.reason;
  try {
    const res = await authFetch('/api/daemon/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    updateState.value = withLocalPause(body);
    showToast(
      action === 'restart'
        ? 'Restarting once nothing blocks it: running turns finish or pause'
        : action === 'postpone'
          ? plain
            ? 'Restart cancelled: waiting turns start now'
            : 'Update postponed: waiting turns start now'
          : action === 'update-now'
            ? 'Restarting once running turns finish or pause'
            : action === 'pause-now'
              ? 'Pausing running turns: they resume after the restart'
              : 'Restarting now',
      'ok',
    );
    void loadUpdateState();
  } catch (err) {
    showToast(`Update: ${err.message}`, 'error');
  }
}

export async function loadKingdomStatus() {
  try {
    const res = await authFetch('/api/kingdom/status');
    if (res.ok) kingdomStatus.value = await res.json();
  } catch {
    /* silent — the daemon is restarting */
  }
}

export async function loadProjects() {
  try {
    const res = await authFetch('/api/projects');
    if (!res.ok) {
      showToast(`Failed to load projects: ${res.status}`, 'error');
      return;
    }
    const data = await res.json();
    projects.value = data.projects ?? [];
    projectTags.value = data.tags ?? [];
    projectsListed = true;
    settleInitialScope();
  } catch (err) {
    if (connected.value) showToast(`Projects unavailable: ${err.message}`, 'warn');
  }
}

export async function createProject(config) {
  try {
    const res = await authFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (res.ok) {
      const created = await res.json();
      showToast(`Project added: ${created.label || created.id}`, 'ok');
      loadProjects();
      return true;
    }
    const err = await res.json().catch(() => ({}));
    showToast(err.error || 'Failed to create project', 'error');
    return false;
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
    return false;
  }
}

/** Rename (`label`) or archive/unarchive (`status`: 'archived' | 'active') a project. */
export async function updateProject(id, patch) {
  try {
    const res = await authFetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      await loadProjects();
      return true;
    }
    const body = await res.json().catch(() => ({}));
    showToast(`Failed to update project: ${body.error || res.status}`, 'error');
    return false;
  } catch (err) {
    showToast(`Failed to update project: ${err.message}`, 'error');
    return false;
  }
}

export async function deleteProject(id) {
  try {
    const res = await authFetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) {
      showToast(`Removed: ${id}`, 'ok');
      if (activeProjectId.value === id) activeProjectId.value = null;
      loadProjects();
      return true;
    }
    const body = await res.json().catch(() => ({}));
    showToast(`Failed to delete project: ${body.error || res.status}`, 'error');
    return false;
  } catch (err) {
    showToast(`Failed to delete project: ${err.message}`, 'error');
    return false;
  }
}

/**
 * Create a thread and select it, so the next send goes to it. `where` is a project id, null
 * (Global), '@forge' or '@feedback' (the scope's role, no project); it defaults to the active scope,
 * and a thread made elsewhere brings the workspace to its scope. `select: false` leaves the person
 * where they are (a new agent joining the thread they're in).
 */
export async function createThread({
  where = currentScope(),
  name,
  description,
  tags,
  worktreePath,
  branch,
  worker,
  model,
  effort,
  speed,
  role,
  select = true,
} = {}) {
  try {
    const scope = isScope(where) ? where.slice(1) : undefined;
    const projectId = scope ? undefined : where || undefined;
    if (scope) role = undefined;
    const res = await authFetch('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        name,
        description,
        tags,
        worktreePath,
        branch,
        worker,
        model,
        effort,
        speed,
        role,
        scope,
      }),
    });
    if (res.ok) {
      const created = await res.json();
      const tid = created.threadId;
      if (!allThreads.value.some((thread) => thread.threadId === tid))
        allThreads.value = [...allThreads.value, created];
      // A new thread has no history to load; a first load would race the first send's rows.
      _threadMessages[tid] ??= [];
      if (!select) return created;
      if (where !== currentScope()) selectScope(where);
      selectThread(tid);
      return created;
    }
    const err = await res.json().catch(() => ({}));
    showToast(err.error || 'Failed to create thread', 'error');
    return null;
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
    return null;
  }
}

export async function revertThread(messageIndex) {
  const tid = activeThreadId.value;
  if (!tid) return;

  const msgs = messages.value;
  if (messageIndex < 0 || messageIndex >= msgs.length) return;

  // Truncate this tab first (optimistic); the server's revert is what other tabs and reloads read.
  _setThreadMessages(tid, msgs.slice(0, messageIndex + 1));

  // Tell server to clean up DB
  try {
    const res = await authFetch(`/api/threads/${encodeURIComponent(tid)}/revert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keepCount: messageIndex + 1 }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Revert failed', 'error', { thread: tid });
      return;
    }
    showToast('Reverted', 'ok', { thread: tid });
  } catch (err) {
    showToast(`Revert failed: ${err.message}`, 'error', { thread: tid });
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The message itself, not its place on this page: the view holds only the newest page.
      body: JSON.stringify({ messageId: msgs[messageIndex].id }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Fork failed', 'error', { thread: tid });
      return;
    }
    const newThread = await res.json();
    showToast(`Forked → ${newThread.title?.text || newThread.threadId}`, 'ok');

    // Pre-populate new thread's messages so switching is instant
    _setThreadMessages(newThread.threadId, forkedMessages);
    // The thread list stream already carries the fork.
    selectThread(newThread.threadId);
  } catch (err) {
    showToast(`Fork failed: ${err.message}`, 'error', { thread: tid });
  }
}

/** Set a person's name on a thread (a hard override); an empty name hands naming back to the agent. */
/**
 * Post an aside to the people in a thread (never an agent). `postId` is stable per message, so a
 * retry records it once. Returns { ok } or { error } (409: the thread isn't open for asides).
 */
export async function postAside(threadId, text, postId) {
  try {
    const res = await authFetch(
      `/api/threads/${encodeURIComponent(threadId)}/conversation/asides`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, postId }),
      },
    );
    const body = await res.json().catch(() => ({}));
    return res.ok
      ? { ok: true, duplicate: !!body.duplicate }
      : { error: body.error ?? `${res.status}` };
  } catch (err) {
    return { error: err.message };
  }
}

/** Promote an aside into the thread. Returns { ok } or { error } (409: already promoted, or the floor refuses). */
export async function promoteAside(threadId, asideId) {
  try {
    const res = await authFetch(
      `/api/threads/${encodeURIComponent(threadId)}/conversation/asides/${encodeURIComponent(asideId)}/promote`,
      { method: 'POST' },
    );
    const body = await res.json().catch(() => ({}));
    return res.ok ? { ok: true } : { error: body.error ?? `${res.status}` };
  } catch (err) {
    return { error: err.message };
  }
}

/** Recreate a thread's released worktree from its branch (the project's worktree mode). */
export async function recreateWorktree(threadId) {
  try {
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/worktree/recreate`, {
      method: 'POST',
    });
    if (res.ok) return true;
    const { error } = await res.json().catch(() => ({}));
    showToast(`Couldn’t recreate the worktree: ${error ?? res.status}`, 'error', {
      thread: threadId,
    });
  } catch (err) {
    showToast(`Couldn’t recreate the worktree: ${err.message}`, 'error', { thread: threadId });
  }
  return false;
}

export async function renameThread(threadId, name) {
  try {
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() || null }),
    });
    if (res.ok) return true;
    const err = await res.json().catch(() => ({}));
    showToast(err.error || 'Failed to rename thread', 'error', { thread: threadId });
    return false;
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error', { thread: threadId });
    return false;
  }
}

export async function updateThreadWorktree(threadId, worktreePath, branch) {
  try {
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktreePath, branch }),
    });
    if (res.ok) {
      showToast('Worktree updated', 'ok', { thread: threadId });
      return true;
    }
    const err = await res.json().catch(() => ({}));
    showToast(err.error || 'Failed to update worktree', 'error', { thread: threadId });
    return false;
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error', { thread: threadId });
    return false;
  }
}

export async function createDefinition(section, id, data) {
  try {
    const res = await fetch(`/api/settings/${section}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [id]: data }),
    });
    if (res.ok) {
      showToast(`Created ${section.slice(0, -1)}: ${id}`, 'ok');
      loadDefinitions();
      return true;
    }
    showToast('Creation failed', 'error');
    return false;
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
    return false;
  }
}

export async function deleteDefinition(section, id) {
  try {
    const res = await fetch(`/api/settings/${section}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      showToast(`Deleted: ${id}`, 'ok');
      loadDefinitions();
      return true;
    }
    const body = await res.json().catch(() => ({}));
    showToast(`Failed to delete ${id}: ${body.error || res.status}`, 'error');
    return false;
  } catch (err) {
    showToast(`Failed to delete ${id}: ${err.message}`, 'error');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Chat — send messages through harness
// ---------------------------------------------------------------------------

// Per-thread message store — keeps messages when switching threads
const _threadMessages = {};

/** Select a thread by ID — switches active thread, restores its messages. */
/** Read the thread's launch settings into `threadLaunch` (model, effort, permission mode, provider). */
export async function loadLaunch(threadId) {
  try {
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/launch`);
    const body = res.ok ? await res.json() : null;
    if (activeThreadId.peek() === threadId) threadLaunch.value = body;
  } catch {
    if (activeThreadId.peek() === threadId) threadLaunch.value = null;
  }
}

/** A thread the list chose (not the user): an open project home, Watchtower or custom workspace view stays open. */
function selectThreadQuietly(threadId) {
  const home = projectHomeOpen.peek();
  const watch = watchtowerOpen.peek();
  const customView = activeCustomView.peek();
  selectThread(threadId);
  projectHomeOpen.value = home;
  watchtowerOpen.value = watch;
  activeCustomView.value = customView;
}

export function selectThread(threadId) {
  compactPanel.value = 'conversation';
  closeTurnView();
  watchtowerOpen.value = false;
  activeCustomView.value = null;
  aboutTarget.value = null;
  incomingOpenId.value = null;
  projectHomeOpen.value = false;
  attentionHold.value = threadId;
  const prev = activeThreadId.value;
  if (prev === threadId) return;

  // Always save current messages (even if prev is the initial default)
  const saveKey = prev ?? '_default';
  _threadMessages[saveKey] = messages.value;

  batch(() => {
    activeThreadId.value = threadId;
    // A thread switch is a new selection generation: pending detail requests for the old view are void.
    dismissTraceSelection();
    selectedEvent.value = null;
    inspectTarget.value = null;
    selectedSpanId.value = null;
    threadLaunch.value = null;
    messages.value = _threadMessages[threadId] ?? [];
    threadData.value = allThreads.value.find((t) => t.threadId === threadId) ?? null;
  });
  followActiveProject();
  if (threadId && !_threadMessages[threadId]) _loadThreadMessages(threadId);
  // A cached thread may have received work while inactive (its stream was closed):
  // reconcile it into its own cache only, even if the user switches again before it returns.
  else if (threadId) requestReconcile(threadId, 0);
}

/** Set a thread's rows in this tab (active or not), with its live turns merged in. The server
 * journal is the only store: a reload or another tab reads history from it. */
function _setThreadMessages(threadId, msgs) {
  const next = mergeLiveSnapshot(msgs, liveView(threadId));
  _threadMessages[threadId] = next;
  if (activeThreadId.value === threadId) messages.value = next;
}

/** A thread's first load: the journal's newest page, merged with any rows this tab already holds. */
async function _loadThreadMessages(threadId) {
  const initial = _threadMessages[threadId];
  const adopt = (serverRows, paging) => {
    _setPaging(threadId, paging);
    _setThreadMessages(threadId, mergeMessageHistory(_threadMessages[threadId] ?? [], serverRows));
  };
  try {
    // Newest index page: identity, content and status only. Detail is fetched per turn on demand.
    const result = await _fetchHistoryIndex(threadId, null);
    if (_threadMessages[threadId] !== initial) {
      requestReconcile(threadId, 0);
      return;
    }
    if (result.data) {
      adopt(result.data.messages, {
        ..._pagingFromPage(result.data, undefined),
        loading: false,
        error: null,
      });
      return;
    }
    if (result.unavailable) {
      // Older server or no journal: the full-detail route is the only history source.
      const res = await authFetch(`/api/messages?threadId=${encodeURIComponent(threadId)}`);
      if (_threadMessages[threadId] !== initial) return;
      if (res.ok) {
        const data = await res.json();
        if (_threadMessages[threadId] !== initial) return;
        if (Array.isArray(data.messages)) {
          adopt(data.messages, {
            indexUnavailable: true,
            hasMore: false,
            oldestReached: false,
            loading: false,
          });
          return;
        }
      }
    }
  } catch {
    /* the server did not answer */
  }
  // No history from the server: this tab shows nothing it cannot load, and the thread retries on its next selection.
  if (_threadMessages[threadId] !== initial) return;
  _setPaging(threadId, { offline: true, hasMore: false, oldestReached: false, loading: false });
}

/** Append a message to a specific thread's cache, and mirror to `messages` if that thread is active. */
function _appendToThread(threadId, msg) {
  const existing =
    _threadMessages[threadId] ?? (activeThreadId.value === threadId ? messages.value : []);
  const next = [...existing, msg];
  _setThreadMessages(threadId, next);
}

/** Update only the response owned by this request, including overlapping sends. */
function _updateAgentMessage(threadId, turnId, patch) {
  const list =
    _threadMessages[threadId] ?? (activeThreadId.value === threadId ? messages.value : []);
  const next = updateTurnMessage(list, turnId, patch);
  if (next === list) return;
  _setThreadMessages(threadId, next);
}

// One scope thread per burst of sends made before any thread is selected.
let _scopeThread = null;

/** No thread selected: start one in the active scope (project, or global) and select it. */
async function threadForSend() {
  if (activeThreadId.value) return activeThreadId.value;
  _scopeThread ??= createThread().finally(() => {
    _scopeThread = null;
  });
  const created = await _scopeThread;
  return created ? created.threadId : null;
}

/**
 * Resolves false when the message could not be bound to a thread. `images` are stored references
 * (`{ id, mediaType, bytes }`, from the upload route); the message needs text or an image.
 */
/**
 * A send that went into the running turn `into` (CORE-001): its message stays where it was sent,
 * marked steered, and the pending answer row it was given goes (the running turn answers it).
 */
function _markSteered(threadId, turnId, into) {
  const list =
    _threadMessages[threadId] ?? (activeThreadId.value === threadId ? messages.value : []);
  _setThreadMessages(
    threadId,
    list
      .filter((m) => !(m.actor === 'agent' && m.turnId === turnId))
      .map((m) =>
        m.actor === 'user' && m.turnId === turnId
          ? { ...m, steeredInto: into, status: { ...m.status, turn: 'steered' } }
          : m,
      ),
  );
  const turns = liveTurns.get(threadId);
  if (turns?.has(turnId)) {
    const next = new Map(turns);
    next.delete(turnId);
    liveTurns.set(threadId, next);
  }
}

/**
 * Send a message on the active thread. `delivery`: `queue` waits for a running turn (⌘↵); absent
 * follows the `steer` setting, which steers it into the running turn by default (CORE-001).
 */
export async function sendMessage(text, images = [], { delivery } = {}) {
  if (!text.trim() && !images.length) return false;

  // Bind this send to the thread that was active at submit time.
  // If the user navigates away during the turn, its output still
  // routes back to this thread (not whatever is active when it arrives).
  const tid = await threadForSend();
  if (!tid) return false;
  // A send deals with a thread only when it was asking you (orange or red); a plain follow-up never moves you.
  if (['attention', 'problem'].includes(categoryOf(threadStatusOf(tid)))) answeringSends.add(tid);
  // A thread's first message, sent from the Projects rail, starts it: the rail goes back to Attention
  // unless `afterProjectStart` says stay. The thread stays open in the centre. Started means a turn in
  // the journal (`lastTurn`, there before its history loads) or a message of yours already shown.
  if (isTabActive('projects', { peek: true }) && afterProjectStart.peek() === 'attention') {
    const started =
      allThreads.peek().find((t) => t.id === tid)?.lastTurn ||
      (_threadMessages[tid] ?? []).some((m) => m.actor === 'user');
    if (!started) {
      focusTab('attention');
      attentionHold.value = tid;
    }
  }

  const turnId = `turn_${uuidv7()}`;
  const refs = images.map(({ id, mediaType, bytes }) => ({ id, mediaType, bytes }));
  _appendToThread(tid, {
    actor: 'user',
    turnId,
    content: text,
    timestamp: Date.now(),
    ...(refs.length ? { images: refs } : {}),
  });
  // Seed a pending agent message the thread stream progressively fills.
  _appendToThread(tid, {
    actor: 'agent',
    turnId,
    content: '',
    timestamp: Date.now(),
    streaming: true,
  });

  // Track in-flight (non-blocking — user can keep typing). The thread stream is
  // held until this turn's terminal arrives, even across a thread switch.
  inflight.value++;
  pendingSends.set(turnId, tid);
  socket.open(`thread:${tid}`);
  _sendInBackground(text, tid, turnId, refs, delivery);
  return true;
}

const SEND_OPEN_WAIT_MS = 5000;
const answeringSends = new Set();

/**
 * Your reply or answer dealt with the last thread in Attention: it leaves, and the centre shows its
 * project's page (Aron, 2026-11-15: "switch middle section to project view"). A Forge Master or
 * Feedback thread has no project page; it only leaves. It stays while it still holds something your
 * action did not answer: another prompt, or a held reply waiting for your release.
 */
async function leaveFinishedAttention(threadId, resolvedPromptId = null) {
  if (!isTabActive('attention', { peek: true }) || attentionHold.peek() !== threadId) return;
  if (activeThreadId.peek() !== threadId) return;
  if (prompts.peek().some((p) => p.threadId === threadId && p.id !== resolvedPromptId)) return;
  const listed = allThreads.peek().find((t) => t.threadId === threadId);
  if ((listed?.conversation?.held ?? 0) > 0) return;
  // why: attention.js imports the store and the UI tree; loaded at call time, not at module load.
  const { attentionOf, openRoots } = await import('./attention.js');
  const { needs, red } = attentionOf(openRoots().filter((node) => node.id !== threadId));
  if (needs || red || attentionHold.peek() !== threadId) return;
  attentionHold.value = null;
  if (listed && !scopeOfThread(listed)) openProjectHome(listed.meta?.projectId ?? null);
}

async function _sendInBackground(text, tid, turnId, images = [], delivery = undefined) {
  const answering = answeringSends.delete(tid);
  // Hold the thread stream on the server before the turn can finish, so its full result reaches this tab.
  await socket.opened(`thread:${tid}`, SEND_OPEN_WAIT_MS);
  let res;
  try {
    res = await authFetch('/api/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The full result (with its evidence) comes back only to this tab, on its thread stream.
      body: JSON.stringify({
        id: turnId,
        message: text,
        threadId: tid,
        clientId,
        ...(images.length ? { images: images.map((image) => image.id) } : {}),
        ...(delivery ? { delivery } : {}),
      }),
    });
  } catch (err) {
    // The request may or may not have reached the server.
    _updateAgentMessage(tid, turnId, {
      content: `Connection error: ${err.message}`,
      connectionStatus: 'unconfirmed',
      streaming: false,
      error: true,
    });
    settleSend(turnId);
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    _updateAgentMessage(tid, turnId, {
      content: `Send failed: ${body?.error ?? res.status}`,
      streaming: false,
      error: true,
    });
    settleSend(turnId);
    return;
  }
  const accepted = await res.json().catch(() => ({}));
  if (answering) void leaveFinishedAttention(tid);
  // Steered into the running turn: nothing of its own will run (its terminal may have come first).
  if (accepted.steer?.steered) {
    _markSteered(tid, turnId, accepted.steer.into);
    settleSend(turnId);
    return;
  }
  // Sent to steer, but the running turn can't take it: it waits, and says why.
  if (accepted.steer && !accepted.steer.steered)
    showToast(`Queued after the running turn: ${accepted.steer.reason}`, 'warn', { thread: tid });
  // Accepted; output arrives on the thread stream. Seed the turn so a later
  // snapshot that no longer has it reads as unconfirmed rather than running.
  const turns = liveTurns.get(tid) ?? new Map();
  if (!pendingSends.has(turnId) || turns.has(turnId)) return;
  const projectId = allThreads.value.find((thread) => thread.threadId === tid)?.meta?.projectId;
  liveTurns.set(
    tid,
    new Map(turns).set(turnId, {
      messageId: turnId,
      threadId: tid,
      projectId,
      content: '',
      startedAt: Date.now(),
      status: 'queued',
      activity: [],
      truncated: false,
      nativeDetail: 'unavailable',
      seededAt: Date.now(),
    }),
  );
  refreshLiveRows(tid);
}

export async function executeAction(kind, target, payload) {
  try {
    const res = await fetch('/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind,
        target,
        payload,
        threadId:
          kind.startsWith('thread:') && target
            ? target
            : (activeThreadId.value ?? threadData.value?.threadId),
        timestamp: Date.now(),
      }),
    });
    const result = await res.json();
    // A list action (archive) can be undone for 20 s; approvals never offer an undo.
    const id =
      kind.startsWith('thread:') && target
        ? target
        : (activeThreadId.peek() ?? threadData.peek()?.threadId);
    if (result.ok && kind === 'thread:archive' && id)
      showToast(result.message, 'ok', {
        undo: () => executeAction('thread:unarchive', id),
        ms: 20000,
      });
    else showToast(result.message, result.ok ? 'ok' : 'error');
    return result;
  } catch (err) {
    showToast(`Action failed: ${err.message}`, 'error');
    return { ok: false, message: err.message };
  }
}

/**
 * "Steer now" (CORE-001): a queued message goes into the running turn, whatever the `steer` setting
 * says. Returns true when it went in; otherwise says why it stays queued.
 */
export async function steerTurn(threadId, turnId) {
  try {
    const res = await authFetch(
      `/api/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/steer`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    if (!body.steered) {
      showToast(`Still queued: ${body.reason}`, 'warn', { thread: threadId });
      return false;
    }
    _markSteered(threadId, turnId, body.into);
    settleSend(turnId);
    return true;
  } catch (err) {
    showToast(`Steer failed: ${err.message}`, 'error', { thread: threadId });
    return false;
  }
}

/** Stop a queued or running turn through the interrupt route; its terminal still arrives on the thread stream. */
export async function stopTurn(threadId, turnId) {
  try {
    const res = await authFetch(
      `/api/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    showToast(
      body.outcome === 'unsupported'
        ? 'This runtime cannot stop a turn; it runs to its end'
        : 'Stop requested',
      body.outcome === 'unsupported' ? 'error' : 'ok',
      { thread: threadId },
    );
    return body.outcome;
  } catch (err) {
    showToast(`Stop failed: ${err.message}`, 'error', { thread: threadId });
  }
}

/**
 * A turn Foundry lost track of after a restart, which the native session's own record couldn't
 * settle: `continue` accepts it as it stands, `retry` sends its message again. Either way the
 * thread takes messages again; the journal change reaches the thread through its reconcile.
 */
export async function resolveLostTurn(threadId, action) {
  try {
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/recovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    if (body.retryError) throw new Error(`settled, but the retry was not sent: ${body.retryError}`);
    showToast(action === 'retry' ? 'Sent the turn again' : 'Continuing from here', 'ok', {
      thread: threadId,
    });
    requestReconcile(threadId, 0);
    return true;
  } catch (err) {
    showToast(`Could not resolve the lost turn: ${err.message}`, 'error', { thread: threadId });
    return false;
  }
}

/**
 * A degraded chorus on a turn (FEAT-008): `retry` asks the Wardens that went unheard again (what they
 * say rides with the next message), `dismiss` closes the notice. The journal row each writes reaches
 * the thread through its own reconcile; nothing is changed here first.
 */
export async function chorusAction(threadId, turnId, action) {
  try {
    const res = await authFetch(
      `/api/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/chorus/${action}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    const body = await res.json();
    if (!res.ok && !body.unavailable?.length) throw new Error(body.error ?? `HTTP ${res.status}`);
    if (action === 'retry') {
      const missing = body.unavailable ?? [];
      showToast(
        body.started?.length
          ? `Asking ${body.started.length === 1 ? 'it' : 'them'} again`
          : body.busy?.length
            ? 'Already asking again'
            : `Cannot ask again: ${missing.map((u) => u.reason).join('; ')}`,
        body.started?.length || body.busy?.length ? 'ok' : 'error',
        { thread: threadId },
      );
    }
    return body;
  } catch (err) {
    showToast(`${action === 'retry' ? 'Retry' : 'Dismiss'} failed: ${err.message}`, 'error', {
      thread: threadId,
    });
  }
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

const toastTimers = new Map();
/**
 * Show a toast. With `thread` (a thread id) it is that thread's and shows at the top of it while it
 * is the open thread; anything else, or a thread that isn't open, is a system toast (bottom left).
 *
 * - "ok" toasts auto-dismiss after 3s
 * - "warn" toasts auto-dismiss after 6s
 * - "error" toasts are persistent — user must dismiss manually
 *
 * @param {string} message
 * @param {"ok"|"error"|"warn"} type
 * @param {{ undo?: () => void, ms?: number, thread?: string | null }} [opts] an Undo button, how long the toast stays, the thread it is about
 */
export function showToast(message, type = 'ok', { undo, ms, thread } = {}) {
  const slot = thread && thread === threadToastHost.peek() ? threadToast : toast;
  // A thread's toast while its conversation is not on screen goes to the corner, saying which thread.
  if (thread && slot === toast) {
    const t = allThreads.peek().find((x) => x.threadId === thread);
    message = `${t?.title?.text || t?.meta?.description || thread}: ${message}`;
  }
  clearTimeout(toastTimers.get(slot));
  toastTimers.delete(slot);
  const persistent = type === 'error';
  slot.value = {
    message,
    type,
    persistent,
    ...(slot === threadToast ? { threadId: thread } : {}),
    ...(undo ? { undo } : {}),
  };
  if (!persistent)
    toastTimers.set(
      slot,
      setTimeout(
        () => {
          slot.value = null;
        },
        ms ?? (type === 'warn' ? 6000 : 3000),
      ),
    );
}

/** Dismiss the system toast, or with `thread: true` the thread's. */
export function dismissToast({ thread = false } = {}) {
  const slot = thread ? threadToast : toast;
  clearTimeout(toastTimers.get(slot));
  toastTimers.delete(slot);
  slot.value = null;
}

// ---------------------------------------------------------------------------
// View state — persist to URL hash so refresh restores position
// ---------------------------------------------------------------------------

const VIEW_KEYS = [
  'project',
  'thread',
  'panel',
  'sidebar',
  'detail',
  'forge',
  'feedback',
  'rtab',
  'rail',
  'view',
  'lsize',
  'rsize',
  'home',
  'device',
];

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  return Object.fromEntries(VIEW_KEYS.map((k) => [k, params.get(k)]));
}

/** Pending hash targets for extension tabs/views before async extensions finish loading. */
const pendingHashRestore = {
  rtab: null,
  rail: null,
  view: null,
  panel: null,
};

function hasPendingHash() {
  return Boolean(
    pendingHashRestore.rtab ||
      pendingHashRestore.rail ||
      pendingHashRestore.view ||
      pendingHashRestore.panel,
  );
}

function writeHash() {
  // Settings and analytics pages own their URL; the workspace's view state returns with it.
  if (route.peek().page !== 'workspace') return;
  const params = new URLSearchParams();
  if (forgeMasterOpen.value) params.set('forge', '1');
  if (feedbackInboxOpen.value) params.set('feedback', '1');
  if (activeProjectId.value) params.set('project', activeProjectId.value);
  if (activeThreadId.value) params.set('thread', activeThreadId.value);
  const panelVal = pendingHashRestore.panel ?? activePanel.value;
  if (panelVal !== 'conversation') params.set('panel', panelVal);
  if (!projectSidebarOpen.value) params.set('sidebar', '0');
  if (!detailDrawerOpen.value) params.set('detail', '0');
  if (!['normal', 'strip'].includes(leftSize.value)) params.set('lsize', leftSize.value);
  if (!['normal', 'icons'].includes(rightSize.value)) params.set('rsize', rightSize.value);
  const rtabVal = pendingHashRestore.rtab ?? rightTab.value;
  if (rtabVal !== 'context') params.set('rtab', rtabVal);
  const railVal = pendingHashRestore.rail ?? railView.value;
  // A project in the hash opens the Projects rail unless the rail is named.
  if (railVal !== 'attention' || activeProjectId.value) params.set('rail', railVal);
  if (boardOpen.value) params.set('view', 'board');
  else if (watchtowerOpen.value) params.set('view', 'watch');
  else if (activeCustomView.value) params.set('view', activeCustomView.value);
  else if (pendingHashRestore.view) params.set('view', pendingHashRestore.view);
  if (projectHomeOpen.value && !boardOpen.value) {
    params.set('home', projectPage.value === 'home' ? '1' : projectPage.value);
    if (projectPage.value === 'device' && devicePageId.value)
      params.set('device', devicePageId.value);
  }
  const hash = params.toString();
  // Replace silently — no history entry per state change; preserve ?safe-ui=1 when active.
  history.replaceState(null, '', withSafeUi(`${location.pathname}${hash ? `#${hash}` : ''}`));
  // Remembered across reloads and bare visits, so the workspace comes back as it was left.
  try {
    localStorage.setItem(WORKSPACE_MEMORY_KEY, hash);
  } catch {
    // Storage can be unavailable (private mode, quota); the hash still carries the state.
  }
}

const WORKSPACE_MEMORY_KEY = 'foundry.workspace';

/** A bare visit takes the remembered workspace; a first visit ever opens on Open with the right panel folded. */
function adoptRememberedWorkspace() {
  if (location.hash.length > 1) return;
  let remembered = null;
  try {
    remembered = localStorage.getItem(WORKSPACE_MEMORY_KEY);
  } catch {
    remembered = null;
  }
  if (remembered === null) {
    detailDrawerOpen.value = false;
    return;
  }
  if (remembered) history.replaceState(null, '', withSafeUi(`${location.pathname}#${remembered}`));
}

function knownRightTabs() {
  const reg = rightTabs().map((t) => t.id);
  return reg.length ? reg : RIGHT_TABS;
}

function knownLeftTabs() {
  const reg = leftTabs().map((t) => t.id);
  return reg.length ? reg : RAIL_VIEWS;
}

function knownThreadViews() {
  const reg = mainViews('thread').map((v) => v.id);
  return reg.length ? reg : CENTER_PANELS;
}

function knownCustomWorkspaceViews() {
  return mainViews('workspace')
    .filter((v) => v.extId)
    .map((v) => v.id);
}

function restoreFromHash() {
  const h = readHash();
  pendingHashRestore.rtab = null;
  pendingHashRestore.rail = null;
  pendingHashRestore.view = null;
  pendingHashRestore.panel = null;
  forgeMasterOpen.value = h.forge === '1';
  feedbackInboxOpen.value = h.feedback === '1' && h.forge !== '1';
  if (h.project) activeProjectId.value = h.project;
  if (h.thread) selectThread(h.thread);
  if (h.panel) {
    if (knownThreadViews().includes(h.panel)) activePanel.value = h.panel;
    else if (!extensionsReady.peek()) pendingHashRestore.panel = h.panel;
  }
  if (h.sidebar === '0') projectSidebarOpen.value = false;
  if (h.detail === '0') detailDrawerOpen.value = false;
  if (['hidden', 'wide'].includes(h.lsize)) leftSize.value = h.lsize;
  if (['hidden', 'wide'].includes(h.rsize)) rightSize.value = h.rsize;
  if (h.rtab) {
    if (knownRightTabs().includes(h.rtab)) rightTab.value = h.rtab;
    else if (!extensionsReady.peek()) pendingHashRestore.rtab = h.rtab;
  }
  boardOpen.value = h.view === 'board';
  watchtowerOpen.value = h.view === 'watch';
  if (h.view && h.view !== 'board' && h.view !== 'watch') {
    if (knownCustomWorkspaceViews().includes(h.view)) activeCustomView.value = h.view;
    else if (!extensionsReady.peek()) pendingHashRestore.view = h.view;
    else activeCustomView.value = null;
  } else {
    activeCustomView.value = null;
  }
  const device = h.home === 'device' && h.device;
  projectHomeOpen.value = h.home === '1' || h.home === 'knowledge' || !!device;
  projectPage.value = h.home === 'knowledge' ? 'knowledge' : device ? 'device' : 'home';
  devicePageId.value = device || null;
  // A link to a project (and no rail named) opens the Projects rail on it.
  if (h.rail) {
    if (knownLeftTabs().includes(h.rail)) railView.value = h.rail;
    else if (!extensionsReady.peek()) {
      pendingHashRestore.rail = h.rail;
      railView.value = h.project ? 'projects' : 'attention';
    } else railView.value = h.project ? 'projects' : 'attention';
  } else {
    railView.value = h.project ? 'projects' : 'attention';
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function init() {
  // Restore view state from URL hash (or the remembered workspace) before loading data
  adoptRememberedWorkspace();
  restoreFromHash();

  connectStreams();
  holdFeedback();
  holdSchedules();
  loadTraces();
  loadDefinitions();
  loadProjects();
  loadWorktrees();
  loadTokenUsage();
  loadIncoming();
  loadKingdomStatus();
  loadUpdateState();
  // Polling for state that has no data stream
  setInterval(loadTraces, 15000);
  setInterval(loadDefinitions, 30000);
  setInterval(loadProjects, 30000);
  setInterval(loadWorktrees, 30000);
  setInterval(loadIncoming, 30000);
  setInterval(loadKingdomStatus, 60000);
  setInterval(loadTokenUsage, 10000); // token usage updates after each message + periodic

  // A thread opened before the list arrived reads its launch settings once it is listed.
  let launchRequested = null;
  effect(() => {
    const id = activeThreadId.value;
    if (!id || launchRequested === id) return;
    if (!allThreads.value.some((t) => t.threadId === id)) return;
    launchRequested = id;
    loadLaunch(id);
  });

  // The owner sees the thread he has open: a turn completed there is read, not a new arrival
  // (VIEWER-001's seen-by-Aron mark). Opening a thread with an unread turn marks it too.
  let seenMarked = null;
  const markSeen = (id, threads) => {
    const thread = threads.find((t) => t.threadId === id);
    const completedAt =
      thread?.lastTurn?.status === 'completed' ? thread.lastTurn.completedAt : null;
    if (!id || !completedAt || completedAt <= (thread.meta?.seenAt ?? 0)) return;
    const key = `${id}:${completedAt}`;
    if (seenMarked === key || document.visibilityState === 'hidden') return;
    seenMarked = key;
    // Seen here at once, and kept through every list push until the server's mark comes back
    // (`seenHere`): otherwise a reply to the thread he is reading reads as answering Attention.
    seenHere.set(id, completedAt);
    const seen = withSeenHere(thread);
    allThreads.value = allThreads.peek().map((t) => (t.threadId === id ? seen : t));
    if (threadData.peek()?.threadId === id) threadData.value = seen;
    authFetch(`/api/threads/${encodeURIComponent(id)}/seen`, { method: 'POST' }).catch(() => {
      seenHere.delete(id);
      seenMarked = null;
    });
  };
  effect(() => markSeen(activeThreadId.value, allThreads.value));
  // A turn that finished while the tab was hidden is seen when he comes back to it.
  document.addEventListener('visibilitychange', () =>
    markSeen(activeThreadId.peek(), allThreads.peek()),
  );

  // Navigating releases Attention's hold on the thread you had open: a page, the board, the
  // Watchtower, Settings or another tab on Attention's side (opening a thread holds that one instead).
  const activeTabOn = (side) => (side === 'right' ? rightTab.value : railView.value);
  const activeTabOnPeek = (side) => (side === 'right' ? rightTab.peek() : railView.peek());
  let attentionSideSeen = effectiveTabSide('attention') ?? 'left';
  let attentionTabSeen = activeTabOnPeek(attentionSideSeen);
  effect(() => {
    const side = effectiveTabSide('attention') ?? 'left';
    const current = activeTabOn(side);
    const away =
      projectHomeOpen.value ||
      boardOpen.value ||
      watchtowerOpen.value ||
      Boolean(activeCustomView.value) ||
      route.value.page !== 'workspace';
    const switched =
      side !== attentionSideSeen ? current !== 'attention' : current !== attentionTabSeen;
    attentionSideSeen = side;
    attentionTabSeen = current;
    if (away || switched) attentionHold.value = null;
  });

  // Leaving the workspace leaves the board; Settings and Analytics have none.
  effect(() => {
    if (route.value.page !== 'workspace') {
      boardOpen.value = false;
      watchtowerOpen.value = false;
      activeCustomView.value = null;
    }
  });

  // Apply deferred hash restore and clear dead extension ids once extensions are ready or disabled.
  effect(() => {
    const lefts = leftTabs();
    const rights = rightTabs();
    const workspaceViews = mainViews('workspace');
    const threadViews = mainViews('thread');
    const ready = extensionsReady.value;
    let changed = false;
    batch(() => {
      if (hasPendingHash()) {
        if (pendingHashRestore.rtab && rights.some((t) => t.id === pendingHashRestore.rtab)) {
          rightTab.value = pendingHashRestore.rtab;
          pendingHashRestore.rtab = null;
          changed = true;
        }
        if (pendingHashRestore.rail && lefts.some((t) => t.id === pendingHashRestore.rail)) {
          railView.value = pendingHashRestore.rail;
          pendingHashRestore.rail = null;
          changed = true;
        }
        if (
          pendingHashRestore.view &&
          workspaceViews.some((v) => v.extId && v.id === pendingHashRestore.view)
        ) {
          activeCustomView.value = pendingHashRestore.view;
          pendingHashRestore.view = null;
          changed = true;
        }
        if (
          pendingHashRestore.panel &&
          threadViews.some((v) => v.id === pendingHashRestore.panel)
        ) {
          activePanel.value = pendingHashRestore.panel;
          pendingHashRestore.panel = null;
          changed = true;
        }
        if (ready && hasPendingHash()) {
          pendingHashRestore.rtab = null;
          pendingHashRestore.rail = null;
          pendingHashRestore.view = null;
          pendingHashRestore.panel = null;
          changed = true;
        }
      }
      // Once extensions have settled, clear any active custom view/tab whose extension was unloaded/disabled.
      if (ready) {
        if (
          activeCustomView.peek() &&
          !pendingHashRestore.view &&
          !workspaceViews.some((v) => v.extId && v.id === activeCustomView.peek())
        ) {
          activeCustomView.value = null;
          changed = true;
        }
        if (
          rights.length > 0 &&
          !pendingHashRestore.rtab &&
          !rights.some((t) => t.id === rightTab.peek())
        ) {
          rightTab.value = resolveActiveId(rights, rightTab.peek(), 'context') ?? 'context';
          changed = true;
        }
        if (
          lefts.length > 0 &&
          !pendingHashRestore.rail &&
          !lefts.some((t) => t.id === railView.peek())
        ) {
          railView.value = resolveActiveId(lefts, railView.peek(), 'attention') ?? 'attention';
          changed = true;
        }
        if (
          threadViews.length > 0 &&
          !pendingHashRestore.panel &&
          activePanel.peek() !== 'feedback' &&
          !threadViews.some((v) => v.id === activePanel.peek())
        ) {
          activePanel.value =
            resolveActiveId(threadViews, activePanel.peek(), 'conversation') ?? 'conversation';
          changed = true;
        }
      }
    });
    if (changed) writeHash();
  });

  // Sync view state → URL hash on any change
  effect(() => {
    // Touch all signals to subscribe
    forgeMasterOpen.value;
    feedbackInboxOpen.value;
    activeProjectId.value;
    // Returning to the workspace writes its live state, not the hash it was left with.
    route.value;
    activeThreadId.value;
    activePanel.value;
    projectSidebarOpen.value;
    detailDrawerOpen.value;
    leftSize.value;
    rightSize.value;
    rightTab.value;
    railView.value;
    boardOpen.value;
    watchtowerOpen.value;
    activeCustomView.value;
    projectHomeOpen.value;
    projectPage.value;
    devicePageId.value;
    writeHash();
  });

  // why: viewers before 2026-11-11 cached every thread's rows here and filled the origin's quota.
  for (const key of Object.keys(localStorage))
    if (key.startsWith('foundry:msgs:')) localStorage.removeItem(key);

  // Handle back/forward navigation
  // Pages leave the workspace's view state alone; returning to the workspace re-reads it.
  window.addEventListener('hashchange', () => {
    if (route.peek().page === 'workspace') restoreFromHash();
  });

  // A tab returning to the foreground may have missed owned events while
  // hidden; reconcile the active thread once, not the whole history set.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const active = activeThreadId.value;
    if (!active) return;
    requestReconcile(active, 0);
    requestKnowledge(active);
  });
}

/** A thread's status for its icon: the listed thread (lastTurn, conversation) and its pending prompts,
 * with the open thread's live turns winning while they run (thread-status.js decides). */
export function threadStatusOf(threadId, live = null) {
  const listed = allThreads.value.find((t) => t.threadId === threadId);
  const thread = listed ?? (threadData.value?.threadId === threadId ? threadData.value : null);
  if (!thread) return 'idle';
  if (live === 'active') return 'working';
  if (live === 'unconfirmed') return 'waitother';
  return threadState(thread, { prompts: prompts.value.filter((p) => p.threadId === threadId) });
}
