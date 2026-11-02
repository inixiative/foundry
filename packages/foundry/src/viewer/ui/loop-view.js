/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Loop: the life of the work, then how each turn ran.
 *
 * A strip across the top places the thread on plan → build → review → land, from what is recorded
 * (a task list = planned; turns ran = building; guards ran or a pull request is linked = in review;
 * closed = landed). Then the agent's recorded loop (its goal, steps, stop check and rounds). Below
 * it, today's graph panel: the thread tree, each turn's flow and the learning loop.
 */
import { GraphPanel, useFlowStream } from './graph-view.js';
import { html, useState } from './lib.js';
import { lifecycle } from './lifecycle.js';
import { activeThreadId, allThreads, commentOn, focusTurnId, threadData } from './store.js';

/** The plan → build → review → land strip. `onOpen` (optional) makes it a link to the Loop tab. */
export function LifecycleStrip({ turns, meta, onOpen }) {
  const steps = lifecycle(turns, meta);
  return html`<ol class="lifecycle ${onOpen ? 'lifecycle--link' : ''}" aria-label="Where the work stands"
    onClick=${onOpen} title=${onOpen ? 'Open the Loop' : undefined}>
    ${steps.map(
      (
        s,
      ) => html`<li key=${s.id} class="lifecycle-step ${s.done ? 'is-done' : ''} ${s.current ? 'is-current' : ''}">
        <span class="lifecycle-mark"></span>${s.label}
      </li>`,
    )}
  </ol>`;
}

/** Warden pointers that reached this thread: one row per contributing domain per turn. */
function pointerRows(flow) {
  const rows = [];
  for (const turn of flow.turns ?? []) {
    const contributions = Array.isArray(turn.plan?.contributions) ? turn.plan.contributions : [];
    for (const c of contributions)
      if (c.decision === 'contribute')
        rows.push({
          key: `${turn.turnId}:${c.domain}`,
          turnId: turn.turnId,
          domain: c.domain,
          input: turn.input?.preview ?? '',
          snippets: Array.isArray(c.snippets)
            ? c.snippets.filter((s) => typeof s === 'string')
            : [],
          reason: c.reason ?? null,
        });
  }
  return rows.reverse();
}

function PointerLedger({ rows }) {
  if (!rows.length)
    return html`<div class="rp-empty loop-pointers-empty">
      No Warden has pointed at anything on this thread’s recent turns. When one does, its pointer
      (the rule or doc, and where it’s written) is listed here with the turn it came in.
    </div>`;
  return html`<ul class="rp-list">
    ${rows.map(
      (r) => html`<li key=${r.key} class="rp-pointer">
        <div class="rp-pointer-head">
          <span class="rp-pointer-domain">† ${r.domain}</span>
          <button type="button" class="comment-btn" title="Comment on this pointer"
            onClick=${() => commentOn({ kind: 'loop-item', label: `Loop › pointer: ${r.domain}`, turnId: r.turnId })}>Comment</button>
          <button class="rp-link" onClick=${() => {
            focusTurnId.value = r.turnId;
          }} title="Show the turn">turn ›</button>
        </div>
        ${r.snippets.map((s, i) => html`<div key=${i} class="rp-pointer-text">${s}</div>`)}
        ${!r.snippets.length && r.reason ? html`<div class="rp-pointer-text">${r.reason}</div>` : null}
        ${r.input ? html`<div class="rp-pointer-input" title="The message it answered">${r.input}</div>` : null}
      </li>`,
    )}
  </ul>`;
}

/** The pointer ledger, folded by default: it holds the flow stream only while it's open. */
function Pointers({ threadId }) {
  const [open, setOpen] = useState(false);
  const flow = useFlowStream(threadId, open && !!threadId);
  return html`<section class="loop-pointers">
    <button type="button" class="rp-section-title loop-pointers-toggle" aria-expanded=${open}
      onClick=${() => setOpen(!open)}>${open ? '▾' : '▸'} Pointers</button>
    ${open ? html`<${PointerLedger} rows=${pointerRows(flow)} />` : null}
  </section>`;
}

const ROUND_MARK = { pass: '✓', fail: '✗', partial: '◐' };
const LOOP_STATE = { running: 'Running', done: 'Done', stopped: 'Stopped' };

/** The agent's loop (set_loop / loop_round / stop_loop): its goal, one round's steps, the stop check, each round. */
export function RecordedLoop({ loop }) {
  if (!loop)
    return html`<section class="loop-record loop-record--empty" aria-label="The loop">
      <div class="rp-empty">No loop recorded. For work that takes several rounds of build, check and fix,
        the agent records its loop here (goal, steps, the check that ends it, and each round).
        Curated loops you can reuse are coming soon.</div>
    </section>`;
  const rounds = loop.rounds ?? [];
  return html`<section class="loop-record" aria-label="The loop" data-state=${loop.state}>
    <header class="plan-section-head">
      <h3>${loop.goal}</h3>
      <small>${LOOP_STATE[loop.state] ?? loop.state} · ${rounds.length}${loop.maxRounds ? ` of ${loop.maxRounds}` : ''} round${rounds.length === 1 ? '' : 's'}</small>
    </header>
    <ol class="loop-steps">${(loop.steps ?? []).map(
      (step, i) =>
        html`<li key=${i}><b>${step.text}</b>${step.detail ? html`<small>${step.detail}</small>` : null}</li>`,
    )}</ol>
    <div class="loop-until"><span class="plan-label">Until</span> ${loop.until}</div>
    ${
      rounds.length
        ? html`<ul class="loop-rounds">${rounds.map(
            (r) => html`<li key=${r.round} class="loop-round r-${r.result}">
              <span class="loop-round-mark" title=${r.result}>${ROUND_MARK[r.result] ?? ''}</span>
              <span class="loop-round-n">Round ${r.round}</span>
              <span class="loop-round-note">${r.note}</span>
            </li>`,
          )}</ul>`
        : null
    }
    ${loop.stopReason ? html`<div class="loop-stop"><span class="plan-label">${loop.state === 'done' ? 'Done' : 'Stopped'}</span> ${loop.stopReason}</div>` : null}
  </section>`;
}

export function LoopView({ onLayerClick }) {
  // From the thread's own fields: the flow stream is held only while a turn graph is shown.
  const data = threadData.value;
  const last =
    data?.lastTurn ?? allThreads.value.find((t) => t.threadId === activeThreadId.value)?.lastTurn;
  return html`<div class="loop-view">
    <${LifecycleStrip}
      turns=${last ? [{ status: last.status === 'running' ? 'active' : last.status }] : []}
      meta=${data?.meta} />
    <${RecordedLoop} loop=${data?.meta?.loop} />
    <div class="loop-graph"><${GraphPanel} onLayerClick=${onLayerClick} /></div>
    <${Pointers} threadId=${activeThreadId.value} />
  </div>`;
}
