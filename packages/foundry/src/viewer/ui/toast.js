/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Toasts, in two places (Aron 11-15): a system toast floats at the bottom left, clear of the thread;
 * a thread's own toast is a full-width bar at the top of that thread, in the flow, so it pushes the
 * messages down instead of covering them. `showToast` (store.js) picks the place.
 */

import { html, useEffect } from './lib.js';
import { dismissToast, threadToast, threadToastHost, toast } from './store.js';

function ToastBody({ t, place, thread }) {
  return html`
    <div class="toast toast--${place} ${t.type} ${t.persistent ? 'toast--persistent' : ''}" role=${t.type === 'error' ? 'alert' : 'status'}>
      <span class="toast-message">${t.message}</span>
      ${
        t.undo
          ? html`<button class="toast-undo" onClick=${() => {
              dismissToast({ thread });
              t.undo();
            }}>Undo</button>`
          : null
      }
      ${t.persistent ? html`<button class="toast-dismiss" onClick=${() => dismissToast({ thread })} aria-label="Dismiss">×</button>` : null}
    </div>
  `;
}

/** The system toast, bottom left of the window. */
export function SystemToast() {
  const t = toast.value;
  return t ? html`<${ToastBody} t=${t} place="system" thread=${false} />` : null;
}

/** This thread's toast, at the top of the thread under its header. */
export function ThreadToast({ threadId }) {
  useEffect(() => {
    threadToastHost.value = threadId;
    return () => {
      if (threadToastHost.peek() === threadId) threadToastHost.value = null;
      // Leaving the thread drops its toast, so an old error never greets you on coming back.
      if (threadToast.peek()?.threadId === threadId) dismissToast({ thread: true });
    };
  }, [threadId]);
  const t = threadToast.value;
  return t && t.threadId === threadId
    ? html`<${ToastBody} t=${t} place="thread" thread=${true} />`
    : null;
}
