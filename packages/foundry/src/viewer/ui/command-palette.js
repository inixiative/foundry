/**
 * CommandPalette — Cmd+K quick action overlay.
 * Fuzzy-matches against available commands and recent actions.
 */

import { html, useState, useEffect, useRef } from "./lib.js";
import { commandPaletteOpen, helpOpen, executeAction, showToast } from "./store.js";
import { settingsOpen } from "./settings.js";
import { allBindings } from "./hotkeys.js";

const COMMANDS = [
  { id: "pause", label: "Pause thread", icon: "⏸", action: () => executeAction("thread:pause") },
  { id: "resume", label: "Resume thread", icon: "▶", action: () => executeAction("thread:resume") },
  { id: "inspect", label: "Inspect thread state", icon: "🔍", action: () => executeAction("thread:inspect") },
  { id: "snapshot", label: "System snapshot", icon: "📸", action: () => executeAction("system:snapshot") },
  { id: "archive", label: "Archive thread", icon: "📦", action: () => executeAction("thread:archive") },
  { id: "settings", label: "Open settings", icon: "⚙", action: () => { settingsOpen.value = true; } },
];

export function CommandPalette() {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);
  const isOpen = commandPaletteOpen.value;

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      setQuery("");
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const filtered = query.trim()
    ? COMMANDS.filter(c =>
        c.label.toLowerCase().includes(query.toLowerCase()) ||
        c.id.toLowerCase().includes(query.toLowerCase())
      )
    : COMMANDS;

  const close = () => { commandPaletteOpen.value = false; };

  const execute = (cmd) => {
    close();
    cmd.action();
  };

  const handleKeyDown = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && filtered.length > 0) {
      execute(filtered[0]);
    }
  };

  return html`
    <div class="overlay-backdrop" onClick=${close}>
      <div class="command-palette" onClick=${(e) => e.stopPropagation()}>
        <input
          ref=${inputRef}
          class="command-input"
          placeholder="Type a command..."
          value=${query}
          onInput=${(e) => setQuery(e.target.value)}
          onKeyDown=${handleKeyDown}
        />
        <div class="command-list">
          ${filtered.map(cmd => html`
            <div
              key=${cmd.id}
              class="command-item"
              onClick=${() => execute(cmd)}
            >
              <span class="command-icon">${cmd.icon}</span>
              <span class="command-label">${cmd.label}</span>
            </div>
          `)}
          ${filtered.length === 0 ? html`
            <div class="command-empty">No matching commands</div>
          ` : null}
        </div>
      </div>
    </div>
  `;
}

export function HelpOverlay() {
  const isOpen = helpOpen.value;
  if (!isOpen) return null;

  const groups = allBindings();
  const close = () => { helpOpen.value = false; };

  return html`
    <div class="overlay-backdrop" onClick=${close}>
      <div class="help-overlay" onClick=${(e) => e.stopPropagation()}>
        <div class="help-title">Keyboard Shortcuts</div>
        ${Object.entries(groups).map(([category, bindings]) => html`
          <div key=${category} class="help-group">
            <div class="help-category">${category}</div>
            ${bindings.map(b => html`
              <div key=${b.key} class="help-row">
                <kbd class="help-key">${b.key}</kbd>
                <span class="help-desc">${b.description}</span>
              </div>
            `)}
          </div>
        `)}
        <div class="help-footer">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close</div>
      </div>
    </div>
  `;
}
