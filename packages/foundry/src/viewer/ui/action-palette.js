/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The actions palette by Send ("Actions ⌥/", or "/" typed into an empty message box): what you can
 * do with this thread, where this draft goes, and feedback. Fuzzy filter, ↑↓, Enter, Esc. Actions
 * with a backend run; the rest are listed with why they're not built (CORE-004 fork and rewind,
 * CORE-001 steering, asides and /btw posting, scheduling, hand-off).
 */

import { html, useEffect, useRef, useState } from './lib.js';
import { composerDestination, separateViews } from './message-box.js';
import { LoopBuilder } from './message-menu.js';
import { settingsConfig } from './settings.js';
import { snooze, tomorrowMorning } from './snooze.js';
import {
  actionPaletteOpen,
  activeThreadId,
  composerFill,
  createThread,
  executeAction,
  messages,
  showToast,
} from './store.js';

const SOON = (why) => ({ disabled: why });

/** The palette's entries. `run` gets { send, threadId, openLoop }; `disabled` says why it can't run. */
export function paletteActions() {
  return [
    [
      'Thread',
      [
        { id: 'new', name: 'New thread', key: '⌥N', run: () => createThread() },
        {
          id: 'reach',
          name: 'Reach out to a teammate…',
          hint: 'start a shared session with someone',
          key: '/reach',
          ...SOON('Reaching out through Kingdom isn’t built yet'),
        },
        {
          id: 'fork',
          name: 'Fork from here',
          hint: 'a copy of the thread from this turn',
          key: '/fork',
          ...SOON('Native fork isn’t built yet (CORE-004)'),
        },
        {
          id: 'revert',
          name: 'Revert to a turn…',
          hint: 'rewind the conversation and its file changes',
          key: '/revert',
          ...SOON('Native rewind isn’t built yet (CORE-004)'),
        },
        {
          id: 'split',
          name: 'Split from here into a new thread',
          key: '/split',
          ...SOON('Splitting a thread isn’t built yet'),
        },
        {
          id: 'merge',
          name: 'Merge into another thread’s plan…',
          hint: 'it becomes a step there',
          key: '/merge',
          ...SOON('Merging threads isn’t built yet'),
        },
        {
          id: 'close',
          name: 'Close this thread',
          hint: 'archive it · Undo for 20 s',
          key: '/close',
          run: ({ threadId }) => executeAction('thread:archive', threadId),
        },
        {
          id: 'pause',
          name: 'Pause',
          hint: 'nothing runs until you resume',
          key: '/pause',
          run: ({ threadId }) => executeAction('thread:pause', threadId),
        },
        {
          id: 'schedule',
          name: 'Schedule…',
          hint: 'run this again later or on a repeat',
          key: '/schedule',
          ...SOON('Scheduling isn’t built yet'),
        },
        {
          id: 'snooze-hour',
          name: 'Snooze 1 hour',
          key: '/snooze',
          run: ({ threadId }) => snooze(threadId, Date.now() + 3_600_000),
        },
        {
          id: 'snooze-tomorrow',
          name: 'Snooze until tomorrow',
          run: ({ threadId }) => snooze(threadId, tomorrowMorning()),
        },
        {
          id: 'handoff',
          name: 'Hand off to…',
          hint: 'another agent or a person',
          key: '/handoff',
          ...SOON('Hand-off isn’t built yet'),
        },
        {
          id: 'loop',
          name: 'Turn into a loop…',
          hint: 'repeat · learn, from the last turn',
          key: '/loop',
          run: ({ openLoop }) => openLoop(),
        },
      ],
    ],
    [
      'Send this draft',
      [
        {
          id: 'send',
          name: 'To the thread',
          hint: 'queues behind a running turn until steering is built',
          key: '↵',
          run: ({ send }) => send(),
        },
        {
          id: 'queue',
          name: 'Queue it',
          hint: 'after the current turn',
          key: '⌘↵',
          run: ({ send }) => send(),
        },
        {
          id: 'btw',
          name: 'To /btw',
          hint: 'only you and your agent',
          key: '/btw',
          run: ({ route }) => route('btw'),
        },
        {
          id: 'aside',
          name: 'As an /aside',
          hint: 'people only',
          key: '/aside',
          run: ({ route }) => route('aside'),
        },
        {
          id: 'other',
          name: 'To another thread…',
          key: '/to',
          ...SOON('Sending to another thread isn’t built yet'),
        },
        {
          id: 'later',
          name: 'Schedule…',
          hint: 'send later',
          key: '/later',
          ...SOON('Scheduled sends aren’t built yet'),
        },
      ],
    ],
    [
      'Feedback',
      [
        {
          id: 'feedback',
          name: 'Give feedback',
          hint: 'goes to the Forge Master',
          key: '/feedback',
          run: () => {
            composerFill.value = '/feedback ';
          },
        },
        {
          id: 'correction',
          name: 'Record a correction',
          key: '/correction',
          ...SOON('Recording a correction from the message box isn’t built yet'),
        },
      ],
    ],
  ];
}

