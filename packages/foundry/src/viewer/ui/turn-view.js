/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * One turn, read top to bottom in the centre, from the journal's turn timeline
 * (`GET /api/threads/:id/turns/:turnId/timeline`): what Foundry did before the agent ran (input,
 * routing, each region's answer layer by layer, the sealed plan, what was delivered), the agent's
 * own work (each tool call with its detail, handoffs), and what Foundry did after (guards,
 * writeback, feedback, Archive capture). Every step keeps its raw record.
 */

import { html, useEffect, useRef, useState } from './lib.js';
import { authFetch, chorusAction, closeTurnView, openTurnDetail, turnViewTarget } from './store.js';

const FILTERS = [
  ['all', 'All'],
  ['foundry', 'Foundry'],
  ['tools', 'Tools'],
  ['flags', 'Flags'],
];
const BEFORE = new Set(['input', 'route', 'chorus', 'plan', 'delivery']);
const WORK = new Set(['tool', 'handoff']);
const GROUPS = [
  ['before', 'Foundry, before'],
  ['work', "The agent's work"],
  ['after', 'Foundry, after'],
];
const LABELS = {
  input: 'Your message',
  route: 'Routing',
  chorus: 'Chorus',
  plan: 'Plan sealed',
  delivery: 'Delivered to the session',
  handoff: 'Handed to a subagent',
  guard: 'Guards',
  writeback: 'Writeback',
  feedback: 'Feedback captured',
  archive: 'Archive',
};

const text = (value) =>
  typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const clip = (value, max = 1200) => {
  const s = text(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
const time = (at) => (at ? new Date(at).toLocaleTimeString() : '');

/** Is the step worth a flag: an error, a refusal, a guard finding, a failed capture? */
function flagged(step) {
  if (step.kind === 'tool') return step.error;
  if (step.kind === 'guard')
    return step.failed.length > 0 || step.regions.some((r) => r.findings > 0);
  if (step.kind === 'chorus') return step.regions.some((r) => r.decision === 'error');
  if (step.kind === 'archive') return step.state === 'failed';
  return false;
}

/** The one-line summary beside a step's name. */
function summary(step) {
  switch (step.kind) {
    case 'input':
      return step.text;
    case 'route':
      return [step.status, step.domains.join(', ')].filter(Boolean).join(' · ');
    case 'chorus': {
      const spoke = step.regions.filter((r) => r.decision === 'contribute').length;
      return `${step.regions.length} regions asked · ${spoke} chimed in`;
    }
    case 'plan':
      return `${step.layers.length} layers${step.confidence != null ? ` · confidence ${step.confidence}` : ''}`;
    case 'delivery': {
      const sent = step.parts.filter((p) => p.outcome === 'sent').length;
      return `${sent} sent · ${step.parts.length - sent} already held · ${step.chimes.length} chimes`;
    }
    case 'tool':
      return text(step.input?.file_path ?? step.input?.command ?? step.input?.path ?? '').slice(
        0,
        90,
      );
    case 'handoff':
      return step.description ?? '';
    case 'guard':
      return `${step.status ?? ''}${step.failed.length ? ` · ${step.failed.length} failed` : ''}`;
    case 'writeback':
      return `${step.region} · ${step.decision}`;
    case 'feedback':
      return step.statement ?? '';
    case 'archive':
      return step.state;
    default:
      return '';
  }
}

/** A tool call's own detail: the edit as a diff, the command and its output, the file read. */
function ToolBody({ step }) {
  const input = step.input ?? {};
  const output = step.outputOmitted ? '(output not recorded)' : clip(step.output, 4000);
  if (/^(Edit|MultiEdit|Write|apply_patch)$/i.test(step.tool)) {
    const before = text(input.old_string ?? '');
    const after = text(input.new_string ?? input.content ?? '');
    return html`<div class="tv-typed">
      <div class="tv-path mono">${input.file_path ?? input.path ?? ''}</div>
      <pre class="tv-diff">${before ? before.split('\n').map((l, i) => html`<span key=${`d${i}`} class="tv-del">- ${l}\n</span>`) : null}${after
        .split('\n')
        .map((l, i) => html`<span key=${`a${i}`} class="tv-add">+ ${l}\n</span>`)}</pre>
    </div>`;
  }
  if (/^(Bash|shell|exec_command|local_shell)$/i.test(step.tool))
    return html`<div class="tv-typed">
      <pre class="tv-cmd mono">$ ${clip(input.command ?? input.cmd, 600)}</pre>
      ${output ? html`<pre class="tv-out mono">${output}</pre>` : null}
    </div>`;
  if (step.tool === 'TodoWrite' && Array.isArray(input.todos))
    return html`<ul class="tv-parts">${input.todos.map(
      (t, i) =>
        html`<li key=${i} data-outcome=${t.status === 'completed' ? 'sent' : 'held'}>${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'} ${t.content}</li>`,
    )}</ul>`;
  if (/^(Read|View)$/i.test(step.tool))
    return html`<div class="tv-typed">
      <div class="tv-path mono">${input.file_path ?? input.path ?? ''}</div>
      ${output ? html`<pre class="tv-out mono">${clip(output, 800)}</pre>` : null}
    </div>`;
  return html`<div class="tv-typed">
    ${Object.keys(input).length ? html`<pre class="tv-out mono">${clip(input, 600)}</pre>` : null}
    ${output ? html`<pre class="tv-out mono">${output}</pre>` : null}
  </div>`;
}

/** Each region's answer, layer by layer: recognise (yes / no and why), then confirm and pick. */
function ChorusBody({ step }) {
  const order = { contribute: 0, error: 1 };
  const regions = [...step.regions].sort(
    (a, b) => (order[a.decision] ?? 2) - (order[b.decision] ?? 2),
  );
  const quiet = Object.entries(step.skipped ?? {}).flatMap(([why, ids]) =>
    ids.map((id) => `${id} (${why})`),
  );
  return html`<div class="tv-typed">
    <ul class="tv-regions">${regions.map(
      (r) => html`<li key=${r.region} data-decision=${r.decision}>
        <b>${r.region}</b> <span class="tv-decision">${r.decision}</span>
        ${r.served ? html` <span class="tv-dim">${r.served.model}${r.served.effort ? ` · ${r.served.effort}` : ''}</span>` : null}
        ${r.layers.map(
          (layer) =>
            html`<div key=${layer.layer} class="tv-layer">Layer ${layer.layer} · ${layer.layer === 1 ? 'detection' : 'confirm and pick'}: ${layer.outcome ?? (layer.timedOut ? 'timed out' : layer.error ? 'error' : '—')}${layer.why ? ` — ${layer.why}` : ''}</div>`,
        )}
        ${r.pointer?.pointer ? html`<div class="tv-pointer">† ${r.pointer.shape === 'choose-one' ? 'Choose one: ' : ''}${r.pointer.pointer}${r.pointer.where ? ` · ${r.pointer.where}` : ''}${r.pointer.why ? ` — ${r.pointer.why}` : ''}</div>` : null}
        ${r.said.map((line, i) => html`<div key=${i} class="tv-said">${line}</div>`)}
        ${!r.layers.length && r.reason ? html`<div class="tv-dim">${r.reason}</div>` : null}
      </li>`,
    )}</ul>
    ${quiet.length || step.prefiltered.length ? html`<div class="tv-dim">Not asked: ${[...quiet, ...step.prefiltered.map((id) => `${id} (pre-filter)`)].join(', ')}</div>` : null}
  </div>`;
}

function DeliveryBody({ step }) {
  return html`<div class="tv-typed">
    ${step.session ? html`<div class="tv-dim">Session ${step.session === 'started' ? 'started (its system prompt carried the base)' : 'continuing'}</div>` : null}
    <ul class="tv-parts">${step.parts.map(
      (p) =>
        html`<li key=${p.id} data-outcome=${p.outcome}><span class="mono">${p.id}</span> ${p.outcome === 'sent' ? 'sent' : 'already in context, not sent again'}</li>`,
    )}</ul>
    ${step.chimes.map(
      (c, i) =>
        html`<div key=${i} class="tv-chime"><b>${c.region}</b> ${c.text}${c.saidBefore ? html` <span class="tv-dim">(already said at turn ${c.saidBefore.turnId})</span>` : null}</div>`,
    )}
  </div>`;
}

function GuardBody({ step }) {
  return html`<div class="tv-typed">
    <ul class="tv-regions">${step.regions.map(
      (
        r,
      ) => html`<li key=${r.region}><b>${r.region}</b> <span class="tv-decision">${r.status}</span>${r.findings ? ` · ${r.findings} findings` : ''}
        ${r.notes.map((n, i) => html`<div key=${i} class="tv-said">${n}</div>`)}</li>`,
    )}</ul>
    ${step.notes.map((n, i) => html`<div key=${i} class="tv-said">${n.severity}: ${n.description}${n.location ? ` (${n.location})` : ''}</div>`)}
    ${step.failed.length ? html`<div class="tv-dim">Failed: ${step.failed.join(', ')}</div>` : null}
  </div>`;
}

function Detail({ step }) {
  switch (step.kind) {
    case 'tool':
      return html`<${ToolBody} step=${step} />`;
    case 'chorus':
      return html`<${ChorusBody} step=${step} />`;
    case 'delivery':
      return html`<${DeliveryBody} step=${step} />`;
    case 'guard':
      return html`<${GuardBody} step=${step} />`;
    case 'route':
      return step.reason ? html`<div class="tv-dim">${step.reason}</div>` : null;
    case 'plan':
      return step.layers.length
        ? html`<div class="tv-dim">Layers: ${step.layers.join(', ')}</div>`
        : null;
    case 'writeback':
      return step.reason
        ? html`<div class="tv-dim">${step.reason}${step.revision != null ? ` · revision ${step.revision}` : ''}</div>`
        : null;
    case 'archive':
      return step.error ? html`<div class="tv-dim">${step.error}</div>` : null;
    default:
      return null;
  }
}

/** The timeline's steps, grouped and keyed. */
export function turnSteps(timeline) {
  return (timeline?.steps ?? []).map((step, i) => ({
    key: `${step.kind}:${i}`,
    group: BEFORE.has(step.kind) ? 'before' : WORK.has(step.kind) ? 'work' : 'after',
    label: step.kind === 'tool' ? step.tool : (LABELS[step.kind] ?? step.kind),
    step,
  }));
}

/** The thread's recorded calls inside the turn's window: its tokens, as Analytics records them. */
function useTurnTokens(target, timeline) {
  const [calls, setCalls] = useState(undefined);
  useEffect(() => {
    if (!target || !timeline?.startedAt) return;
    let live = true;
    authFetch(`/api/analytics/calls?field=threadId&value=${encodeURIComponent(target.threadId)}`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])
      .then((all) => {
        if (!live) return;
        const end = timeline.endedAt ?? Date.now();
        setCalls(
          (Array.isArray(all) ? all : []).filter(
            (c) => c.timestamp >= timeline.startedAt && c.timestamp <= end,
          ),
        );
      });
    return () => {
      live = false;
    };
  }, [target?.threadId, timeline?.startedAt, timeline?.endedAt]);
  return calls;
}

const callTokens = (c) =>
  (c.input ?? 0) + (c.output ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0);
const kTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The turn at a glance (design review 11-02): what it got, what it did, the Wardens, the cost. */
function TurnSummary({ steps, calls, took }) {
  const input = steps.find((s) => s.kind === 'input');
  const tools = steps.filter((s) => s.kind === 'tool');
  const edits = tools.filter((t) => /^(Edit|MultiEdit|Write|apply_patch)$/i.test(t.tool)).length;
  const reads = tools.filter((t) => /^(Read|View|Grep|Glob)$/i.test(t.tool)).length;
  const commands = tools.filter((t) =>
    /^(Bash|shell|exec_command|local_shell)$/i.test(t.tool),
  ).length;
  const handoffs = steps.filter((s) => s.kind === 'handoff').length;
  const chorus = steps.find((s) => s.kind === 'chorus');
  const regions = chorus?.regions ?? [];
  const spoke = regions.filter((r) => r.decision === 'contribute').length;
  const timedOut = regions.filter((r) => r.layers.some((l) => l.timedOut)).length;
  const tokens = (calls ?? []).reduce((n, c) => n + callTokens(c), 0);
  const did = [
    edits ? `${edits} edit${edits === 1 ? '' : 's'}` : null,
    reads ? `${reads} read${reads === 1 ? '' : 's'}` : null,
    commands ? `${commands} command${commands === 1 ? '' : 's'}` : null,
    handoffs ? `${handoffs} subagent${handoffs === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return html`<dl class="tv-summary" aria-label="Turn summary">
    <dt>Got</dt><dd>${input?.text ? clip(input.text, 160) : '—'}</dd>
    <dt>Did</dt><dd>${did.length ? did.join(' · ') : tools.length ? `${tools.length} tool call${tools.length === 1 ? '' : 's'}` : 'No tool calls'}</dd>
    <dt>Wardens</dt><dd>${regions.length ? `${regions.length} asked · ${spoke} chimed in${timedOut ? ` · ${timedOut} timed out` : ''}` : 'No chorus on this turn'}</dd>
    <dt>Cost</dt><dd>${calls === undefined ? 'Reading…' : calls.length ? `${kTokens(tokens)} tokens · ${calls.length} call${calls.length === 1 ? '' : 's'}${took ? ` · ${took}` : ''}` : `No recorded calls${took ? ` · ${took}` : ''}`}</dd>
  </dl>`;
}

/** Every Warden asked on the turn, one row each: its layers, what it said, timeouts with Retry. */
function WardenTable({ step, target }) {
  const regions = step?.regions ?? [];
  if (!regions.length) return null;
  const timedOut = regions.some((r) => r.layers.some((l) => l.timedOut));
  const order = { contribute: 0, error: 1 };
  const rows = [...regions].sort((a, b) => (order[a.decision] ?? 2) - (order[b.decision] ?? 2));
  const cell = (r, n) => {
    const l = r.layers.find((x) => x.layer === n);
    if (!l) return n === 1 && !r.layers.length ? r.decision : '—';
    return `${l.timedOut ? 'timed out' : (l.outcome ?? (l.error ? 'error' : '—'))}${l.elapsedMs != null ? ` · ${(l.elapsedMs / 1000).toFixed(1)} s` : ''}`;
  };
  return html`<section class="tv-wardens" aria-label="Wardens">
    <header><b>Wardens</b>${
      timedOut && target
        ? html`<button type="button" class="proj-btn" onClick=${() => chorusAction(target.threadId, target.turnId, 'retry')}
            title="Ask the Wardens that timed out again; what they say rides with your next message">Retry timed out</button>`
        : null
    }</header>
    <table>
      <thead><tr><th>Region</th><th>Layer 1 · detection</th><th>Layer 2 · confirm and pick</th><th>Pointer</th></tr></thead>
      <tbody>${rows.map(
        (
          r,
        ) => html`<tr key=${r.region} data-decision=${r.decision} class=${r.layers.some((l) => l.timedOut) ? 'is-timeout' : ''}>
          <td>${r.region}</td><td>${cell(r, 1)}</td><td>${cell(r, 2)}</td>
          <td>${r.pointer?.pointer ? `† ${r.pointer.pointer}${r.pointer.where ? ` · ${r.pointer.where}` : ''}` : ''}</td>
        </tr>`,
      )}</tbody>
    </table>
    <div class="tv-dim">Tokens per Warden and per step aren't recorded yet; the turn's total is above.</div>
  </section>`;
}

export function TurnView() {
  const target = turnViewTarget.value;
  const [timeline, setTimeline] = useState(undefined);
  const [filter, setFilter] = useState('all');
  const [at, setAt] = useState(0);
  const [raw, setRaw] = useState(() => new Set());
  const root = useRef(null);

  useEffect(() => {
    if (!target) return;
    let live = true;
    setTimeline(undefined);
    authFetch(
      `/api/threads/${encodeURIComponent(target.threadId)}/turns/${encodeURIComponent(target.turnId)}/timeline`,
      { cache: 'no-store' },
    )
      .then(async (res) =>
        res.ok
          ? res.json()
          : {
              error:
                res.status === 404
                  ? 'This turn is not in the thread’s journal.'
                  : res.status === 503
                    ? 'The history journal is unavailable.'
                    : `Turn unavailable (${res.status}).`,
            },
      )
      .catch((err) => ({ error: err.message }))
      .then((body) => live && setTimeline(body));
    return () => {
      live = false;
    };
  }, [target?.threadId, target?.turnId]);

  const all = turnSteps(timeline);
  const steps = all.filter((s) =>
    filter === 'all'
      ? true
      : filter === 'tools'
        ? s.step.kind === 'tool'
        : filter === 'flags'
          ? flagged(s.step)
          : s.group !== 'work',
  );
  const close = closeTurnView;
  useEffect(() => {
    root.current?.focus();
  }, [target?.turnId]);
  useEffect(() => {
    root.current?.querySelector(`[data-step-index="${at}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [at]);
  const onKeyDown = (e) => {
    if (e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAt((i) => Math.min(steps.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAt((i) => Math.max(0, i - 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const toggleRaw = (key) =>
    setRaw((current) => {
      const next = new Set(current);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const input = timeline?.steps?.find((s) => s.kind === 'input');
  const calls = useTurnTokens(target, timeline);
  const took =
    timeline?.startedAt && timeline?.endedAt
      ? `${((timeline.endedAt - timeline.startedAt) / 1000).toFixed(1)} s`
      : null;

  return html`<section class="turn-view" ref=${root} tabIndex="-1" onKeyDown=${onKeyDown} aria-label="Turn">
    <header class="tv-head">
      <button type="button" class="proj-btn tv-close" onClick=${close} title="Close the turn view (Esc)">✕ Close</button>
      <h2>Turn</h2>
      <span class="tv-input">${input?.text ?? ''}</span>
      <span class="tv-spacer"></span>
      ${timeline?.status ? html`<span class="tv-dim">${timeline.status}${took ? ` · ${took}` : ''}</span>` : null}
      ${target ? html`<button type="button" class="proj-btn" onClick=${() => openTurnDetail(target.threadId, target.turnId)}>Open in inspector</button>` : null}
    </header>
    <div class="tv-bar">
      <div class="tv-filters" role="tablist" aria-label="Show">
        ${FILTERS.map(
          ([id, label]) => html`<button key=${id} role="tab" aria-selected=${filter === id}
            class="tv-filter ${filter === id ? 'is-on' : ''}" onClick=${() => {
              setFilter(id);
              setAt(0);
            }}>${label}</button>`,
        )}
      </div>
      <span class="tv-hint"><kbd>↑</kbd><kbd>↓</kbd> steps · <kbd>Esc</kbd> close</span>
    </div>
    ${timeline?.error ? html`<div class="tv-error">${timeline.error}</div>` : null}
    ${timeline?.steps ? html`<${TurnSummary} steps=${all.map((s) => s.step)} calls=${calls} took=${took} />` : null}
    ${timeline?.steps ? html`<${WardenTable} step=${all.find((s) => s.step.kind === 'chorus')?.step} target=${target} />` : null}
    ${
      timeline === undefined
        ? html`<div class="rp-empty">Reading the turn…</div>`
        : timeline.error && !timeline.steps
          ? null
          : html`<ol class="tv-steps">${GROUPS.map(([group, title]) => {
              const mine = steps.filter((s) => s.group === group);
              if (!mine.length) return null;
              return html`<li key=${group} class="tv-group"><h3>${title}</h3><ol>${mine.map((s) => {
                const i = steps.indexOf(s);
                return html`<li key=${s.key} data-step-index=${i} class="tv-step ${i === at ? 'is-at' : ''}" data-status=${flagged(s.step) ? 'error' : 'ok'}
                  onClick=${() => setAt(i)}>
                  <div class="tv-step-head">
                    <span class="tv-dot"></span>
                    <b>${s.label}</b>
                    <span class="tv-sub">${summary(s.step)}</span>
                    <span class="tv-dim">${time(s.step.at)}</span>
                    <button type="button" class="tv-raw" aria-pressed=${raw.has(s.key)} onClick=${(
                      e,
                    ) => {
                      e.stopPropagation();
                      toggleRaw(s.key);
                    }}>Raw</button>
                  </div>
                  ${raw.has(s.key) ? html`<pre class="tv-out mono">${JSON.stringify(s.step, null, 2)}</pre>` : html`<${Detail} step=${s.step} />`}
                </li>`;
              })}</ol></li>`;
            })}</ol>`
    }
  </section>`;
}
