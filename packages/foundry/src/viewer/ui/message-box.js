/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Where the message box sends: the thread, /btw (you and your agent) or an /aside (people only).
 * One Foundry setting, "Separate message boxes for /btw and /aside" (`messageBox.separateViews`,
 * off by default), decides the layout: off is one box whose label picks the destination (click to
 * cycle; typing /btw or /aside at the start switches it); on gives each open view its own box.
 * Posting to /btw isn't built yet, so that destination says so instead of sending; an aside posts
 * to the people in the thread (`POST /api/threads/:id/conversation/asides`).
 * Every helper takes the Foundry settings (`settingsConfig.value`) as `config`.
 */

import { html, signal, useRef, useState } from './lib.js';
import { activeThreadId, postAside } from './store.js';
import { uuidv7 } from './uuidv7.js';

export const DESTINATIONS = [
  ['thread', 'Thread'],
  ['btw', '/btw'],
  ['aside', '/aside'],
];
export const NOT_BUILT = {
  btw: 'Posting to /btw isn’t built yet: Foundry has no private side-channel to your agent',
};

/** Where the single box sends. */
export const composerDestination = signal('thread');

export const separateViews = (config) => config?.messageBox?.separateViews === true;

/** A destination command at the start of `text` ("btw ", "aside ", "thread ", the space included). */
export const DESTINATION_COMMAND = /^(btw|aside|thread)\s/;

/** "/btw text", "/aside text" or "/thread text" typed at the start switches the destination and drops the prefix. */
export function routeTyped(text, config) {
  const m = /^\/(btw|aside|thread)\s/.exec(text);
  if (!m || separateViews(config)) return null;
  return { destination: m[1], text: text.slice(m[0].length) };
}

export function DestinationLabel({ config }) {
  if (separateViews(config)) return null;
  const current = composerDestination.value;
  const i = DESTINATIONS.findIndex(([id]) => id === current);
  const [, label] = DESTINATIONS[i];
  return html`<button type="button" class="composer-destination" data-destination=${current}
    title="Where this message goes · click to change, or start it with /btw or /aside"
    onClick=${() => {
      composerDestination.value = DESTINATIONS[(i + 1) % DESTINATIONS.length][0];
    }}>${label}</button>`;
}

/** With separate boxes on, an open /btw or aside column gets its own box; /btw's isn't built yet. */
export function ViewBox({ view, config }) {
  if (!separateViews(config)) return null;
  if (view === 'aside') return html`<${AsideBox} />`;
  return html`<div class="view-box" title=${NOT_BUILT[view]}>
    <textarea class="view-box-input" rows="2" disabled placeholder="Ask your own agent privately"></textarea>
    <p class="view-box-note">${NOT_BUILT[view]}</p>
  </div>`;
}

/** The aside column's own box: Enter posts to the people here (one id per message, so a retry records once). */
function AsideBox() {
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const post = useRef(null);
  const send = async () => {
    const sent = text.trim();
    if (!sent) return;
    if (post.current?.text !== sent) post.current = { text: sent, id: uuidv7() };
    const result = await postAside(activeThreadId.value, sent, post.current.id);
    if (result.error) return setError(result.error);
    post.current = null;
    setError(null);
    setText('');
  };
  return html`<div class="view-box">
    <textarea class="view-box-input" rows="2" placeholder="Say something to the people here" value=${text}
      onInput=${(e) => setText(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      }}></textarea>
    ${error ? html`<p class="view-box-note view-box-error" role="alert">The aside wasn’t posted: ${error}</p>` : html`<p class="view-box-note">Enter posts an aside: people only, never an agent</p>`}
  </div>`;
}

/** Settings › Message box: the one switch, set for you (this machine's settings). */
export function MessageBoxSection({ config, onSave }) {
  const on = separateViews(config);
  return html`<section class="settings-card" data-setting="messageBox">
    <h3>Message box</h3>
    <label class="message-box-setting">
      <input type="checkbox" checked=${on} onChange=${(e) => onSave({ separateViews: e.target.checked })} />
      <span><b>Separate message boxes for /btw and /aside</b>
        <small>Off: one box, and its label picks where it sends (Thread · /btw · /aside). On: each open view has its own box.</small></span>
    </label>
    <p class="settings-hint">Set for you: it's kept in this machine's Foundry settings. A Foundry-wide setting has no shared layer, so there is no "for everyone" here.</p>
  </section>`;
}
