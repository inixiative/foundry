/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * One settings row (design review 11-02): the label and its help on the left; on the right the
 * control, a chip saying where the value comes from, and ⋯ with Set for me / Set for everyone /
 * Reset. A project's settings cascade yours (this machine's settings) over everyone's (the
 * repository's `.foundry/project.json`) over Foundry's over the default (Aron 10-16).
 *
 * `actions` holds what this setting can do: `me`, `everyone`, `reset`, each a function, or a string
 * saying why it can't. A row with no actions (a detected or read-only value) shows the chip alone.
 */

import { html, useEffect, useState } from './lib.js';

const SOURCE = {
  yours: ['Yours', 'Set by you, on this machine'],
  'yours-over-team': [
    'Yours · overrides team',
    'Set by you; the repository sets another value for everyone',
  ],
  everyone: ['Team · .foundry/', 'Set for everyone in the repository’s .foundry/project.json'],
  foundry: ['Foundry’s', 'Follows the Foundry-wide setting'],
  default: ['Default', 'Nobody has set it'],
  detected: ['From the repo', 'Read from the repository; not a setting'],
};

function SourceMenu({ path, actions, busy }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && e.target.closest?.(`[data-source-menu="${path}"]`)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  const item = (key, label, note) => {
    const act = actions[key];
    const why = typeof act === 'string' ? act : undefined;
    return html`<button type="button" role="menuitem" disabled=${busy || typeof act !== 'function'} title=${why}
      onClick=${async () => {
        setOpen(false);
        await act();
      }}>${label}${note ? html` <small>${note}</small>` : null}</button>`;
  };
  return html`<span class="setting-source-menu" data-source-menu=${path}>
    <button type="button" class="setting-more" aria-haspopup="menu" aria-expanded=${open}
      aria-label="Set for me, for everyone, or reset" onClick=${() => setOpen(!open)}>⋯</button>
    ${
      open
        ? html`<span class="setting-menu" role="menu">
            ${item('me', 'Set for me')}
            ${item('everyone', 'Set for everyone', 'writes .foundry/')}
            ${item('reset', 'Reset')}
          </span>`
        : null
    }
  </span>`;
}

export function SourceChip({ source }) {
  const [label, title] = SOURCE[source] ?? SOURCE.default;
  return html`<span class="setting-source s-${source}" title=${title}>${label}</span>`;
}

export function SettingRow({ path, label, help, source, actions, busy = false, children }) {
  return html`<div class="setting-row" data-setting=${path}>
    <div class="setting-row-label"><b>${label}</b>${help ? html`<p class="settings-desc">${help}</p>` : null}</div>
    <div class="setting-row-value">
      ${children}
      ${source ? html`<${SourceChip} source=${source} />` : null}
      ${actions ? html`<${SourceMenu} path=${path} actions=${actions} busy=${busy} />` : null}
    </div>
  </div>`;
}
