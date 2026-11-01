/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The Plan: what this thread is doing and where it stands, without scrolling the conversation.
 *
 * About first: what the work is, where it came from, what it is doing now and what waits on you.
 * Then the checklist: the agent's own plan (Claude's TodoWrite, Codex's update_plan) as recorded
 * turn by turn, each step with its status and the turn where it got there, child threads nested
 * under the step that spawned them. Then the plan → build → review → land strip, which opens Loop.
 * Decisions join the checklist when the running thread summary exists; it isn't built yet.
 */
import { useFlowStream } from './graph-view.js';
import { html, useState } from './lib.js';
import { liveThreadStatus, liveWorkLabel } from './live-state.js';
import { LifecycleStrip } from './loop-view.js';
import { buildChecklist, progress } from './plan-checklist.js';
import { STATES, StatusIcon } from './status-icons.js';
import {
  activePanel,
  activeThreadId,
  allThreads,
  commentOn,
  createThread,
  executeAction,
  focusTurnId,
  messages,
  selectThread,
  threadData,
  threadStatusOf,
  waitingFor,
} from './store.js';
import { ReferenceChips, threadName } from './thread-labels.js';
import { promptState } from './thread-status.js';

function Line({ label, children }) {
  return html`<div class="plan-line"><span class="plan-label">${label}</span><div class="plan-value">${children}</div></div>`;
}

const openTurn = (turnId) => {
  activePanel.value = 'conversation';
  focusTurnId.value = turnId;
};

function ChildNode({ child }) {
  return html`<li class="plan-child">
    <button class="rp-link plan-link" onClick=${() => selectThread(child.threadId)}>
      <${StatusIcon} state=${child.state} still=${true} /> ${child.name}
    </button>
  </li>`;
}

function Step({ step, turnLabel }) {
  const [open, setOpen] = useState(true);
  const kids = step.children.length;
  return html`<li class="plan-step" data-state=${step.state}>
    <div class="plan-step-row">
      ${
        kids
          ? html`<button class="plan-caret" aria-expanded=${open} aria-label=${open ? 'Collapse' : 'Expand'}
              onClick=${() => setOpen(!open)}>${open ? '▾' : '▸'}</button>`
          : html`<span class="plan-caret-space"></span>`
      }
      <${StatusIcon} state=${step.state} still=${true} />
      <span class="plan-step-text">${step.text}</span>
      ${
        step.when
          ? html`<button class="plan-when" title="Open this turn in Thread" onClick=${() => openTurn(step.when)}>${turnLabel(step.when)}</button>`
          : null
      }
      <button type="button" class="comment-btn" title="Comment on this step"
        onClick=${() => commentOn({ kind: 'plan-step', label: `Plan › ${step.text}`, ...(step.when ? { turnId: step.when } : {}) })}>Comment</button>
    </div>
    ${kids && open ? html`<ul class="plan-children">${step.children.map((c) => html`<${ChildNode} key=${c.threadId} child=${c} />`)}</ul>` : null}
  </li>`;
}

/** The technical plan's decisions, as chips. */
const DECISIONS = {
  reuse: ['Reuse', 'uses what exists as is'],
  extend: ['Extend', 'adds to an existing system'],
  new: ['New system', 'nothing fits; the reason says why'],
  combine: ['Combine', 'merges with other work'],
  refactor: ['Refactor', 'moves old code onto it'],
  migrate: ['Migrate after', 'a data change once this lands'],
  none: ['None', 'nothing to do'],
};
const MARK = { done: '✓', doing: '◐', you: '!' };

function PlanItem({ item, status }) {
  return html`<li class="plan-item">
    ${status ? html`<span class="plan-box s-${status}" title=${status === 'you' ? 'needs you' : status}>${MARK[status] ?? ''}</span>` : html`<span class="plan-dot"></span>`}
    <div><b>${item.text}</b>${item.detail ? html`<small>${item.detail}</small>` : null}</div>
  </li>`;
}

/** One section of the what and why; "not recorded yet" until the agent records it. */
function PlanSection({ title, sub, items }) {
  return html`<section class="plan-section" aria-label=${title}>
    <header class="plan-section-head"><h3>${title}</h3><small>${sub}</small></header>
    ${items?.length ? html`<ul class="plan-items">${items.map((it, i) => html`<${PlanItem} key=${i} item=${it} />`)}</ul>` : html`<div class="rp-dim">Not recorded yet.</div>`}
  </section>`;
}

