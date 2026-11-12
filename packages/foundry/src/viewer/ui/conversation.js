/**
 * @atlas
 * @kind component
 * @partOf feature:threads, feature:viewer
 */
/**
 * Conversation — center panel. Always chat mode.
 *
 * User types a message → harness processes it → agent responds.
 * Each agent response shows classification/route badges and a trace link.
 * Clicking "trace" opens trace details in the right pane (detail drawer).
 */

import { ActionPalette } from './action-palette.js';
import { PillGroup } from './band-pills.js';
import { chorusNotice, lastDegraded } from './chorus-health.js';
import { HeldPromptCard, useConversationView } from './conversation-members.js';
import { isUnsavedCompletion } from './conversation-state.js';
import { FeedbackPrompt, GiveFeedback, TurnFeedback } from './feedback.js';
import { ForkLink } from './fork-link.js';
import {
  IMAGE_TYPES,
  IMAGES_PER_MESSAGE,
  imageFiles,
  imageUrl,
  prepareImage,
  uploadImage,
} from './image-attachments.js';
import { failurePresentation } from './inspector-data.js';
import { kingdomOwnerOf } from './kingdom-holder.js';
import { html, useEffect, useRef, useState } from './lib.js';
import { liveExecutionStatus, liveThreadStatus, liveWorkLabel, workLog } from './live-state.js';
import { LoopView } from './loop-view.js';
import { Markdown } from './markdown.js';
import {
  composerDestination,
  DestinationLabel,
  NOT_BUILT,
  routeTyped,
  separateViews,
} from './message-box.js';
import { MessageMenu } from './message-menu.js';
import { Modal, RenameModal } from './modal.js';
import { Plan } from './plan.js';
import { openThreadRun, roleLabel } from './run-picker.js';
import { settingsConfig } from './settings.js';
import { isDangerous, MODES, ModeIcon, STATES, StatusIcon } from './status-icons.js';
import { QueuedRows, SendHint, turnRunning } from './steering.js';
import {
  aboutTarget,
  actionPaletteOpen,
  activePanel,
  activeThreadId,
  allThreads,
  chorusAction,
  composerFill,
  composerNote,
  contextWindowOf,
  detailDrawerOpen,
  focusTurnId,
  giveFeedback,
  historyPaging,
  kingdomStatus,
  launchLabels,
  layerColor,
  loadOlderMessages,
  loadTraceDetail,
  messages,
  modelLabel,
  openTurnView,
  postAside,
  projects,
  promoteAside,
  prompts,
  recreateWorktree,
  renameThread,
  resolveLostTurn,
  resolvePrompt,
  rightTab,
  selectedSpanId,
  selectThread,
  sendMessage,
  showToast,
  stopTurn,
  systemActivity,
  systemActivityLog,
  threadContextTokens,
  threadData,
  threadLaunch,
  threadStatusOf,
  threadUsage,
  tokenUsage,
  waitingFor,
} from './store.js';
import { stripView } from './system-strip.js';
import {
  harnessName,
  isUnnamed,
  nameSourceLabel,
  threadName,
  threadPlace,
} from './thread-labels.js';
import {
  categoryOf,
  isClosedThread,
  statusText,
  subagentParentOf,
  threadState,
} from './thread-status.js';
import {
  AsidesSince,
  AsidesView,
  BtwView,
  shownViews,
  ThreadViewSegments,
} from './thread-views.js';
import { uuidv7 } from './uuidv7.js';
import {
  dictationSupported,
  speakReplies,
  speechSupported,
  startDictation,
  toggleSpeakReplies,
} from './voice.js';
import { WorkerSwitchMarker, withSwitchMarkers } from './worker-switch.js';
import { BranchIcon, FolderIcon, WorktreePill } from './worktree-pill.js';

// ---------------------------------------------------------------------------
// Token bar — this thread's recorded usage, plus the Foundry session budget
// ---------------------------------------------------------------------------

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

