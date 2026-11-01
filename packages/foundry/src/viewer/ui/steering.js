/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Sending while a turn runs. Steering a message into the running turn (CORE-001) isn't built: a
 * message sent mid-turn queues behind it, and the queue is shown above the composer with Edit and ✕
 * (cancelling a queued turn is real, through the interrupt route); "Send now" (steer it in) stays
 * disabled with the reason.
 */

import { html } from './lib.js';
import { liveExecutionStatus } from './live-state.js';
import { composerFill, messages, stopTurn } from './store.js';

export const STEER_NOT_BUILT =
  'Steering a message into the running turn isn’t built yet (CORE-001)';

/** This thread's queued sends, oldest first: each queued turn with the text that was sent. */
export function queuedSends(rows) {
  const users = new Map(rows.filter((m) => m.actor === 'user').map((m) => [m.turnId, m]));
  return rows
    .filter(
      (m) => m.actor === 'agent' && liveExecutionStatus(m) === 'queued' && users.has(m.turnId),
    )
    .map((m) => ({
      turnId: m.turnId,
      threadId: m.threadId ?? users.get(m.turnId).threadId,
      text: users.get(m.turnId).content ?? '',
    }));
}

/** Is a turn of this thread running right now? */
export const turnRunning = (rows) =>
  rows.some((m) => m.actor === 'agent' && liveExecutionStatus(m) === 'running');

export function QueuedRows({ threadId }) {
  const queued = queuedSends(messages.value);
  if (!queued.length) return null;
  return html`<div class="queued-rows" aria-label="Queued messages">
    ${queued.map(
      (q) => html`<div key=${q.turnId} class="queued-row">
        <span class="queued-label">Queued</span>
        <span class="queued-text" title=${q.text}>${q.text}</span>
        <button type="button" disabled title=${STEER_NOT_BUILT}>Send now</button>
        <button type="button" title="Take it out of the queue and back into the message box" onClick=${async () => {
          const outcome = await stopTurn(q.threadId ?? threadId, q.turnId);
          if (outcome === 'cancelled') composerFill.value = q.text;
        }}>Edit</button>
        <button type="button" aria-label="Remove from the queue" title="Remove from the queue" onClick=${() => stopTurn(q.threadId ?? threadId, q.turnId)}>✕</button>
      </div>`,
    )}
  </div>`;
}
