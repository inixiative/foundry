/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * CommandPalette — Cmd+K quick action overlay.
 * Fuzzy-matches against available commands and recent actions.
 */

import { html, useEffect, useRef, useState } from './lib.js';
import { analyticsPath, navigate, settingsPath } from './route.js';
import { MODES, ModeIcon, StatusLegend } from './status-icons.js';
import {
  activeThreadId,
  authFetch,
  commandPaletteOpen,
  createThread,
  executeAction,
  helpOpen,
  scopeProjectId,
  showToast,
  toggleBoard,
  toggleGraphPanel,
} from './store.js';

const COMMANDS = [
  { id: 'pause', label: 'Pause thread', icon: '⏸', action: () => executeAction('thread:pause') },
  { id: 'resume', label: 'Resume thread', icon: '▶', action: () => executeAction('thread:resume') },
  {
    id: 'inspect',
    label: 'Inspect thread state',
    icon: '🔍',
    action: () => executeAction('thread:inspect'),
  },
  {
    id: 'snapshot',
    label: 'System snapshot',
    icon: '📸',
    action: () => executeAction('system:snapshot'),
  },
  {
    id: 'archive',
    label: 'Archive thread',
    icon: '📦',
    action: () => executeAction('thread:archive'),
  },
  {
    id: 'settings',
    label: 'Open settings',
    icon: '⚙',
    action: () => navigate(settingsPath(scopeProjectId())),
  },
  {
    id: 'about',
    label: 'About Foundry',
    icon: 'i',
    action: () => navigate(settingsPath(null, 'about')),
  },
  {
    id: 'analytics',
    label: 'Open analytics',
    icon: '$',
    action: () => navigate(analyticsPath(scopeProjectId())),
  },
  { id: 'graph', label: 'Loop (the graph)', icon: '◇', action: toggleGraphPanel },
  {
    id: 'board',
    label: 'Open the attention board',
    icon: '▦',
    action: toggleBoard,
  },
  {
    id: 'new-thread',
    label: 'New thread in this scope',
    icon: '+',
    action: () => createThread({}),
  },
];

