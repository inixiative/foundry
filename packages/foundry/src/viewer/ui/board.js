/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The attention board: every thread on one Kanban, a column per status colour.
 *
 * Columns: Problems (red, only when something is) · Needs you (orange) · Working (green) · Queued
 * (light yellow) · Done (light blue). A thread's column is its status category (thread-status.js), so
 * the rail, the header and the board classify it once. Filters: Everything, one project, Global, Forge
 * Master, this Foundry.
 *
 * A card shows what the thread is and what it asks, with one-tap answers for its pending prompt. The
 * attention controls of the spec (dismiss, not important, wipe, combine, bring back, take over) need
 * the attention tag on the thread; they appear when a thread carries `meta.attention`.
 *
 * Incoming sits apart from the columns: parties asking to join through a Signet. They are requests,
 * not approvals of the agent's work, and nothing runs until the owner accepts in Kingdom.
 */

import { FilterChips, passesChips } from './filter-chips.js';
import { html, useEffect, useState } from './lib.js';
import { DeviceBadge, loadMachineProfile, machineProfile, otherMachine } from './machine-icons.js';
import { selfChatSending } from './self-chat.js';
import { settingsConfig } from './settings.js';
import { STATES, StatusIcon } from './status-icons.js';
import {
  allThreads,
  boardFilter,
  boardOpen,
  createThread,
  executeAction,
  incoming,
  projects,
  prompts,
  resolvePrompt,
  selectScope,
  selectThread,
} from './store.js';
import { projectKingdom, threadName } from './thread-labels.js';
import {
  categoryOf,
  isClosedThread,
  statusText,
  subagentParentOf,
  threadState,
} from './thread-status.js';

const COLUMNS = [
  { cat: 'problem', title: 'Problems' },
  { cat: 'attention', title: 'Needs you' },
  { cat: 'working', title: 'Working' },
  { cat: 'queued', title: 'Queued' },
  { cat: 'done', title: 'Done' },
];
const OPEN = (t) => !isClosedThread(t);

/** The board's filter: 'all', 'global', 'forge', 'this', or 'project:<id>'. */
function Card({ thread, state }) {
  const pending = prompts.value.filter((p) => p.threadId === thread.threadId);
  const ask = pending[0];
  const project = thread.meta?.projectId
    ? (projects.value.find((p) => p.id === thread.meta.projectId)?.label ?? thread.meta.projectId)
    : 'Global';
  const s = STATES[state];
  const open = () => {
    boardOpen.value = false;
    selectThread(thread.threadId);
  };
  const choices = ask?.options?.length
    ? ask.options
    : ask
      ? [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ]
      : [];
  return html`<article class="board-card" data-thread=${thread.threadId}>
    <div class="board-card-head">
      <${StatusIcon} state=${state} />
      <span class="board-card-kind">${statusText(thread, state) || (s?.kind ?? s?.label)}</span>
      <span class="board-card-project">${project}</span>
      <${DeviceBadge} thread=${thread} />
    </div>
    <button class="board-card-title" onClick=${open} title="Open the thread">${threadName(thread)}</button>
    ${ask ? html`<p class="board-card-ask">${ask.message}</p>` : null}
    ${
      choices.length
        ? html`<div class="board-card-actions">${choices.map(
            (o, i) => html`<button key=${o.id} class="proj-btn ${i === 0 ? 'proj-btn-ok' : ''}"
              onClick=${() => resolvePrompt(ask.id, o.id)}>${o.label}</button>`,
          )}</div>`
        : null
    }
    <div class="board-card-foot">
      <button class="rp-link" onClick=${open}>Open ›</button>
      <button class="rp-link" onClick=${() => createThread({ description: `Follow-up to: ${threadName(thread)}` })}>Another thread for this</button>
      <button class="rp-link" onClick=${() => executeAction('thread:archive', thread.threadId)}>Close</button>
    </div>
  </article>`;
}

function ForgeMasterCard() {
  const working = selfChatSending.value;
  return html`<article class="board-card">
    <div class="board-card-head">
      <${StatusIcon} state=${working ? 'working' : 'idle'} />
      <span class="board-card-kind">${working ? 'Working' : 'Idle'}</span>
      <span class="board-card-project">this Foundry</span>
    </div>
    <button class="board-card-title" onClick=${() => {
      boardOpen.value = false;
      selectScope('forge');
    }}>Forge Master</button>
    <p class="board-card-ask">The thread about this Foundry and its settings.</p>
  </article>`;
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : null);

/** One party asking to join: who, what for, and where to decide (Kingdom). */
export function IncomingCard({ request }) {
  const until = request.until ? `until ${when(request.until)}` : 'no end date';
  const allowance = request.maxRequests ? `${request.maxRequests} requests` : 'unlimited requests';
  return html`<article class="incoming-card" data-request=${request.id}>
    <div class="incoming-card-head">
      <span class="incoming-card-kind">Request</span>
      <span class="incoming-card-when">${when(request.createdAt)}</span>
    </div>
    <p class="incoming-card-who"><strong>${request.requester}</strong> asks to join your threads</p>
    <p class="incoming-card-what">${request.name}${request.operations.length ? ` · ${request.operations.join(', ')}` : ''}</p>
    <p class="incoming-card-terms">${request.lifecycle} · ${allowance} · ${until}</p>
    <p class="incoming-card-note">Nothing runs until you accept it in Kingdom.</p>
    <div class="board-card-actions">
      <a class="proj-btn proj-btn-ok" href=${request.reviewUrl} target="_blank" rel="noopener">Review in Kingdom ↗</a>
    </div>
  </article>`;
}