export function TokenBar() {
  const usage = tokenUsage.value;
  const used = threadUsage(usage, activeThreadId.value);
  // An empty thread has nothing to account for; neither does one with no recorded calls.
  if (!used || messages.value.length === 0) return null;

  const { percentage, warning, exceeded, limitCost, usedCost } = usage;
  const budgetPct = Math.min(percentage * 100, 100);
  const budgetColor = exceeded ? 'var(--err)' : warning ? 'var(--warn)' : 'var(--ok)';
  const barClass = exceeded ? 'token-bar--exceeded' : warning ? 'token-bar--warning' : '';
  const cost =
    used.cost > 0
      ? `$${used.cost.toFixed(4)}`
      : usage.subscription
        ? 'Included in subscription'
        : 'Not reported';
  const breakdown = `${fmtNum(used.input)} in · ${fmtNum(used.output)} out · ${fmtNum(used.cacheRead + used.cacheWrite)} cache (${fmtNum(used.cacheRead)} read, ${fmtNum(used.cacheWrite)} write)`;

  return html`
    <div class="token-bar ${barClass}" aria-label="This thread's usage">
      <div class="token-bar-stats">
        <span class="token-bar-scope">This thread</span>
        <span class="token-stat" title=${breakdown}>
          <span class="token-stat-value">${fmtNum(used.total)}</span>
          <span class="token-stat-label">tokens incl. cache</span>
        </span>
        <span class="token-stat-divider"></span>
        <span class="token-stat">
          <span class="token-stat-value">${cost}</span>
          <span class="token-stat-label">${used.cost > 0 ? 'cost' : ''}</span>
        </span>
        <span class="token-stat-divider"></span>
        <span class="token-stat">
          <span class="token-stat-value">${used.calls}</span>
          <span class="token-stat-label">calls</span>
        </span>
      </div>
      <div class="token-bar-meters">
        <div class="token-bar-meter" title="The executor does not report its context fill">
          <span class="token-bar-meter-label">ctx</span>
          <span class="token-bar-pct">n/a</span>
        </div>
        ${
          limitCost
            ? html`
          <div class="token-bar-meter" title=${`Foundry session budget: $${usedCost.toFixed(4)} / $${limitCost.toFixed(2)}`}>
            <span class="token-bar-meter-label" style="color: ${budgetColor}">$$$</span>
            <div class="token-bar-track">
              <div class="token-bar-fill" style="width: ${budgetPct}%; background: ${budgetColor}"></div>
            </div>
            <span class="token-bar-pct" style="color: ${budgetColor}">${budgetPct.toFixed(0)}%</span>
          </div>
        `
            : null
        }
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Context bar — thread metadata + active context at top of conversation
// ---------------------------------------------------------------------------

const WARM_LAYER_STATES = new Set(['warm', 'warming']);

/** The thread's working-context numbers: agents, layers, warm / system / thread tokens and the warm-layer
 * stack against the window. Shown on the right panel's Context tab. */
export function ContextStats() {
  const data = threadData.value;
  const msgList = messages.value;
  const usage = tokenUsage.value;
  if (!data) return null;
  const layers = data.layers || [];
  const agents = data.agents || [];
  const warmLayers = layers.filter((l) => WARM_LAYER_STATES.has(l.state));
  // Rough token estimate: ~4 chars per token (same heuristic as store.estimateContextTokens).
  const warmTokens = warmLayers.reduce((sum, l) => sum + Math.ceil((l.contentLength || 0) / 4), 0);
  // System: what the last agent turn actually injected (from the Librarian's injection ledger on msg.meta).
  const lastAgent = [...msgList]
    .reverse()
    .find((m) => m.actor === 'agent' && m.meta?.injectedLayers);
  const injectedLayers = lastAgent?.meta?.injectedLayers || [];
  const systemTokens = injectedLayers.reduce(
    (sum, l) => sum + (l.tokens ?? Math.ceil((l.contentLength || 0) / 4)),
    0,
  );
  const threadTokens = threadContextTokens.value;
  const launch = threadLaunch.value;
  const contextWindow =
    contextWindowOf(launch?.provider, launch?.model) ?? usage?.contextWindow ?? null;
  const denom =
    contextWindow && contextWindow > 0
      ? contextWindow
      : Math.max(warmTokens, systemTokens, threadTokens, 1);
  const segments = warmLayers.map((l) => {
    const tokens = Math.ceil((l.contentLength || 0) / 4);
    return { id: l.id, tokens, pct: (tokens / denom) * 100, color: layerColor(l.id) };
  });
  const row = (label, value, tooltip) =>
    html`<dt title=${tooltip}>${label}</dt><dd class="rp-mono">${value}</dd>`;
  return html`<section class="rp-section context-stats">
    <h3 class="rp-section-title">Working context</h3>
    <dl class="rp-facts">
      ${row('Agents', agents.length, 'Agents on this thread')}
      ${row('Layers', `${warmLayers.length} warm / ${layers.length}`, 'Warm / total context layers')}
      ${row('Warm', fmtNum(warmTokens), 'Warm layer cache pool (tokens of currently-warm layer content)')}
      ${row('System', fmtNum(systemTokens), 'Layers injected on the last agent turn')}
      ${row('Thread', fmtNum(threadTokens), 'Estimated tokens of the conversation so far')}
      ${contextWindow ? row('Window', fmtNum(contextWindow), 'This thread’s model context window') : null}
    </dl>
    ${
      segments.length > 0
        ? html`<div class="context-bar-stack" title="Warm layers vs. model context window">
          ${segments.map(
            (s) => html`<span key=${s.id} class="context-bar-seg"
              style="width: ${s.pct}%; background: ${s.color}"
              title="${s.id}: ${fmtNum(s.tokens)} tok (${s.pct.toFixed(1)}% of window)"></span>`,
          )}
        </div>`
        : null
    }
  </section>`;
}

/** Kingdom's own words for what a member reads (its `threads` terms). */
const VIEW_READS = {
  own: 'Its own posts and what is sent to it',
  thread: 'The whole thread: messages and answers, never tool calls',
};

const signetLine = (m) =>
  [
    m.displayName,
    m.terms ? VIEW_READS[m.terms.view] : null,
    m.limits?.maxRequests ? `up to ${m.limits.maxRequests} requests` : null,
    m.limits?.expiresAt ? `until ${new Date(m.limits.expiresAt).toLocaleDateString()}` : null,
    m.listed ? null : 'no longer listed by Kingdom',
  ]
    .filter(Boolean)
    .join(' · ');

/**
 * The centre's header band, two rows of grouped pills (Aron, 2026-11-01):
 *   row 1  the thread name                     | project · Kingdom · branch · worktree
 *   row 2  status · your agents · people · Signets | provider · model · effort · context fill · mode
 * What the thread is doing right now sits above the composer, not here. References, layers and
 * token detail live on the right panel's Context tab.
 */
function ContextBar() {
  const data = threadData.value;
  const usage = tokenUsage.value;
  const [view] = useConversationView(data?.threadId, data?.conversation ?? null);
  const [renaming, setRenaming] = useState(false);
  if (!data) return null;
  const meta = data.meta || {};
  const title = threadName(data);
  const titleSource = data.title?.source || null;
  const place = threadPlace(meta);
  const launch = threadLaunch.value;
  const project = meta.projectId ? projects.value.find((p) => p.id === meta.projectId) : null;
  const owner = meta.projectId
    ? kingdomOwnerOf(settingsConfig.value, kingdomStatus.value, meta.projectId)
    : null;
  const members = view?.members ?? [];
  const localAgents = members.filter((m) => m.member.kind === 'local');
  const external = members.filter((m) => m.member.kind !== 'local');
  const peopleCount = view ? external.length : (data.conversation?.members ?? 0);
  const signets = external.filter((m) => m.member.kind === 'signet');
  const harness = harnessName(launch?.provider);
  // Live subagents are sessions too (child threads whose status is active).
  const subagents = allThreads.value.filter(
    (t) => t.meta?.parentThreadId === data.threadId && t.meta?.status === 'active',
  );
  const agentNames = [
    `${harness ?? 'Agent'} · your agent`,
    ...localAgents.map((m) => m.displayName),
    ...subagents.map((t) => threadName(t)),
  ];
  const openParticipants = () => {
    rightTab.value = 'participants';
    detailDrawerOpen.value = true;
  };
  const state = threadStatusOf(data.threadId, liveThreadStatus(messages.value));
  const contextWindow =
    contextWindowOf(launch?.provider, launch?.model) ?? usage?.contextWindow ?? null;
  const fill = contextWindow
    ? Math.min(100, (threadContextTokens.value / contextWindow) * 100)
    : null;
  const named = launchLabels(launch?.provider, launch?.model);
  // Worker · model · effort (Aron 11-02): the worker goes first when space is tight, never the
  // model or the effort; an effort the thread didn't choose is the one it runs at by default.
  const worker = harnessName(launch?.worker ?? launch?.provider) ?? named.provider;
  const effort = launch?.effort ?? launch?.effortDefault ?? null;
  // Its thread role (coder, assistant, …) beside how it runs: what its instructions compose as.
  const role = roleLabel(launch?.options?.roles, launch?.effectiveRole);
  const runs = [named.model, effort, role].filter(Boolean);

  return html`
    <div class="context-bar thread-band thread-band--pills">
      <div class="band-grid">
        <span class="band-title">
        <span class="context-bar-title ${isUnnamed(data) ? 'context-bar-title--unnamed' : ''}" data-name-source=${titleSource || ''}
          title=${`${title} · ${data.threadId}${titleSource ? ` · ${nameSourceLabel[titleSource]}` : ''}`}>${title}</span>
        ${titleSource === 'foundry' || titleSource === 'agent' ? html`<button type="button" class="context-bar-name-source" title=${`${nameSourceLabel[titleSource]} · rename`} onClick=${() => setRenaming(true)}>auto · rename</button>` : null}
        ${
          renaming
            ? html`<${RenameModal} title="Rename thread" label="Thread name" value=${title}
                onClose=${() => setRenaming(false)} onSave=${(next) => renameThread(data.threadId, next)} />`
            : null
        }
        </span>
        <${PillGroup} className="band-where" label="Where it lives" render=${() => html`
          <span class="band-pill band-where--keep" title=${project ? `Project: ${project.label}` : 'No project'}>${project ? project.label : 'Global'}</span>
          ${
            owner
              ? html`<span class="band-pill band-where--keep" title=${`Kingdom: ${owner}`}>${owner}</span>`
              : project?.tags?.[0]
                ? html`<span class="band-pill band-where--keep band-org" title=${`Organisation tag: ${project.tags[0]} (the project's Kingdom names it once linked)`}>${project.tags[0]}</span>`
                : null
          }
          ${
            place.branch
              ? html`<span class="band-pill context-bar-chip--branch" title=${place.repository ? `branch of ${place.repository}` : 'branch'}>${BranchIcon()}${place.branch}</span>`
              : null
          }
          ${
            data.meta?.context?.checkout
              ? html`<${WorktreePill} checkout=${data.meta.context.checkout} onRecreate=${() => recreateWorktree(data.threadId)} />`
              : place.worktreeShort
                ? html`<span class="band-pill worktree-pill" title=${`${place.worktree}\nFrom the thread's working folder (no worktree record yet)`}>${FolderIcon()}${place.worktreeShort}</span>`
                : null
          }
        `} />
        <${PillGroup} className="band-who" label="Who is in it" render=${() => html`
          <span class="band-pill band-status" data-state=${state}>
            <${StatusIcon} state=${state} still=${true} />${statusText(data, state) || (STATES[state]?.label ?? state)}
          </span>
          <${ForkLink} threadId=${data.threadId} forkedFrom=${meta.forkedFrom} />
          <span class="band-pill band-count band-pop" tabindex="0" role="button" onClick=${openParticipants}
            aria-label=${`${agentNames.length} agent session${agentNames.length === 1 ? '' : 's'} · open Participants`}>
            <span class="band-glyph" aria-hidden="true">🤖</span>${agentNames.length}
            <span class="band-popover" role="tooltip">
              <span class="band-pop-head">Agent sessions · ${agentNames.length}</span>
              <span class="band-pop-row is-primary"><b>${named.model ?? harness ?? 'Your agent'}</b><span>${[named.provider, launch?.effort ? `effort ${launch.effort}` : null].filter(Boolean).join(' · ') || 'your agent'}</span><i>primary</i></span>
              ${localAgents.map((m) => html`<span key=${m.member.id} class="band-pop-row"><b>${m.displayName}</b><span>local member</span><i></i></span>`)}
              ${subagents.map((t) => html`<span key=${t.threadId} class="band-pop-row"><b>${threadName(t)}</b><span>${t.meta?.spawn?.agentType ?? 'subagent'}</span><i>subagent</i></span>`)}
            </span>
          </span>
          <span class="band-pill band-count band-pop ${peopleCount ? 'band-chip--shared' : ''}" tabindex="0" role="button" onClick=${openParticipants}
            aria-label=${`${peopleCount + 1} ${peopleCount ? 'people' : 'person'} · open Participants`}>
            <span class="band-glyph" aria-hidden="true">👤</span>${peopleCount + 1}
            <span class="band-popover" role="tooltip">
              <span class="band-pop-head">People · ${peopleCount + 1}</span>
              <span class="band-pop-row is-primary"><b>You</b><span>acting as ${owner ? `your ${owner} membership` : 'your personal account'}</span><i>trusted</i></span>
              ${external.map((m) => html`<span key=${m.member.id} class="band-pop-row"><b>${m.displayName}</b><span>${m.member.kind === 'signet' ? 'joined through a Signet' : m.member.kind}</span><i>${m.trust ?? ''}</i></span>`)}
              <span class="band-pop-note">Trusted: in your org, or a vendor set up properly through Kingdom. Untrusted: everyone else.</span>
            </span>
          </span>
          ${
            signets.length
              ? html`<span class="band-pill band-signet" title=${`Signets in this thread (manage in Kingdom):\n${signets.map(signetLine).join('\n')}`}
                  aria-label=${`${signets.length} Signet${signets.length === 1 ? '' : 's'}`}>Signet${signets.length > 1 ? html` ${signets.length}` : null}</span>`
              : null
          }
        `} />
        <${PillGroup} className="band-runs" label="How it runs" render=${() => html`
          ${
            runs.length
              ? html`<button type="button" class="band-pill band-run" data-run="pill" onClick=${openThreadRun}
                  title=${`${[worker, ...runs].filter(Boolean).join(' · ')}${launch?.effort ? '' : ' (default effort)'} · change for this thread`}>${
                    worker ? html`<span class="band-drop">${worker}\u00a0·\u00a0</span>` : null
                  }${runs.join(' · ')}</button>`
              : null
          }
          ${
            fill !== null
              ? html`<span class="band-pill band-meter" title=${`Estimated context fill: ${fmtNum(threadContextTokens.value)} of ${fmtNum(contextWindow)} tokens`}>
                  <span class="band-meter-bar"><span style=${`width:${fill.toFixed(0)}%`}></span></span>${fill.toFixed(0)}%
                </span>`
              : null
          }
          ${
            MODES[launch?.permissionMode]
              ? html`<span class="band-pill band-mode" data-mode=${MODES[launch.permissionMode].word.toLowerCase()} title=${MODES[launch.permissionMode].label}>
                  <${ModeIcon} mode=${launch.permissionMode} />${MODES[launch.permissionMode].word}
                </span>`
              : null
          }
          ${
            isDangerous(launch?.permissionMode)
              ? html`<span class="band-pill band-dangerous" title="Dangerous: every permission check is skipped, overriding the mode's asks">Dangerous</span>`
              : null
          }
        `} />
      </div>
    </div>
  `;
}

const STRIP_DOT = { working: 'working', ready: 'done', degraded: 'attention', failed: 'problem' };

/**
 * What the system is doing around this thread, above the composer (Aron, 2026-11-11): its project's
 * Wardens starting, a rate limit on the login, the last turn's unheard Wardens. One plain line in the
 * status colours; the chevron opens the technical log. Nothing shows while all is quiet.
 */
function SystemStrip({ threadId }) {
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  const now = Date.now();
  const view = stripView(systemActivity.value, now);
  const degraded = lastDegraded(messages.value);
  const showing = !!view || !!degraded;
  useEffect(() => {
    if (!showing) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [showing]);
  if (!showing) return null;
  const count = degraded ? chorusNotice(degraded.chorus).count : 0;
  const log = systemActivityLog.value;
  return html`<div class="system-strip" role="status" data-state=${degraded ? 'degraded' : view.state}>
    ${
      degraded
        ? html`<div class="system-strip-row" data-chorus-bar="open">
        <span class="system-strip-dot" data-tone="attention"></span>
        <span class="system-strip-text">On the last turn, ${count} Warden${count === 1 ? '' : 's'} went unheard.</span>
        <button class="system-strip-action" onClick=${() => chorusAction(threadId, degraded.turnId, 'retry')}>Retry</button>
      </div>`
        : null
    }
    ${
      view
        ? html`<div class="system-strip-row" data-key=${view.head.key}>
        <span class="system-strip-dot" data-tone=${STRIP_DOT[view.state]}></span>
        <span class="system-strip-text">${view.head.summary}</span>
        ${view.elapsed ? html`<span class="system-strip-elapsed">${view.elapsed}</span>` : null}
        ${view.others.length ? html`<span class="system-strip-more">+${view.others.length} more</span>` : null}
        ${
          log.length || view.others.length
            ? html`<button class="system-strip-toggle" aria-expanded=${open} title=${open ? 'Hide the details' : 'Show the details'} onClick=${() => setOpen(!open)}>${open ? '▾' : '▸'}</button>`
            : null
        }
      </div>`
        : null
    }
    ${
      open && view
        ? html`<div class="system-strip-log">
        ${view.others.map(
          (a) => html`<div key=${a.key} class="system-strip-row system-strip-other">
            <span class="system-strip-dot" data-tone=${STRIP_DOT[a.state]}></span>
            <span class="system-strip-text">${a.summary}</span>
          </div>`,
        )}
        ${log.map(
          (a, i) => html`<div key=${i} class="system-strip-line">
            <span class="system-strip-time">${new Date(a.timestamp).toLocaleTimeString()}</span>
            <span class="system-strip-source">${a.source}</span>
            <span>${a.detail}</span>
          </div>`,
        )}
      </div>`
        : null
    }
  </div>`;
}

/** What the thread is doing right now, one line above the composer (moved out of the header). */
function ThreadNowStrip() {
  const list = messages.value;
  const live = [...list].reverse().find((m) => m.actor !== 'user' && m.live);
  const label = live ? liveWorkLabel(live) : null;
  if (!label) return null;
  return html`<div class="thread-now" role="status"><${StatusIcon} state=${threadStatusOf(threadData.value?.threadId, liveThreadStatus(list))} still=${true} />${label}</div>`;
}

// ---------------------------------------------------------------------------
// Chat input bar
// ---------------------------------------------------------------------------

const inputHistory = [];
let historyIdx = -1;

let attachmentKey = 0;

/** An image in the composer: its local preview, then its stored reference once uploaded. */
function ComposerImage({ image, onRemove }) {
  return html`
    <div class="composer-image ${image.status === 'error' ? 'composer-image-error' : ''}"
      data-status=${image.status} title=${image.error ?? image.name ?? 'image'}>
      <img src=${image.preview} alt=${image.name ?? 'attached image'} />
      ${image.status === 'uploading' ? html`<span class="composer-image-state">…</span>` : null}
      ${image.status === 'error' ? html`<span class="composer-image-state">!</span>` : null}
      <button class="composer-image-remove" onClick=${onRemove} title="Remove image"
        aria-label="Remove image">×</button>
    </div>
  `;
}

/** Each thread's unsent draft, kept while another view (Search, the board) replaces the conversation. */
const drafts = new Map();

function ChatInput() {
  const [text, setTextState] = useState(() => drafts.get(activeThreadId.peek()) ?? '');
  // The one writer of the draft: kept at once, so a view that replaces the box (Search, the board)
  // before the next render keeps every keystroke. An effect would run after paint, stale.
  const setText = (next) =>
    setTextState((current) => {
      const value = typeof next === 'function' ? next(current) : next;
      drafts.set(activeThreadId.peek(), value);
      return value;
    });
  const [asideError, setAsideError] = useState(null);
  const asidePost = useRef(null);
  // Mirror the draft so a waiting card can send it with its answer (which then empties the box
  // through composerFill).
  useEffect(() => {
    composerNote.value = text;
  }, [text]);
  const fill = composerFill.value;
  useEffect(() => {
    if (fill == null) return;
    setText(fill);
    composerFill.value = null;
  }, [fill]);
  const [images, setImages] = useState([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const stopDictation = useRef(null);
  const [listening, setListening] = useState(false);
  useEffect(() => () => stopDictation.current?.(), []);

  const patchImage = (key, patch) =>
    setImages((list) => list.map((image) => (image.key === key ? { ...image, ...patch } : image)));
  const removeImage = (key) =>
    setImages((list) => {
      const removed = list.find((image) => image.key === key);
      if (removed) URL.revokeObjectURL(removed.preview);
      return list.filter((image) => image.key !== key);
    });

  /** Downscale (when needed) and upload each image; the composer shows it from the first moment. */
  const addImages = (files) => {
    const accepted = imageFiles(files);
    if (!accepted.length) return;
    const room = IMAGES_PER_MESSAGE - images.length;
    if (accepted.length > room)
      showToast(`A message carries at most ${IMAGES_PER_MESSAGE} images`, 'warn');
    for (const file of accepted.slice(0, Math.max(0, room))) {
      const key = ++attachmentKey;
      setImages((list) => [
        ...list,
        { key, name: file.name, preview: URL.createObjectURL(file), status: 'uploading' },
      ]);
      prepareImage(file)
        .then(uploadImage)
        .then((stored) => patchImage(key, { status: 'ready', ...stored }))
        .catch((error) => {
          patchImage(key, { status: 'error', error: error.message });
          showToast(`Image not attached: ${error.message}`, 'error');
        });
    }
  };

  const handlePaste = (e) => {
    const files = imageFiles(e.clipboardData?.items);
    if (!files.length) return;
    e.preventDefault();
    addImages(files);
  };
  const handleDragOver = (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  };
  const handleDrop = (e) => {
    setDragging(false);
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    addImages(e.dataTransfer.files);
  };

  const toggleDictation = () => {
    if (stopDictation.current) return stopDictation.current();
    // Speech lands after whatever was already typed.
    const base = text.trimEnd();
    stopDictation.current = startDictation({
      onText: (heard) => setText(base && heard ? `${base} ${heard}` : base || heard),
      onEnd: (error) => {
        stopDictation.current = null;
        setListening(false);
        if (error) showToast(`Dictation stopped: ${error}`, 'warn');
      },
    });
    setListening(true);
  };

  const uploading = images.some((image) => image.status === 'uploading');
  const ready = images.filter((image) => image.status === 'ready');
  const destination = separateViews(settingsConfig.value) ? 'thread' : composerDestination.value;
  const sendable =
    (destination === 'thread' && !uploading && (!!text.trim() || ready.length > 0)) ||
    (destination === 'aside' && !!text.trim());

  /** `delivery: 'queue'` (⌘↵) waits for a running turn; otherwise the `steer` setting decides. */
  const handleSubmit = async ({ delivery } = {}) => {
    const sent = text.trim();
    if (!sendable) return;
    // An aside goes to the people here, never an agent. One id per message: a retry records once.
    if (destination === 'aside') {
      if (asidePost.current?.text !== sent) asidePost.current = { text: sent, id: uuidv7() };
      const posted = await postAside(activeThreadId.value, sent, asidePost.current.id);
      if (posted.error) return setAsideError(posted.error);
      asidePost.current = null;
      setAsideError(null);
      inputHistory.push(sent);
      historyIdx = -1;
      setText('');
      return;
    }
    // `/feedback <text>` records feedback on this thread's last turn; it is never sent to the model.
    const feedback = /^\/feedback(?:\s+([\s\S]*))?$/.exec(sent);
    if (feedback) {
      const body = feedback[1]?.trim() ?? '';
      if (!body)
        return showToast('Usage: /feedback <what you want to say about this thread>', 'warn');
      stopDictation.current?.();
      inputHistory.push(sent);
      historyIdx = -1;
      const about = aboutTarget.peek();
      const aimed = about ? { about, ...(about.turnId ? { turnId: about.turnId } : {}) } : {};
      if (await giveFeedback(activeThreadId.value, body, aimed)) {
        setText('');
        aboutTarget.value = null;
      }
      return;
    }
    // With an approval waiting, sending declines it and tells the agent why: the text rides the
    // rejection as its note (the resolve route's note), instead of queueing behind the blocked turn.
    const waitingApproval = promptsForThread(prompts.peek(), activeThreadId.peek()).find(
      (p) => p.kind === 'approval',
    );
    if (waitingApproval && sent && !ready.length) {
      stopDictation.current?.();
      inputHistory.push(sent);
      historyIdx = -1;
      if (await resolvePrompt(waitingApproval.id, 'reject', undefined, { note: sent })) setText('');
      return;
    }
    stopDictation.current?.();
    if (sent) inputHistory.push(sent);
    historyIdx = -1;
    setText('');
    const attached = images;
    setImages([]);
    // A message about a Plan step or Loop item says so on its first line ("Re: …"), for the agent too.
    const about = aboutTarget.peek();
    const outgoing = about && sent ? `Re: ${about.label}\n\n${sent}` : sent;
    if (about) aboutTarget.value = null;
    // Unsent text and images come back unless something new was added meanwhile.
    if (!(await sendMessage(outgoing, ready, delivery ? { delivery } : {}))) {
      if (about) aboutTarget.value = about;
      setText((current) => current || sent);
      setImages((current) => (current.length ? current : attached));
      return;
    }
    for (const image of attached) URL.revokeObjectURL(image.preview);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // ↵ sends (into a running turn, with steering on); ⌘↵ / Ctrl↵ queues it after.
      handleSubmit(e.metaKey || e.ctrlKey ? { delivery: 'queue' } : {});
    }
    if (e.key === 'ArrowUp' && !text.includes('\n')) {
      if (inputHistory.length === 0) return;
      e.preventDefault();
      if (historyIdx === -1) historyIdx = inputHistory.length;
      historyIdx = Math.max(0, historyIdx - 1);
      setText(inputHistory[historyIdx]);
    }
    if (e.key === 'ArrowDown' && !text.includes('\n')) {
      if (historyIdx === -1) return;
      e.preventDefault();
      historyIdx += 1;
      if (historyIdx >= inputHistory.length) {
        historyIdx = -1;
        setText('');
      } else {
        setText(inputHistory[historyIdx]);
      }
    }
  };

  return html`
    <${SubagentStrip} threadId=${activeThreadId.value} />
    <div class="chat-input-bar ${dragging ? 'chat-input-dragging' : ''}" style="position: relative"
      onDragOver=${handleDragOver} onDragLeave=${() => setDragging(false)} onDrop=${handleDrop}>
      <${ActionPalette} onSend=${handleSubmit} />
      <div class="chat-input-main">
        <${QueuedRows} threadId=${activeThreadId.value} />
        ${
          aboutTarget.value
            ? html`<div class="about-row"><span class="about-chip" title="Your message will be tagged to this">About: ${aboutTarget.value.label}<button type="button" aria-label="Remove the tag" onClick=${() => {
                aboutTarget.value = null;
              }}>×</button></span></div>`
            : null
        }
        ${
          images.length
            ? html`<div class="composer-images">
          ${images.map(
            (image) =>
              html`<${ComposerImage} key=${image.key} image=${image} onRemove=${() => removeImage(image.key)} />`,
          )}
        </div>`
            : null
        }
        <div class="composer-row">
        <${DestinationLabel} config=${settingsConfig.value} />
        <textarea
          ref=${inputRef}
          class="chat-input"
          placeholder=${aboutTarget.value ? `Message the thread about ${aboutTarget.value.label} · /feedback records it as feedback on it` : 'Message the thread · ↑ history · paste or drop images'}
          value=${text}
          onInput=${(e) => {
            // "/" typed into an empty box opens the actions palette (and goes no further).
            if (!text && e.target.value === '/') {
              e.target.value = '';
              actionPaletteOpen.value = 'slash';
              return;
            }
            const routed = routeTyped(e.target.value, settingsConfig.peek());
            if (routed) {
              composerDestination.value = routed.destination;
              setText(routed.text);
              return;
            }
            setText(e.target.value);
          }}
          onKeyDown=${handleKeyDown}
          onPaste=${handlePaste}
          rows="1"
        ></textarea>
        </div>
        ${(() => {
          const waiting = promptsForThread(prompts.value, activeThreadId.value);
          const approval = waiting.find((p) => p.kind === 'approval');
          if (destination === 'aside')
            return asideError
              ? html`<div class="composer-note-hint composer-note-hint--error" role="alert">The aside wasn’t posted: ${asideError}</div>`
              : html`<div class="composer-note-hint">An aside: the people in this thread see it, never an agent</div>`;
          if (destination !== 'thread')
            return html`<div class="composer-note-hint composer-note-hint--queue">${NOT_BUILT[destination]}</div>`;
          if (text.trim() && approval)
            return html`<div class="composer-note-hint">Sending declines “${approval.message}” and tells the agent why · or answer the card to send it with your answer</div>`;
          if (text.trim() && waiting.length)
            return html`<div class="composer-note-hint">Goes with your answer to the waiting card · or press Send to post it on its own</div>`;
          if (text.trim() && turnRunning(messages.value)) return html`<${SendHint} />`;
          return null;
        })()}
      </div>
      <input ref=${fileRef} class="composer-file-input" type="file" multiple
        accept=${IMAGE_TYPES.join(',')} hidden
        onChange=${(e) => {
          addImages(e.target.files);
          e.target.value = '';
        }} />
      <div class="chat-input-actions">
        <button tabindex="-1" class="chat-voice-btn chat-attach-btn" onClick=${() => fileRef.current?.click()}
          title="Attach images" aria-label="Attach images">📎</button>
        ${
          dictationSupported
            ? html`<button tabindex="-1" class="chat-voice-btn ${listening ? 'chat-voice-on' : ''}" onClick=${toggleDictation}
          title=${listening ? 'Stop dictation' : 'Dictate'} aria-pressed=${listening}>${listening ? '■' : '🎙'}</button>`
            : null
        }
        ${
          speechSupported
            ? html`<button tabindex="-1" class="chat-voice-btn ${speakReplies.value ? 'chat-voice-on' : ''}" onClick=${toggleSpeakReplies}
          title=${speakReplies.value ? 'Stop reading replies aloud' : 'Read replies aloud'} aria-pressed=${speakReplies.value}>${speakReplies.value ? '🔊' : '🔈'}</button>`
            : null
        }
        <button tabindex="-1" type="button" class="composer-actions-btn" title="Actions and routing (⌥/ · or type / in an empty message)"
          onClick=${() => {
            actionPaletteOpen.value = !actionPaletteOpen.value;
          }}>Actions <kbd class="cmd">⌥/</kbd></button>
        <button
          tabindex="-1"
          class="chat-send-btn"
          onClick=${handleSubmit}
          disabled=${!sendable}
          title=${uploading ? 'Waiting for images to upload' : 'Send'}
        >Send</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

function tabOnlyLabel(msg) {
  return msg.storage === 'browser-only' ? 'Only in this tab' : '';
}

function evidenceText(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'Evidence could not be serialized for display. The message above remains available in this tab.';
  }
}

