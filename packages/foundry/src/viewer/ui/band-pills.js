/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * One pill group in the thread header. It never wraps: it takes the room it needs (the header's
 * grid gives the right-hand groups up to 70%), and when its pills still don't fit it scrolls
 * sideways with the wheel or trackpad, hides any pill the edge would cut (never clipped mid-word),
 * and shows "…", which lists every pill on hover or focus. Pills marked `band-drop` (the provider)
 * are hidden first, before anything overflows.
 */

import { html, useLayoutEffect, useRef, useState } from './lib.js';

/** Hide (whole) every pill that the group's visible edge, less the "…" button, would cut. */
const MORE_ROOM = 26;
function markCut(el, over) {
  const box = el.getBoundingClientRect();
  for (const pill of el.children) {
    const r = pill.getBoundingClientRect();
    const cut = over && (r.right > box.right - MORE_ROOM + 0.5 || r.left < box.left - 0.5);
    pill.classList.toggle('is-cut', cut);
  }
}

/** `render` returns the pills; it runs again for the "…" list while that is open. */
export function PillGroup({ className, label, render }) {
  const scroller = useRef(null);
  const [fit, setFit] = useState({ tight: false, over: false });
  const [listed, setListed] = useState(false);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const measure = () => {
      el.classList.remove('is-tight');
      const tight = el.scrollWidth > el.clientWidth + 1;
      el.classList.toggle('is-tight', tight);
      const over = el.scrollWidth > el.clientWidth + 1;
      setFit((prev) => (prev.tight === tight && prev.over === over ? prev : { tight, over }));
      markCut(el, over);
    };
    measure();
    const onScroll = () => markCut(el, el.scrollWidth > el.clientWidth + 1);
    el.addEventListener('scroll', onScroll, { passive: true });
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    for (const child of el.children) watch.observe(child);
    return () => {
      watch.disconnect();
      el.removeEventListener('scroll', onScroll);
    };
  });

  const onWheel = (event) => {
    if (!fit.over || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.currentTarget.scrollLeft += event.deltaY;
    event.preventDefault();
  };

  return html`<span class="band-group ${className} ${fit.over ? 'is-over' : ''}" aria-label=${label}>
    <span ref=${scroller} class="band-pills ${fit.tight ? 'is-tight' : ''}" onWheel=${onWheel}>${render()}</span>
    ${
      fit.over
        ? html`<span class="band-more" onMouseEnter=${() => setListed(true)} onMouseLeave=${() => setListed(false)}>
            <button type="button" class="band-more-button" aria-label=${`Show everything in ${label}`} aria-expanded=${listed}
              onFocus=${() => setListed(true)} onBlur=${() => setListed(false)}>…</button>
            ${listed ? html`<span class="band-more-list" role="tooltip">${render()}</span>` : null}
          </span>`
        : null
    }
  </span>`;
}
