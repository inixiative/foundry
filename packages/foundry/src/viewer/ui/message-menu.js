/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * A message's ⋯ menu: give feedback on its turn, flag it, turn it into a loop, open its turn view,
 * revert or fork from it. Flagging and "Learn from this" record feedback items on the turn (the
 * existing `/feedback` route, tagged), for the Forge Master to look at. "Repeat until" needs a loop
 * runner, which isn't built.
 */

import { html, useLayoutEffect, useRef, useState } from './lib.js';
import { Modal } from './modal.js';
import { activeThreadId, forkThread, giveFeedback, openTurnView, revertThread } from './store.js';

export function LoopBuilder({ msg, onClose }) {
  const [kind, setKind] = useState('repeat');
  const [wrong, setWrong] = useState('');
  const [make, setMake] = useState('A Warden note');
  const [scope, setScope] = useState('This project');
  const create = async () => {
    if (kind !== 'learn' || !wrong.trim()) return;
    const ok = await giveFeedback(
      activeThreadId.peek(),
      `${wrong.trim()} (make it: ${make}; applies to: ${scope})`,
      {
        turnId: msg.turnId,
        messageId: msg.id,
        tags: ['loop:learn'],
      },
    );
    if (ok) onClose();
  };
  return html`<${Modal} title="Turn this into a loop" onClose=${onClose}>
    <div class="loop-builder">
      <div class="loop-kinds" role="tablist">
        <button type="button" role="tab" aria-selected=${kind === 'repeat'} onClick=${() => setKind('repeat')}>Repeat until</button>
        <button type="button" role="tab" aria-selected=${kind === 'learn'} onClick=${() => setKind('learn')}>Learn from this</button>
      </div>
      ${
        kind === 'repeat'
          ? html`<div class="loop-body">
            <label>Do <input class="settings-input" placeholder="Fix what the failing test says" /></label>
            <label>Check <input class="settings-input" placeholder="the test passes" /></label>
            <label>If it fails <select class="settings-input"><option>Do it again with the failure as input</option><option>Ask me</option></select></label>
            <label>Stop after <input class="settings-input" placeholder="5 tries" /> or when the check passes</label>
            <p class="loop-note">Not built yet: Foundry has no loop runner. Once it does, a loop runs in this thread, shows in Running while it goes and as a graph in Loop.</p>
          </div>`
          : html`<div class="loop-body">
            <label>What went wrong <input class="settings-input" value=${wrong} onInput=${(e) => setWrong(e.target.value)} placeholder="Built a row by hand instead of using the factory" /></label>
            <label>Make it <select class="settings-input" value=${make} onChange=${(e) => setMake(e.target.value)}><option>A Warden note</option><option>A guard that flags it</option><option>An approval rule</option></select></label>
            <label>Applies to <select class="settings-input" value=${scope} onChange=${(e) => setScope(e.target.value)}><option>This project</option><option>Every project</option><option>Just me</option></select></label>
            <p class="loop-note">Recorded as feedback on this turn; the Forge Master drafts the change and shows it in Feedback before anything is applied.</p>
          </div>`
      }
      <div class="loop-actions">
        <button type="button" class="proj-btn" onClick=${onClose}>Cancel</button>
        <button type="button" class="proj-btn proj-btn-ok" disabled=${kind === 'repeat' || !wrong.trim()} onClick=${create}
          title=${kind === 'repeat' ? 'Not built yet' : ''}>Create loop</button>
      </div>
      <p class="loop-note">Saved loops you reuse will live in Settings › Loops (coming soon).</p>
    </div>
  </${Modal}>`;
}

export function MessageMenu({ msg, index, onFeedback }) {
  const [open, setOpen] = useState(false);
  const [loop, setLoop] = useState(false);
  const [at, setAt] = useState(null);
  const trigger = useRef(null);
  // Fixed to the viewport beside the ⋯ button, so the message list never clips it.
  const place = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    setAt({
      left: Math.max(8, Math.min(window.innerWidth - 260, r.left)),
      top: Math.min(window.innerHeight - 280, r.bottom + 4),
    });
  };
  // Measured once the menu is open: the ⋯ button shows then, even if it was hidden before the click.
  useLayoutEffect(() => {
    if (open) place();
  }, [open]);
  const run = (fn) => (e) => {
    e.stopPropagation();
    setOpen(false);
    fn();
  };
  const turnId = msg.turnId;
  const flag = () =>
    giveFeedback(activeThreadId.peek(), 'Flagged for review', {
      turnId,
      messageId: msg.id,
      tags: ['flag'],
    });
  return html`<div class="msg-actions ${open || loop ? 'msg-actions-open' : ''}">
    <button type="button" ref=${trigger} class="msg-action-btn msg-action-trigger" title="Actions" aria-haspopup="menu" aria-expanded=${open}
      onClick=${(e) => {
        e.stopPropagation();
        setOpen(!open);
      }}>⋯</button>
    ${
      open
        ? html`<div class="msg-menu" role="menu" style=${at ? `left:${at.left}px;top:${at.top}px` : ''} onClick=${(e) => e.stopPropagation()}>
          ${onFeedback ? html`<button type="button" role="menuitem" onClick=${run(onFeedback)}>Give feedback on this<i>/feedback</i></button>` : null}
          ${turnId ? html`<button type="button" role="menuitem" onClick=${run(flag)}>Flag this<i>for review</i></button>` : null}
          ${turnId ? html`<button type="button" role="menuitem" onClick=${run(() => setLoop(true))}>Turn this into a loop<i>repeat · learn</i></button>` : null}
          <hr />
          ${
            turnId
              ? html`<button type="button" role="menuitem" onClick=${run(() => {
                  openTurnView(activeThreadId.peek(), turnId);
                })}>Open the turn view<i>full trace</i></button>`
              : null
          }
          <button type="button" role="menuitem" onClick=${run(() => revertThread(index))}>Revert to here</button>
          <button type="button" role="menuitem" onClick=${run(() => forkThread(index))}>Fork from here</button>
        </div>`
        : null
    }
    ${loop ? html`<${LoopBuilder} msg=${msg} onClose=${() => setLoop(false)} />` : null}
  </div>`;
}
