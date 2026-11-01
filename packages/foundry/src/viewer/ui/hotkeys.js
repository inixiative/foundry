/**
 * @atlas
 * @kind utils
 * @partOf feature:viewer
 */
/**
 * Foundry hotkey system — lightweight keyboard shortcut manager.
 * No dependencies. Supports chords, modifiers, and customizable bindings.
 */

import { stepSize } from './panel-sizes.js';
import {
  actionPaletteOpen,
  boardOpen,
  commandPaletteOpen,
  createThread,
  helpOpen,
  openSearch,
} from './store.js';

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
    category: opts.category || 'general',
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
export function setEnabled(v) {
  enabled = v;
}

// ---------------------------------------------------------------------------
// Key normalization
// ---------------------------------------------------------------------------

function normalizeKey(key) {
  return key.toLowerCase().split('+').sort().join('+');
}

function eventToKey(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');

  let key = e.key.toLowerCase();
  // Normalize special keys
  if (key === ' ') key = 'space';
  if (key === 'escape') key = 'escape';
  if (key === 'arrowup') key = 'up';
  if (key === 'arrowdown') key = 'down';
  if (key === 'arrowleft') key = 'left';
  if (key === 'arrowright') key = 'right';

  // Don't duplicate modifier keys
  if (!['control', 'meta', 'alt', 'shift'].includes(key)) {
    parts.push(key);
  }

  return parts.sort().join('+');
}

// ---------------------------------------------------------------------------
// Global listener
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The message box: you never have to leave it
// ---------------------------------------------------------------------------

/** The visible message boxes, then the waiting stack: the only stops for Tab. */
function tabStops() {
  const visible = (el) => el.getBoundingClientRect().width > 0;
  const boxes = [...document.querySelectorAll('textarea.chat-input')].filter(visible);
  const stack = [...document.querySelectorAll('.prompt-stack')].filter(visible);
  return boxes.concat(stack);
}

function cycleTab(from, back) {
  const stops = tabStops();
  if (stops.length < 2) return false;
  const at = stops.indexOf(from);
  const next = stops[(at + (back ? -1 : 1) + stops.length) % stops.length];
  next.focus();
  return true;
}

/** The waiting stack's main action; a long command opens its full view first. */
function stackPrimary(stack) {
  const full = stack.querySelector('.prompt-full-link');
  if (full) return full.click();
  const btn = [...stack.querySelectorAll('.prompt-btn-approve, .prompt-btn')].find(
    (b) => !b.disabled,
  );
  btn?.click();
}

function stackReject(stack) {
  const btn = [...stack.querySelectorAll('.prompt-btn')].find(
    (b) =>
      !b.disabled &&
      (b.classList.contains('prompt-btn-reject') ||
        /Reject|Withdraw|Dismiss|Decline/.test(b.textContent)),
  );
  btn?.click();
}

function stackStep(stack, d) {
  stack.querySelectorAll('.prompt-stack-step')[d < 0 ? 0 : 1]?.click();
}

function composerButton(title) {
  return [...document.querySelectorAll('.chat-input-actions .chat-voice-btn')].find(
    (b) => b.getBoundingClientRect().width > 0 && title.test(b.title),
  );
}

/** ⌥ works while typing: the letter's binding, read from the physical key so macOS ⌥ characters never get typed. */
const ALT_CODES = {
  BracketLeft: '[',
  BracketRight: ']',
  Slash: '/',
};
function altTwin(e) {
  if (e.code?.startsWith('Key')) return e.code.slice(3).toLowerCase();
  if (e.code?.startsWith('Digit')) return e.code.slice(5);
  // ⌥⇧[ and ⌥⇧] are the "larger" twins ({ and }).
  if (e.shiftKey && e.code === 'BracketLeft') return '{';
  if (e.shiftKey && e.code === 'BracketRight') return '}';
  return ALT_CODES[e.code];
}

const ALT_ONLY = {
  f: () => composerButton(/attach/i)?.click(),
  v: () => composerButton(/dictat/i)?.click(),
  k: () => {
    commandPaletteOpen.value = !commandPaletteOpen.value;
  },
  '/': () => {
    actionPaletteOpen.value = !actionPaletteOpen.value;
  },
  n: () => createThread(),
};

// The hold-⌥ overlay: what ⌥ does, without leaving the message box.
let holdTimer = null;
function showHoldKeys(on) {
  document.querySelector('.hold-keys')?.remove();
  if (!on) return;
  const rows = [
    ['⌥T ⌥B', 'Threads · Board'],
    ['⌥1 ⌥2 ⌥3', 'Thread · Plan · Loop'],
    ['⌥[ ⌥]', 'Left list · right panel'],
    ['⌥↵ ⌥⌫', 'Approve · reject the waiting card'],
    ['⌥← ⌥→', 'Previous · next waiting card'],
    ['⌥F ⌥V', 'Attach a file · start voice'],
    ['⌥K ⌘K', 'Command palette'],
    ['Tab ⇧Tab', 'Message boxes and the waiting stack'],
    ['Esc · /', 'Leave the message box · come back'],
  ];
  const el = document.createElement('div');
  el.className = 'hold-keys';
  el.setAttribute('role', 'tooltip');
  const head = document.createElement('b');
  head.textContent = '⌥ shortcuts · work while typing';
  el.append(head);
  for (const [k, what] of rows) {
    const row = document.createElement('div');
    const kbd = document.createElement('kbd');
    kbd.textContent = k;
    const span = document.createElement('span');
    span.textContent = what;
    row.append(kbd, span);
    el.append(row);
  }
  document.body.append(el);
}

