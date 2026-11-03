/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The side panels' sizes, in steps: left hidden · strip · normal · wide; right hidden · icons ·
 * normal · wide (the widest step was dropped, Aron 11-02). One symbol makes a side larger and one smaller, at every step; a control
 * disappears at its side's limit, and a strip shows only "larger". A hidden side keeps its grid
 * column at 0 width (the other panels never shift), with a slim restore tab mid-height on that edge.
 * `projectSidebarOpen` / `detailDrawerOpen` stay the "at least normal" view of these levels, so the
 * many places that open a panel keep working; the two are synced both ways here.
 */

import { computed, effect, html, signal } from './lib.js';
import { detailDrawerOpen, leftSize, projectSidebarOpen, rightSize } from './store.js';

export const LEFT_LEVELS = ['hidden', 'strip', 'normal', 'wide'];
export const RIGHT_LEVELS = ['hidden', 'icons', 'normal', 'wide'];
const LEFT_WIDTH = { hidden: 0, strip: 32, normal: 272, wide: 360 };
const RIGHT_WIDTH = { hidden: 0, icons: 44, normal: 440, wide: 560 };

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

/** The window's width, kept current. */
export const viewportWidth = signal(window.innerWidth);
window.addEventListener('resize', () => {
  viewportWidth.value = window.innerWidth;
});

/** The centre never drops below this (design review 11-02, the narrow-screen rule). */
const CENTRE_MIN = 560;

/**
 * How the sides fit beside a centre of at least 560 px, without changing the sizes you chose: the
 * left list folds to its strip first; if that isn't enough, the right panel (the turn view with it)
 * floats over the centre as a drawer, keeping only its icon column. Below 1100 px the workspace is
 * tabs instead (styles.css), so this applies from there up. Closing or widening the window restores
 * the layout you had.
 */
export const panelFit = computed(() => {
  // At 1700 px and up the app is zoomed 1.1 (styles.css), so it lays out in fewer pixels.
  const width = viewportWidth.value >= 1700 ? viewportWidth.value / 1.1 : viewportWidth.value;
  let left = LEFT_WIDTH[leftSize.value] ?? 272;
  const right = RIGHT_WIDTH[rightSize.value] ?? 440;
  if (width < 1100) return { leftFolded: false, rightOverlay: false, left, right };
  const leftFolded = left > LEFT_WIDTH.strip && width - left - right < CENTRE_MIN;
  if (leftFolded) left = LEFT_WIDTH.strip;
  const rightOverlay = right > RIGHT_WIDTH.icons && width - left - right < CENTRE_MIN;
  return { leftFolded, rightOverlay, left, right };
});

/** The grid columns for the workspace (the board and Watchtower span the width on their own). */
export function panelColumns({ forge }) {
  const fit = panelFit.value;
  const right = forge ? 0 : fit.rightOverlay ? RIGHT_WIDTH.icons : fit.right;
  return `${fit.left}px minmax(0, 1fr) ${right}px`;
}

/**
 * A panel's inner edge with a chevron (the mockup's bracket): the bracket is the edge the panel
 * shares with the centre, and the chevron points where that edge moves. On the left list larger
 * points right, on the right panel larger points left: toward the centre the panel grows into.
 */
function EdgeIcon({ side, toward }) {
  const bar = side === 'left' ? 11.5 : 2.5;
  const hook = side === 'left' ? -1.5 : 1.5;
  const cx = toward === 'right' ? [6, 8, 6] : [8, 6, 8];
  return html`<svg class="edge-icon" data-toward=${toward} viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d=${`M${bar + hook} 2 H${bar} V12 H${bar + hook}`} /><path d=${`M${cx[0]} 4.5 L${cx[1]} 7 L${cx[2]} 9.5`} /></svg>`;
}

/** Larger moves a panel's inner edge toward the centre; smaller toward its screen edge. */
const growsToward = (side) => (side === 'left' ? 'right' : 'left');
const shrinksToward = (side) => side;

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
  const keySmall = side === 'left' ? '⌥[' : '⌥]';
  const keyLarge = side === 'left' ? '⌥⇧[' : '⌥⇧]';
  const name = side === 'left' ? 'left list' : 'right panel';
  // At its normal size the right panel's smaller step folds it to its icon column (the mockup's words).
  const smallerWord = side === 'right' && size === 'normal' ? 'Collapse to icons' : 'Narrow';
  const smallerBtn = smaller
    ? html`<button type="button" class="size-btn size-btn--smaller" aria-label=${`Make the ${name} smaller`} title=${`${smallerWord} · ${keySmall}`} onClick=${() => stepSize(side, -1)}>
      <${EdgeIcon} side=${side} toward=${shrinksToward(side)} /></button>`
    : null;
  const largerBtn = larger
    ? html`<button type="button" class="size-btn size-btn--larger" aria-label=${`Make the ${name} larger`} title=${`Widen · ${keyLarge}`} onClick=${() => stepSize(side, 1)}>
      <${EdgeIcon} side=${side} toward=${growsToward(side)} /></button>`
    : null;
  // Each control sits on the side it points to: the left list narrows left of widening, the right
  // panel widens left of narrowing.
  return html`<span class="size-controls size-controls--${side}">
    ${side === 'left' ? smallerBtn : largerBtn}${side === 'left' ? largerBtn : smallerBtn}
  </span>`;
}

/** A hidden side's restore tab: slim, mid-height on that screen edge. */
export function RestoreTab({ side }) {
  const size = (side === 'left' ? leftSize : rightSize).value;
  if (size !== 'hidden') return null;
  return html`<button type="button" class="restore-tab restore-tab--${side}" aria-label=${side === 'left' ? 'Show the left list' : 'Show the right panel'}
    title=${side === 'left' ? 'Show the left list · ⌥⇧[' : 'Show the right panel · ⌥⇧]'} onClick=${() => stepSize(side, 1)}>
    <${EdgeIcon} side=${side} toward=${growsToward(side)} /></button>`;
}
