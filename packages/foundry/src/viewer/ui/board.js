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
import { html, signal, useEffect, useState } from './lib.js';
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
import { ThreadActions, threadTree } from './thread-tree.js';

const COLUMNS = [
  { cat: 'problem', title: 'Problems' },
  { cat: 'attention', title: 'Needs you' },
  { cat: 'working', title: 'Working' },
  { cat: 'queued', title: 'Queued' },
  { cat: 'done', title: 'Done' },
];
const OPEN = (t) => !isClosedThread(t);

/** The board's filter: 'all', 'global', 'forge', 'this', or 'project:<id>'. */
/** "12 min", "3 h", "2 d": how long since the thread last moved. */
function age(at) {
  if (!at) return null;
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
}

/** Whose machine it runs on, in the badge's one place: this machine or another of yours. */
function MachineBadge({ thread }) {
  if (otherMachine(thread)) return html`<${DeviceBadge} thread=${thread} />`;
  return html`<span class="device-badge is-here" title="Runs on this machine">this machine</span>`;
}

/**
 * A card, as in concept-v4: project on top with the machine badge and ⋯ (Open, Another thread for
 * this, Pause, Archive …), the name, one status line (icon · status · age, the rail's line 2), what
 * it asks, one-tap answers, and its subagents folded in.
 */
/** The card whose Details drawer is open (its thread id), or null. */
const detailsOf = signal(null);

function Card({ thread, state, subagents = [] }) {
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
  const node = threadTree([thread])[0];
  const since = age(thread.meta?.lastActiveAt);
  const done = subagents.filter(
    (c) => categoryOf(threadState(c, { prompts: [] })) === 'done',
  ).length;
  return html`<article class="board-card" data-thread=${thread.threadId}>
    <div class="board-card-head">
      <span class="board-card-project">${project}</span>
      <span class="board-card-spacer"></span>
      <${MachineBadge} thread=${thread} />
      <button type="button" class="board-card-details" title="Details" aria-label=${`Details: ${threadName(thread)}`}
        onClick=${() => {
          detailsOf.value = thread.threadId;
        }}>ⓘ</button>
      <${ThreadActions} thread=${node} lead=${[
        { label: 'Open', onClick: open },
        {
          label: 'Another thread for this',
          onClick: () => createThread({ description: `Follow-up to: ${threadName(thread)}` }),
        },
      ]} />
    </div>
    <button class="board-card-title" onClick=${open} title="Open the thread">${threadName(thread)}</button>
    <div class="board-card-status">
      <${StatusIcon} state=${state} />
      <span class="board-card-kind">${statusText(thread, state) || (s?.kind ?? s?.label)}</span>
      ${since ? html`<span class="board-card-age">· ${since}</span>` : null}
    </div>
    ${ask ? html`<p class="board-card-ask">${ask.message}</p>` : null}
    ${
      choices.length
        ? html`<div class="board-card-actions">${choices.map(
            (o, i) => html`<button key=${o.id} class="proj-btn ${i === 0 ? 'proj-btn-ok' : ''}"
              onClick=${() => resolvePrompt(ask.id, o.id)}>${o.label}</button>`,
          )}</div>`
        : null
    }
    ${
      subagents.length
        ? html`<div class="board-card-subs">${subagents.length} subagent${subagents.length === 1 ? '' : 's'}${done ? ` · ${done} done` : ''}</div>`
        : null
    }
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
    <p class="incoming-card-what">${request.name}${request.full || request.operations.length ? ` · ${[...(request.full ? ['everything'] : []), ...request.operations].join(', ')}` : ''}</p>
    <p class="incoming-card-terms">${request.lifecycle} · ${allowance} · ${until}</p>
    <p class="incoming-card-note">Nothing runs until you accept it in Kingdom.</p>
    <div class="board-card-actions">
      <a class="proj-btn proj-btn-ok" href=${request.reviewUrl} target="_blank" rel="noopener">Review in Kingdom ↗</a>
    </div>
  </article>`;
}

/** Incoming: one compact line above the columns, opened to show the requests. */
/** Incoming: a button at the band's end that opens the requests as a popover (concept-v4). */
function Incoming() {
  const [open, setOpen] = useState(false);
  const requests = incoming.value;
  if (!requests.length) return null;
  return html`<span class="board-incoming" aria-label="Incoming requests">
    <button type="button" class="board-incoming-toggle" aria-expanded=${open} title="Requests to join, not yet accepted"
      onClick=${() => setOpen(!open)}>Incoming <span class="rail-pane-count">${requests.length}</span></button>
    ${
      open
        ? html`<div class="board-incoming-list" role="dialog" aria-label="Incoming requests">
            ${requests.map((r) => html`<${IncomingCard} key=${r.id} request=${r} />`)}
          </div>`
        : null
    }
  </span>`;
}