export function Plan() {
  const data = threadData.value;
  const threadId = activeThreadId.value;
  const flow = useFlowStream(threadId, !!threadId);
  if (!data || !threadId) return html`<div class="rp-empty">Open a thread to see its plan.</div>`;
  const meta = data.meta || {};
  const state = threadStatusOf(threadId, liveThreadStatus(messages.value));
  const lastAgent = [...messages.value].reverse().find((m) => m.actor === 'agent');
  const waiting = waitingFor(threadId);
  const parent = meta.parentThreadId
    ? allThreads.value.find((t) => t.threadId === meta.parentThreadId)
    : null;
  const refs = meta.context?.references ?? [];
  const turns = flow.turns ?? [];
  const order = new Map(turns.map((t, i) => [t.turnId, i + 1]));
  const turnLabel = (turnId) => (order.has(turnId) ? `t${order.get(turnId)}` : 'turn');
  const children = allThreads.value
    .filter((t) => t.meta?.parentThreadId === threadId)
    .map((t) => ({
      threadId: t.threadId,
      name: threadName(t),
      state: threadStatusOf(t.threadId),
      parentTurnId: t.meta?.parentTurnId,
    }));
  const checklist = buildChecklist({ turns, children, needsYou: waiting.length > 0 });
  const { done, total } = progress(checklist);
  // The plan's what and why, once the agent records it on the thread (see PlanSection).
  const recorded = meta.plan ?? {};

  return html`<article class="plan">
    <section class="plan-about" aria-label="About">
      ${meta.description && meta.description !== threadName(data) ? html`<p class="plan-desc">${meta.description}</p>` : null}

      <${Line} label="From">
        ${parent ? html`<button class="rp-link plan-link" onClick=${() => selectThread(parent.threadId)}>Started from “${threadName(parent)}”</button>` : null}
        ${meta.spawn?.description ? html`<div>${meta.spawn.description}</div>` : null}
        ${refs.length ? html`<div class="plan-refs"><${ReferenceChips} meta=${meta} /></div>` : null}
        ${!parent && !meta.spawn && !refs.length ? html`<span class="rp-dim">You started it here.</span>` : null}
      </${Line}>

      <${Line} label="Now">
        <span class="plan-now"><${StatusIcon} state=${state} still=${true} /> ${STATES[state]?.label}${lastAgent?.streaming ? ` · ${liveWorkLabel(lastAgent)}` : ''}</span>
      </${Line}>

      ${
        waiting.length
          ? html`<${Line} label="Needs you">
            <ul class="plan-needs">${waiting.map(
              (p) => html`<li key=${p.id}>
                <${StatusIcon} state=${promptState(p)} still=${true} />
                <span>${p.message}</span>
                <button class="rp-link" onClick=${() => {
                  activePanel.value = 'conversation';
                }}>Answer in Thread</button>
              </li>`,
            )}</ul>
          </${Line}>`
          : null
      }
      <div class="plan-actions">
        <button class="proj-btn" onClick=${() => createThread({ description: `Follow-up to: ${threadName(data)}`, branch: meta.context?.branch ?? meta.branch ?? undefined })}>Start another thread for this</button>
        <button class="proj-btn" onClick=${() => executeAction('thread:archive', threadId)}>Close this thread</button>
      </div>
    </section>

    <p class="plan-intro">The plan is what you want and why${meta.plan?.updatedAt ? html`<span class="rp-dim"> · recorded by the agent ${new Date(meta.plan.updatedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>` : null}.
      <button type="button" class="rp-link" onClick=${() => {
        activePanel.value = 'graph';
      }}>The Loop is how it’s being done →</button></p>

    <section class="plan-section plan-checklist" aria-label="Your outcomes">
      <header class="plan-section-head">
        <h3>Your outcomes</h3><small>what done looks like</small>
        ${total ? html`<span class="rp-dim">${done} of ${total} done</span>` : null}
      </header>
      ${
        recorded.outcomes?.length
          ? html`<ul class="plan-items">${recorded.outcomes.map((o, i) => html`<${PlanItem} key=${i} item=${o} status=${o.status} />`)}</ul>`
          : checklist.goals.length
            ? checklist.goals.map(
                (g) => html`<div key=${g.source} class="plan-goal">
                  <ul class="plan-steps">${g.steps.map((s) => html`<${Step} key=${s.text} step=${s} turnLabel=${turnLabel} />`)}</ul>
                </div>`,
              )
            : html`<div class="rp-dim">The agent hasn’t recorded its steps on this thread’s recent turns.</div>`
      }
      ${
        checklist.loose.length
          ? html`<div class="plan-goal">
              <div class="plan-goal-text">Child threads</div>
              <ul class="plan-children">${checklist.loose.map((c) => html`<${ChildNode} key=${c.threadId} child=${c} />`)}</ul>
            </div>`
          : null
      }
    </section>

    <${PlanSection} title="Pain and friction" sub="what this removes" items=${recorded.pains} />
    <${PlanSection} title="Strategy" sub="how we’ll get there"
      items=${recorded.strategy?.length ? recorded.strategy : checklist.goals.filter((g) => g.goal).map((g) => ({ text: g.goal }))} />
    <${PlanSection} title="Reasons" sub="why this way, and not the alternatives" items=${recorded.reasons} />

    <section class="plan-section" aria-label="Technical plan">
      <header class="plan-section-head"><h3>Technical plan</h3><small>for each concern: the system it uses, and the decision</small></header>
      ${
        recorded.technical?.length
          ? html`<div class="plan-tech">${recorded.technical.map(
              (r, i) => html`<div key=${i} class="plan-tech-row">
                <span class="plan-tech-concern">${r.concern}</span>
                <span class="plan-decision d-${r.decision}" title=${DECISIONS[r.decision]?.[1] ?? ''}>${DECISIONS[r.decision]?.[0] ?? r.decision}</span>
                <span class="plan-tech-system"><code class="cmd">${r.system}</code>${r.path ? html`<small>${r.path}</small>` : null}</span>
                <span class="plan-tech-reason">${r.reason}</span>
              </div>`,
            )}</div>`
          : html`<div class="rp-dim">Not recorded yet. Each concern will show its decision (${Object.values(
              DECISIONS,
            )
              .map(([w]) => w)
              .join(' · ')}), the system it uses and where it lives, and why.</div>`
      }
    </section>

    <section class="plan-lifecycle" aria-label="Where the work stands">
      <${LifecycleStrip} turns=${turns} meta=${meta} onOpen=${() => {
        activePanel.value = 'graph';
      }} />
    </section>
  </article>`;
}
