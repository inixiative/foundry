/**
 * Foundry Viewer — main app shell.
 * Workspace: projects | threads | conversation | detail drawer.
 * Settings and analytics are pages beside it (ui/route.js).
 */

import { AnalyticsPage } from './analytics.js';
import { CommandPalette, HelpOverlay } from './command-palette.js';
import { Conversation } from './conversation.js';
import { DetailDrawer } from './detail-drawer.js';
import { GlossButton, GlossReview } from './gloss.js';
import { GraphPanel } from './graph-view.js';
import { initHotkeys, registerDefaults } from './hotkeys.js';
import { html, render, useEffect, useState } from './lib.js';
import { ProjectSidebar } from './project-sidebar.js';
import { analyticsPath, navigate, onLink, route, settingsPath } from './route.js';
import { SelfChatPane } from './self-chat.js';
import { loadSettings, SettingsPage, settingsConfig } from './settings.js';
import {
  activePanel,
  activeProjectId,
  compactPanel,
  connected,
  currentTrace,
  detailDrawerOpen,
  dismissToast,
  dismissTraceSelection,
  eventCount,
  executeAction,
  forgeMasterOpen,
  init,
  loadTraces,
  projectSidebarOpen,
  projects,
  resyncStreams,
  selectedEvent,
  selectedSpanId,
  toast,
  toggleGraphPanel,
} from './store.js';
import { Sidebar } from './thread-tree.js';
import { checkSetupNeeded, Wizard, wizardOpen } from './wizard.js';

// ---------------------------------------------------------------------------
// Header — slim: logo + connection status + hints
// ---------------------------------------------------------------------------

/** The scope the workspace is showing: a project, or Foundry itself (Global and Forge Master). */
const workspaceProject = () => (forgeMasterOpen.value ? null : activeProjectId.value);

function PageNav() {
  const { page, projectId } = route.value;
  const scope = page === 'workspace' ? workspaceProject() : projectId;
  const scopeLabel = scope ? projects.value.find((p) => p.id === scope)?.label || scope : 'Foundry';
  const link = (href, label, current) =>
    html`<a href=${href} aria-current=${current ? 'page' : undefined} onClick=${onLink}>${label}</a>`;
  return html`<nav class="page-nav" aria-label="Pages">
    ${link('/', 'Workspace', page === 'workspace')}
    ${link(settingsPath(scope), 'Settings', page === 'settings')}
    ${link(analyticsPath(scope), 'Analytics', page === 'analytics')}
    ${page === 'workspace' ? html`<span class="page-nav-scope">${scopeLabel}</span>` : null}
  </nav>`;
}