/** A card's Details: everything the card says, its subagents, and the same actions as its ⋯. */
function Details({ placed }) {
  const id = detailsOf.value;
  useEffect(() => {
    if (!id) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      detailsOf.value = null;
    };
    // Capture: Esc closes the drawer before any other binding sees it.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [id]);
  const p = placed.find((x) => x.thread.threadId === id);
  if (!p) return null;
  const { thread, state, subagents } = p;
  const s = STATES[state];
  const status = (t) => threadState(t, { prompts: [] });
  const open = () => {
    detailsOf.value = null;
    boardOpen.value = false;
    selectThread(thread.threadId);
  };
  const ask = prompts.value.find((q) => q.threadId === thread.threadId);
  return html`<aside class="board-details" aria-label="Details">
    <header>
      <span class="board-card-project">${thread.meta?.projectId ? (projects.value.find((x) => x.id === thread.meta.projectId)?.label ?? thread.meta.projectId) : 'Global'}</span>
      <${MachineBadge} thread=${thread} />
      <button type="button" class="board-details-close" aria-label="Close details" onClick=${() => {
        detailsOf.value = null;
      }}>✕</button>
    </header>
    <h3>${threadName(thread)}</h3>
    <div class="board-card-status"><${StatusIcon} state=${state} /><span>${statusText(thread, state) || (s?.kind ?? s?.label)}</span>${age(thread.meta?.lastActiveAt) ? html`<span class="board-card-age">· ${age(thread.meta.lastActiveAt)}</span>` : null}</div>
    ${ask ? html`<p class="board-card-ask">${ask.message}</p>` : null}
    ${thread.meta?.branch || thread.meta?.context?.branch ? html`<div class="board-details-row"><span>Branch</span><code>${thread.meta.branch ?? thread.meta.context.branch}</code></div>` : null}
    ${
      subagents.length
        ? html`<div class="board-details-subs"><b>Subagents · ${subagents.length}</b>${subagents.map(
            (c) =>
              html`<div key=${c.threadId} class="board-details-row"><${StatusIcon} state=${status(c)} /><span>${threadName(c)}</span></div>`,
          )}</div>`
        : null
    }
    <div class="board-details-actions">
      <button type="button" class="proj-btn proj-btn-ok" onClick=${open}>Open</button>
      <button type="button" class="proj-btn" onClick=${() => createThread({ description: `Follow-up to: ${threadName(thread)}` })}>Another thread for this</button>
      <button type="button" class="proj-btn" onClick=${() => executeAction('thread:pause', thread.threadId)}>Pause</button>
      <button type="button" class="proj-btn" onClick=${() => executeAction('thread:archive', thread.threadId)}>Archive</button>
    </div>
  </aside>`;
}

/** Quiet threads: paused, idle, snoozed (all neutral) or archived. Off the board unless asked for. */
const QUIET = new Set(['idle', 'archived']);

/** The Project chip's own entry for the Forge Master (it has no threads; it shows its card). */
const FORGE = '__forge';

export function Board() {
  const chips = boardFilter.value;
  const [showQuiet, setShowQuiet] = useState(false);
  // All · Yours · Shared (another party is a member), as the rail splits them.
  const [zone, setZone] = useState('all');
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
  // Subagents fold into their parent's card; the counts are top-level threads only.
  const open = allThreads.value.filter((t) => (showQuiet || OPEN(t)) && !subagentParentOf(t.meta));
  const isShared = (t) => (t.conversation?.members ?? 0) > 0;
  const inZone = (t) => zone === 'all' || (zone === 'shared') === isShared(t);
  const threads = open.filter((t) => inZone(t) && passesChips(chips, valuesOf, t));
  const place = (t) => {
    const children = allThreads.value.filter((c) => subagentParentOf(c.meta) === t.threadId);
    const state = threadState(t, {
      prompts: prompts.value.filter((p) => p.threadId === t.threadId),
      childrenWorking: children.some(
        (c) => categoryOf(threadState(c, { prompts: [] })) === 'working',
      ),
    });
    return { thread: t, state, cat: categoryOf(state), subagents: children };
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
      label: 'Machine',
      options: [...new Set([machine, ...open.map(valuesOf.device)])].map((d) =>
        option('device', d, d),
      ),
    },
  ];

  return html`<div class="board">
    <header class="board-band">
      <h2 class="board-title">Board</h2>
      <span class="board-zone" role="group" aria-label="Whose threads">
        ${[
          ['all', 'All', open.length],
          ['yours', 'Yours', open.filter((t) => !isShared(t)).length],
          ['shared', 'Shared', open.filter(isShared).length],
        ].map(
          ([id, label, n]) =>
            html`<button key=${id} type="button" aria-pressed=${zone === id} onClick=${() => setZone(id)}>${label}<span class="board-zone-count">${n}</span></button>`,
        )}
      </span>
      <span class="board-filter-label">Filter</span>
      <${FilterChips} groups=${groups} selected=${chips} onChange=${(next) => {
        boardFilter.value = next;
      }}>
        <button type="button" class="board-quiet-toggle" aria-pressed=${showQuiet} title="Paused, idle and archived threads"
          onClick=${() => setShowQuiet(!showQuiet)}>${showQuiet ? 'Hide' : 'Show'} quiet · ${quietCount}</button>
      <//>
      <${Incoming} />
    </header>
    <${Details} placed=${placed} />
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
            <span class="board-column-swatch"></span><span class="board-column-title">${col.title}</span>
            <span class="rail-pane-count">${cards.length + (forgeHere ? 1 : 0)}</span>
          </h3>
          <div class="board-frame">
            ${forgeHere ? html`<${ForgeMasterCard} />` : null}
            ${cards.map((p) => html`<${Card} key=${p.thread.threadId} thread=${p.thread} state=${p.state} subagents=${p.subagents} />`)}
            ${!cards.length && !forgeHere ? html`<div class="rail-empty">Nothing here.</div>` : null}
          </div>
        </section>`;
      })}
    </div>
    ${forge && !selfChatSending.value ? html`<div class="board-aside"><${ForgeMasterCard} /></div>` : null}
  </div>`;
}
