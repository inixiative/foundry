/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Sending while a turn runs (CORE-001). With steering on (the `steer` setting, on by default) a
 * message sent mid-turn goes into the running turn; with it off, or with ⌘↵, it queues behind it.
 * A queued message can always be steered in with "Steer now", whatever the setting says. Where the
 * running turn can't take one (its runtime can't steer, it hasn't reached its runtime yet), the
 * message queues, and the reason shows on the queued row and on the disabled "Steer now".
 */

import { html, useState } from './lib.js';
import { liveExecutionStatus } from './live-state.js';
import { composerFill, messages, steerTurn, stopTurn, threadLaunch } from './store.js';

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
      images: (users.get(m.turnId).images ?? users.get(m.turnId).meta?.images ?? []).length > 0,
    }));
}

/** Is a turn of this thread running right now? */
export const turnRunning = (rows) =>
  rows.some((m) => m.actor === 'agent' && liveExecutionStatus(m) === 'running');

/**
 * Can a message go into the running turn now? `{ available: true }`, or `{ available: false,
 * reason }`. Null when no turn runs.
 */
export function runningSteer(rows) {
  const running = rows.find((m) => m.actor === 'agent' && liveExecutionStatus(m) === 'running');
  if (!running) return null;
  return (
    running.live?.steer ?? {
      available: false,
      reason: 'the running turn hasn’t reached its runtime yet',
    }
  );
}

/** Whether a plain send (Enter) steers on this thread: the `steer` setting in effect (on unless set off). */
export const steerOnSend = () => threadLaunch.value?.steer !== false;

/** The composer's line while a turn runs: what Enter and ⌘↵ will do. */
export function SendHint() {
  const steer = runningSteer(messages.value);
  if (!steer) return null;
  if (!steerOnSend())
    return html`<div class="composer-note-hint composer-note-hint--queue">Enter queues it after the running turn (steering is off) · “Steer now” sends a queued one in</div>`;
  if (steer.available)
    return html`<div class="composer-note-hint composer-note-hint--steer">Enter steers it into the running turn · ⌘↵ queues it after</div>`;
  return html`<div class="composer-note-hint composer-note-hint--queue" title=${steer.reason}>Enter queues it: ${steer.reason} · ⌘↵ queues</div>`;
}

export function QueuedRows({ threadId }) {
  const [busy, setBusy] = useState(null);
  const queued = queuedSends(messages.value);
  if (!queued.length) return null;
  const steer = runningSteer(messages.value);
  return html`<div class="queued-rows" aria-label="Queued messages">
    ${queued.map((q) => {
      const why = q.images
        ? 'a message with images can’t go into a running turn'
        : !steer
          ? 'no turn is running'
          : steer.available
            ? null
            : steer.reason;
      return html`<div key=${q.turnId} class="queued-row">
        <span class="queued-label">Queued</span>
        <span class="queued-text" title=${q.text}>${q.text}</span>
        <button type="button" disabled=${!!why || busy === q.turnId}
          title=${why ? `Can’t steer: ${why}` : 'Send it into the running turn now'}
          onClick=${async () => {
            setBusy(q.turnId);
            try {
              await steerTurn(q.threadId ?? threadId, q.turnId);
            } finally {
              setBusy(null);
            }
          }}>Steer now</button>
        <button type="button" title="Take it out of the queue and back into the message box" onClick=${async () => {
          const outcome = await stopTurn(q.threadId ?? threadId, q.turnId);
          if (outcome === 'cancelled') composerFill.value = q.text;
        }}>Edit</button>
        <button type="button" aria-label="Remove from the queue" title="Remove from the queue" onClick=${() => stopTurn(q.threadId ?? threadId, q.turnId)}>✕</button>
        ${why && steer ? html`<span class="queued-why">${why}</span>` : null}
      </div>`;
    })}
  </div>`;
}
