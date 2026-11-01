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

import { html, useLayoutEffect, useRef, useState } from './lib.js';

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

/** A small rename window: one field (and any extra content), ✕ Cancel and ✓ Save; Enter saves, Escape cancels. */
export function RenameModal({ title, value, label = 'Name', onSave, onClose, children }) {
  const [draft, setDraft] = useState(value ?? '');
  const save = async () => {
    const next = draft.trim();
    if (!next || next === value) return onClose();
    if ((await onSave(next)) !== false) onClose();
  };
  return html`<${Modal} title=${title} onClose=${onClose} class="rename-modal">
    <input class="rename-input" aria-label=${label} value=${draft}
      onInput=${(e) => setDraft(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === 'Enter') save();
      }}
      ref=${(el) => {
        if (el && !el.dataset.focused) {
          el.dataset.focused = '1';
          el.focus();
          el.select();
        }
      }} />
    ${children}
    <div class="rename-actions">
      <button type="button" class="action-btn" onClick=${onClose}>✕ Cancel</button>
      <button type="button" class="action-btn primary" onClick=${save}>✓ Save</button>
    </div>
  <//>`;
}