/** The images a sent message carried, shown from the attachment route. */
function MessageImages({ images }) {
  if (!Array.isArray(images) || !images.length) return null;
  return html`
    <div class="chat-msg-images">
      ${images.map(
        (image) => html`<a href=${imageUrl(image.id)} target="_blank" rel="noopener"
          class="chat-msg-image"><img src=${imageUrl(image.id)} alt="sent image" loading="lazy" /></a>`,
      )}
    </div>
  `;
}

/** A message's "Give feedback" form, opened from its ⋯ actions. */
function useGiveFeedback(msg) {
  const [giving, setGiving] = useState(false);
  const threadId = activeThreadId.value;
  return {
    onFeedback: msg.turnId && threadId ? () => setGiving(true) : undefined,
    form: giving
      ? html`<${GiveFeedback} threadId=${threadId} msg=${msg} onDone=${() => setGiving(false)} />`
      : null,
  };
}

const RE_LINE = /^Re: ((Plan|Loop) › [^\n]+)\n\n?/;

/**
 * A user message, as Markdown with every newline kept; one about a Plan step or Loop item opens
 * with a "Re: …" link back to it.
 */
function UserContent({ content }) {
  const re = RE_LINE.exec(content);
  const body = re ? content.slice(re[0].length) : content;
  return html`<div class="chat-msg-content chat-msg-md">${
    re
      ? html`<button type="button" class="re-link" title="Open it"
      onClick=${() => {
        activePanel.value = re[2] === 'Plan' ? 'plan' : 'graph';
      }}>Re: ${re[1]}</button>`
      : null
  }<${Markdown} text=${body} breaks=${true} /></div>`;
}

