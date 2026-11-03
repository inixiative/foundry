/**
 * @atlas
 * @kind component
 * @partOf feature:daemon, feature:viewer
 */
/**
 * The spin-down, as the owner sees it (packages/foundry/src/daemon/restart-roll.ts): a quiet
 * top-bar notice while an update waits for running turns ("Update ready: restarting when 2 turns
 * finish"), with Restart now (confirmed: it names the turns that would be cut and says each is
 * recovered) and Not now (postpone this update). Settings › About shows the same state.
 */
import { html, useState } from './lib.js';
import { Modal } from './modal.js';
import { updateAction, updateState } from './store.js';

const short = (sha) => (sha ? sha.slice(0, 8) : '');
const turns = (n) => `${n} turn${n === 1 ? '' : 's'}`;

/** One line for the update state, or null when there is nothing to say. */
export function updateLine(state) {
  if (!state) return null;
  if (state.phase === 'spinning-down')
    return state.running.length
      ? `Update ready: restarting when ${turns(state.running.length)} finish${state.running.length === 1 ? 'es' : ''}`
      : state.finishing
        ? 'Update ready: restarting when the last plan draft is written'
        : 'Update ready: restarting now';
  if (state.phase === 'restarting') return 'Restarting onto the update…';
  if (state.phase === 'postponed') return `Update ${short(state.candidate)} postponed`;
  return null;
}

function RestartConfirm({ state, onClose }) {
  const running = state.running ?? [];
  return html`<${Modal} title="Restart now?" onClose=${onClose} class="update-confirm">
    <div class="update-confirm-body">
      ${
        running.length
          ? html`<p>These ${turns(running.length)} would be cut:</p>
            <ul class="update-confirm-list">
              ${running.map((t) => html`<li key=${t.turnId}>${t.name ?? t.threadId}</li>`)}
            </ul>
            <p>After the restart Foundry reads each one's native session record to see how far it got; one it can't tell shows Continue and Retry on its thread. Turns waiting to start run after the restart; one queued behind a cut turn may need sending again.</p>`
          : html`<p>Nothing is running. Turns waiting to start run after the restart.</p>`
      }
      ${
        state.background?.length
          ? html`<p>${state.background.length} background process${state.background.length === 1 ? '' : 'es'} an agent started will stop: ${state.background.map((b) => b.label).join(', ')}.</p>`
          : null
      }
    </div>
    <div class="loop-actions">
      <button type="button" class="proj-btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="proj-btn proj-btn-ok" onClick=${async () => {
        await updateAction('restart-now');
        onClose();
      }}>Restart now</button>
    </div>
  <//>`;
}

/** The header notice. Quiet: one line and two small actions; nothing while there is no update. */
export function UpdateNotice() {
  const state = updateState.value;
  const [confirming, setConfirming] = useState(false);
  const line = updateLine(state);
  if (!line || state.phase === 'postponed') return null;
  const waiting = state.waiting
    ? ` · ${turns(state.waiting)} waiting to start after the restart`
    : '';
  return html`<span class="update-notice" title=${`Update ${short(state.candidate)}${waiting}`}>
    <span class="update-notice-text" role="status">${line}</span>
    ${
      state.phase === 'spinning-down'
        ? html`<button type="button" class="update-notice-btn" onClick=${() => setConfirming(true)}>Restart now</button>
          <button type="button" class="update-notice-btn" onClick=${() => updateAction('postpone')}>Not now</button>`
        : null
    }
    ${confirming ? html`<${RestartConfirm} state=${state} onClose=${() => setConfirming(false)} />` : null}
  </span>`;
}

/** Settings › About: the update state, and "Update now" for a postponed one. */
export function UpdateFact() {
  const state = updateState.value;
  const line = updateLine(state) ?? 'Up to date';
  return html`<span class="update-fact">
    ${line}
    ${
      state?.phase === 'postponed'
        ? html` <button type="button" class="proj-btn" onClick=${() => updateAction('update-now')}>Update now</button>`
        : null
    }
  </span>`;
}
