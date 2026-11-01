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

import { html, useState } from './lib.js';
import { allThreads, projects, prompts, selectThread, watchtowerOpen } from './store.js';
import { threadName } from './thread-labels.js';
import { categoryOf, subagentParentOf, threadState } from './thread-status.js';

export const STAGES = [
  ['idea', 'Idea · pain · bug'],
  ['discuss', 'Discussing'],
  ['aligned', 'Aligned'],
  ['planned', 'Planned'],
  ['progress', 'In progress'],
  ['review', 'Review · QA'],
  ['landed', 'Landed'],
];
const LANDED = new Set(['archived', 'completed', 'done']);

/** A thread's stage, from what it records. */
export function stageOf(thread, category) {
  const meta = thread.meta ?? {};
  if (LANDED.has(meta.status)) return 'landed';
  const refs = meta.context?.references ?? [];
  if (refs.some((r) => r.integration === 'github')) return 'review';
  if (category === 'working' || meta.context?.branch || meta.branch) return 'progress';
  if (category === 'queued') return 'planned';
  if ((thread.conversation?.members ?? 0) > 0 || category === 'attention') return 'discuss';
  return 'idea';
}

function Card({ item }) {
  const { thread, sources, people, blocked } = item;
  return html`<button type="button" class="wt-card ${blocked ? 'is-blocked' : ''}" title=${threadName(thread)}
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
    <span class="wt-who">${people.map((p) => html`<span key=${p} class=${p === 'You' ? 'is-me' : ''}>${p}</span>`)}<i>you're on it</i></span>
    ${blocked ? html`<span class="wt-blocked">Blocked · can't proceed</span>` : null}
  </button>`;
}

export function Watchtower() {
  const [kingdom, setKingdom] = useState('');
  const [project, setProject] = useState('');
  const [mine, setMine] = useState(false);
  const label = (id) => (id ? (projects.value.find((p) => p.id === id)?.label ?? id) : 'Global');
  const laneOf = (id) => {
    const p = projects.value.find((x) => x.id === id);
    return p?.tags?.[0] ?? 'This Foundry';
  };
  const items = allThreads.value
    .filter((t) => !subagentParentOf(t.meta))
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
      const category = categoryOf(state);
      const refs = thread.meta?.context?.references ?? [];
      const members = thread.conversation?.members ?? 0;
      return {
        thread,
        stage: stageOf(thread, category),
        lane: `${laneOf(thread.meta?.projectId)} › ${label(thread.meta?.projectId)}`,
        kingdom: laneOf(thread.meta?.projectId),
        projectId: thread.meta?.projectId ?? '',
        sources: {
          linear: refs.filter((r) => r.integration === 'linear').length,
          github: refs.filter((r) => r.integration === 'github').length,
          sessions: 1 + subagents.length,
        },
        people: members ? ['You', `+${members}`] : ['You'],
        blocked: category === 'problem',
      };
    })
    .filter((i) => !kingdom || i.kingdom === kingdom)
    .filter((i) => !project || i.projectId === project)
    // Every thread here is yours (Heralds would add teammates' work): Involves me keeps them all.
    .filter(() => !mine || true);
  const lanes = [...new Set(items.map((i) => i.lane))].sort();
  const kingdoms = [...new Set(projects.value.map((p) => p.tags?.[0] ?? 'This Foundry'))];

  return html`<section class="watchtower" aria-label="Watchtower">
    <header class="wt-head">
      <h2>Watchtower</h2><span class="wt-chip" title="A proposal: the name isn't decided">working name</span>
      <span class="wt-meta">What everyone is working on and talking about, by stage, so nobody duplicates it</span>
    </header>
    <div class="wt-filters">
      <span class="wt-label">Show</span>
      <button type="button" aria-pressed=${!kingdom && !project} onClick=${() => {
        setKingdom('');
        setProject('');
      }}>Everything</button>
      <select class="settings-input" value=${kingdom} onChange=${(e) => setKingdom(e.target.value)}>
        <option value="">Kingdom…</option>${kingdoms.map((k) => html`<option key=${k} value=${k}>${k}</option>`)}
      </select>
      <select class="settings-input" value=${project} onChange=${(e) => setProject(e.target.value)}>
        <option value="">Project…</option>${projects.value.map((p) => html`<option key=${p.id} value=${p.id}>${p.label}</option>`)}
      </select>
      <button type="button" aria-pressed=${mine} onClick=${() => setMine(!mine)}>Involves me</button>
    </div>
    <p class="wt-note">Mapped from this Foundry's threads. Slack, Linear and teammates' sessions arrive with the Heralds (not built); a stage is read from the thread (status, plan, branch, linked PR), and nothing marks a thread Aligned yet. Lanes use the project's first tag until projects record their Kingdom.</p>
    <div class="wt-grid" style=${`grid-template-columns: 170px repeat(${STAGES.length}, minmax(150px, 1fr))`}>
      <div class="wt-th"></div>${STAGES.map(([id, title]) => html`<div key=${id} class="wt-th">${title}</div>`)}
      ${lanes.map(
        (lane) =>
          html`<div key=${lane} class="wt-lane">${lane}</div>${STAGES.map(
            ([id]) =>
              html`<div key=${`${lane}:${id}`} class="wt-cell">${items
                .filter((i) => i.lane === lane && i.stage === id)
                .map((i) => html`<${Card} key=${i.thread.threadId} item=${i} />`)}</div>`,
          )}`,
      )}
    </div>
  </section>`;
}
