/**
 * Foundry hotkey system — lightweight keyboard shortcut manager.
 * No dependencies. Supports chords, modifiers, and customizable bindings.
 */

import { commandPaletteOpen, helpOpen } from "./store.js";

// ---------------------------------------------------------------------------
// Hotkey registry
// ---------------------------------------------------------------------------

const bindings = new Map();
let enabled = true;

/**
 * Register a hotkey binding.
 * @param {string} key — "k" | "ctrl+k" | "shift+?" | "1" | "escape"
 * @param {object} opts — { description, action, category }
 */
export function bind(key, opts) {
  bindings.set(normalizeKey(key), {
    key,
    description: opts.description || key,
    category: opts.category || "general",
    action: opts.action,
  });
}

/** Remove a binding. */
export function unbind(key) {
  bindings.delete(normalizeKey(key));
}

/** Get all bindings grouped by category. */
export function allBindings() {
  const groups = {};
  for (const [, b] of bindings) {
    if (!groups[b.category]) groups[b.category] = [];
    groups[b.category].push(b);
  }
  return groups;
}

/** Temporarily disable all hotkeys (e.g. when typing in an input). */
export function setEnabled(v) { enabled = v; }

// ---------------------------------------------------------------------------
// Key normalization
// ---------------------------------------------------------------------------

function normalizeKey(key) {
  return key
    .toLowerCase()
    .split("+")
    .sort()
    .join("+");
}

function eventToKey(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");

  let key = e.key.toLowerCase();
  // Normalize special keys
  if (key === " ") key = "space";
  if (key === "escape") key = "escape";
  if (key === "arrowup") key = "up";
  if (key === "arrowdown") key = "down";
  if (key === "arrowleft") key = "left";
  if (key === "arrowright") key = "right";

  // Don't duplicate modifier keys
  if (!["control", "meta", "alt", "shift"].includes(key)) {
    parts.push(key);
  }

  return parts.sort().join("+");
}

// ---------------------------------------------------------------------------
// Global listener
// ---------------------------------------------------------------------------

export function initHotkeys() {
  document.addEventListener("keydown", (e) => {
    // Don't fire in inputs/textareas unless it's Escape
    if (!enabled) return;
    const tag = e.target.tagName;
    if ((tag === "INPUT" || tag === "TEXTAREA") && e.key !== "Escape") return;

    const normalized = eventToKey(e);
    const binding = bindings.get(normalized);

    if (binding) {
      e.preventDefault();
      e.stopPropagation();
      binding.action();
    }
  });
}

// ---------------------------------------------------------------------------
// Default bindings
// ---------------------------------------------------------------------------

export function registerDefaults(actions) {
  // Navigation
  bind("1", { description: "Focus thread tree", category: "navigation", action: actions.focusTree });
  bind("2", { description: "Focus conversation", category: "navigation", action: actions.focusConversation });
  bind("3", { description: "Focus detail drawer", category: "navigation", action: actions.focusDetail });

  // Movement
  bind("j", { description: "Next trace / span", category: "navigation", action: actions.nextItem });
  bind("k", { description: "Previous trace / span", category: "navigation", action: actions.prevItem });
  bind("enter", { description: "Expand / select", category: "navigation", action: actions.expandItem });
  bind("escape", { description: "Close overlay / deselect", category: "navigation", action: actions.escape });

  // Actions
  bind("ctrl+k", { description: "Command palette", category: "actions", action: () => { commandPaletteOpen.value = !commandPaletteOpen.value; } });
  bind("shift+?", { description: "Show hotkey help", category: "actions", action: () => { helpOpen.value = !helpOpen.value; } });
  bind("p", { description: "Pause / resume thread", category: "actions", action: actions.togglePause });
  bind("i", { description: "Inspect thread state", category: "actions", action: actions.inspect });
  bind("o", { description: "Override selected span", category: "actions", action: actions.override });
  bind("r", { description: "Refresh all data", category: "actions", action: actions.refresh });

  // Panels
  bind("s", { description: "Open settings", category: "panels", action: actions.openSettings });
  bind("l", { description: "Toggle layers panel", category: "panels", action: actions.toggleLayers });
  bind("e", { description: "Toggle events panel", category: "panels", action: actions.toggleEvents });
}
