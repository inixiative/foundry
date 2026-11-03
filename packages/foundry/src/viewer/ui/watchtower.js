/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Watchtower (working name): what is being worked on, by lifecycle stage, so nobody duplicates it.
 * Heralds would fill it from Slack, Linear, GitHub and teammates' sessions; they aren't built, so it
 * maps this Foundry's own threads. A thread's stage is read from what it records (status, plan,
 * branch, linked PRs, shared conversation); nothing records "aligned", so that column stays empty.
 */

import { ComingSoon, ticketUrl } from './coming-soon.js';
import { otherMachines } from './device-page.js';
import { FilterChips, passesChips } from './filter-chips.js';
import { html, useEffect, useState } from './lib.js';
import {
  ActorChip,
  loadMachineProfile,
  machineIcon,
  machineProfile,
  otherMachine,
} from './machine-icons.js';
import { settingsConfig } from './settings.js';
import {
  allThreads,
  projects,
  prompts,
  selectThread,
  watchtowerFilter,
  watchtowerOpen,
} from './store.js';
import { projectKingdom, threadName } from './thread-labels.js';
import { categoryOf, isClosedThread, subagentParentOf, threadState } from './thread-status.js';
import { WatchingSidebar } from './watching.js';

export const STAGES = [
  ['idea', 'Idea · pain · bug'],
  ['discuss', 'Discussing'],
  ['aligned', 'Aligned'],
  ['planned', 'Planned'],
  ['progress', 'In progress'],
  ['review', 'Review · QA'],
  ['blocked', 'Blocked'],
];

/** A thread's stage, from what it records; work that can't proceed is Blocked whatever its stage. */
export function stageOf(thread, category) {
  const meta = thread.meta ?? {};
  if (category === 'problem') return 'blocked';
  const refs = meta.context?.references ?? [];
  if (refs.some((r) => r.integration === 'github')) return 'review';
  if (category === 'working' || meta.context?.branch || meta.branch) return 'progress';
  if (category === 'queued') return 'planned';
  if ((thread.conversation?.members ?? 0) > 0 || category === 'attention') return 'discuss';
  return 'idea';
}

const SCOPES = [
  [
    'everyone',
    'Everyone',
    'What everyone is working on and talking about, by stage, so nobody duplicates it',
  ],
  ['mine', 'Involves me', "Work you're on, on any machine"],
];

function Card({ item, machine }) {
  const { thread, sources, people } = item;
  return html`<button type="button" class="wt-card ${item.mine ? 'is-mine' : ''} ${item.stage === 'blocked' ? 'is-blocked' : ''}" title=${threadName(thread)}
    onClick=${() => {
      watchtowerOpen.value = false;
      selectThread(thread.threadId);
    }}>
    <b>${threadName(thread)}</b>
    ${item.blockedAt ? html`<span class="wt-stage-tag" title="The stage it was blocked at">at ${STAGES.find(([id]) => id === item.blockedAt)?.[1] ?? item.blockedAt}</span>` : null}
    <span class="wt-sources">${Object.entries(sources)
      .filter(([, n]) => n)
      .map(
        ([k, n]) =>
          html`<span key=${k} class="wt-src s-${k}">${k === 'github' ? 'GitHub' : k === 'linear' ? 'Linear' : 'Sessions'} ${n}</span>`,
      )}</span>
    <span class="wt-actors">
      ${item.mine ? html`<${ActorChip} person="You" machine=${item.device} icon=${item.here ? machineIcon() : undefined} me=${true} here=${item.here} />` : null}
      ${people.filter((p) => p !== 'You').map((p) => html`<${ActorChip} key=${p} person=${p} />`)}
    </span>
  </button>`;
}

