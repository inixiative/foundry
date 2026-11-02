/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:viewer
 */
/**
 * Foundry Viewer — main app shell.
 * Workspace: navigation (pinned scopes, projects, the scope's threads) | conversation | detail drawer.
 * Settings and analytics are pages beside it (ui/route.js).
 */

import { AnalyticsPage } from './analytics.js';
import { Attention, openRoots } from './attention.js';
import { Board, IncomingCard } from './board.js';
import { CommandPalette, HelpOverlay } from './command-palette.js';
import { Conversation } from './conversation.js';
import { FeedbackInbox } from './feedback.js';
import { GlossReview } from './gloss.js';
import { initHotkeys, registerDefaults } from './hotkeys.js';
import { RequestView } from './incoming.js';
import { KnowledgePage } from './knowledge.js';
import { html, render, useEffect, useRef, useState } from './lib.js';
import { loadMachineProfile } from './machine-icons.js';
import { NavRail } from './nav-rail.js';
import { panelColumns, RestoreTab } from './panel-sizes.js';
import { ProjectHome } from './project-home.js';
import { RightPanel } from './right-panel.js';
import {
  analyticsPath,
  closeSearch,
  navigate,
  onLink,
  openSearch,
  route,
  settingsPath,
} from './route.js';
import { SearchPage } from './search.js';
import { SelfChatPane } from './self-chat.js';
import { loadSettings, SettingsPage, settingsConfig } from './settings.js';
import {
  activePanel,
  activeProjectId,
  boardOpen,
  CENTER_PANELS,
  compactPanel,
  connected,
  currentTrace,
  detailDrawerOpen,
  dismissToast,
  dismissTraceSelection,
  eventCount,
  executeAction,
  feedbackInboxOpen,
  forgeMasterOpen,
  helpOpen,
  incoming,
  incomingOpenId,
  init,
  inspectLayer,
  inspectTarget,
  loadTraces,
  projectHomeOpen,
  projectPage,
  projectSidebarOpen,
  projects,
  RIGHT_TABS,
  railView,
  resyncStreams,
  rightTab,
  scopeProjectId,
  selectedEvent,
  selectedSpanId,
  toast,
  toggleBoard,
  toggleGraphPanel,
  toggleWatchtower,
  watchtowerOpen,
} from './store.js';
import { Watchtower } from './watchtower.js';
import { checkSetupNeeded, Wizard, wizardOpen } from './wizard.js';

// ---------------------------------------------------------------------------
// Header — slim: logo + connection status + hints
// ---------------------------------------------------------------------------

function PageNav() {
  const { page } = route.value;
  const scope = scopeProjectId();
  const link = (href, label, current) =>
    html`<a href=${href} aria-current=${current ? 'page' : undefined} onClick=${onLink}>${label}</a>`;
  return html`<nav class="page-nav" aria-label="Pages">
    ${link('/', 'Workspace', page === 'workspace')}
    ${link(settingsPath(scope), 'Settings', page === 'settings')}
    ${link(analyticsPath(scope), 'Analytics', page === 'analytics')}
  </nav>`;
}

/** Search, beside the pages: icon-only on narrow screens; / opens it too. */
function SearchButton() {
  const open = route.value.page === 'search';
  return html`<button type="button" class="search-button ${open ? 'is-active' : ''}" title="Search everything (/)" aria-label="Search"
    onClick=${openSearch}>⌕<span class="search-button-label"> Search</span><kbd>/</kbd></button>`;
}

/** The selected scope, centered in the header: a project's name, else Global / Forge Master / Feedback (or Foundry off the workspace). */
/**
 * Threads · Board · Watchtower: one segmented switch with its keys (concept-v4). The Board carries
 * the orange and red counts (attention.js), top-level threads only.
 */
