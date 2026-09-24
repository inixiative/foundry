/**
 * Foundry Viewer — main app shell.
 * Three-panel layout: sidebar | conversation | detail drawer.
 */

import { html, render, useState, useEffect } from "./lib.js";
import {
  init, connected, eventCount, toast, currentTrace, selectedEvent, dismissTraceSelection,
  selectedSpanId, loadTraces, loadThreads, executeAction,
  projectSidebarOpen, detailDrawerOpen, compactPanel, dismissToast,
} from "./store.js";
import { initHotkeys, registerDefaults } from "./hotkeys.js";
import { ProjectSidebar } from "./project-sidebar.js";
import { Sidebar } from "./thread-tree.js";
import { Conversation } from "./conversation.js";
import { DetailDrawer } from "./detail-drawer.js";
import { CommandPalette, HelpOverlay } from "./command-palette.js";
import { Settings, settingsOpen, settingsConfig, loadSettings } from "./settings.js";
import { Analytics, analyticsOpen } from "./analytics.js";
import { Wizard, wizardOpen, checkSetupNeeded } from "./wizard.js";

// ---------------------------------------------------------------------------
// Header — slim: logo + connection status + hints
// ---------------------------------------------------------------------------

function Header() {
  const isConnected = connected.value;
  const count = eventCount.value;

  return html`
    <div class="header">
      <span class="header-logo"><span class="logo-bracket">${"<"}</span><span class="logo-mark">iXi</span><span class="logo-bracket">${">"}</span></span>
      <span class="header-title">foundry</span>
      <div class="header-right">
        <a class="action-btn" href="/kingdom">${settingsConfig.value?.kingdomRuntime ? "Kingdom" : "Connect to Kingdom"}</a>
        <span class="status-dot ${isConnected ? "on" : "off"}"></span>
        <span class="status-text">${isConnected ? "connected" : "reconnecting..."}</span>
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

const panelViews = [["projects", "Projects"], ["threads", "Threads"],
  ["conversation", "Chat"], ["detail", "Inspect"]];

function PanelNavigation() {
  const select = (id) => {
    if (id === "projects") projectSidebarOpen.value = true;
    if (id === "detail") detailDrawerOpen.value = true;
    compactPanel.value = id;
  };
  const onKeyDown = (event, index) => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % panelViews.length;
    if (event.key === "ArrowLeft") next = (index + panelViews.length - 1) % panelViews.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = panelViews.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    select(panelViews[next][0]);
    event.currentTarget.parentElement.children[next].focus();
  };
  return html`<nav class="panel-navigation" role="tablist" aria-label="Workspace views">
    ${panelViews.map(([id, label], index) => html`<button key=${id} role="tab"
      aria-selected=${compactPanel.value === id} aria-controls=${`workspace-${id}`}
      tabIndex=${compactPanel.value === id ? 0 : -1}
      onKeyDown=${event => onKeyDown(event, index)}
      onClick=${() => select(id)}>${label}</button>`)}
  </nav>`;
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function Toast() {
  const t = toast.value;
  if (!t) return null;
  return html`
    <div class="toast ${t.type} ${t.persistent ? "toast--persistent" : ""}">
      <span class="toast-message">${t.message}</span>
      ${t.persistent && html`
        <button class="toast-dismiss" onClick=${dismissToast} aria-label="Dismiss">\u00d7</button>
      `}
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
    compactPanel.value = "detail";
  };

  const handleLayerClick = (layerId) => {
    clearSelection();
    dismissTraceSelection();
    selectedSpanId.value = null;
    setSelectedLayer(layerId);
    detailDrawerOpen.value = true;
    compactPanel.value = "detail";
  };

  const handleAgentClick = (agentId) => {
    clearSelection();
    dismissTraceSelection();
    selectedSpanId.value = null;
    setSelectedAgent(agentId);
    detailDrawerOpen.value = true;
    compactPanel.value = "detail";
  };

  const handleCreateLayer = () => {
    clearSelection();
    setCreating("layer");
    detailDrawerOpen.value = true;
    compactPanel.value = "detail";
  };

  const handleCreateAgent = () => {
    clearSelection();
    setCreating("agent");
    detailDrawerOpen.value = true;
    compactPanel.value = "detail";
  };

  const handleCreated = () => {
    setCreating(null);
  };

  // Register hotkey actions
  useEffect(() => {
    registerDefaults({
      focusTree: () => document.querySelector(".sidebar")?.focus(),
      focusConversation: () => document.querySelector(".conversation")?.focus(),
      focusDetail: () => document.querySelector(".detail-drawer")?.focus(),
      nextItem: () => { /* TODO: span navigation */ },
      prevItem: () => { /* TODO: span navigation */ },
      expandItem: () => { /* TODO: expand selected */ },
      escape: () => {
        clearSelection();
        selectedSpanId.value = null;
      },
      togglePause: () => executeAction("thread:pause"),
      inspect: () => executeAction("thread:inspect"),
      override: () => { /* TODO: open override form */ },
      refresh: () => { loadTraces(); loadThreads(); },
      openSettings: () => { settingsOpen.value = !settingsOpen.value; },
      openAnalytics: () => { analyticsOpen.value = !analyticsOpen.value; },
      toggleLayers: () => {},
      toggleEvents: () => {},
    });
    initHotkeys();
  }, []);

  // Check if first-run wizard is needed
  useEffect(() => {
    fetch("/api/settings").then(r => r.json()).then(config => {
      checkSetupNeeded(config);
    }).catch(() => {});
  }, []);

  const projOpen = projectSidebarOpen.value;
  const detailOpen = detailDrawerOpen.value;

  const panelClass = `panels panels--proj-${projOpen ? "open" : "closed"} panels--detail-${detailOpen ? "open" : "closed"}`;

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

        <!-- Center: Conversation / trace timeline -->
        <div class="panel-center" id="workspace-conversation" tabIndex="0">
          <${Conversation}
            onSpanSelect=${handleSpanSelect}
            onLayerClick=${handleLayerClick}
          />
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
      <${Settings} />
      <${Analytics} />
      <${Wizard} />
      <${Toast} />
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

init();
loadSettings();
render(html`<${App} />`, document.getElementById("root"));