export function Watchtower() {
  const [scope, setScope] = useState('everyone');
  // What you watch (Kingdoms, projects, connectors, people) opens from the header (concept-v4).
  const [watchingOpen, setWatchingOpen] = useState(false);
  const chips = watchtowerFilter.value;
  const setChips = (next) => {
    watchtowerFilter.value = next;
  };
  useEffect(() => {
    loadMachineProfile();
  }, []);
  const machine =
    machineProfile.value?.installationName ?? settingsConfig.value?.installationName ?? 'this Mac';
  useEffect(() => {
    const onKey = (e) => {
      // The message box is where focus lives: Esc there closes Watchtower; another field keeps it.
      if (
        e.key !== 'Escape' ||
        e.target.closest?.('input, textarea:not(.chat-input), select, [contenteditable]')
      )
        return;
      watchtowerOpen.value = false;
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const label = (id) => (id ? (projects.value.find((p) => p.id === id)?.label ?? id) : 'Global');
  const kingdomOf = projectKingdom;
  const all = allThreads.value
    .filter((t) => !subagentParentOf(t.meta) && !isClosedThread(t))
    .map((thread) => {
      const subagents = allThreads.value.filter(
        (c) => subagentParentOf(c.meta) === thread.threadId,
      );
      const state = threadState(thread, {
        prompts: prompts.value.filter((p) => p.threadId === thread.threadId),
        childrenWorking: subagents.some(
          (c) => categoryOf(threadState(c, { prompts: [] })) === 'working',
        ),
      });
      const refs = thread.meta?.context?.references ?? [];
      const members = thread.conversation?.members ?? 0;
      return {
        thread,
        stage: stageOf(thread, categoryOf(state)),
        kingdom: kingdomOf(thread.meta?.projectId),
        projectId: thread.meta?.projectId ?? '',
        lane: `${kingdomOf(thread.meta?.projectId)} › ${label(thread.meta?.projectId)}`,
        sources: {
          linear: refs.filter((r) => r.integration === 'linear').length,
          github: refs.filter((r) => r.integration === 'github').length,
          sessions: 1 + subagents.length,
        },
        people: members ? ['You', `+${members}`] : ['You'],
        // Every listed thread is yours; it runs on this machine unless meta.machine names another.
        mine: true,
        device: otherMachine(thread)?.deviceName ?? machine,
        here: !otherMachine(thread),
        // Blocked work keeps the stage it was blocked at, shown as a tag in the Blocked column.
        blockedAt: categoryOf(state) === 'problem' ? stageOf(thread, null) : null,
      };
    });
  const valuesOf = {
    kingdom: (i) => i.kingdom,
    project: (i) => i.projectId,
    actors: (i) => i.people.filter((p) => !p.startsWith('+')),
    device: (i) => i.device,
  };
  const inScope = all.filter((i) => scope === 'everyone' || i.mine);
  const [blockedOnly, setBlockedOnly] = useState(false);
  const items = inScope.filter(
    (i) => passesChips(chips, valuesOf, i) && (!blockedOnly || i.stage === 'blocked'),
  );
  // The counts line (concept-v4): each count filters the map; collisions need the Heralds.
  const involve = all.filter((i) => i.mine).length;
  const blocked = all.filter((i) => i.stage === 'blocked');
  const machines = [...new Set(all.map((i) => i.device))];
  const activeMachines = new Set(all.map((i) => i.device)).size;
  const knownMachines = new Set([machine, ...otherMachines().map((m) => m.name)]);
  const pickMachine = (name) => {
    const current = new Set(chips.device ?? []);
    current.has(name) ? current.delete(name) : current.add(name);
    setChips({ ...chips, device: current });
  };
  const count = (group, value) =>
    inScope.filter((i) => [valuesOf[group](i)].flat().includes(value)).length;
  const options = (group, values) =>
    [...new Set(values)].map((v) => ({
      value: v,
      label: group === 'project' ? label(v) : v,
      count: count(group, v),
    }));
  const groups = [
    {
      id: 'kingdom',
      label: 'Kingdom',
      options: options(
        'kingdom',
        inScope.map((i) => i.kingdom),
      ),
    },
    {
      id: 'project',
      label: 'Project',
      options: options(
        'project',
        inScope.map((i) => i.projectId),
      ),
    },
    { id: 'actors', label: 'Actors', options: options('actors', inScope.flatMap(valuesOf.actors)) },
    {
      id: 'device',
      label: 'Machine',
      options: options(
        'device',
        inScope.map((i) => i.device),
      ),
    },
  ];
  const lanes = [...new Set(items.map((i) => i.lane))].sort();

  return html`<section class="watchtower" aria-label="Watchtower">
    <header class="wt-head">
      <h2>Watchtower</h2>
      <span class="wt-counts" role="group" aria-label="Counts">
        <button type="button" class="wt-count" aria-pressed=${scope === 'mine'} onClick=${() => setScope(scope === 'mine' ? 'everyone' : 'mine')}><b>${involve}</b> involve you</button>
        <button type="button" class="wt-count is-red" aria-pressed=${blockedOnly} onClick=${() => setBlockedOnly(!blockedOnly)}><b>${blocked.length}</b> blocked (${blocked.filter((i) => i.mine).length} on you)</button>
        <a class="wt-count is-soon" href=${ticketUrl('AGENT-001')} target="_blank" rel="noreferrer" title="Two pieces of work touching the same files, found by the Heralds">collisions · coming soon</a>
        <span class="wt-count is-dim"><b>${activeMachines}</b> of ${knownMachines.size} machine${knownMachines.size === 1 ? '' : 's'} active</span>
      </span>
      <span class="wt-head-spacer"></span>
      <span class="wt-watching-anchor">
        <button type="button" class="wt-watching-btn" aria-expanded=${watchingOpen} onClick=${() => setWatchingOpen(!watchingOpen)}>Watching ▾</button>
        ${watchingOpen ? html`<div class="wt-watching-pop"><${WatchingSidebar} machine=${machine} /></div>` : null}
      </span>
    </header>
    <div class="wt-wrap">
    <div class="wt-main">
    <div class="wt-machines" role="group" aria-label="Machines">
      <span class="wt-filter-label">Machines</span>
      ${[...knownMachines].map(
        (
          name,
        ) => html`<button key=${name} type="button" class="wt-machine ${machines.includes(name) ? '' : 'is-off'}" aria-pressed=${!!chips.device?.has(name)}
          title=${machines.includes(name) ? `Show only ${name}` : `${name}: nothing open on it here`} onClick=${() => pickMachine(name)}>${name === machine ? 'this machine' : name}</button>`,
      )}
    </div>
    <div class="wt-filters">
      <div class="wt-scope" role="tablist" aria-label="Whose work">
        ${SCOPES.map(
          ([
            id,
            title,
            about,
          ]) => html`<button key=${id} type="button" role="tab" aria-selected=${scope === id} title=${about}
          onClick=${() => setScope(id)}>${title}</button>`,
        )}
      </div>
      <span class="wt-filter-label">Filter</span>
      <${FilterChips} groups=${groups} selected=${chips} onChange=${setChips} />
    </div>
    <${ComingSoon} what="Threads on your other machines, and Slack, Linear and teammates' work, as cards on this map, brought in by the Heralds." ticket="AGENT-001" />
    <p class="wt-note">Mapped from this Foundry's threads, all running on ${machine}. A stage is read from the thread (status, plan, branch, linked PR); nothing marks a thread Aligned yet. Lanes use the project's first tag until projects record their Kingdom.</p>
    <div class="wt-grid" style=${`grid-template-columns: 170px repeat(${STAGES.length}, minmax(150px, 1fr))`}>
      <div class="wt-th"></div>${STAGES.map(([id, title]) => html`<div key=${id} class="wt-th ${id === 'blocked' ? 'is-blocked' : ''}">${title}</div>`)}
      ${lanes.map(
        (lane) =>
          html`<div key=${lane} class="wt-lane">${lane}</div>${STAGES.map(
            ([id]) =>
              html`<div key=${`${lane}:${id}`} class="wt-cell">${items
                .filter((i) => i.lane === lane && i.stage === id)
                .map(
                  (i) => html`<${Card} key=${i.thread.threadId} item=${i} machine=${machine} />`,
                )}</div>`,
          )}`,
      )}
    </div>
    </div>
    </div>
  </section>`;
}