function WorkspaceSwitch() {
  const board = boardOpen.value;
  const tower = watchtowerOpen.value;
  return html`<span class="ws-seg" role="group" aria-label="Workspace view">
    <button type="button" class=${!board && !tower ? 'is-active' : ''} title="Threads (t)"
      onClick=${() => {
        boardOpen.value = false;
        watchtowerOpen.value = false;
      }}>Threads<kbd>T</kbd></button>
    <button type="button" class="board-button ${board ? 'is-active' : ''}" title="The attention board (b)"
      onClick=${toggleBoard}>Board<${Attention} nodes=${openRoots()} /><kbd>B</kbd></button>
    <button type="button" class="watchtower-button ${tower ? 'is-active' : ''}" title="Watchtower: work by stage (h)"
      onClick=${toggleWatchtower}>Watchtower<kbd>H</kbd></button>
  </span>`;
}

/** Open N: every open top-level thread, with the orange and red counts; it shows the Open list. */
function OpenPill() {
  const roots = openRoots();
  return html`<button type="button" class="top-pill open-pill" title="Your open threads"
    onClick=${() => {
      railView.value = 'open';
      boardOpen.value = false;
      watchtowerOpen.value = false;
    }}><span class="top-pill-dot"></span>Open<span class="top-pill-count">${roots.length}</span><${Attention} nodes=${roots} /></button>`;
}

/**
 * Requests to join, waiting in Kingdom: a separate mark from the Board count, since none is accepted
 * yet. It opens a popover under itself (outside click or Esc closes it); the Board keeps its band.
 */
/** Solid pill icons, the same cut-out family as the status icons. */
const INCOMING_ICON = html`<svg class="pill-glyph" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="3.6" fill="currentColor"/><path d="M8 3.6v5.2M5.6 6.6 8 9l2.4-2.4" fill="none" stroke="hsl(var(--background))" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.6 10.4h2.2l.8 1.4h2.8l.8-1.4h2.2" fill="none" stroke="hsl(var(--background))" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const KINGDOM_ICON = html`<svg class="pill-glyph" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="3.6" fill="currentColor"/><path d="M6.6 4.4h5v5" fill="none" stroke="hsl(var(--background))" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.4 4.6 4.6 11.4" fill="none" stroke="hsl(var(--background))" stroke-width="1.7" stroke-linecap="round"/></svg>`;

/** The Kingdom this Foundry is paired with, opened in a new window; unpaired, the link to pair one. */
function KingdomPill() {
  const kingdoms = settingsConfig.value?.kingdomIntegrations ?? [];
  const url = kingdoms.find((k) => k?.url)?.url;
  if (!kingdoms.length || !url)
    return html`<a class="top-pill" href=${settingsPath(null, 'kingdom')} onClick=${onLink}>${KINGDOM_ICON}Connect to Kingdom</a>`;
  return html`<a class="top-pill" href=${`${new URL(url).origin}/dashboard`} target="_blank" rel="noopener" title="Open Kingdom in a new window">${KINGDOM_ICON}Kingdom</a>`;
}

function IncomingIndicator() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onEscape = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);
  const requests = incoming.value;
  if (!requests.length) return null;
  const count = requests.length;
  // Esc is handled on the anchor too: focus is on its button after the click, so the first key
  // works even before the document listener above is attached.
  return html`<div class="incoming-anchor" ref=${ref} onKeyDown=${(e) => {
    if (e.key === 'Escape') setOpen(false);
  }}>
    <button class="incoming-indicator top-pill" aria-expanded=${open} aria-haspopup="dialog"
      title=${`${count} request${count === 1 ? '' : 's'} to join, not yet accepted`}
      onClick=${() => setOpen(!open)}>${INCOMING_ICON}Incoming <span class="incoming-indicator-count">${count}</span></button>
    ${
      open
        ? html`<div class="incoming-popover" role="dialog" aria-label="Incoming requests">
            ${requests.map((r) => html`<${IncomingCard} key=${r.id} request=${r} />`)}
          </div>`
        : null
    }
  </div>`;
}