/** Incoming: one compact line above the columns, opened to show the requests. */
function Incoming() {
  const [open, setOpen] = useState(false);
  const requests = incoming.value;
  if (!requests.length) return null;
  return html`<section class="board-incoming board-incoming--line" aria-label="Incoming requests">
    <button type="button" class="board-incoming-toggle" aria-expanded=${open} onClick=${() => setOpen(!open)}>
      <span class="board-incoming-caret">${open ? '▾' : '▸'}</span>
      Incoming <span class="rail-pane-count">${requests.length}</span>
      <span class="board-incoming-hint">Requests to join, not yet accepted</span>
    </button>
    ${
      open
        ? html`<div class="board-incoming-list">
            ${requests.map((r) => html`<${IncomingCard} key=${r.id} request=${r} />`)}
          </div>`
        : null
    }
  </section>`;
}

/** Quiet threads: paused, idle, snoozed (all neutral) or archived. Off the board unless asked for. */
const QUIET = new Set(['idle', 'archived']);

/** The Project chip's own entry for the Forge Master (it has no threads; it shows its card). */
const FORGE = '__forge';

export function Board() {
  const chips = boardFilter.value;
  const [showQuiet, setShowQuiet] = useState(false);
  useEffect(() => {
    loadMachineProfile();
  }, []);
  const machine =
    machineProfile.value?.installationName ??
    settingsConfig.value?.installationName ??
    'This Foundry';
  // A thread runs on this machine unless its meta.machine names another device.
  const valuesOf = {
    project: (t) => t.meta?.projectId ?? '',
    kingdom: (t) => projectKingdom(t.meta?.projectId),
    device: (t) => otherMachine(t)?.deviceName ?? machine,
  };
  const open = allThreads.value.filter((t) => showQuiet || OPEN(t));
  const threads = open.filter((t) => passesChips(chips, valuesOf, t));
  const place = (t) => {
    const children = allThreads.value.filter((c) => subagentParentOf(c.meta) === t.threadId);
    const state = threadState(t, {
      prompts: prompts.value.filter((p) => p.threadId === t.threadId),
      childrenWorking: children.some(
        (c) => categoryOf(threadState(c, { prompts: [] })) === 'working',
      ),
    });
    return { thread: t, state, cat: categoryOf(state) };
  };
  const placed = threads.map(place);
  const forge = !!chips.project?.has(FORGE);
  const quiet = placed.filter((p) => QUIET.has(p.cat));
  const columns = [
    ...COLUMNS.filter((c) => c.cat !== 'problem' || placed.some((p) => p.cat === 'problem')),
    ...(showQuiet ? [{ cat: 'quiet', title: 'Quiet' }] : []),
  ];
  // Everything quiet across the board (not only this filter), placed exactly as the columns are.
  const quietCount = allThreads.value.filter((t) => QUIET.has(place(t).cat)).length;
  const count = (group, value) => open.filter((t) => valuesOf[group](t) === value).length;
  const option = (group, value, label) => ({ value, label, count: count(group, value) });
  const live = projects.value.filter((p) => p.status !== 'archived');
  const groups = [
    {
      id: 'project',
      label: 'Project',
      options: [
        ...live.map((p) => option('project', p.id, p.label)),
        option('project', '', 'Global'),
        { value: FORGE, label: 'Forge Master' },
      ],
    },
    {
      id: 'kingdom',
      label: 'Kingdom',
      options: [...new Set(open.map(valuesOf.kingdom))].map((k) => option('kingdom', k, k)),
    },
    {
      id: 'device',
      label: 'Device',
      options: [...new Set([machine, ...open.map(valuesOf.device)])].map((d) =>
        option('device', d, d),
      ),
    },
  ];

  return html`<div class="board">
    <header class="board-band">
      <h2 class="board-title">Board</h2>
      <span class="board-device-note" title="A thread on another of your machines carries a device badge">This machine: ${machine}</span>
    </header>
    <div class="board-filter-row">
      <${FilterChips} groups=${groups} selected=${chips} onChange=${(next) => {
        boardFilter.value = next;
      }}>
        <button type="button" class="board-quiet-toggle" aria-pressed=${showQuiet} title="Paused, idle and archived threads"
          onClick=${() => setShowQuiet(!showQuiet)}>${showQuiet ? 'Hide' : 'Show'} quiet · ${quietCount}</button>
      <//>
    </div>
    <${Incoming} />
    <div class="board-columns">
      ${columns.map((col) => {
        const cards = forge
          ? []
          : col.cat === 'quiet'
            ? quiet
            : placed.filter((p) => p.cat === col.cat);
        const forgeHere = forge && col.cat === (selfChatSending.value ? 'working' : null);
        return html`<section key=${col.cat} class="board-column board-column--${col.cat}">
          <h3 class="board-column-head">
            <span class="board-column-swatch"></span>${col.title}
            <span class="rail-pane-count">${cards.length + (forgeHere ? 1 : 0)}</span>
          </h3>
          <div class="board-frame">
            ${forgeHere ? html`<${ForgeMasterCard} />` : null}
            ${cards.map((p) => html`<${Card} key=${p.thread.threadId} thread=${p.thread} state=${p.state} />`)}
            ${!cards.length && !forgeHere ? html`<div class="rail-empty">Nothing here.</div>` : null}
          </div>
        </section>`;
      })}
    </div>
    ${forge && !selfChatSending.value ? html`<div class="board-aside"><${ForgeMasterCard} /></div>` : null}
  </div>`;
}