/** "New <worker> thread in this scope" for each worker other than the scope's default that has a login. */
function useWorkerCommands(isOpen) {
  const [workers, setWorkers] = useState([]);
  useEffect(() => {
    const threadId = activeThreadId.value;
    if (!isOpen || !threadId) return;
    let live = true;
    authFetch(`/api/threads/${encodeURIComponent(threadId)}/launch`)
      .then((res) => (res.ok ? res.json() : null))
      .then((view) => {
        if (live) setWorkers((view?.options?.workers ?? []).filter((worker) => !worker.default));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [isOpen]);
  return workers.map((worker) => ({
    id: `new-thread-${worker.id}`,
    label: `New ${worker.label} thread in this scope`,
    icon: '+',
    action: () => createThread({ worker: worker.id }),
  }));
}

export function CommandPalette() {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);
  const isOpen = commandPaletteOpen.value;
  const workerCommands = useWorkerCommands(isOpen);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      setQuery('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const commands = [...COMMANDS, ...workerCommands];
  const filtered = query.trim()
    ? commands.filter(
        (c) =>
          c.label.toLowerCase().includes(query.toLowerCase()) ||
          c.id.toLowerCase().includes(query.toLowerCase()),
      )
    : commands;

  const close = () => {
    commandPaletteOpen.value = false;
  };

  const execute = (cmd) => {
    close();
    cmd.action();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && filtered.length > 0) {
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
          ${filtered.map(
            (cmd) => html`
            <div
              key=${cmd.id}
              class="command-item"
              onClick=${() => execute(cmd)}
            >
              <span class="command-icon">${cmd.icon}</span>
              <span class="command-label">${cmd.label}</span>
            </div>
          `,
          )}
          ${
            filtered.length === 0
              ? html`
            <div class="command-empty">No matching commands</div>
          `
              : null
          }
        </div>
      </div>
    </div>
  `;
}

/** What you can type in a message box, besides plain text. */
const COMPOSER_COMMANDS = [
  ['/btw', 'Ask your own agent privately; it never enters the thread'],
  ['/aside', 'Say something to the people here only; no agents'],
  [
    '/feedback',
    'Record a correction; with an About chip it attaches to that Plan step or Loop node',
  ],
];

/** The keys worth knowing, curated (Aron, 11-01); every one also works with ⌥ while typing. */
const KEY_GROUPS = [
  [
    'Moving around',
    [
      ['⌥T · ⌥B · ⌥H', 'Threads · Board · Watchtower'],
      ['⌥1 · ⌥2 · ⌥3', 'Thread · Plan · Loop (⌘ works too)'],
      ['⌥[ · ⌥⇧[', 'Left list smaller · larger'],
      ['⌥] · ⌥⇧]', 'Right panel smaller · larger'],
      ['⌥↑ · ⌥↓', 'Step through the turn view'],
      ['⌥← · ⌥→', 'Previous · next card in the waiting stack'],
    ],
  ],
  [
    'Doing things',
    [
      ['⌘K', 'Command palette: run any action by name'],
      ['⌥⇧F', 'Search everything (/ where there is no message box)'],
      ['⌥↵ · ⌥⌫', 'Approve · reject the waiting card (a long command opens first)'],
      ['Esc', 'Close a menu or window; you stay in the message box'],
      ['⌥?', 'This window'],
    ],
  ],
  [
    'While typing',
    [
      ['typing', 'Always goes to the message box; app commands are ⌥ chords'],
      ['hold ⌥', 'Show these shortcuts; every ⌥ shortcut works while typing'],
      ['Tab · ⇧Tab', 'Next / previous message box, and the waiting stack'],
      ['⌥F · ⌥V', 'Attach a file · start voice'],
      ['⌥/ · ⌥N', 'Actions for this thread and draft · new thread'],
      [
        '↵ · ⌘↵',
        'Send (steers into a running turn when steering is on) · queue it after the running turn',
      ],
    ],
  ],
];

/**
 * Help: one centred window, two tabs. "Keys & commands" is how you act (the hotkey registry plus the
 * message-box commands); "Statuses & icons" is the map key (status colours and states, permission modes).
 */
export function HelpOverlay() {
  const [tab, setTab] = useState('keys');
  const isOpen = helpOpen.value;
  if (!isOpen) return null;

  const close = () => {
    helpOpen.value = false;
  };
  const modes = ['default', 'plan', 'acceptEdits'];

  return html`
    <div class="overlay-backdrop" onClick=${close}>
      <div class="help-overlay help-modal" role="dialog" aria-modal="true" aria-label="Help" onClick=${(e) => e.stopPropagation()}>
        <div class="help-head">
          <div class="help-tabs band-tabs" role="tablist">
            <button role="tab" aria-selected=${tab === 'keys'} class="center-view ${tab === 'keys' ? 'center-view--active' : ''}" onClick=${() => setTab('keys')}>Keys & commands</button>
            <button role="tab" aria-selected=${tab === 'status'} class="center-view ${tab === 'status' ? 'center-view--active' : ''}" onClick=${() => setTab('status')}>Statuses & icons</button>
          </div>
          <button class="help-close" aria-label="Close" onClick=${close}>✕</button>
        </div>
        <div class="help-body">
          ${
            tab === 'keys'
              ? html`
            ${KEY_GROUPS.map(
              ([category, rows]) => html`
              <div key=${category} class="help-group">
                <div class="help-category">${category}</div>
                ${rows.map(
                  ([k, what]) => html`
                  <div key=${k} class="help-row">
                    <kbd class="help-key">${k}</kbd>
                    <span class="help-desc">${what}</span>
                  </div>
                `,
                )}
              </div>
            `,
            )}
            <div class="help-group">
              <div class="help-category">In a message box</div>
              ${COMPOSER_COMMANDS.map(
                ([cmd, what]) =>
                  html`<div key=${cmd} class="help-row"><kbd class="help-key">${cmd}</kbd><span class="help-desc">${what}</span></div>`,
              )}
            </div>`
              : html`
            <div class="help-group">
              <div class="help-category">Status · colour is the category, the symbol is the state</div>
              <${StatusLegend} />
            </div>
            <div class="help-group">
              <div class="help-category">Permission mode</div>
              ${modes.map((m) => html`<div key=${m} class="help-row"><${ModeIcon} mode=${m} /><span class="help-desc"><b>${MODES[m].word}</b> · ${MODES[m].label.split(': ')[1]}</span></div>`)}
              <div class="help-row"><span class="mode-dangerous-chip">Dangerous</span><span class="help-desc">A separate switch on top of the mode: the host skips every permission check</span></div>
            </div>`
          }
        </div>
      </div>
    </div>
  `;
}
