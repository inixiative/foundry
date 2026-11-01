/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Status icons: colour = category, the cut-out symbol = the state within it.
 *
 * Every status is one solid rounded tile in its category colour with a symbol knocked out of it
 * (Aron, 2026-11-01: "big, thick things, not really outlines, where the images are cut out"; at most
 * three symbols per colour). The words live in the tooltip and the legend, never on the row.
 * Colours come from tokens.css (--status-*). Only needs-you and working move, and both stop under
 * prefers-reduced-motion.
 */
import { html } from './lib.js';

const KNOCK = 'var(--bg)';
const TILE =
  'M3.6 1h6.8A2.6 2.6 0 0 1 13 3.6v6.8A2.6 2.6 0 0 1 10.4 13H3.6A2.6 2.6 0 0 1 1 10.4V3.6A2.6 2.6 0 0 1 3.6 1Z';
const cut = (d, w = 1.7, cls = '') =>
  `<path${cls ? ` class="${cls}"` : ''} d="${d}" stroke="${KNOCK}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;

/** The cut-outs: a small set reused across colours. */
const CUTS = {
  bars:
    cut('M4.6 4.4v5.2', 1.6, 'eq') +
    cut('M7 4.4v5.2', 1.6, 'eq d2') +
    cut('M9.4 4.4v5.2', 1.6, 'eq d3'),
  branch: cut('M4.6 3.8v6.4M4.6 7h1.6c1.4 0 1.4-3 3.2-3M6.2 7c1.4 0 1.4 3 3.2 3', 1.5),
  notch: `<path d="M8.6 .4h5v5Z" fill="${KNOCK}"/>` + cut('M4.4 8h.01M7 8h.01M9.6 8h.01', 2),
  down: `<g class="drop">${cut('M7 3.4v4.6M4.9 6 7 8.1 9.1 6', 1.6)}</g>` + cut('M4 10.4h6', 1.5),
  ask: cut('M5.4 5.2a1.6 1.6 0 1 1 2.3 1.4c-.5.3-.7.6-.7 1.2', 1.6) + cut('M7 10h.01', 2.1),
  person: `<path d="M7 3.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6ZM3.8 10.8c.4-1.8 1.7-2.9 3.2-2.9s2.8 1.1 3.2 2.9Z" fill="${KNOCK}"/>`,
  bang: cut('M7 3.6v4.2', 1.9) + cut('M7 10.2h.01', 2.2),
  lock:
    cut('M5.3 6.4V5.3a1.7 1.7 0 0 1 3.4 0v1.1', 1.4) +
    `<rect x="4.2" y="6.2" width="5.6" height="4.2" rx=".9" fill="${KNOCK}"/>`,
  lines: cut('M4.2 4.9h5.6M4.2 7.1h5.6M4.2 9.3h3.4', 1.4),
  check: cut('M4.2 7.2 6.1 9.1 9.9 5', 1.8),
  dash: cut('M4.3 7h5.4', 1.9),
  pause: cut('M5.5 4.5v5M8.5 4.5v5', 1.9),
  box: cut('M3.2 5.3h7.6', 1.3) + cut('M5.8 8h2.4', 1.7),
};

/** The colour categories, most urgent first: that order decides which state a row shows. */
export const CATEGORIES = [
  {
    id: 'problem',
    token: '--st-problem',
    name: 'Red',
    means: 'Broken: it can’t go on without help.',
  },
  {
    id: 'attention',
    token: '--st-attention',
    name: 'Orange',
    means: 'Needs your attention. Not an error.',
  },
  { id: 'working', token: '--st-working', name: 'Green', means: 'Working.' },
  { id: 'queued', token: '--st-queued', name: 'Light yellow', means: 'Queued: it will run.' },
  { id: 'done', token: '--st-done', name: 'Light blue', means: 'Done.' },
  {
    id: 'idle',
    token: '--st-idle',
    name: 'Neutral',
    means: 'Resting: not working, nothing needs you.',
  },
  {
    id: 'archived',
    token: '--st-archived',
    name: 'Charcoal',
    means: 'Archived: off your attention.',
  },
];

/** Every state: its category, its cut-out and the words for the tooltip and legend. */
export const STATES = {
  error: { cat: 'problem', cut: 'bang', label: 'Failed' },
  blocked: { cat: 'problem', cut: 'lock', label: 'Blocked: missing permission or credential' },
  newarrival: { cat: 'attention', cut: 'down', label: 'New arrival', kind: 'New arrival' },
  approve: {
    cat: 'attention',
    cut: 'ask',
    label: 'Waiting for your approval',
    kind: 'The agent asks',
  },
  question: {
    cat: 'attention',
    cut: 'ask',
    label: 'The agent asks you something',
    kind: 'The agent asks',
  },
  held: { cat: 'attention', cut: 'ask', label: 'A reply is held for you', kind: 'The agent asks' },
  request: {
    cat: 'attention',
    cut: 'person',
    label: 'A request from someone',
    kind: 'Coworker request',
  },
  working: { cat: 'working', cut: 'bars', label: 'Working' },
  starting: { cat: 'working', cut: 'bars', label: 'Starting' },
  subagents: { cat: 'working', cut: 'branch', label: 'Subagents working' },
  waitother: { cat: 'working', cut: 'notch', label: 'In motion, not by you' },
  queued: { cat: 'queued', cut: 'lines', label: 'Queued' },
  done: { cat: 'done', cut: 'check', label: 'Done' },
  idle: { cat: 'idle', cut: 'dash', label: 'Idle' },
  paused: { cat: 'idle', cut: 'pause', label: 'Paused' },
  archived: { cat: 'archived', cut: 'box', label: 'Archived' },
};

const tokenOf = (cat) => CATEGORIES.find((c) => c.id === cat)?.token ?? '--st-idle';

/** The SVG for a state, as a string (static, ours: safe to inline). */
export function statusSvg(state) {
  const s = STATES[state] ?? STATES.idle;
  const halo =
    s.cat === 'attention'
      ? `<path class="halo" d="${TILE}" fill="none" stroke="var(${tokenOf(s.cat)})" stroke-width="1.1"/>`
      : '';
  return `<svg class="ic ic-${s.cat}" viewBox="0 0 14 14" aria-hidden="true">${halo}<path d="${TILE}" fill="var(${tokenOf(s.cat)})"/>${CUTS[s.cut]}</svg>`;
}

/** One status icon. `label` overrides the state's words in the tooltip. */
export function StatusIcon({ state, label, still = false }) {
  const s = STATES[state] ?? STATES.idle;
  const words = label ?? s.label;
  return html`<span
    class="status-icon ${still ? 'is-still' : ''}"
    role="img"
    aria-label=${words}
    title=${words}
    data-state=${state}
    dangerouslySetInnerHTML=${{ __html: statusSvg(state) }}
  ></span>`;
}

/** The legend: each colour, what it means, and its states. */
export function StatusLegend() {
  return html`<div class="status-legend">
    ${CATEGORIES.map(
      (c) => html`<div key=${c.id} class="status-legend-row">
        <span class="status-legend-swatch" style=${`background: var(${c.token})`}></span>
        <span class="status-legend-name">${c.name}</span>
        <span class="status-legend-means">${c.means}</span>
        <span class="status-legend-states">
          ${Object.entries(STATES)
            .filter(([, s]) => s.cat === c.id)
            .map(
              ([k, s]) =>
                html`<span key=${k} class="status-legend-state"><${StatusIcon} state=${k} still=${true} /> ${s.label}</span>`,
            )}
        </span>
      </div>`,
    )}
  </div>`;
}
