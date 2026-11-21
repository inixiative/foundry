/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The side panels' sizes, in steps: left hidden · strip · normal · wide; right hidden · icons ·
 * normal · wide (the widest step was dropped, Aron 11-02). In the Projects view the left list is
 * one share wider, since it shows projects and the selected scope's threads side by side (Aron, 11-14). One symbol makes a side larger and one smaller, at every step; a control
 * disappears at its side's limit, and a strip shows only "larger". A hidden side keeps its grid
 * column at 0 width (the other panels never shift), with a slim restore tab mid-height on that edge.
 * `projectSidebarOpen` / `detailDrawerOpen` stay the "at least normal" view of these levels, so the
 * many places that open a panel keep working; the two are synced both ways here.
 */

import { computed, effect, html, signal } from './lib.js';
import { detailDrawerOpen, leftSize, projectSidebarOpen, railView, rightSize } from './store.js';
import { leftTabById } from './ui-registry.js';

export const LEFT_LEVELS = ['hidden', 'strip', 'normal', 'wide'];
export const RIGHT_LEVELS = ['hidden', 'icons', 'normal', 'wide'];
/**
 * Each open step is a share of the window, kept between a floor and a ceiling (Aron, 11-14: the
 * sides were "a little bit too big", fixed pixels that grew to over a third of a laptop screen).
 * The usual shares for side panels: a navigation list a fifth, a detail panel a quarter, nothing
 * past a third. Collapsed steps stay fixed.
 */
const LEFT_SHARE = { normal: [0.18, 240, 300], wide: [0.28, 400, 540] };
/**
 * The Projects view lays projects and threads side by side, so each of its steps is one wider; its
 * normal floor stays at 320 so a 1280 px laptop keeps the list open beside the centre and right panel.
 */
const PROJECTS_SHARE = { normal: [0.28, 320, 540], wide: [0.33, 480, 640] };
const RIGHT_SHARE = { normal: [0.25, 360, 480], wide: [0.33, 440, 640] };
const STRIP = 32;
const ICONS = 44;

const share = ([part, min, max], width) => Math.round(Math.min(max, Math.max(min, width * part)));
const leftWidth = (size, width, view) => {
  if (size === 'hidden') return 0;
  if (size === 'strip') return STRIP;
  const tab = leftTabById(view);
  const shares = tab?.wideShare || view === 'projects' ? PROJECTS_SHARE : LEFT_SHARE;
  return share(shares[size] ?? shares.normal, width);
};
const rightWidth = (size, width) =>
  size === 'hidden'
    ? 0
    : size === 'icons'
      ? ICONS
      : share(RIGHT_SHARE[size] ?? RIGHT_SHARE.normal, width);

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
 * How the sides fit beside a centre of at least 560 px, without changing the sizes you chose. The
 * Projects view's wider list only takes what the centre can spare, so picking Projects never folds
 * the rail; when an open rail and right panel still leave the centre too narrow, the rail folds to
 * its strip. The right panel never needs to float: its shares (at most a third of the window) always
 * fit beside the strip from 1100 px, and below that the workspace is tabs instead (styles.css).
 * Widening the window restores the layout you had.
 */
export const panelFit = computed(() => {
  // At 1700 px and up the app is zoomed 1.1 (styles.css), so it lays out in fewer pixels.
  const width = viewportWidth.value >= 1700 ? viewportWidth.value / 1.1 : viewportWidth.value;
  const right = rightWidth(rightSize.value, width);
  const base = leftWidth(leftSize.value, width, 'attention');
  let left = leftWidth(leftSize.value, width, railView.value);
  if (left > base) left = Math.max(base, Math.min(left, width - right - CENTRE_MIN));
  if (width < 1100) return { leftFolded: false, left, right };
  const leftFolded = left > STRIP && width - left - right < CENTRE_MIN;
  if (leftFolded) left = STRIP;
  return { leftFolded, left, right };
});

/** The grid columns for the workspace (the board and Watchtower span the width on their own). */
export function panelColumns() {
  const fit = panelFit.value;
  return `${fit.left}px minmax(0, 1fr) ${fit.right}px`;
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
 * points toward the panel's own edge, larger away from it, stacked narrow above widen on both
 * sides; each hides at its limit, and a strip (or icons) shows only larger.
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
  // Both sides stack the pair the same way, narrow above widen.
  return html`<span class="size-controls size-controls--${side}">${smallerBtn}${largerBtn}</span>`;
}

/** A hidden side's restore tab: slim, mid-height on that screen edge. */
export function RestoreTab({ side }) {
  const size = (side === 'left' ? leftSize : rightSize).value;
  if (size !== 'hidden') return null;
  return html`<button type="button" class="restore-tab restore-tab--${side}" aria-label=${side === 'left' ? 'Show the left list' : 'Show the right panel'}
    title=${side === 'left' ? 'Show the left list · ⌥⇧[' : 'Show the right panel · ⌥⇧]'} onClick=${() => stepSize(side, 1)}>
    <${EdgeIcon} side=${side} toward=${growsToward(side)} /></button>`;
}
