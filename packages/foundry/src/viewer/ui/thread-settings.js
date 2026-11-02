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
 *
 * And what a message sent during a running turn does (`steer`, CORE-001): steer it into the turn
 * (the default) or queue it after. Foundry-wide (PATCH /api/settings/threads); per project, set for
 * you (this machine's settings, which win) or for everyone (the repository's .foundry/project.json),
 * through /api/projects/:id/steer.
 */

import { html, useEffect, useState } from './lib.js';
import { authFetch, showToast } from './store.js';

const CHOICES = [
  ['done', 'Mark it done', 'Light blue, "Merged into main", until your next message.'],
  ['auto-archive', 'Archive it', 'Archives the thread and frees its worktree.'],
];

/** `config` is the settings (GET /api/settings); `projectId` picks the project's own setting. */
export function ThreadSettings({ config, projectId, onSaved }) {
  return html`<${MergeSettings} config=${config} projectId=${projectId} onSaved=${onSaved} />
    <${SteerSettings} config=${config} projectId=${projectId} onSaved=${onSaved} />`;
}

const STEER_CHOICES = [
  [
    true,
    'Steer it into the turn',
    'The running turn takes it in at its next step. ⌘↵ still queues.',
  ],
  [
    false,
    'Queue it after',
    'It waits for the running turn to finish. "Steer now" still sends one in.',
  ],
];
const STEER_FROM = {
  settings: 'Set for you',
  repository: 'Set for everyone (the repository’s .foundry/project.json)',
  foundry: 'Following Foundry’s setting',
  default: 'Default',
};

function SteerSettings({ config, projectId, onSaved }) {
  const [state, setState] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const base = projectId ? `/api/projects/${encodeURIComponent(projectId)}/steer` : null;
  const load = () =>
    base
      ? authFetch(base)
          .then((r) => (r.ok ? r.json() : null))
          .then(setState)
          .catch(() => setState(null))
      : setState({
          steer: config.steer ?? true,
          from: config.steer === undefined ? 'default' : 'settings',
          mine: config.steer ?? null,
        });
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the project or saved settings change.
  useEffect(() => {
    load();
  }, [projectId, config.steer]);
  if (state === undefined)
    return html`<div class="settings-empty">Reading the steer setting…</div>`;
  if (state === null)
    return html`<div class="settings-empty">The steer setting could not be read.</div>`;
  const save = async (scope, value) => {
    setBusy(true);
    try {
      const res = base
        ? await authFetch(base, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope, value }),
          })
        : await authFetch('/api/settings/threads', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ steer: value }),
          });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return showToast(body.error || 'Could not save', 'error');
      await onSaved?.();
      await load();
      showToast(
        value === null ? 'Reset' : scope === 'everyone' ? 'Saved for everyone' : 'Saved for you',
        'ok',
      );
    } finally {
      setBusy(false);
    }
  };
  return html`<section class="settings-card" data-setting="steer">
    <div class="settings-card-header"><span class="settings-card-title">When you send during a running turn</span></div>
    ${state.repositoryError ? html`<p class="settings-desc">${state.repositoryFile}: ${state.repositoryError}</p>` : null}
    <div class="thread-on-merge" role="radiogroup" aria-label="When you send during a running turn">
      ${STEER_CHOICES.map(
        ([value, label, desc]) => html`<div key=${String(value)} class="settings-choice">
          <span><b>${label}</b><span class="settings-desc">${desc}</span></span>
          <span class="settings-card-actions">
            ${state.steer === value ? html`<span class="settings-desc">In effect</span>` : null}
            <button class="action-btn" disabled=${busy || state.mine === value} onClick=${() => save('me', value)}>Set this for me</button>
            ${base ? html`<button class="action-btn" disabled=${busy || state.repository === value} title=${`Writes ${state.repositoryFile ?? '.foundry/project.json'}`} onClick=${() => save('everyone', value)}>Set this for everyone</button>` : null}
          </span>
        </div>`,
      )}
    </div>
    <p class="settings-desc">${STEER_FROM[state.from] ?? 'Default'}${state.mine !== null && state.mine !== undefined ? html` · <button type="button" class="rp-link" disabled=${busy} onClick=${() => save('me', null)}>Drop my override</button>` : null}${base && state.repository !== null && state.repository !== undefined ? html` · <button type="button" class="rp-link" disabled=${busy} onClick=${() => save('everyone', null)}>Clear it for everyone</button>` : null}</p>
  </section>`;
}

function MergeSettings({ config, projectId, onSaved }) {
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
