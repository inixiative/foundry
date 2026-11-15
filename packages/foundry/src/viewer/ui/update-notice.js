/**
 * @atlas
 * @kind component
 * @partOf feature:daemon, feature:viewer
 */
/**
 * The spin-down, as the owner sees it (packages/foundry/src/daemon/restart-roll.ts): a quiet
 * top-bar notice while an update waits for running turns ("Update ready: pausing 2 turns in 0:45"),
 * with Pause now (pause them without the grace; each resumes after the restart), Restart now once
 * they are pausing (confirmed: it names the turns that would be cut) and Not now (postpone this
 * update). Settings › About shows the same state. The page reloads onto the new build by itself
 * (`loadUpdateState`).
 */
import { html, useState } from './lib.js';
import { Modal } from './modal.js';
import { updateAction, updateState } from './store.js';

const short = (sha) => (sha ? sha.slice(0, 8) : '');
const turns = (n) => `${n} turn${n === 1 ? '' : 's'}`;

/** One line for the update state, or null when there is nothing to say. */
export function updateLine(state) {
  if (!state) return null;
  if (state.phase === 'spinning-down') {
    const running = state.running?.length ?? 0;
    const pausing = state.pausing?.length ?? 0;
    if (pausing && pausing === running)
      return `Update ready: pausing ${turns(running)}; ${running === 1 ? 'it resumes' : 'they resume'} after the restart`;
    // Only the turns not yet pausing wait out the grace.
    const unpaused = running - pausing;
    const left = state.pauseAtLocal ? Math.ceil((state.pauseAtLocal - Date.now()) / 1000) : 0;
    if (unpaused && left > 0) {
      return `Update ready: pausing ${turns(unpaused)} in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} unless ${unpaused === 1 ? 'it finishes' : 'they finish'}`;
    }
    // The grace is over: the daemon pauses them on its next look, within a few seconds.
    if (unpaused && state.pauseAtLocal) return `Update ready: pausing ${turns(unpaused)} now`;
    if (running)
      return `Update ready: restarting when ${turns(running)} finish${running === 1 ? 'es' : ''}`;
    return state.finishing
      ? 'Update ready: restarting when the last plan draft is written'
      : 'Update ready: restarting now';
  }
  if (state.phase === 'restarting') return 'Restarting onto the update…';
  if (state.phase === 'postponed') return `Update ${short(state.candidate)} postponed`;
  return null;
}

function RestartConfirm({ state, onClose }) {
  const pausingIds = new Set((state.pausing ?? []).map((t) => t.turnId));
  const pausing = (state.running ?? []).filter((t) => pausingIds.has(t.turnId));
  const cut = (state.running ?? []).filter((t) => !pausingIds.has(t.turnId));
  const list = (items) =>
    html`<ul class="update-confirm-list">
      ${items.map((t) => html`<li key=${t.turnId}>${t.name ?? t.threadId}</li>`)}
    </ul>`;
  return html`<${Modal} title="Restart now?" onClose=${onClose} class="update-confirm">
    <div class="update-confirm-body">
      ${
        pausing.length
          ? html`<p>${pausing.length === 1 ? 'This turn is' : `These ${turns(pausing.length)} are`} pausing and ${pausing.length === 1 ? 'resumes' : 'resume'} after the restart:</p>
            ${list(pausing)}`
          : null
      }
      ${
        cut.length
          ? html`<p>${cut.length === 1 ? 'This turn' : `These ${turns(cut.length)}`} would be cut:</p>
            ${list(cut)}
            <p>After the restart Foundry reads each one's native session record to see how far it got; one it can't tell shows Continue and Retry on its thread. Turns waiting to start run after the restart; one queued behind a cut turn may need sending again.</p>`
          : null
      }
      ${
        !pausing.length && !cut.length
          ? html`<p>Nothing is running. Turns waiting to start run after the restart.</p>`
          : null
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
        ? html`${
            state.pauseAtLocal > Date.now() &&
            (state.pausing?.length ?? 0) < (state.running?.length ?? 0)
              ? html`<button type="button" class="update-notice-btn" title="Pause running turns now; each resumes after the restart" onClick=${() => updateAction('pause-now')}>Pause now</button>`
              : html`<button type="button" class="update-notice-btn" onClick=${() => setConfirming(true)}>Restart now</button>`
          }
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
