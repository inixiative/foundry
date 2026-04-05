/**
 * Foundry Viewer — main app shell.
 * Three-panel layout: sidebar | conversation | detail drawer.
 */

import { html, render, useState, useEffect } from "./lib.js";
import {
  init, connected, eventCount, toast, currentTrace,
  selectedSpanId, loadTraces, loadThreads, executeAction,
  projectSidebarOpen,
} from "./store.js";
import { initHotkeys, registerDefaults } from "./hotkeys.js";
import { ProjectSidebar } from "./project-sidebar.js";
import { Sidebar } from "./thread-tree.js";
import { Conversation } from "./conversation.js";
import { DetailDrawer } from "./detail-drawer.js";
import { CommandPalette, HelpOverlay } from "./command-palette.js";
import { Settings, settingsOpen } from "./settings.js";
import { Analytics, analyticsOpen } from "./analytics.js";

// ---------------------------------------------------------------------------
// Header — slim: logo + connection status + hints
// ---------------------------------------------------------------------------

function Header() {
  const isConnected = connected.value;
  const count = eventCount.value;

  return html`
    <div class="header">
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
    <div class="toast ${t.type}">${t.message}</div>
  `;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const [selectedSpan, setSelectedSpan] = useState(null);
  const [selectedLayer, setSelectedLayer] = useState(null);
  // "layer" | "agent" | null — when set, detail drawer shows creation form
  const [creating, setCreating] = useState(null);

  const handleSpanSelect = (span) => {
    setSelectedSpan(span);
    setSelectedLayer(null);
    setCreating(null);
  };

  const handleLayerClick = (layerId) => {
    setSelectedLayer(layerId);
    setSelectedSpan(null);
    setCreating(null);
  };

  const handleCreateLayer = () => {
    setCreating("layer");
    setSelectedSpan(null);
    setSelectedLayer(null);
  };

  const handleCreateAgent = () => {
    setCreating("agent");
    setSelectedSpan(null);
    setSelectedLayer(null);
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
        setSelectedSpan(null);
        setSelectedLayer(null);
        setCreating(null);
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

  const projOpen = projectSidebarOpen.value;

  return html`
    <div class="app">
      <${Header} />

      <div class="panels ${projOpen ? "panels--proj-open" : "panels--proj-closed"}">
        <!-- Far left: Project sidebar (collapsible) -->
        <div class="panel-projects" tabIndex="0">
          <${ProjectSidebar} />
        </div>

        <!-- Left: Thread/Layer/Agent sidebar -->
        <div class="panel-left" tabIndex="0">
          <${Sidebar}
            onLayerClick=${handleLayerClick}
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
      <${Toast} />
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

init();
render(html`<${App} />`, document.getElementById("root"));
