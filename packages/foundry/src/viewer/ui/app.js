/**
 * Foundry Viewer — main app shell.
 * Three-panel layout: sidebar | conversation | detail drawer.
 */

import { html, render, useState, useEffect } from "./lib.js";
import {
  init, connected, eventCount, toast, currentTrace,
  selectedSpanId, loadTraces, loadThreads, executeAction,
  projectSidebarOpen, detailDrawerOpen, dismissToast,
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
    setSelectedSpan(null);
    setSelectedLayer(null);
    setSelectedAgent(null);
    setCreating(null);
  };

  const handleSpanSelect = (span) => {
    clearSelection();
    setSelectedSpan(span);
  };

  const handleLayerClick = (layerId) => {
    clearSelection();
    setSelectedLayer(layerId);
  };

  const handleAgentClick = (agentId) => {
    clearSelection();
    setSelectedAgent(agentId);
  };

  const handleCreateLayer = () => {
    clearSelection();
    setCreating("layer");
  };

  const handleCreateAgent = () => {
    clearSelection();
    setCreating("agent");
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

      <div class=${panelClass}>
        <!-- Far left: Project sidebar (collapsible) -->
        <div class="panel-projects" tabIndex="0">
          <${ProjectSidebar} />
        </div>

        <!-- Left: Thread/Layer/Agent sidebar -->
        <div class="panel-left" tabIndex="0">
          <${Sidebar}
            onLayerClick=${handleLayerClick}
            onAgentClick=${handleAgentClick}
            onCreateLayer=${handleCreateLayer}
            onCreateAgent=${handleCreateAgent}
          />
        </div>

        <!-- Center: Conversation / trace timeline -->
        <div class="panel-center" tabIndex="0">
          <${Conversation}
            onSpanSelect=${handleSpanSelect}
            onLayerClick=${handleLayerClick}
          />
        </div>

        <!-- Right: Detail drawer -->
        <div class="panel-right" tabIndex="0">
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