function Header() {
  const isConnected = connected.value;
  const count = eventCount.value;

  return html`
    <div class="header">
      <span class="header-logo"><span class="logo-bracket">${'<'}</span><span class="logo-mark">iXi</span><span class="logo-bracket">${'>'}</span></span>
      <span class="header-title">foundry</span>
      <${PageNav} />
      <div class="header-right">
        <${GlossButton} projectId=${activeProjectId.value} />
        <a class="action-btn" href=${settingsPath(null, 'kingdom')} onClick=${onLink}>${settingsConfig.value?.kingdomIntegrations?.length ? 'Kingdom' : 'Connect to Kingdom'}</a>
        <span class="status-dot ${isConnected ? 'on' : 'off'}"></span>
        <span class="status-text">${isConnected ? 'connected' : 'reconnecting...'}</span>
        <span class="status-sep">|</span>
        <span class="status-text">${count} events</span>
        <span class="status-sep">|</span>
        <kbd class="status-key">Ctrl+K</kbd>
        <span class="status-text dim">commands</span>
        <kbd class="status-key">?</kbd>
        <span class="status-text dim">help</span>
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
  // Forge Master has no thread list or thread detail.
  const views = forgeMasterOpen.value
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

// Center panel mode: the conversation, or graphs of the structures behind it.
function CenterViews() {
  const current = activePanel.value === 'graph' ? 'graph' : 'conversation';
  return html`<div class="center-views" role="tablist" aria-label="Center view">
    ${[
      ['conversation', 'Chat'],
      ['graph', 'Graph'],
    ].map(
      ([id, label]) => html`<button key=${id} role="tab"
      class="center-view ${current === id ? 'center-view--active' : ''}" aria-selected=${current === id}
      title=${id === 'graph' ? 'Threads, turn flow and learning loops (g)' : 'Conversation'}
      onClick=${() => {
        activePanel.value = id;
      }}>${label}</button>`,
    )}
  </div>`;
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
  const [selectedSpan, setSelectedSpan] = useState(null);
  const [selectedLayer, setSelectedLayer] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState(null);
  // "layer" | "agent" | null — when set, detail drawer shows creation form
  const [creating, setCreating] = useState(null);

  const clearSelection = () => {
    selectedEvent.value = null;
    setSelectedSpan(null);
    setSelectedLayer(null);
    setSelectedAgent(null);
    setCreating(null);
  };

  const handleSpanSelect = (span) => {
    clearSelection();
    setSelectedSpan(span);
    detailDrawerOpen.value = true;
    compactPanel.value = 'detail';
  };

  const handleLayerClick = (layerId) => {
    clearSelection();
    dismissTraceSelection();
    selectedSpanId.value = null;
    setSelectedLayer(layerId);
    detailDrawerOpen.value = true;
    compactPanel.value = 'detail';
  };

  const handleAgentClick = (agentId) => {
    clearSelection();
    dismissTraceSelection();
    selectedSpanId.value = null;
    setSelectedAgent(agentId);
    detailDrawerOpen.value = true;
    compactPanel.value = 'detail';
  };

  const handleCreateLayer = () => {
    clearSelection();
    setCreating('layer');
    detailDrawerOpen.value = true;
    compactPanel.value = 'detail';
  };

  const handleCreateAgent = () => {
    clearSelection();
    setCreating('agent');
    detailDrawerOpen.value = true;
    compactPanel.value = 'detail';
  };

  const handleCreated = () => {
    setCreating(null);
  };

  // Register hotkey actions
  useEffect(() => {
    registerDefaults({
      focusTree: () => document.querySelector('.sidebar')?.focus(),
      focusConversation: () => document.querySelector('.conversation')?.focus(),
      focusDetail: () => document.querySelector('.detail-drawer')?.focus(),
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
        clearSelection();
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
        navigate(route.value.page === 'settings' ? '/' : settingsPath(workspaceProject())),
      openAnalytics: () =>
        navigate(route.value.page === 'analytics' ? '/' : analyticsPath(workspaceProject())),
      toggleLayers: () => {},
      toggleEvents: () => {},
      toggleGraph: toggleGraphPanel,
    });
    initHotkeys();
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
  const page = route.value.page;

  const panelClass = `panels panels--proj-${projOpen ? 'open' : 'closed'} panels--detail-${detailOpen ? 'open' : 'closed'}${forge ? ' panels--forge' : ''}`;

  if (page !== 'workspace')
    return html`
      <div class="app">
        <${Header} />
        ${page === 'settings' ? html`<${SettingsPage} />` : html`<${AnalyticsPage} />`}
        <${CommandPalette} />
        <${HelpOverlay} />
        <${Toast} />
      </div>
    `;

  return html`
    <div class="app">
      <${Header} />
      <${PanelNavigation} />

      <div class=${panelClass} data-compact-panel=${compactPanel.value}>
        <!-- Far left: Project sidebar (collapsible) -->
        <div class="panel-projects" id="workspace-projects" tabIndex="0">
          <${ProjectSidebar} />
        </div>

        <!-- Left: Thread/Layer/Agent sidebar -->
        <div class="panel-left" id="workspace-threads" tabIndex="0">
          <${Sidebar}
            onLayerClick=${handleLayerClick}
            onAgentClick=${handleAgentClick}
            onCreateLayer=${handleCreateLayer}
            onCreateAgent=${handleCreateAgent}
          />
        </div>

        <!-- Center: Conversation / trace timeline, or the graph panel -->
        <div class="panel-center" id="workspace-conversation" tabIndex="0">
          ${
            forge
              ? html`<div class="forge-master"><${SelfChatPane} docked=${false} /></div>`
              : html`
            <${CenterViews} />
            ${
              activePanel.value === 'graph'
                ? html`<${GraphPanel} onLayerClick=${handleLayerClick} />`
                : html`<${Conversation} onSpanSelect=${handleSpanSelect} onLayerClick=${handleLayerClick} />`
            }
          `
          }
        </div>

        <!-- Right: Detail drawer -->
        <div class="panel-right" id="workspace-detail" tabIndex="0">
          <${DetailDrawer}
            selectedSpan=${selectedSpan}
            selectedLayer=${selectedLayer}
            selectedAgent=${selectedAgent}
            creating=${creating}
            onCreated=${handleCreated}
          />
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
