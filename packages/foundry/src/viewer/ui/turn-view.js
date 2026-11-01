/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * One turn, read top to bottom in the centre: what Foundry did before the agent ran (input, routing,
 * each region's answer, the sealed plan), the agent's own work (each tool call with its detail), and
 * what Foundry did after (guards, delivery, writeback, feedback). Steps come from the same builder as
 * the Loop's turn graph (`turnFlowGraph`), so the two never disagree; every step keeps its raw record.
 */

import { turnFlowGraph } from './flow-graph.js';
import { useFlowStream } from './graph-view.js';
import { html, useEffect, useRef, useState } from './lib.js';
import { openTurnDetail, turnViewTarget } from './store.js';

const FILTERS = [
  ['all', 'All'],
  ['foundry', 'Foundry'],
  ['tools', 'Tools'],
  ['flags', 'Flags'],
];
const FLAGGED = new Set(['warn', 'error', 'blocked', 'deny', 'fail']);

const text = (value) =>
  typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const clip = (value, max = 1200) => {
  const s = text(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** A tool call's own detail: the edit as a diff, the command and its output, the file read. */
function ToolBody({ use }) {
  const input = use.toolInput ?? {};
  const output = use.toolOutputOmitted ? '(output not recorded)' : clip(use.toolOutput);
  const name = use.toolName ?? 'tool';
  if (/^(Edit|MultiEdit|Write|apply_patch)$/i.test(name)) {
    const path = input.file_path ?? input.path ?? '';
    const before = input.old_string ?? '';
    const after = input.new_string ?? input.content ?? '';
    return html`<div class="tv-typed">
      <div class="tv-path mono">${path}</div>
      <pre class="tv-diff">${text(before)
        .split('\n')
        .filter((l) => l !== '' || before)
        .map((l, i) => html`<span key=${`d${i}`} class="tv-del">- ${l}\n</span>`)}${text(after)
        .split('\n')
        .map((l, i) => html`<span key=${`a${i}`} class="tv-add">+ ${l}\n</span>`)}</pre>
    </div>`;
  }
  if (/^(Bash|shell|exec|local_shell)$/i.test(name)) {
    return html`<div class="tv-typed">
      <pre class="tv-cmd mono">$ ${clip(input.command ?? input.cmd, 600)}</pre>
      ${output ? html`<pre class="tv-out mono">${output}</pre>` : null}
    </div>`;
  }
  if (/^(Read|View)$/i.test(name)) {
    return html`<div class="tv-typed">
      <div class="tv-path mono">${input.file_path ?? input.path ?? ''}</div>
      ${output ? html`<pre class="tv-out mono">${clip(output, 800)}</pre>` : null}
    </div>`;
  }
  return html`<div class="tv-typed">
    ${Object.keys(input).length ? html`<pre class="tv-out mono">${clip(input, 600)}</pre>` : null}
    ${output ? html`<pre class="tv-out mono">${output}</pre>` : null}
  </div>`;
}

/** The turn as ordered steps: Foundry before, the agent's work, Foundry after. */
export function turnSteps(turn) {
  if (!turn) return [];
  const graph = turnFlowGraph(turn);
  const executor = graph.nodes.find((n) => n.kind === 'executor');
  const cut = executor?.col ?? Number.POSITIVE_INFINITY;
  const order = [...graph.nodes]
    .filter((n) => n.kind !== 'more' && n.kind !== 'folded')
    .sort((a, b) => a.col - b.col || (a.row ?? 0) - (b.row ?? 0));
  const node = (n, group) => ({
    key: n.id,
    group,
    kind: n.kind,
    label: n.label,
    sub: n.sub ?? '',
    status: n.status ?? 'ok',
    detail: n.detail ?? null,
    raw: n.detail ?? n,
  });
  const before = order.filter((n) => n.col < cut).map((n) => node(n, 'before'));
  const after = order.filter((n) => n.col > cut).map((n) => node(n, 'after'));
  const uses = (Array.isArray(turn.toolUses) ? turn.toolUses : []).filter((u) => u.toolName);
  const work = [
    ...(executor ? [node(executor, 'work')] : []),
    ...uses.map((use, i) => ({
      key: `tool:${use.callId ?? i}`,
      group: 'work',
      kind: 'tool',
      label: use.toolName,
      sub: text(
        use.toolInput?.file_path ?? use.toolInput?.command ?? use.toolInput?.path ?? '',
      ).slice(0, 80),
      status: use.toolError || use.nativeOutcome === 'failed' ? 'error' : 'ok',
      use,
      raw: use,
    })),
  ];
  return [...before, ...work, ...after];
}

const GROUPS = [
  ['before', 'Foundry, before'],
  ['work', "The agent's work"],
  ['after', 'Foundry, after'],
];

function Detail({ step }) {
  if (step.use) return html`<${ToolBody} use=${step.use} />`;
  const entries = step.detail && typeof step.detail === 'object' ? Object.entries(step.detail) : [];
  const shown = entries.filter(
    ([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length),
  );
  if (!shown.length) return null;
  // Epoch milliseconds read as a time of day.
  const show = (v) =>
    typeof v === 'number' && v > 1e12 ? new Date(v).toLocaleTimeString() : clip(v, 400);
  return html`<dl class="tv-dl">${shown.map(
    ([k, v]) => html`<div key=${k}><dt>${k}</dt><dd>${show(v)}</dd></div>`,
  )}</dl>`;
}

export function TurnView() {
  const target = turnViewTarget.value;
  const flow = useFlowStream(target?.threadId ?? null, !!target);
  const [filter, setFilter] = useState('all');
  const [at, setAt] = useState(0);
  const [raw, setRaw] = useState(() => new Set());
  const root = useRef(null);
  const turns = flow.turns ?? [];
  const index = turns.findIndex((t) => t.turnId === target?.turnId);
  const turn = index >= 0 ? turns[index] : null;
  const all = turnSteps(turn);
  const steps = all.filter((s) =>
    filter === 'all'
      ? true
      : filter === 'tools'
        ? s.kind === 'tool'
        : filter === 'flags'
          ? FLAGGED.has(s.status)
          : s.group !== 'work',
  );
  const close = () => {
    turnViewTarget.value = null;
  };

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

  return html`<section class="turn-view" ref=${root} tabIndex="-1" onKeyDown=${onKeyDown} aria-label="Turn">
    <header class="tv-head">
      <button type="button" class="proj-btn" onClick=${close} title="Back to the thread (Esc)">← Thread</button>
      <h2>Turn ${index >= 0 ? index + 1 : ''}</h2>
      <span class="tv-input">${turn?.input?.preview ?? ''}</span>
      <span class="tv-spacer"></span>
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
      <span class="tv-hint"><kbd>↑</kbd><kbd>↓</kbd> steps · <kbd>Esc</kbd> back</span>
    </div>
    ${
      !turn
        ? html`<div class="rp-empty">${flow.turns ? 'This turn is outside the thread’s recent window.' : 'Reading the turn…'}</div>`
        : html`<ol class="tv-steps">${GROUPS.map(([group, title]) => {
            const mine = steps.filter((s) => s.group === group);
            if (!mine.length) return null;
            return html`<li key=${group} class="tv-group"><h3>${title}</h3><ol>${mine.map((s) => {
              const i = steps.indexOf(s);
              return html`<li key=${s.key} data-step-index=${i} class="tv-step ${i === at ? 'is-at' : ''}" data-status=${s.status}
                onClick=${() => setAt(i)}>
                <div class="tv-step-head">
                  <span class="tv-dot"></span>
                  <b>${s.label}</b>
                  <span class="tv-sub">${s.sub}</span>
                  <button type="button" class="tv-raw" aria-pressed=${raw.has(s.key)} onClick=${(
                    e,
                  ) => {
                    e.stopPropagation();
                    toggleRaw(s.key);
                  }}>Raw</button>
                </div>
                ${raw.has(s.key) ? html`<pre class="tv-out mono">${JSON.stringify(s.raw, null, 2)}</pre>` : html`<${Detail} step=${s} />`}
              </li>`;
            })}</ol></li>`;
          })}</ol>`
    }
  </section>`;
}
