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

import { FilterChips, passesChips } from './filter-chips.js';
import { html, useEffect, useState } from './lib.js';
import { ActorChip, loadMachineProfile, machineIcon, machineProfile } from './machine-icons.js';
import { settingsConfig } from './settings.js';
import { allThreads, projects, prompts, selectThread, watchtowerOpen } from './store.js';
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
  ['here', 'This Mac', 'Work running on this machine'],
];

function Card({ item, machine }) {
  const { thread, sources, people } = item;
  return html`<button type="button" class="wt-card ${item.mine ? 'is-mine' : ''} ${item.stage === 'blocked' ? 'is-blocked' : ''}" title=${threadName(thread)}
    onClick=${() => {
      watchtowerOpen.value = false;
      selectThread(thread.threadId);
    }}>
    <b>${threadName(thread)}</b>
    <span class="wt-sources">${Object.entries(sources)
      .filter(([, n]) => n)
      .map(
        ([k, n]) =>
          html`<span key=${k} class="wt-src s-${k}">${k === 'github' ? 'GitHub' : k === 'linear' ? 'Linear' : 'Sessions'} ${n}</span>`,
      )}</span>
    <span class="wt-actors">
      ${item.mine ? html`<${ActorChip} person="You" machine=${machine} icon=${machineIcon()} me=${true} here=${true} />` : null}
      ${people.filter((p) => p !== 'You').map((p) => html`<${ActorChip} key=${p} person=${p} />`)}
    </span>
  </button>`;
}

export function Watchtower() {
  const [scope, setScope] = useState('everyone');
  const [chips, setChips] = useState({});
  useEffect(() => {
    loadMachineProfile();
  }, []);
  const machine =
    machineProfile.value?.installationName ?? settingsConfig.value?.installationName ?? 'this Mac';
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.target.closest?.('input, textarea, select, [contenteditable]'))
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
        // Every listed thread runs on this machine and is yours: the list has no other machine's threads yet.
        mine: true,
        device: machine,
      };
    });
  const valuesOf = {
    kingdom: (i) => i.kingdom,
    project: (i) => i.projectId,
    actors: (i) => i.people.filter((p) => !p.startsWith('+')),
    device: (i) => i.device,
  };
  const inScope = all.filter(
    (i) => scope === 'everyone' || (scope === 'mine' ? i.mine : i.device === machine),
  );
  const items = inScope.filter((i) => passesChips(chips, valuesOf, i));
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
      label: 'Device',
      options: options(
        'device',
        inScope.map((i) => i.device),
      ),
    },
  ];
  const lanes = [...new Set(items.map((i) => i.lane))].sort();
  const subtitle = SCOPES.find(([id]) => id === scope)[2];

  return html`<section class="watchtower" aria-label="Watchtower">
    <header class="wt-head">
      <h2>Watchtower</h2><span class="wt-chip" title="A proposal: the name isn't decided">working name</span>
      <span class="wt-meta">${subtitle}</span>
    </header>
    <div class="wt-wrap">
    <${WatchingSidebar} machine=${machine} />
    <div class="wt-main">
    <div class="wt-filters">
      <div class="wt-scope" role="tablist" aria-label="Whose work">
        ${SCOPES.map(
          ([
            id,
            title,
          ]) => html`<button key=${id} type="button" role="tab" aria-selected=${scope === id}
          onClick=${() => setScope(id)}>${title}</button>`,
        )}
      </div>
      <${FilterChips} groups=${groups} selected=${chips} onChange=${setChips} />
    </div>
    <p class="wt-note">Mapped from this Foundry's threads, all running on ${machine}: threads on your other machines, and Slack, Linear and teammates' work, arrive with the Heralds (not built). A stage is read from the thread (status, plan, branch, linked PR); nothing marks a thread Aligned yet. Lanes use the project's first tag until projects record their Kingdom.</p>
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
