/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Shared centered modal: a titled panel with a close (×) button, closed by Escape and, unless
 * `dismissOnBackdrop` is false, by a click on the backdrop.
 *
 * Usage:
 *   <${Modal} title="Add project" onClose=${close} class="proj-modal">...<//>
 */

import { html, useLayoutEffect, useRef } from './lib.js';

export function Modal({ title, onClose, dismissOnBackdrop = true, children, ...props }) {
  const close = useRef(onClose);
  close.current = onClose;
  // Layout effect: Escape works from the first painted frame, not one frame after (a deferred
  // effect left a modal that had just opened deaf to an immediate Escape).
  useLayoutEffect(() => {
    // Captured ahead of the global hotkeys, so Escape closes this modal and nothing else.
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  return html`
    <div
      class="overlay-backdrop modal-backdrop"
      onClick=${(event) => {
        if (dismissOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div class="modal-panel ${props.class ?? ''}" role="dialog" aria-modal="true" aria-label=${title}>
        <div class="modal-header">
          <span class="modal-title">${title}</span>
          <button type="button" class="fullscreen-close" onClick=${onClose} aria-label="Close">×</button>
        </div>
        ${children}
      </div>
    </div>
  `;
}
