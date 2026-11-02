/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Settings › Threads: what a thread does when its branch merges. `done` (the default) marks it done,
 * light blue, "Merged into main", until your next message; `auto-archive` archives it and frees its
 * worktree. Foundry-wide (`threadOnMerge`, PATCH /api/settings/threads) and per project, over it
 * (PATCH /api/projects/:id); a project with none follows Foundry's.
 */

import { html, useState } from './lib.js';
import { authFetch, showToast } from './store.js';

const CHOICES = [
  ['done', 'Mark it done', 'Light blue, "Merged into main", until your next message.'],
  ['auto-archive', 'Archive it', 'Archives the thread and frees its worktree.'],
];

/** `config` is the settings (GET /api/settings); `projectId` picks the project's own setting. */
export function ThreadSettings({ config, projectId, onSaved }) {
  const [busy, setBusy] = useState(false);
  // The choice shows at once; the saved settings take over when they reload.
  const [chosen, setChosen] = useState(undefined);
  const foundry = config.threadOnMerge ?? null;
  const saved = projectId ? (config.projects?.[projectId]?.threadOnMerge ?? null) : foundry;
  const own = chosen === undefined ? saved : chosen;
  const effective = own ?? (projectId ? foundry : null) ?? 'done';
  const source = own
    ? projectId
      ? 'Set for this project'
      : 'Set by you'
    : projectId && foundry
      ? 'Following Foundry’s setting'
      : 'Default';
  const save = async (value) => {
    setChosen(value);
    setBusy(true);
    try {
      const res = projectId
        ? await authFetch(`/api/projects/${encodeURIComponent(projectId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadOnMerge: value }),
          })
        : await authFetch('/api/settings/threads', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadOnMerge: value }),
          });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setChosen(undefined);
        return showToast(body.error || 'Could not save', 'error');
      }
      await onSaved?.();
      setChosen(undefined);
      showToast(value === null ? 'Reset' : 'Saved', 'ok');
    } finally {
      setBusy(false);
    }
  };
  return html`<section class="settings-card" data-setting="threadOnMerge">
    <div class="settings-card-header"><span class="settings-card-title">When a thread’s branch merges</span></div>
    <div class="thread-on-merge" role="radiogroup" aria-label="When a thread’s branch merges">
      ${CHOICES.map(
        ([value, label, desc]) => html`<label key=${value} class="settings-choice">
          <input type="radio" name="threadOnMerge" value=${value} checked=${effective === value} disabled=${busy}
            onChange=${() => save(value)} />
          <span><b>${label}</b><span class="settings-desc">${desc}</span></span>
        </label>`,
      )}
    </div>
    <p class="settings-desc">${source}${own ? html` · <button type="button" class="rp-link" disabled=${busy} onClick=${() => save(null)}>${projectId ? 'Follow Foundry’s setting' : 'Reset to the default'}</button>` : null}</p>
  </section>`;
}
