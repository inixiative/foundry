/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * One titled pane of the left rail: its head (title, count, the Attention dots of its threads, an
 * action) over a frame that scrolls on its own, holding a lead, then its rows or the empty line.
 */
import { Attention } from './attention.js';
import { html } from './lib.js';

export function Pane({
  title,
  count,
  children,
  empty,
  lead,
  nodes = [],
  action = null,
  className = '',
}) {
  return html`<section class=${`rail-pane ${className}`.trim()} aria-label=${title}>
    <h3 class="rail-pane-head"><span>${title}</span><span class="rail-pane-count">${count}</span><${Attention} nodes=${nodes} />${action}</h3>
    <div class="rail-frame">${lead ?? null}${count ? children : html`<div class="rail-empty">${empty}</div>`}</div>
  </section>`;
}
