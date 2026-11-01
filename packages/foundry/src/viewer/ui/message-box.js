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
 * Posting to /btw or an aside isn't built yet, so those destinations say so instead of sending.
 * Every helper takes the Foundry settings (`settingsConfig.value`) as `config`.
 */

import { html, signal } from './lib.js';

export const DESTINATIONS = [
  ['thread', 'Thread'],
  ['btw', '/btw'],
  ['aside', '/aside'],
];
export const NOT_BUILT = {
  btw: 'Posting to /btw isn’t built yet: Foundry has no private side-channel to your agent',
  aside:
    'Posting an aside isn’t built yet: shared-thread asides arrive with the conversations work',
};

/** Where the single box sends. */
export const composerDestination = signal('thread');

export const separateViews = (config) => config?.messageBox?.separateViews === true;

/** "/btw text" or "/aside text" typed at the start switches the destination and drops the prefix. */
export function routeTyped(text, config) {
  const m = /^\/(btw|aside)\s/.exec(text);
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

/** With separate boxes on, an open /btw or aside column gets its own box (not built yet). */
export function ViewBox({ view, config }) {
  if (!separateViews(config)) return null;
  return html`<div class="view-box" title=${NOT_BUILT[view]}>
    <textarea class="view-box-input" rows="2" disabled placeholder=${view === 'btw' ? 'Ask your own agent privately' : 'Say something to the people here'}></textarea>
    <p class="view-box-note">${NOT_BUILT[view]}</p>
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
