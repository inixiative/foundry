/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The side panels' sizes, in steps: left hidden · strip · normal · wide; right hidden · icons ·
 * normal · wide · wider. One symbol makes a side larger and one smaller, at every step; a control
 * disappears at its side's limit, and a strip shows only "larger". A hidden side keeps its grid
 * column at 0 width (the other panels never shift), with a slim restore tab mid-height on that edge.
 * `projectSidebarOpen` / `detailDrawerOpen` stay the "at least normal" view of these levels, so the
 * many places that open a panel keep working; the two are synced both ways here.
 */

import { effect, html } from './lib.js';
import { detailDrawerOpen, leftSize, projectSidebarOpen, rightSize } from './store.js';

export const LEFT_LEVELS = ['hidden', 'strip', 'normal', 'wide'];
export const RIGHT_LEVELS = ['hidden', 'icons', 'normal', 'wide', 'wider'];
const LEFT_WIDTH = { hidden: 0, strip: 32, normal: 272, wide: 360 };
const RIGHT_WIDTH = { hidden: 0, icons: 44, normal: 360, wide: 560, wider: 760 };

export { leftSize, rightSize };

const open = (levels, size) => levels.indexOf(size) >= levels.indexOf('normal');

// Sizes → the open booleans, and an outside open/close → a size.
effect(() => {
  projectSidebarOpen.value = open(LEFT_LEVELS, leftSize.value);
});
effect(() => {
  detailDrawerOpen.value = open(RIGHT_LEVELS, rightSize.value);
});
effect(() => {
  const wantOpen = projectSidebarOpen.value;
  const size = leftSize.peek();
  if (wantOpen && !open(LEFT_LEVELS, size)) leftSize.value = 'normal';
  else if (!wantOpen && open(LEFT_LEVELS, size)) leftSize.value = 'strip';
});
effect(() => {
  const wantOpen = detailDrawerOpen.value;
  const size = rightSize.peek();
  if (wantOpen && !open(RIGHT_LEVELS, size)) rightSize.value = 'normal';
  else if (!wantOpen && open(RIGHT_LEVELS, size)) rightSize.value = 'icons';
});

/** Step a side one level smaller (-1) or larger (+1), stopping at its ends. */
export function stepSize(side, delta) {
  const levels = side === 'left' ? LEFT_LEVELS : RIGHT_LEVELS;
  const size = side === 'left' ? leftSize : rightSize;
  const i = Math.max(0, Math.min(levels.length - 1, levels.indexOf(size.peek()) + delta));
  size.value = levels[i];
}

/** The grid columns for the workspace (the board and Watchtower span the width on their own). */
export function panelColumns({ forge }) {
  const left = LEFT_WIDTH[leftSize.value] ?? 272;
  const right = forge ? 0 : (RIGHT_WIDTH[rightSize.value] ?? 360);
  return `${left}px minmax(0, 1fr) ${right}px`;
}

/** A panel edge with a chevron: `edge` is the side the panel sits on, `toward` where it moves. */
function EdgeIcon({ edge, toward }) {
  const x = edge === 'left' ? 2.5 : 13.5;
  const chevron = toward === 'left' ? 'M10 4.5 6.5 8 10 11.5' : 'M6 4.5 9.5 8 6 11.5';
  return html`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d=${`M${x} 2.5v11`} /><path d=${chevron} /></svg>`;
}

/**
 * A side's size controls, rendered once inside the panel (never patched in afterwards). Smaller
 * points toward the panel's own edge, larger away from it; each hides at its limit, and a strip
 * (or icons) shows only larger.
 */
export function SizeControls({ side }) {
  const levels = side === 'left' ? LEFT_LEVELS : RIGHT_LEVELS;
  const size = (side === 'left' ? leftSize : rightSize).value;
  const i = levels.indexOf(size);
  const collapsed = i <= 1;
  const smaller = !collapsed && i > 0;
  const larger = i < levels.length - 1;
  const keySmall = side === 'left' ? '[' : ']';
  const keyLarge = side === 'left' ? '{' : '}';
  const name = side === 'left' ? 'left list' : 'right panel';
  return html`<span class="size-controls size-controls--${side}">
    ${
      smaller
        ? html`<button type="button" class="size-btn" aria-label=${`Make the ${name} smaller`} title=${`Smaller (${keySmall})`} onClick=${() => stepSize(side, -1)}>
      <${EdgeIcon} edge=${side} toward=${side} /></button>`
        : null
    }
    ${
      larger
        ? html`<button type="button" class="size-btn" aria-label=${`Make the ${name} larger`} title=${`Larger (${keyLarge})`} onClick=${() => stepSize(side, 1)}>
      <${EdgeIcon} edge=${side} toward=${side === 'left' ? 'right' : 'left'} /></button>`
        : null
    }
  </span>`;
}

/** A hidden side's restore tab: slim, mid-height on that screen edge. */
export function RestoreTab({ side }) {
  const size = (side === 'left' ? leftSize : rightSize).value;
  if (size !== 'hidden') return null;
  return html`<button type="button" class="restore-tab restore-tab--${side}" aria-label=${side === 'left' ? 'Show the left list' : 'Show the right panel'}
    title=${side === 'left' ? 'Show the left list ({)' : 'Show the right panel (})'} onClick=${() => stepSize(side, 1)}>
    <${EdgeIcon} edge=${side} toward=${side === 'left' ? 'right' : 'left'} /></button>`;
}