/** Every action whose name, hint or key contains the query (leading "/" ignored). */
export function filterActions(groups, query) {
  const q = query.toLowerCase().replace(/^\//, '').trim();
  return groups
    .map(([group, items]) => [
      group,
      items.filter(
        (a) => !q || `${a.name} ${a.hint ?? ''} ${a.key ?? ''}`.toLowerCase().includes(q),
      ),
    ])
    .filter(([, items]) => items.length);
}

export function ActionPalette({ onSend }) {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const [loopFor, setLoopFor] = useState(null);
  const input = useRef(null);
  const open = actionPaletteOpen.value;
  useEffect(() => {
    if (!open) return;
    setAt(0);
    // Opened by "/" in an empty box: whatever was typed there before this input took focus
    // belongs to the palette (a fast "/btw " lands in the box first).
    const box = document.querySelector('textarea.chat-input');
    const carried = open === 'slash' ? (box?.value ?? '') : '';
    if (carried) composerFill.value = '';
    if (carried && /^(btw|aside)\s/.test(carried) && !separateViews(settingsConfig.peek())) {
      route(/^(btw|aside)/.exec(carried)[1], carried.replace(/^(btw|aside)\s/, ''));
      return;
    }
    setQuery(carried);
    input.current?.focus();
  }, [open]);
  const groups = filterActions(paletteActions(), query);
  const flat = groups.flatMap(([, items]) => items);
  const close = () => {
    actionPaletteOpen.value = false;
  };
  // Send this draft to /btw or an aside: the box's label switches, and focus goes back to it.
  const route = (destination, rest = '') => {
    close();
    composerDestination.value = destination;
    if (rest) composerFill.value = rest;
    document.querySelector('textarea.chat-input')?.focus();
  };
  const run = (action) => {
    if (action.disabled) return showToast(action.disabled, 'warn');
    close();
    const threadId = activeThreadId.peek();
    action.run({
      route,
      threadId,
      send: onSend,
      openLoop: () => {
        const last = [...messages.peek()].reverse().find((m) => m.actor === 'agent' && m.turnId);
        if (last) setLoopFor(last);
        else showToast('No finished turn to make a loop from yet', 'warn');
      },
    });
  };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setAt((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % Math.max(1, flat.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (flat[at]) run(flat[at]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      document.querySelector('textarea.chat-input')?.focus();
    }
  };
  let index = 0;
  return html`
    ${
      open
        ? html`<div class="action-palette" role="dialog" aria-label="Actions">
          <input ref=${input} class="action-palette-input" placeholder="Do something with this thread or this message…"
            value=${query} onInput=${(e) => {
              // "/btw " or "/aside " (the "/" opened the palette) switches the box's destination.
              const typed = /^(btw|aside)\s/.exec(e.target.value);
              if (typed && !separateViews(settingsConfig.peek())) {
                route(typed[1]);
                return;
              }
              setQuery(e.target.value);
              setAt(0);
            }} onKeyDown=${onKeyDown} />
          <div class="action-palette-list">
            ${groups.map(
              ([group, items]) =>
                html`<div key=${group} class="action-palette-group"><h5>${group}</h5>${items.map(
                  (a) => {
                    const i = index++;
                    return html`<button key=${a.id} type="button" class="action-palette-item ${i === at ? 'is-at' : ''} ${a.disabled ? 'is-off' : ''}"
                  title=${a.disabled ?? ''} onMouseEnter=${() => setAt(i)} onClick=${() => run(a)}>
                  <span>${a.name}</span>${a.hint || a.disabled ? html`<small>${a.disabled ? `not built · ${a.disabled}` : a.hint}</small>` : null}${a.key ? html`<kbd class="cmd">${a.key}</kbd>` : null}
                </button>`;
                  },
                )}</div>`,
            )}
            ${flat.length ? null : html`<div class="action-palette-none">Nothing matches.</div>`}
          </div>
        </div>`
        : null
    }
    ${loopFor ? html`<${LoopBuilder} msg=${loopFor} onClose=${() => setLoopFor(null)} />` : null}
  `;
}
