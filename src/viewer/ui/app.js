/**
 * Foundry Viewer — main app shell.
 * Three-panel layout: thread tree | conversation | detail drawer.
 * Hotkeys, command palette, layer bands, action bar.
 */

import { html, render, useState, useEffect } from "./lib.js";
import {
  init, connected, eventCount, toast, currentTrace,
  selectedSpanId, loadTraces, loadThreads, executeAction, liveEvents,
} from "./store.js";
import { initHotkeys, registerDefaults, setEnabled } from "./hotkeys.js";
import { ThreadTree } from "./thread-tree.js";
import { Conversation } from "./conversation.js";
import { DetailDrawer } from "./detail-drawer.js";
import { CommandPalette, HelpOverlay } from "./command-palette.js";

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function StatusBar() {
  const isConnected = connected.value;
  const count = eventCount.value;

  return html`
    <div class="status-bar">
      <span class="status-dot ${isConnected ? "on" : "off"}"></span>
      <span class="status-text">${isConnected ? "connected" : "reconnecting..."}</span>
      <span class="status-sep">|</span>
      <span class="status-text">${count} events</span>
      <span class="status-right">
        <kbd class="status-key">Ctrl+K</kbd> commands
        <kbd class="status-key">?</kbd> help
      </span>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Action bar
// ---------------------------------------------------------------------------

function ActionBar() {
  return html`
    <div class="action-bar">
      <button class="action-btn" onClick=${() => executeAction("thread:inspect")} title="Inspect (i)">
        inspect
      </button>
      <button class="action-btn" onClick=${() => executeAction("thread:pause")} title="Pause (p)">
        pause
      </button>
      <button class="action-btn" onClick=${() => executeAction("system:snapshot")} title="Snapshot">
        snapshot
      </button>
      <span class="action-sep"></span>
      <button class="action-btn subtle" onClick=${() => { loadTraces(); loadThreads(); }} title="Refresh (r)">
        refresh
      </button>
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
// Live events panel (bottom of left panel)
// ---------------------------------------------------------------------------

function LiveEvents() {
  const events = liveEvents.value;
  return html`
    <div class="live-events">
      <div class="panel-header">
        <span class="panel-title">LIVE EVENTS</span>
        <span class="panel-badge">${events.length}</span>
      </div>
      <div class="live-events-list">
        ${events.slice(0, 50).map((ev, i) => html`
          <div key=${i} class="live-event-row">
            <span class="le-kind">${ev.kind}</span>
            <span class="le-time">${ev._time}</span>
          </div>
        `)}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const [selectedSpan, setSelectedSpan] = useState(null);
  const [selectedLayer, setSelectedLayer] = useState(null);

  const handleSpanSelect = (span) => {
    setSelectedSpan(span);
    setSelectedLayer(null);
  };

  const handleLayerClick = (layerId) => {
    setSelectedLayer(layerId);
    setSelectedSpan(null);
  };

  // Register hotkey actions
  useEffect(() => {
    registerDefaults({
      focusTree: () => document.querySelector(".thread-tree")?.focus(),
      focusConversation: () => document.querySelector(".conversation")?.focus(),
      focusDetail: () => document.querySelector(".detail-drawer")?.focus(),
      nextItem: () => { /* TODO: span navigation */ },
      prevItem: () => { /* TODO: span navigation */ },
      expandItem: () => { /* TODO: expand selected */ },
      escape: () => {
        setSelectedSpan(null);
        setSelectedLayer(null);
        selectedSpanId.value = null;
      },
      togglePause: () => executeAction("thread:pause"),
      inspect: () => executeAction("thread:inspect"),
      override: () => { /* TODO: open override form */ },
      refresh: () => { loadTraces(); loadThreads(); },
      toggleLayers: () => { /* handled by tree panel */ },
      toggleEvents: () => { /* handled by tree panel */ },
    });
    initHotkeys();
  }, []);

  return html`
    <div class="app">
      <div class="header">
        <span class="header-title">foundry</span>
        <${ActionBar} />
        <${StatusBar} />
      </div>

      <div class="panels">
        <!-- Left: Thread tree + layers + events -->
        <div class="panel-left" tabIndex="0">
          <${ThreadTree} onThreadSelect=${() => {}} />
          <${LiveEvents} />
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
          />
        </div>
      </div>

      <!-- Overlays -->
      <${CommandPalette} />
      <${HelpOverlay} />
      <${Toast} />
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

init();
render(html`<${App} />`, document.getElementById("root"));