/** Every message: Inspect opens its turn in the turn view (the right panel, widened). */
function InspectLink({ turnId }) {
  return html`<button type="button" class="inspect-link" title="Open this turn in the turn view"
    onClick=${() => openTurnView(activeThreadId.peek(), turnId)}>Inspect</button>`;
}

/** The thread's open subagents, above the composer (concept-v4 "Subagents · running N"); each opens. */
function SubagentStrip({ threadId }) {
  const kids = allThreads.value.filter(
    (t) => subagentParentOf(t.meta) === threadId && !isClosedThread(t),
  );
  if (!kids.length) return null;
  const running = kids.filter(
    (t) => categoryOf(threadState(t, { prompts: [] })) === 'working',
  ).length;
  return html`<div class="subagent-strip" aria-label="Subagents">
    <b>Subagents</b>
    <span class="subagent-strip-count">${running ? `running ${running} of ${kids.length}` : `${kids.length} open`}</span>
    ${kids.map(
      (
        t,
      ) => html`<button key=${t.threadId} type="button" class="subagent-strip-item" onClick=${() => selectThread(t.threadId)}
        title="Open this subagent">${threadName(t)}</button>`,
    )}
  </div>`;
}

/**
 * In place of the composer on an observed subagent thread: it is a record of the subagent's work and
 * takes no turns (the server refuses them), so it points at the parent thread that does.
 */
