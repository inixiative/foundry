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
import { Attention, openListRoots, openRoots } from './attention.js';
import { Board, IncomingCard } from './board.js';
import { CommandPalette, HelpOverlay } from './command-palette.js';
import { initComposerFocus } from './composer-focus.js';
import { Conversation } from './conversation.js';
import { DevicePage } from './device-page.js';
import { ExtensionBoundary, safeCall } from './error-boundary.js';
import { disableExtension, initUiExtensions } from './extension-loader.js';
import { FeedbackInbox } from './feedback.js';
import { GlossReview } from './gloss.js';
import { initHotkeys, registerDefaults } from './hotkeys.js';
import { RequestView } from './incoming.js';
import { KnowledgePage } from './knowledge.js';
import { html, render, useEffect, useRef, useState } from './lib.js';
import { loadMachineProfile } from './machine-icons.js';
import { NavRail } from './nav-rail.js';
import { panelColumns, panelFit, RestoreTab } from './panel-sizes.js';
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
import { RunPickers } from './run-picker.js';
import { SearchPage } from './search.js';
import { loadSettings, SettingsPage, settingsConfig } from './settings.js';
import { SectionList } from './slot.js';
import {
  activeCustomView,
  activePanel,
  activeProjectId,
  activeThreadId,
  allThreads,
  boardOpen,
  closeTurnView,
  compactPanel,
  connected,
  currentTrace,
  detailDrawerOpen,
  devicePageId,
  dismissTraceSelection,
  eventCount,
  executeAction,
  feedbackInboxOpen,
  helpOpen,
  incoming,
  incomingOpenId,
  init,
  inspectLayer,
  inspectTarget,
  loadTraces,
  openCustomView,
  openRightTab,
  projectHomeOpen,
  projectPage,
  projectSidebarOpen,
  projects,
  RIGHT_TAB_KEYS,
  RIGHT_TAB_LABELS,
  RIGHT_TABS,
  railView,
  resyncStreams,
  scopeOfThread,
  scopeProjectId,
  selectedEvent,
  selectedSpanId,
  showThreadsWorkspace,
  showThreadView,
  toggleBoard,
  toggleGraphPanel,
  toggleWatchtower,
  turnViewTarget,
  watchtowerOpen,
} from './store.js';
import { ThreadAgentsModals } from './thread-agents.js';
import { SystemToast } from './toast.js';
import { getMainViews, registerBuiltinMainView } from './ui-registry.js';
import { UpdateNotice } from './update-notice.js';
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
registerBuiltinMainView({ id: 'threads', label: 'Threads', key: 't', scope: 'workspace' });
registerBuiltinMainView({ id: 'board', label: 'Board', key: 'b', scope: 'workspace' });
registerBuiltinMainView({ id: 'watchtower', label: 'Watchtower', key: 'h', scope: 'workspace' });

/**
 * Threads · Board · Watchtower (plus any extension workspace views): one segmented switch with its keys.
 * The Board carries the orange and red counts (attention.js), top-level threads only.
 */
function WorkspaceSwitch() {
  const board = boardOpen.value;
  const tower = watchtowerOpen.value;
  const customView = activeCustomView.value;
  const views = getMainViews('workspace');
  const ctx = { activeThreadId: activeThreadId.value, activeProjectId: activeProjectId.value };
  return html`<span class="ws-seg" role="group" aria-label="Workspace view">
    ${views.map((view) => {
      if (view.id === 'threads') {
        const active = !board && !tower && !customView;
        return html`<button key="threads" type="button" class=${active ? 'is-active' : ''} title="Threads (t)"
          onClick=${showThreadsWorkspace}>${view.label}<kbd>T</kbd></button>`;
      }
      if (view.id === 'board') {
        return html`<button key="board" type="button" class="board-button ${board ? 'is-active' : ''}" title="The attention board (b)"
          onClick=${toggleBoard}>${view.label}<${Attention} nodes=${openRoots()} /><kbd>B</kbd></button>`;
      }
      if (view.id === 'watchtower') {
        return html`<button key="watchtower" type="button" class="watchtower-button ${tower ? 'is-active' : ''}" title="Watchtower: work by stage (h)"
          onClick=${toggleWatchtower}>${view.label}<kbd>H</kbd></button>`;
      }
      const badge =
        typeof view.badge === 'function'
          ? safeCall(view.extId, () => view.badge(ctx), null, 'mainView.badge')
          : null;
      return html`<button key=${view.id} type="button" class="ws-custom-button ${customView === view.id ? 'is-active' : ''}"
        data-view-id=${view.id}
        title=${view.key ? `${view.label} (${view.key})` : view.label}
        onClick=${() => openCustomView(view.id)}>${view.label}${badge ? html` <span class="ws-custom-badge">${badge}</span>` : null}${view.key ? html`<kbd>${view.key.toUpperCase()}</kbd>` : null}</button>`;
    })}
  </span>`;
}

