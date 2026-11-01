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
  createThread,
  executeAction,
  focusTurnId,
  messages,
  prompts,
  selectThread,
  threadData,
  threadStatusOf,
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
    </div>
    ${kids && open ? html`<ul class="plan-children">${step.children.map((c) => html`<${ChildNode} key=${c.threadId} child=${c} />`)}</ul>` : null}
  </li>`;
}

export function Plan() {
  const data = threadData.value;
  const threadId = activeThreadId.value;
  const flow = useFlowStream(threadId, !!threadId);
  if (!data || !threadId) return html`<div class="rp-empty">Open a thread to see its plan.</div>`;
  const meta = data.meta || {};
  const state = threadStatusOf(threadId, liveThreadStatus(messages.value));
  const lastAgent = [...messages.value].reverse().find((m) => m.actor === 'agent');
  const waiting = prompts.value.filter((p) => p.threadId === threadId);
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

    <section class="plan-checklist" aria-label="Plan">
      <header class="plan-section-head">
        <h3>Plan</h3>
        ${total ? html`<span class="rp-dim">${done} of ${total} done</span>` : null}
      </header>
      ${
        checklist.goals.length
          ? checklist.goals.map(
              (g) => html`<div key=${g.source} class="plan-goal">
                ${g.goal ? html`<div class="plan-goal-text">${g.goal}</div>` : null}
                <ul class="plan-steps">${g.steps.map((s) => html`<${Step} key=${s.text} step=${s} turnLabel=${turnLabel} />`)}</ul>
              </div>`,
            )
          : html`<div class="rp-dim">The agent hasn’t recorded a plan on this thread’s recent turns.</div>`
      }
      ${
        checklist.loose.length
          ? html`<div class="plan-goal">
              <div class="plan-goal-text">Child threads</div>
              <ul class="plan-children">${checklist.loose.map((c) => html`<${ChildNode} key=${c.threadId} child=${c} />`)}</ul>
            </div>`
          : null
      }
      <div class="plan-decisions rp-dim">
        Decisions join this list when the running thread summary is built; until then they are in the turns.
      </div>
    </section>

    <section class="plan-lifecycle" aria-label="Where the work stands">
      <${LifecycleStrip} turns=${turns} meta=${meta} onOpen=${() => {
        activePanel.value = 'graph';
      }} />
    </section>
  </article>`;
}