function SubagentRecordNotice({ meta }) {
  const parentId = subagentParentOf(meta);
  const parent = parentId ? allThreads.value.find((t) => t.threadId === parentId) : null;
  return html`<div class="subagent-record" role="note">
    <span>A record of this subagent's work. It takes no messages; talk to the thread that started it.</span>
    ${
      parentId
        ? html`<button type="button" class="subagent-record-parent" onClick=${() => selectThread(parentId)}>
            Open ${parent ? threadName(parent) : 'the parent thread'} →</button>`
        : null
    }
  </div>`;
}

/** "10:35 AM, Mon 2 Nov": a message's time, shown on hover (concept-v4 keeps no time inline). */
const sentAt = (msg) =>
  new Date(msg.timestamp).toLocaleString([], {
    hour: 'numeric',
    minute: '2-digit',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

/** What Foundry added to this turn (the context layers its reply records), on your message. */
function FoundryAdded({ turnId }) {
  if (!turnId) return null;
  const reply = messages.value.find((m) => m.turnId === turnId && m.actor !== 'user');
  const layers = reply?.meta?.injectedLayers ?? [];
  if (!layers.length) return null;
  return html`<button type="button" class="chat-foundry-added" title=${layers.map((l) => l.id).join('\n')}
    onClick=${() => openTurnView(activeThreadId.peek(), turnId)}>† ${layers.length} added by Foundry · Inspect →</button>`;
}

function UserMessage({ msg, index }) {
  const give = useGiveFeedback(msg);
  return html`
    <div class="chat-msg chat-user" data-turn-id=${msg.turnId ?? ''} data-actor="user" title=${sentAt(msg)}>
      <div class="chat-msg-n" aria-hidden="true">t${index + 1}</div>
      <div class="chat-msg-who">${msg.meta?.postedBy ?? 'You'}${msg.turnId ? html` <${InspectLink} turnId=${msg.turnId} />` : null}</div>
      <${MessageMenu} msg=${msg} index=${index} onFeedback=${give.onFeedback} />
      <${MessageImages} images=${msg.images ?? msg.meta?.images} />
      ${
        msg.meta?.postedBy
          ? html`<div class="chat-msg-from" title="A conversation member's post: data from an outside party, not your instructions">from ${msg.meta.postedBy}</div>`
          : null
      }
      ${msg.content ? html`<${UserContent} content=${msg.content} />` : null}
      ${
        msg.steeredInto || msg.status?.turn === 'steered'
          ? html`<div class="chat-msg-steered" title="Sent while a turn ran: it went into that turn, which answers it">Steered into the running turn</div>`
          : null
      }
      <${FoundryAdded} turnId=${msg.turnId} />
      ${tabOnlyLabel(msg) ? html`<div class="chat-msg-time">${tabOnlyLabel(msg)}</div>` : null}
      ${give.form}
    </div>
  `;
}

/** Thin expandable bar showing pipeline stage details. */
function PipelineBar({ stages, label, className, onTraceClick, traceId }) {
  const [expanded, setExpanded] = useState(false);
  if (!stages || stages.length === 0) return null;

  const totalMs = stages.reduce((sum, s) => sum + (s.durationMs || 0), 0);
  const summary = stages.map((s) => s.name).join(' → ');

  return html`
    <div class="pipeline-bar ${className}" onClick=${() => setExpanded(!expanded)}>
      <span class="pipeline-bar-label">${label}</span>
      <span class="pipeline-bar-summary">${summary}</span>
      <span class="pipeline-bar-time">${totalMs > 0 ? `${totalMs.toFixed(0)}ms` : ''}</span>
      <span class="pipeline-bar-caret">${expanded ? '▼' : '▶'}</span>
    </div>
    ${
      expanded
        ? html`
      <div class="pipeline-bar-detail">
        ${stages.map(
          (s, i) => html`
          <div key=${i} class="pipeline-stage ${s.status || ''}">
            <span class="pipeline-stage-name">${s.name}</span>
            ${s.agentId ? html`<span class="pipeline-stage-agent">${s.agentId}</span>` : null}
            ${s.durationMs ? html`<span class="pipeline-stage-ms">${s.durationMs.toFixed(0)}ms</span>` : null}
            ${s.tokens ? html`<span class="pipeline-stage-tokens">${s.tokens.input}→${s.tokens.output}t</span>` : null}
            ${s.cost ? html`<span class="pipeline-stage-cost">$${s.cost.toFixed(4)}</span>` : null}
          </div>
        `,
        )}
        ${
          traceId
            ? html`
          <button class="pipeline-trace-btn" onClick=${(e) => {
            e.stopPropagation();
            onTraceClick(traceId);
          }}>
            full trace
          </button>
        `
            : null
        }
      </div>
    `
        : null
    }
  `;
}

function fmtTokenCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/** Chips showing which layers were in-context when the model responded. */
function LayerChips({ layers }) {
  if (!layers?.length) return null;
  return html`
    <div class="chat-layers">
      <span class="chat-layers-prefix">ctx:</span>
      ${layers.map(
        (l) => html`
        <span class="chat-layer-chip"
              title="${l.id}\nhash: ${l.hash}\n~${l.tokens} tokens">
          ${l.id}<span class="chat-layer-chip-tokens">${fmtTokenCount(l.tokens)}</span>
        </span>
      `,
      )}
    </div>
  `;
}

function ActivityRow({ a }) {
  if (a.kind === 'steer')
    return html`<div class="live-work-steer"><small>You steered in</small><br/>${a.text}</div>`;
  if (a.kind === 'thought')
    return html`<div class="live-work-thought"><small>Thinking</small><br/>${a.text}</div>`;
  if (a.kind === 'text')
    return html`<div class="live-work-progress"><small>${a.phase === 'final_answer' ? 'Final answer preview' : 'Live output'}</small><br/>${a.text}</div>`;
  return html`<div class="live-work-tool">${a.toolName} · ${a.state}</div>`;
}

/** One status line for the turn's actual stage, then its activity. Once the turn has finished, the
 * activity folds into a closed work log without the text the answer already shows. */
function LiveWork({ msg }) {
  if (!msg.live)
    return msg.streaming
      ? html`<section class="live-work" aria-label="Work activity"><div class="live-work-status">Sending…</div></section>`
      : null;
  const status = liveExecutionStatus(msg);
  const finished = status !== 'queued' && status !== 'running';
  const label = liveWorkLabel(msg);
  if (finished) {
    const log = workLog(msg);
    // The outcome already shows as the message; only a failed or unconfirmed outcome is restated.
    const outcome =
      label === 'Completed' ? null : html`<div class="live-work-status">${label}</div>`;
    if (!log.rows.length && !outcome) return null;
    return html`<section class="live-work live-work--done" aria-label="Work activity">
      ${outcome}
      ${
        log.rows.length
          ? html`<details class="live-work-log">
        <summary>Work log${log.summary ? ` · ${log.summary}` : ''}</summary>
        <div class="live-work-activity">${log.rows.map((a) => html`<${ActivityRow} key=${a.id} a=${a} />`)}</div>
        ${msg.live.truncated ? html`<div>Partial activity window; complete recorded evidence is in inspection.</div>` : null}
      </details>`
          : null
      }
    </section>`;
  }
  return html`<section class="live-work" aria-label="Work activity">
    <div class="live-work-status">${label} <button class="live-work-stop" title="Stop this turn"
      onClick=${() => stopTurn(msg.live.threadId, msg.live.messageId)}>Stop</button></div>
    <div class="live-work-activity">${msg.live.activity.map((a) => html`<${ActivityRow} key=${a.id} a=${a} />`)}</div>
    ${msg.live.truncated ? html`<div>Partial activity window; complete recorded evidence is in inspection.</div>` : null}
  </section>`;
}

/** The turn's degraded chorus (FEAT-008): which Wardens went unheard, with Retry and Dismiss. */
function ChorusNotice({ msg }) {
  const [busy, setBusy] = useState(false);
  const notice = chorusNotice(msg.chorus);
  const threadId = activeThreadId.value;
  if (!notice || !msg.turnId || !threadId) return null;
  const act = async (action) => {
    setBusy(true);
    try {
      await chorusAction(threadId, msg.turnId, action);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="chorus-notice chorus-notice--${notice.state}" role="status" data-chorus=${notice.state}>
    <span>${notice.text}</span>
    ${
      notice.state === 'open'
        ? html`<span class="chorus-notice-actions">
            <button class="prompt-btn" disabled=${busy} onClick=${() => act('retry')}
              title="Ask these Wardens again on the same moment; what they say rides with your next message">Retry</button>
            <button class="prompt-btn" disabled=${busy} onClick=${() => act('dismiss')}>Dismiss</button>
          </span>`
        : null
    }
  </div>`;
}

/** A turn lost to a restart that the native record couldn't settle: the owner decides, never a silent refusal. */
function LostTurnCard({ msg }) {
  const [busy, setBusy] = useState(false);
  if (msg.meta?.recovery !== 'pending') return null;
  const threadId = msg.threadId ?? activeThreadId.value;
  const act = async (action) => {
    setBusy(true);
    await resolveLostTurn(threadId, action);
    setBusy(false);
  };
  return html`<section class="lost-turn-card" role="alert" aria-label="Lost turn">
    <div class="lost-turn-title">Foundry lost track of the last turn after a restart.</div>
    <div class="lost-turn-body">Check the files it touched, then Continue. Retry sends that turn's message again; anything you sent after it needs sending again.</div>
    <div class="lost-turn-actions">
      <button class="prompt-btn prompt-btn-approve" disabled=${busy} onClick=${() => act('continue')}>Continue</button>
      <button class="prompt-btn" disabled=${busy} onClick=${() => act('retry')}>Retry the turn</button>
    </div>
  </section>`;
}

/**
 * Who answered, with the model that worked and how long: "Your agent · Opus 5.5 · 22.1s". The model
 * is what the native session reported (observed, else requested), named from the registry; an id it
 * does not know shows nothing. A participant's agent will read "<name> · <model>" the same way.
 */
export function agentWho(msg, execStage) {
  const config = msg.meta?.native?.configuration;
  const model = modelLabel(config?.observedModel) ?? modelLabel(config?.requestedModel);
  const ms = execStage?.durationMs ?? msg.trace?.totalDurationMs;
  return ['Your agent', model, ms ? `${(ms / 1000).toFixed(1)}s` : null]
    .filter(Boolean)
    .join(' · ');
}

function AgentMessage({ msg, index, onTraceClick }) {
  const hasTrace = !!msg.traceId;
  const stages = msg.trace?.stages || [];
  const isStreaming = !!msg.streaming;
  const injectedLayers = msg.meta?.injectedLayers;
  const failure = failurePresentation(msg.meta);
  const give = useGiveFeedback(msg);

  // Split stages into pre-execution (classify, route, middleware) and post (guards, writeback).
  // Ingress is the turn's root span, not a stage before the executor: an unwrapped turn has no pre bar.
  const execIdx = stages.findIndex((s) => s.kind === 'execute' || s.name?.includes('execut'));
  const preStages = execIdx > 0 ? stages.slice(0, execIdx).filter((s) => s.kind !== 'ingress') : [];
  const postStages = execIdx >= 0 && execIdx < stages.length - 1 ? stages.slice(execIdx + 1) : [];
  const execStage = execIdx >= 0 ? stages[execIdx] : null;

  return html`
    <div class="chat-msg chat-agent ${msg.error ? 'chat-error' : ''} ${isStreaming ? 'chat-streaming' : ''}" data-turn-id=${msg.turnId ?? ''} data-actor="agent" title=${sentAt(msg)}>
      <div class="chat-msg-n" aria-hidden="true">t${index + 1}</div>
      <div class="chat-msg-who">${agentWho(msg, execStage)}</div>
      <${MessageMenu} msg=${msg} index=${index} onFeedback=${give.onFeedback} />
      <!-- Pre-execution bar: classify → route → context loading -->
      <${PipelineBar}
        stages=${preStages}
        label="pre"
        className="pipeline-pre"
        onTraceClick=${onTraceClick}
        traceId=${msg.traceId}
      />

      <!-- Classification + route badges (inline) -->
      ${
        msg.classification || hasTrace
          ? html`
        <div class="chat-pipeline">
          ${
            msg.classification
              ? html`
            <span class="chat-badge classify">${msg.classification.category}</span>
          `
              : null
          }
          ${
            hasTrace
              ? html`
            <button class="chat-trace-btn" onClick=${() => onTraceClick(msg.traceId)}
              title=${`Inspect this turn in the detail panel${msg.trace?.totalDurationMs ? ` · ${(msg.trace.totalDurationMs / 1000).toFixed(1)} s` : ''}`}>Inspect</button>
          `
              : null
          }
        </div>
      `
          : null
      }

      <${LayerChips} layers=${injectedLayers} />

      <${LiveWork} msg=${msg} />

      <div class="chat-msg-content chat-msg-md"><${Markdown} text=${msg.content} streaming=${isStreaming} />${isStreaming ? html`<span class="stream-cursor">▍</span>` : null}</div>
      ${failure.notices.map((notice) => html`<div class="chat-msg-time">${notice}</div>`)}
      <${LostTurnCard} msg=${msg} />
      ${msg.journalRecord ? html`<div class="chat-msg-time">Server journal: ${msg.journalRecord.meta?.turnStatus}; this tab's observed result is separate.</div>` : null}
      ${
        isUnsavedCompletion(msg)
          ? html`
        <details>
          <summary>Completed evidence (only in this tab)</summary>
          <div class="chat-msg-content">${evidenceText({ trace: msg.traceSnapshot ?? msg.trace, input: msg.meta?.injection })}</div>
        </details>
      `
          : null
      }
      ${
        failure.partialOutput
          ? html`
        <details open>
          <summary>Partial output (unconfirmed)</summary>
          <div class="chat-msg-content chat-msg-md"><${Markdown} text=${failure.partialOutput} /></div>
        </details>
      `
          : null
      }
      ${
        failure.browserEvidence
          ? html`
        <details>
          <summary>Failure evidence (only in this tab)</summary>
          <div class="chat-msg-content">${evidenceText(failure.browserEvidence)}</div>
        </details>
      `
          : null
      }

      <${ChorusNotice} msg=${msg} />

      <!-- Post-execution bar: guards, writeback -->
      <${PipelineBar}
        stages=${postStages}
        label="post"
        className="pipeline-post"
        onTraceClick=${onTraceClick}
        traceId=${msg.traceId}
      />

      ${
        tabOnlyLabel(msg) || msg.connectionStatus === 'unconfirmed'
          ? html`<div class="chat-msg-time">${[tabOnlyLabel(msg), msg.connectionStatus === 'unconfirmed' ? 'Connection interrupted; server outcome unconfirmed' : ''].filter(Boolean).join(' · ')}</div>`
          : null
      }
      <${TurnFeedback} threadId=${activeThreadId.value} turnId=${msg.turnId} />
      ${give.form}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Thinking message — collapsed accordion, expand to read the reasoning
// ---------------------------------------------------------------------------

function ThinkingMessage({ msg }) {
  const [open, setOpen] = useState(false);
  const content = msg.content || '';
  const words = content.split(/\s+/).filter(Boolean).length;

  return html`
    <div class="chat-msg chat-agent chat-thinking-block">
      <div class="thinking-fold-header" onClick=${() => setOpen(!open)}>
        <span class="thinking-caret">${open ? '▼' : '▶'}</span>
        <span class="thinking-label">thinking</span>
        <span class="thinking-meta">${words} words</span>
      </div>
      ${
        open
          ? html`
        <div class="chat-msg-content chat-msg-md thinking-content"><${Markdown} text=${content} /></div>
      `
          : null
      }
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Prompt cards — pending agent→human interactions
// ---------------------------------------------------------------------------

/** Walk the thread tree to build a breadcrumb path for a given threadId. */
function threadBreadcrumb(threadId) {
  const threads = allThreads.value || [];
  // Build parent map from thread tree
  const parentMap = {};
  const threadMap = {};
  function walk(nodes) {
    for (const t of nodes) {
      const id = t.threadId || t.id;
      threadMap[id] = t;
      for (const child of t.children || []) {
        const cid = child.threadId || child.id;
        parentMap[cid] = id;
        walk([child]);
      }
    }
  }
  walk(threads);

  // Walk up from threadId to root
  const path = [];
  let cur = threadId;
  while (cur) {
    path.unshift(cur);
    cur = parentMap[cur];
  }
  return path;
}

function PromptCard({ prompt }) {
  if (prompt.meta?.feedback) return html`<${FeedbackPrompt} prompt=${prompt} />`;
  if (prompt.meta?.conversationHeld) return html`<${HeldPromptCard} prompt=${prompt} />`;
  return html`<${ActionPromptCard} prompt=${prompt} />`;
}

/** A detail long enough to need its own window: a script, SQL, a long command. */
const lineCount = (text) => String(text).split('\n').length;
const isLong = (text) => lineCount(text) > 3 || String(text).length > 280;
const previewOf = (text) => `${String(text).split('\n').slice(0, 3).join('\n')}\n…`;
/** What an approval would run: the tool gate puts the tool's input on the prompt (a Bash command, a file's content). */
function commandOf(prompt) {
  const input = prompt.meta?.toolInput;
  if (input && typeof input === 'object') {
    for (const key of ['command', 'content', 'new_string', 'query', 'sql']) {
      if (typeof input[key] === 'string' && input[key]) return input[key];
    }
  }
  return prompt.detail ?? null;
}

/** One plain line saying what approving would do, from the call's capability, tool and command. */
export function riskLine(prompt) {
  const meta = prompt.meta ?? {};
  // The call's command, or the ask itself when the call carries none ("Allow git push …?").
  const command = String(meta.toolInput?.command ?? prompt.message ?? '');
  const path = meta.path ?? meta.toolInput?.file_path ?? meta.toolInput?.path;
  const cap = prompt.capability ?? '';
  let what = null;
  if (cap === 'git.push') what = 'Pushes to a remote';
  else if (cap === 'exec:shell' || /^(Bash|shell|exec_command)$/.test(meta.toolName ?? '')) {
    if (/\bgit\s+push\b/.test(command)) what = 'Pushes to a remote';
    else if (/\brm\s+-[a-z]*r|\bDROP\s+|\bDELETE\s+FROM\b|--force-reset/i.test(command))
      what = 'Deletes data';
    else what = 'Runs a shell command';
  } else if (cap === 'file:write') what = `Changes ${path ?? 'a file'}`;
  else if (cap === 'file:read') what = `Reads ${path ?? 'a file'}`;
  else if (cap.startsWith('net') || cap === 'fetch') what = 'Reaches the network';
  if (!what) return null;
  const level =
    prompt.urgency === 'critical' ? 'critical' : prompt.urgency === 'high' ? 'high risk' : null;
  return level ? `${what} · ${level}` : what;
}

const SCOPES = [
  ['once', 'Once', true],
  ['thread', 'This thread', true],
  ['session', 'This session · not built', false],
  ['project', 'Always for this project · not built', false],
];

function ActionPromptCard({ prompt }) {
  const [full, setFull] = useState(false);
  const [scope, setScope] = useState('once');
  const [input, setInput] = useState('');
  const command = commandOf(prompt);
  const [resolving, setResolving] = useState(false);

  const urgencyClass =
    prompt.urgency === 'critical'
      ? 'prompt-critical'
      : prompt.urgency === 'high'
        ? 'prompt-high'
        : '';

  const handleAction = async (action) => {
    setResolving(true);
    // "This thread" answers the same call the same way for the rest of this thread (the route's always).
    await resolvePrompt(prompt.id, action, input || undefined, {
      always: action === 'approve' && scope === 'thread',
    });
    setResolving(false);
  };
  const risk = riskLine(prompt);
  const makeRule = () =>
    giveFeedback(prompt.threadId, `Make a rule for this approval: ${prompt.message}`, {
      ...(prompt.meta?.turnId ? { turnId: prompt.meta.turnId } : {}),
      tags: ['rule-request'],
    });

  const options = prompt.options || [];
  const isInput = prompt.kind === 'input';
  const isChoice = prompt.kind === 'choice';

  const breadcrumb = prompt.threadId ? threadBreadcrumb(prompt.threadId) : [];

  return html`
    <div class="prompt-card ${urgencyClass}">
      <div class="prompt-card-header">
        <span class="prompt-kind">${prompt.kind}</span>
        ${prompt.agentId ? html`<span class="prompt-agent">${prompt.agentId}</span>` : null}
        ${prompt.capability ? html`<span class="prompt-cap">${prompt.capability}</span>` : null}
        ${
          prompt.urgency && prompt.urgency !== 'normal'
            ? html`<span class="prompt-urgency ${urgencyClass}">${prompt.urgency}</span>`
            : null
        }
      </div>
      ${
        breadcrumb.length > 0
          ? html`
        <div class="prompt-breadcrumb">
          ${breadcrumb.map(
            (seg, i) => html`
            <span key=${seg}>
              ${i > 0 ? html`<span class="prompt-breadcrumb-sep">/</span>` : null}
              <span class="prompt-breadcrumb-seg ${i === breadcrumb.length - 1 ? 'current' : ''}">${seg}</span>
            </span>
          `,
          )}
        </div>
      `
          : null
      }
      <div class="prompt-card-message">${prompt.message}</div>
      ${risk ? html`<div class="prompt-risk">${risk}</div>` : null}
      ${
        command
          ? isLong(command)
            ? html`<pre class="prompt-card-preview">${previewOf(command)}</pre>
                <button type="button" class="prompt-full-link" onClick=${() => setFull(true)}>View full command · ${lineCount(command)} lines ▸</button>`
            : html`<pre class="prompt-card-command">${command}</pre>`
          : null
      }
      ${
        full
          ? html`<${Modal} title="Approve a command" onClose=${() => setFull(false)} class="command-modal">
              <p class="command-modal-ask">${prompt.message}</p>
              <pre class="command-modal-code">${command}</pre>
              <div class="command-modal-actions">
                <button class="prompt-btn prompt-btn-reject" disabled=${resolving} onClick=${async () => {
                  await handleAction('reject');
                  setFull(false);
                }}>Reject</button>
                <button class="prompt-btn prompt-btn-approve" disabled=${resolving} onClick=${async () => {
                  await handleAction('approve');
                  setFull(false);
                }}>${composerNote.value.trim() ? 'Approve + note' : 'Approve'}</button>
              </div>
            <//>`
          : null
      }

      ${
        isInput
          ? html`
        <input
          class="prompt-input"
          placeholder="Type your response..."
          value=${input}
          onInput=${(e) => setInput(e.target.value)}
          disabled=${resolving}
        />
      `
          : null
      }

      <div class="prompt-card-actions">
        ${
          isChoice && options.length > 0
            ? options.map(
                (opt) => html`
          <button key=${opt.id}
            class="prompt-btn"
            onClick=${() => handleAction(opt.id)}
            disabled=${resolving}
            title=${opt.description || ''}
          >${opt.label}${composerNote.value.trim() ? ' + note' : ''}</button>
        `,
              )
            : html`
          <button class="prompt-btn prompt-btn-approve"
            onClick=${() => handleAction('approve')}
            disabled=${resolving}>${composerNote.value.trim() ? 'Approve + note' : 'Approve'}</button>
          <select class="prompt-scope" aria-label="Approve for" value=${scope} onChange=${(e) => setScope(e.target.value)}>
            ${SCOPES.map(([id, label, built]) => html`<option key=${id} value=${id} disabled=${!built}>${label}</option>`)}
          </select>
          <button class="prompt-btn prompt-btn-reject"
            onClick=${() => handleAction('reject')}
            disabled=${resolving}>Reject</button>
        `
        }
        ${
          prompt.kind === 'approval'
            ? html`<button type="button" class="prompt-make-rule" onClick=${makeRule}
          title="Records a feedback item for the Forge Master to turn into a rule">Tired of this? Make a rule</button>`
            : null
        }
      </div>
    </div>
  `;
}

/**
 * The open thread's pending prompts only. Other threads' prompts are reached from the Board and
 * their row counts, so an Approve here can only ever act on the thread being read.
 */
export function promptsForThread(pending, threadId) {
  return waitingFor(threadId, pending);
}

/**
 * The open thread's waiting items as one stack above the composer: one card at a time, stepped
 * with ‹ › (never folded away), in a fixed-height frame so the transcript doesn't jump.
 */
function PromptList({ threadId }) {
  const pending = promptsForThread(prompts.value, threadId);
  const [index, setIndex] = useState(0);
  if (pending.length === 0) return null;
  const at = Math.min(index, pending.length - 1);
  const step = (d) => setIndex((at + d + pending.length) % pending.length);
  return html`
    <div class="prompt-list prompt-stack" role="region" aria-label="Waiting on you" tabindex="0">
      ${
        pending.length > 1
          ? html`<div class="prompt-stack-nav">
              <button type="button" class="prompt-stack-step" aria-label="Previous" onClick=${() => step(-1)}>‹</button>
              <span class="prompt-stack-pos">${at + 1} of ${pending.length}</span>
              <button type="button" class="prompt-stack-step" aria-label="Next" onClick=${() => step(1)}>›</button>
            </div>`
          : null
      }
      <div class="prompt-stack-card"><${PromptCard} key=${pending[at].id} prompt=${pending[at]} /></div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Conversation (exported)
// ---------------------------------------------------------------------------

/** Older-page control at the top of the list. Reaching the oldest record is stated explicitly. */
function HistoryPager({ threadId, count, onLoadOlder }) {
  const paging = historyPaging.value[threadId] ?? null;
  if (!threadId || !paging) return null;
  if (paging.indexUnavailable)
    return html`<div class="chat-history-pager" role="status">Older history is not available from this server; showing the rows it returned (${count}).</div>`;
  if (paging.offline)
    return html`<div class="chat-history-pager" role="status">Server history unavailable; showing what this tab holds (${count} rows). Reload when the server is back.</div>`;
  // An empty thread has no conversation to mark the start of.
  if (count === 0 && !paging.hasMore && !paging.error) return null;
  return html`
    <div class="chat-history-pager" role="status">
      ${
        paging.hasMore
          ? html`
        <button class="chat-history-older" type="button" disabled=${paging.loading} onClick=${onLoadOlder}>
          ${paging.loading ? 'Loading older messages…' : `Load older messages (${count} loaded)`}
        </button>
      `
          : html`<span class="chat-history-oldest visually-hidden">Start of conversation${paging.pages > 1 ? ` (${count} messages)` : ''}</span>`
      }
      ${paging.error ? html`<span class="chat-history-error">${paging.error}</span>` : null}
    </div>
  `;
}

/** The centre's tabs, on the band's lower edge. Ids are the store's `activePanel` values. */
const CENTER_TABS = [
  ['conversation', 'Thread', 1],
  ['plan', 'Plan', 2],
  ['graph', 'Loop', 3],
];

function CenterTabs() {
  const current = activePanel.value;
  return html`<div class="center-tab-row"><nav class="center-views band-tabs" role="tablist" aria-label="Center view">
    ${CENTER_TABS.map(
      ([id, label, key]) => html`<button key=${id} role="tab"
        class="center-view ${current === id ? 'center-view--active' : ''}" aria-selected=${current === id}
        title=${`${label} (${key})`}
        onClick=${() => {
          activePanel.value = id;
        }}>${label}</button>`,
    )}
  </nav>
  ${current === 'conversation' ? html`<${ThreadViewSegments} conversation=${threadData.value?.conversation} />` : null}
  </div>`;
}

export function Conversation({ onTraceSelect, onLayerClick }) {
  const view = activePanel.value;
  const msgList = messages.value;
  const scrollRef = useRef(null);
  const threadId = activeThreadId.value;
  const prepend = useRef(null);

  // Auto-scroll only when the newest row changes (new message or streaming text),
  // not when older pages are prepended above.
  const last = msgList.at(-1);
  const newestKey = last
    ? `${last.turnId ?? last.id ?? ''}:${last.actor}:${last.content?.length ?? 0}:${last.streaming ? 1 : 0}`
    : '';
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prepend.current) {
      // Keep the reader's place after older rows arrive above.
      el.scrollTop = prepend.current.top + (el.scrollHeight - prepend.current.height);
      prepend.current = null;
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [newestKey, msgList.length]);

  // A feedback item's provenance link: bring its turn into view once the thread's messages show.
  const focus = focusTurnId.value;
  useEffect(() => {
    if (!focus) return;
    const el = scrollRef.current?.querySelector(`[data-turn-id="${CSS.escape(focus)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('chat-msg--focused');
    setTimeout(() => el.classList.remove('chat-msg--focused'), 2000);
    focusTurnId.value = null;
  }, [focus, msgList.length, threadId]);

  const handleLoadOlder = () => {
    const el = scrollRef.current;
    if (el) prepend.current = { top: el.scrollTop, height: el.scrollHeight };
    loadOlderMessages(threadId);
  };

  const handleTraceClick = (traceId) => {
    // Load trace and show in detail drawer (right pane)
    loadTraceDetail(traceId);
    if (onTraceSelect) onTraceSelect(traceId);
  };

  return html`
    <div class="conversation">
      <header class="center-band">
        <${ContextBar} />
        <${CenterTabs} />
      </header>
      ${
        view === 'plan'
          ? html`<div class="center-frame"><${Plan} /></div>`
          : view === 'graph'
            ? html`<div class="center-frame center-frame--loop"><${LoopView} onLayerClick=${onLayerClick} /></div>`
            : null
      }
      ${
        view === 'conversation'
          ? html`<${AsidesSince} conversation=${threadData.value?.conversation} />`
          : null
      }
      <div class="thread-views ${shownViews().length > 1 ? `thread-views--columns thread-views--${shownViews().length}` : ''}" hidden=${view !== 'conversation'}>
      <div class="chat-messages center-frame" ref=${scrollRef} hidden=${!shownViews().includes('thread')}>
        <${HistoryPager} threadId=${threadId} count=${msgList.length} onLoadOlder=${handleLoadOlder} />
        ${
          msgList.length === 0
            ? html`
          <div class="conv-empty">
            Type a message below to start a conversation.<br/>
            Messages are routed through the agent pipeline.
          </div>
        `
            : null
        }
        ${withSwitchMarkers(
          msgList,
          threadLaunch.value?.threadId === threadId ? threadLaunch.value.switches : null,
          historyPaging.value[threadId]?.hasMore ?? false,
        ).map(({ msg, marker, index: i }) =>
          marker
            ? html`<${WorkerSwitchMarker} key=${`switch:${marker.at}`} marker=${marker} />`
            : msg.actor === 'user'
              ? html`<${UserMessage} key=${msg.turnId ? `${msg.actor}:${msg.turnId}` : (msg.id ?? i)} msg=${msg} index=${i} />`
              : msg.kind === 'thinking'
                ? html`<${ThinkingMessage} key=${msg.id ?? i} msg=${msg} />`
                : html`<${AgentMessage} key=${msg.turnId ? `${msg.actor}:${msg.turnId}` : (msg.id ?? i)} msg=${msg} index=${i}
                  onTraceClick=${handleTraceClick} />`,
        )}
      </div>
      ${shownViews().includes('btw') ? html`<${BtwView} entries=${threadData.value?.conversation?.btw} />` : null}
      ${shownViews().includes('asides') ? html`<${AsidesView} entries=${threadData.value?.conversation?.asides} onPromote=${(aside) => promoteAside(activeThreadId.value, aside.id)} />` : null}
      </div>
      <${SystemStrip} threadId=${threadId} />
      <${ThreadNowStrip} />
      <${PromptList} threadId=${threadId} />
      ${
        threadData.value?.meta?.spawn?.observed
          ? html`<${SubagentRecordNotice} meta=${threadData.value.meta} />`
          : html`<${ChatInput} />`
      }
    </div>
  `;
}