/**
 * Open N: the Open list's threads (scheduled runs live under Scheduled), with the orange and red
 * counts over every open thread, runs included; it shows the Open list.
 */
function OpenPill() {
  const roots = openListRoots();
  return html`<button type="button" class="top-pill open-pill header-item--keep header-item--keep-sm" title="Your open threads"
    onClick=${() => {
      railView.value = 'open';
      showThreadsWorkspace();
    }}><span class="top-pill-dot"></span>Open<span class="top-pill-count">${roots.length}</span><${Attention} nodes=${openRoots()} /></button>`;
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
    return html`<a class="top-pill header-div-before" href=${settingsPath(null, 'kingdom')} onClick=${onLink}>${KINGDOM_ICON}Connect to Kingdom</a>`;
  return html`<a class="top-pill header-div-before" href=${`${new URL(url).origin}/dashboard`} target="_blank" rel="noopener" title="Open Kingdom in a new window">${KINGDOM_ICON}Kingdom</a>`;
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
  return html`<div class="incoming-anchor header-div-before" ref=${ref} onKeyDown=${(e) => {
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
  const headerCtx = { page: route.value.page, connected: isConnected, eventCount: count };

  const leftItems = [
    {
      id: 'brand',
      render: () =>
        html`<span class="header-brand">Foundry<span class="header-brand-dot">.</span></span>`,
    },
    { id: 'page-nav', render: () => html`<${PageNav} />` },
    { id: 'search', render: () => html`<${SearchButton} />` },
  ];

  const centerItems = [
    {
      id: 'workspace-switch',
      render: () => (route.value.page === 'workspace' ? html`<${WorkspaceSwitch} />` : null),
    },
  ];

  const rightItems = [
    { id: 'update-notice', render: () => html`<${UpdateNotice} />` },
    { id: 'open-pill', render: () => html`<${OpenPill} />` },
    { id: 'incoming', render: () => html`<${IncomingIndicator} />` },
    { id: 'kingdom', render: () => html`<${KingdomPill} />` },
    {
      id: 'connection',
      render: () => html`
        <span class="status-dot ${isConnected ? 'on' : 'off'}" title=${`${isConnected ? 'Connected to this Foundry' : 'Reconnecting'} · ${count} events · ⌘K commands`} aria-label=${isConnected ? 'Connected' : 'Reconnecting'}></span>
        ${isConnected ? null : html`<span class="status-text">reconnecting…</span>`}
      `,
    },
    {
      id: 'help',
      render: () =>
        html`<button class="help-btn" aria-label="Help" title="Help (?)" onClick=${() => {
          helpOpen.value = !helpOpen.value;
        }}>?</button>`,
    },
  ];

  return html`
    <div class="header">
      <div class="header-left">
        <${SectionList} slot="header.left" items=${leftItems} context=${headerCtx} />
      </div>
      <div class="header-center">
        <${SectionList} slot="header.center" items=${centerItems} context=${headerCtx} />
      </div>
      <div class="header-right">
        <${SectionList} slot="header.right" items=${rightItems} context=${headerCtx} />
      </div>
    </div>
  `;
}

// The left rail (its own Attention · Open · Projects toggle) is the one Threads tab.
const panelViews = [
  ['projects', 'Threads'],
  ['conversation', 'Chat'],
  ['detail', 'Inspect'],
];

function PanelNavigation() {
  const views = panelViews;
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
// App
// ---------------------------------------------------------------------------

/**
 * The Feedback scope's centre: the inbox (every project's items) beside the open Feedback thread,
 * so the person and the agent work the same items side by side; the inbox alone until a Feedback
 * thread is open.
 */
function FeedbackScope({ onSpanSelect, onLayerClick }) {
  // The rail may list every thread (Attention, Open); only a Feedback thread opens beside the inbox.
  const open = allThreads.value.find((t) => t.threadId === activeThreadId.value);
  const hasThread = scopeOfThread(open) === '@feedback';
  return html`<div class=${`feedback-scope${hasThread ? ' feedback-scope--thread' : ''}`}>
    <div class="feedback-scope-inbox"><${FeedbackInbox} /></div>
    ${hasThread ? html`<div class="feedback-scope-thread"><${Conversation} onSpanSelect=${onSpanSelect} onLayerClick=${onLayerClick} /></div>` : null}
  </div>`;
}

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
      showThread: showThreadView,
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
        if (turnViewTarget.value) {
          closeTurnView();
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
      rightTabKeys: Object.fromEntries(
        RIGHT_TABS.filter((t) => RIGHT_TAB_KEYS[t]).map((t) => [t, RIGHT_TAB_KEYS[t]]),
      ),
      rightTabLabels: RIGHT_TAB_LABELS,
      showRightTab: (tab) => openRightTab(tab, { toggle: true }),
    });
    initHotkeys();
    initComposerFocus();
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
  const inbox = feedbackInboxOpen.value;
  const page = route.value.page;
  const customViewId = activeCustomView.value;
  const customViewDef = customViewId
    ? getMainViews('workspace').find((v) => v.extId && v.id === customViewId)
    : null;
  const fullWidthView =
    boardOpen.value ||
    watchtowerOpen.value ||
    Boolean(customViewDef && customViewDef.fullWidth !== false);

  const panelClass = `panels panels--proj-${projOpen ? 'open' : 'closed'} panels--detail-${detailOpen ? 'open' : 'closed'}${fullWidthView ? ' panels--board' : ''}${panelFit.value.leftFolded ? ' panels--left-folded' : ''}`;

  if (page !== 'workspace')
    return html`
      <div class="app">
        <${Header} />
        ${page === 'settings' ? html`<${SettingsPage} />` : page === 'search' ? html`<${SearchPage} />` : html`<${AnalyticsPage} />`}
        <${CommandPalette} />
        <${HelpOverlay} />
        <${Wizard} />
        <${SystemToast} />
      </div>
    `;

  return html`
    <div class="app">
      <${Header} />
      <${PanelNavigation} />

      <div class=${panelClass} data-compact-panel=${compactPanel.value}
        style=${fullWidthView ? '' : `grid-template-columns: ${panelColumns()}`}>
        <${RestoreTab} side="left" />
        <${RestoreTab} side="right" />
        <!-- Left: navigation — pinned scopes, projects, the selected scope's threads (collapsible) -->
        <div class="panel-projects" id="workspace-projects" tabIndex="0">
          <${NavRail} />
        </div>

        <!-- Center: Conversation / trace timeline, or the graph panel -->
        <div class="panel-center" id="workspace-conversation" tabIndex="0">
          ${
            // A board, the Watchtower, a custom workspace view or an open request is chosen on purpose, so it shows over the
            // Feedback scope: on the Attention rail an open Feedback thread puts the workspace there.
            incomingOpenId.value && incoming.value.some((r) => r.id === incomingOpenId.value)
              ? html`<${RequestView} />`
              : customViewDef
                ? html`<${ExtensionBoundary}
                    key=${customViewDef.id}
                    extId=${customViewDef.extId}
                    slot="workspace.views"
                    onDisable=${disableExtension}
                    render=${customViewDef.render}
                    ctx=${{ activeThreadId: activeThreadId.value, activeProjectId: activeProjectId.value }}
                  />`
                : watchtowerOpen.value
                  ? html`<${Watchtower} />`
                  : boardOpen.value
                    ? html`<${Board} />`
                    : inbox
                      ? html`<${FeedbackScope} onSpanSelect=${handleSpanSelect} onLayerClick=${inspectLayer} />`
                      : projectHomeOpen.value
                        ? projectPage.value === 'device' && devicePageId.value
                          ? html`<${DevicePage} key=${devicePageId.value} deviceId=${devicePageId.value} />`
                          : projectPage.value === 'knowledge' && activeProjectId.value
                            ? html`<${KnowledgePage} key=${activeProjectId.value} />`
                            : html`<${ProjectHome} key=${activeProjectId.value ?? 'global'} />`
                        : activePanel.value === 'feedback'
                          ? html`<${FeedbackInbox} key=${scopeProjectId() ?? 'global'} projectId=${scopeProjectId()} />`
                          : html`<${Conversation} onSpanSelect=${handleSpanSelect} onLayerClick=${inspectLayer} />`
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
      <${SystemToast} />
      <${GlossReview} />
      <${RunPickers} />
      <${ThreadAgentsModals} />
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

init();
initUiExtensions(settingsConfig);
loadSettings();
render(html`<${App} />`, document.getElementById('root'));