export function initHotkeys() {
  document.addEventListener('keydown', (e) => {
    if (!enabled) return;
    const tag = e.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA';
    const inStack = e.target.classList?.contains('prompt-stack');

    if (e.key === 'Alt') {
      if (!e.repeat) {
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => showHoldKeys(true), 450);
      }
      return;
    }

    // Tab moves between the message boxes and the waiting stack, nothing else.
    if (e.key === 'Tab' && (e.target.classList?.contains('chat-input') || inStack)) {
      // Nothing else is a stop: with one box and no waiting card, Tab stays put.
      e.preventDefault();
      cycleTab(e.target, e.shiftKey);
      return;
    }

    // On the waiting stack: Enter acts, ⌫ rejects, ←/→ step.
    if (inStack && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const map = {
        Enter: () => stackPrimary(e.target),
        Backspace: () => stackReject(e.target),
        Delete: () => stackReject(e.target),
        ArrowLeft: () => stackStep(e.target, -1),
        ArrowRight: () => stackStep(e.target, 1),
      };
      if (map[e.key]) {
        e.preventDefault();
        map[e.key]();
        return;
      }
    }

    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      clearTimeout(holdTimer);
      showHoldKeys(false);
      const stack = document.querySelector('.prompt-stack');
      if (e.key === 'Enter' && stack) {
        e.preventDefault();
        return stackPrimary(stack);
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && stack) {
        e.preventDefault();
        return stackReject(stack);
      }
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && stack) {
        e.preventDefault();
        return stackStep(stack, e.key === 'ArrowLeft' ? -1 : 1);
      }
      const twin = altTwin(e);
      const action = (twin && ALT_ONLY[twin]) || (twin && bindings.get(normalizeKey(twin))?.action);
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        action();
      }
      return;
    }

    if (typing) {
      // Esc leaves the message box (overlays still close through the escape binding).
      if (e.key === 'Escape') {
        e.target.blur();
        bindings.get('escape')?.action();
      }
      return;
    }

    // / opens Search (typed into an empty message box, it opens the action palette instead).
    if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      openSearch();
      return;
    }

    const normalized = eventToKey(e);
    const binding = bindings.get(normalized);

    if (binding) {
      e.preventDefault();
      e.stopPropagation();
      binding.action();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') {
      clearTimeout(holdTimer);
      showHoldKeys(false);
    }
  });
  window.addEventListener('blur', () => {
    clearTimeout(holdTimer);
    showHoldKeys(false);
  });
}

// ---------------------------------------------------------------------------
// Default bindings
// ---------------------------------------------------------------------------

export function registerDefaults(actions) {
  // Navigation
  for (const [i, key] of ['1', '2', '3', '4'].entries())
    bind(key, {
      description: `Centre: ${actions.centerTabs[i]}`,
      category: 'navigation',
      action: () => actions.showCenterTab(i),
    });

  // Movement
  bind('j', { description: 'Next trace / span', category: 'navigation', action: actions.nextItem });
  bind('k', {
    description: 'Previous trace / span',
    category: 'navigation',
    action: actions.prevItem,
  });
  bind('enter', {
    description: 'Expand / select',
    category: 'navigation',
    action: actions.expandItem,
  });
  bind('escape', {
    description: 'Close overlay / deselect',
    category: 'navigation',
    action: actions.escape,
  });

  // Actions
  bind('ctrl+k', {
    description: 'Command palette',
    category: 'actions',
    action: () => {
      commandPaletteOpen.value = !commandPaletteOpen.value;
    },
  });
  bind('shift+?', {
    description: 'Show hotkey help',
    category: 'actions',
    action: () => {
      helpOpen.value = !helpOpen.value;
    },
  });
  bind('p', {
    description: 'Pause / resume thread',
    category: 'actions',
    action: actions.togglePause,
  });
  bind('i', { description: 'Inspect thread state', category: 'actions', action: actions.inspect });
  bind('o', {
    description: 'Override selected span',
    category: 'actions',
    action: actions.override,
  });
  bind('r', { description: 'Refresh all data', category: 'actions', action: actions.refresh });

  // Panels
  bind('s', { description: 'Open settings', category: 'panels', action: actions.openSettings });
  bind('a', { description: 'Open analytics', category: 'panels', action: actions.openAnalytics });
  bind('l', {
    description: 'Toggle layers panel',
    category: 'panels',
    action: actions.toggleLayers,
  });
  bind('e', {
    description: 'Toggle events panel',
    category: 'panels',
    action: actions.toggleEvents,
  });
  bind('g', { description: 'Loop (the graph)', category: 'panels', action: actions.toggleGraph });
  bind('b', {
    description: 'The attention board',
    category: 'panels',
    action: actions.toggleBoard,
  });
  bind('h', {
    description: 'Watchtower: work by stage',
    category: 'panels',
    action: actions.toggleWatchtower,
  });
  bind('t', {
    description: 'Threads',
    category: 'panels',
    action: () => {
      boardOpen.value = false;
    },
  });
  bind('[', {
    description: 'Left list smaller',
    category: 'panels',
    action: () => stepSize('left', -1),
  });
  bind('{', {
    description: 'Left list larger',
    category: 'panels',
    action: () => stepSize('left', 1),
  });
  bind(']', {
    description: 'Right panel smaller',
    category: 'panels',
    action: () => stepSize('right', -1),
  });
  bind('}', {
    description: 'Right panel larger',
    category: 'panels',
    action: () => stepSize('right', 1),
  });
  for (const [i, key] of ['5', '6', '7', '8', '9'].entries())
    bind(key, {
      description: `Right panel: ${actions.rightTabs[i]}`,
      category: 'panels',
      action: () => actions.showRightTab(i),
    });
}