function Header() {
  const isConnected = connected.value;
  const count = eventCount.value;

  return html`
    <div class="header">
      <div class="header-left">
        <span class="header-brand">Foundry<span class="header-brand-dot">.</span></span>
        <${PageNav} /><${SearchButton} />
      </div>
      <div class="header-center">
        ${route.value.page === 'workspace' ? html`<${WorkspaceSwitch} />` : null}
      </div>
      <div class="header-right">
        <${OpenPill} />
        <span class="header-divider"></span>
        <${IncomingIndicator} />
        <span class="header-divider"></span>
        <${KingdomPill} />
        <span class="status-dot ${isConnected ? 'on' : 'off'}" title=${`${isConnected ? 'Connected' : 'Reconnecting'} · ${count} events · ⌘K commands`}></span>
        <span class="status-text">${isConnected ? 'connected' : 'reconnecting...'}</span>
        <button class="help-btn" aria-label="Help" title="Help (?)" onClick=${() => {
          helpOpen.value = !helpOpen.value;
        }}>?</button>
      </div>
    </div>
  `;
}

const panelViews = [
  ['projects', 'Projects'],
  ['threads', 'Threads'],
  ['conversation', 'Chat'],
  ['detail', 'Inspect'],
];

function PanelNavigation() {
  // Forge Master and the Feedback inbox have no thread list or thread detail.
  const views =
    forgeMasterOpen.value || feedbackInboxOpen.value
      ? panelViews.filter(([id]) => id === 'projects' || id === 'conversation')
      : panelViews;
  const select = (id) => {
    if (id === 'projects') projectSidebarOpen.value = true;
    if (id === 'detail') detailDrawerOpen.value = true;
    compactPanel.value = id;
  };
  const onKeyDown = (event, index) => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % views.length;
    if (event.key === 'ArrowLeft') next = (index + views.length - 1) % views.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = views.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    select(views[next][0]);
    event.currentTarget.parentElement.children[next].focus();
  };
  return html`<nav class="panel-navigation" role="tablist" aria-label="Workspace views">
    ${views.map(
      ([id, label], index) => html`<button key=${id} role="tab"
      aria-selected=${compactPanel.value === id} aria-controls=${`workspace-${id}`}
      tabIndex=${compactPanel.value === id ? 0 : -1}
      onKeyDown=${(event) => onKeyDown(event, index)}
      onClick=${() => select(id)}>${label}</button>`,
    )}
  </nav>`;
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function Toast() {
  const t = toast.value;
  if (!t) return null;
  return html`
    <div class="toast ${t.type} ${t.persistent ? 'toast--persistent' : ''}">
      <span class="toast-message">${t.message}</span>
      ${
        t.undo
          ? html`<button class="toast-undo" onClick=${() => {
              dismissToast();
              t.undo();
            }}>Undo</button>`
          : null
      }
      ${
        t.persistent &&
        html`
        <button class="toast-dismiss" onClick=${dismissToast} aria-label="Dismiss">\u00d7</button>
      `
      }
    </div>
  `;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const handleSpanSelect = (span) => {
    selectedEvent.value = null;
    inspectTarget.value = null;
    selectedSpanId.value = span?.id ?? null;
    detailDrawerOpen.value = true;
    compactPanel.value = 'detail';
  };

  useEffect(() => {
    registerDefaults({
      centerTabs: ['Thread', 'Plan', 'Loop'],
      showCenterTab: (i) => {
        activePanel.value = CENTER_PANELS[i];
      },
      nextItem: () => {
        /* TODO: span navigation */
      },
      prevItem: () => {
        /* TODO: span navigation */
      },
      expandItem: () => {
        /* TODO: expand selected */
      },
      escape: () => {
        if (route.value.page === 'search') {
          closeSearch();
          return;
        }
        if (projectHomeOpen.value && projectPage.value === 'knowledge') {
          projectPage.value = 'home';
          return;
        }
        selectedEvent.value = null;
        inspectTarget.value = null;
        selectedSpanId.value = null;
      },
      togglePause: () => executeAction('thread:pause'),
      inspect: () => executeAction('thread:inspect'),
      override: () => {
        /* TODO: open override form */
      },
      refresh: () => {
        loadTraces();
        resyncStreams();
      },
      openSettings: () =>
        navigate(route.value.page === 'settings' ? '/' : settingsPath(scopeProjectId())),
      openAnalytics: () =>
        navigate(route.value.page === 'analytics' ? '/' : analyticsPath(scopeProjectId())),
      toggleLayers: () => {},
      toggleEvents: () => {},
      toggleGraph: toggleGraphPanel,
      toggleBoard,
      toggleWatchtower,
      toggleRightPanel: () => {
        detailDrawerOpen.value = !detailDrawerOpen.value;
      },
      rightTabs: RIGHT_TABS.map((t) => t[0].toUpperCase() + t.slice(1)),
      showRightTab: (i) => {
        rightTab.value = RIGHT_TABS[i];
        detailDrawerOpen.value = true;
      },
    });
    initHotkeys();
    loadMachineProfile();
  }, []);

  // Check if first-run wizard is needed
  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((config) => {
        checkSetupNeeded(config);
      })
      .catch(() => {});
  }, []);

  const projOpen = projectSidebarOpen.value;
  const detailOpen = detailDrawerOpen.value;
  const forge = forgeMasterOpen.value;
  const inbox = feedbackInboxOpen.value;
  const page = route.value.page;

  const panelClass = `panels panels--proj-${projOpen ? 'open' : 'closed'} panels--detail-${detailOpen ? 'open' : 'closed'}${forge || inbox ? ' panels--forge' : ''}${boardOpen.value || watchtowerOpen.value ? ' panels--board' : ''}`;

  if (page !== 'workspace')
    return html`
      <div class="app">
        <${Header} />
        ${page === 'settings' ? html`<${SettingsPage} />` : page === 'search' ? html`<${SearchPage} />` : html`<${AnalyticsPage} />`}
        <${CommandPalette} />
        <${HelpOverlay} />
        <${Wizard} />
        <${Toast} />
      </div>
    `;

  return html`
    <div class="app">
      <${Header} />
      <${PanelNavigation} />

      <div class=${panelClass} data-compact-panel=${compactPanel.value}
        style=${boardOpen.value || watchtowerOpen.value ? '' : `grid-template-columns: ${panelColumns({ forge: forge || inbox })}`}>
        <${RestoreTab} side="left" />
        <${RestoreTab} side="right" />
        <!-- Left: navigation — pinned scopes, projects, the selected scope's threads (collapsible) -->
        <div class="panel-projects" id="workspace-projects" tabIndex="0">
          <${NavRail} />
        </div>

        <!-- Center: Conversation / trace timeline, or the graph panel -->
        <div class="panel-center" id="workspace-conversation" tabIndex="0">
          ${
            forge
              ? html`<div class="forge-master"><${SelfChatPane} docked=${false} /></div>`
              : inbox
                ? html`<${FeedbackInbox} />`
                : html`
            ${
              incomingOpenId.value && incoming.value.some((r) => r.id === incomingOpenId.value)
                ? html`<${RequestView} />`
                : watchtowerOpen.value
                  ? html`<${Watchtower} />`
                  : boardOpen.value
                    ? html`<${Board} />`
                    : projectHomeOpen.value
                      ? projectPage.value === 'knowledge' && activeProjectId.value
                        ? html`<${KnowledgePage} key=${activeProjectId.value} />`
                        : html`<${ProjectHome} key=${activeProjectId.value ?? 'global'} />`
                      : activePanel.value === 'feedback'
                        ? html`<${FeedbackInbox} key=${scopeProjectId() ?? 'global'} projectId=${scopeProjectId()} />`
                        : html`<${Conversation} onSpanSelect=${handleSpanSelect} onLayerClick=${inspectLayer} />`
            }
          `
          }
        </div>

        <!-- Right: reference about the thread, or the inspector -->
        <div class="panel-right" id="workspace-detail" tabIndex="0">
          <${RightPanel} onSpanSelect=${handleSpanSelect} />
        </div>
      </div>

      <!-- Overlays -->
      <${CommandPalette} />
      <${HelpOverlay} />
      <${Wizard} />
      <${Toast} />
      <${GlossReview} />
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

init();
loadSettings();
render(html`<${App} />`, document.getElementById('root'));
