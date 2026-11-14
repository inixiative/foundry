/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * What a thread runs on and as: its worker (Claude Code, Codex, Muse: those with a working login),
 * the model (that worker's), the effort (that model's levels) and its thread role (coder, assistant,
 * or the user's own; empty follows the worker's default). One picker, two places: the thread
 * header's run pill (a change applies from the next turn) and "+ New thread" (chosen before the
 * first message, starting from the scope's defaults). The choices come from the daemon (the launch
 * view's `options.workers`, or `/api/workers` for a new thread); nothing here keeps its own list.
 */

import { html, signal, useEffect, useState } from './lib.js';
import { Modal } from './modal.js';
import {
  activeThreadId,
  authFetch,
  composerFill,
  createThread,
  currentScope,
  loadLaunch,
  projects,
  SCOPE_ROLES,
  showToast,
  threadLaunch,
} from './store.js';
import { harnessName } from './thread-labels.js';

/** "Claude Code", "Codex", "Muse"; the registry label without its "(…subscription)" for anything else. */
export const workerName = (worker) =>
  harnessName(worker?.id ?? worker) ?? worker?.label?.replace(/\s*\(.*\)\s*$/, '') ?? null;

/** A thread role's label from the scope's choices. */
export const roleLabel = (roles, id) =>
  id ? (roles?.find((r) => r.id === id)?.label ?? id) : null;

/** The model entry of a worker choice. */
const modelOf = (worker, modelId) => worker?.models?.find((m) => m.id === modelId) ?? null;

/**
 * The four choices, controlled. `value` is `{ worker, model, effort, role }`; an empty effort is the
 * model's own default, an empty role the worker's default role (each named, so never blank). `lock` is why the worker can't change
 * now; `musePersonal` replaces the Muse note with what a mid-thread switch means for the Archive.
 */
export function RunPicker({
  value,
  workers,
  roles = [],
  unavailable = [],
  lock = null,
  musePersonal = null,
  onChange,
  onNewThread,
}) {
  const worker = workers.find((w) => w.id === value.worker) ?? workers[0];
  const model = modelOf(worker, value.model) ?? modelOf(worker, worker?.defaultModel);
  const efforts = model?.efforts ?? [];
  const pickWorker = (id) => {
    const next = workers.find((w) => w.id === id);
    // A worker and its model are chosen together: the new worker starts on its own default model.
    // A role that was the old worker's default follows the worker to its own default.
    const role =
      value.role && value.role === worker?.defaultRole
        ? (next?.defaultRole ?? '')
        : (value.role ?? '');
    onChange({ worker: id, model: next?.defaultModel ?? '', effort: '', role });
  };
  const pickModel = (id) => {
    const next = modelOf(worker, id);
    onChange({
      ...value,
      model: id,
      effort: next?.efforts?.includes(value.effort) ? value.effort : '',
    });
  };
  return html`<div class="run-picker">
    <label class="run-picker-row">Worker
      <select class="rp-select" data-run="worker" value=${worker?.id ?? ''} disabled=${!!lock}
        onChange=${(e) => pickWorker(e.target.value)}>
        ${workers.map((w) => html`<option key=${w.id} value=${w.id}>${workerName(w)}${w.default ? ' (default)' : ''}</option>`)}
      </select>
    </label>
    <label class="run-picker-row">Model
      <select class="rp-select" data-run="model" value=${model?.id ?? ''}
        onChange=${(e) => pickModel(e.target.value)}>
        ${(worker?.models ?? []).map((m) => html`<option key=${m.id} value=${m.id}>${m.label ?? m.id}${m.id === worker.defaultModel ? ' (default)' : ''}</option>`)}
      </select>
    </label>
    <label class="run-picker-row">Effort
      <select class="rp-select" data-run="effort" value=${value.effort ?? ''}
        onChange=${(e) => onChange({ ...value, effort: e.target.value })}>
        <option value="">${model?.defaultEffort ? `${model.defaultEffort} (default)` : 'Default'}</option>
        ${efforts.map((e) => html`<option key=${e} value=${e}>${e}</option>`)}
      </select>
    </label>
    ${
      roles.length
        ? html`<label class="run-picker-row">Role
            <select class="rp-select" data-run="role" value=${value.role ?? ''}
              onChange=${(e) => onChange({ ...value, role: e.target.value })}>
              <option value="">${roleLabel(roles, worker?.defaultRole) ?? 'Default'} (default)</option>
              ${roles.map((r) => html`<option key=${r.id} value=${r.id}>${r.label}</option>`)}
            </select>
          </label>`
        : null
    }
    ${
      worker?.id === 'muse' && !musePersonal
        ? html`<p class="run-picker-note" data-note="muse-personal">Muse is personal: this thread goes to your personal Archive, whatever project it's in.</p>`
        : null
    }
    ${musePersonal ? html`<p class="run-picker-note" data-note="muse-personal">${musePersonal}</p>` : null}
    ${
      lock
        ? html`<p class="run-picker-note" data-note="worker-lock">The worker can't change right now: ${lock}.
            ${onNewThread ? html` <button type="button" class="run-picker-link" onClick=${onNewThread}>New thread…</button>` : null}</p>`
        : null
    }
    ${
      unavailable.length
        ? html`<p class="run-picker-note run-picker-note--dim" data-note="unavailable">${unavailable.map((u) => html`<span key=${u.id}>${workerName(u)} isn't available: ${u.reason}. </span>`)}</p>`
        : null
    }
  </div>`;
}

// --- The thread header's picker ---------------------------------------------------------------

/**
 * Apply a picked run to a thread. A worker or role change goes first: the thread is rebuilt on the
 * new worker, whose native session starts fresh (after the first turn, seeded with the conversation and
 * marked "continued on" in the transcript); then the model and effort, which its idle session picks
 * up on the next turn.
 */
async function applyRun(threadId, launch, next) {
  const json = { 'Content-Type': 'application/json' };
  // The worker and role go together, so a refused role never leaves the worker switched.
  const thread = {
    ...(next.worker !== launch.worker ? { worker: next.worker } : {}),
    ...((next.role || null) !== (launch.role ?? null) ? { role: next.role || null } : {}),
  };
  if (Object.keys(thread).length) {
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify(thread),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Error(body.error ?? res.statusText);
  }
  const worker = launch.options?.workers?.find((w) => w.id === next.worker);
  const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/launch`, {
    method: 'PATCH',
    headers: json,
    body: JSON.stringify({
      // The worker's default model is no choice: the thread follows the project's default.
      model: next.model && next.model !== worker?.defaultModel ? next.model : null,
      effort: next.effort || null,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(body.error ?? res.statusText);
}

/** Whether the open thread's picker is showing (mounted at the app's root, outside the header's containment). */
export const threadRunOpen = signal(false);
export const openThreadRun = () => {
  threadRunOpen.value = true;
};

function ThreadRunModal({ launch, onClose }) {
  const threadId = activeThreadId.value;
  const workers = launch.options?.workers ?? [];
  // What the picker shows is what Apply sends: a model its worker doesn't list reads as the default.
  const current = workers.find((w) => w.id === launch.worker);
  const [value, setValue] = useState({
    worker: launch.worker,
    model: modelOf(current, launch.model) ? launch.model : (current?.defaultModel ?? launch.model),
    effort: launch.effort ?? '',
    role: launch.role ?? '',
  });
  const [busy, setBusy] = useState(false);
  const switching = value.worker !== launch.worker;
  // What a mid-thread switch means for where the thread is archived (Muse is always personal).
  const ranOnMuse =
    launch.worker === 'muse' || (launch.switches ?? []).some((s) => s.from === 'muse');
  const musePersonal = !launch.started
    ? null
    : switching && value.worker === 'muse' && !ranOnMuse
      ? `Muse is personal: from here this thread goes to your personal Archive${launch.projectLabel ? `, not ${launch.projectLabel}'s` : ''}.`
      : switching && ranOnMuse
        ? 'This thread stays personal: it ran on Muse, so it keeps going to your personal Archive.'
        : null;
  const save = async () => {
    setBusy(true);
    try {
      await applyRun(threadId, launch, value);
      await loadLaunch(threadId);
      showToast(
        switching
          ? launch.started
            ? `Continued on ${workerName(value.worker)} from here`
            : `This thread now runs on ${workerName(value.worker)}`
          : 'Applies from the next turn',
        'ok',
      );
      onClose();
    } catch (error) {
      showToast(`Could not change it: ${error.message}`, 'error');
      // A worker switch may have landed before the model or effort was refused: show what is true now.
      await loadLaunch(threadId);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return html`<${Modal} title="Runs on" onClose=${onClose} class="run-modal">
    <${RunPicker} value=${value} workers=${workers} roles=${launch.options?.roles ?? []}
      unavailable=${launch.options?.unavailableWorkers ?? []}
      lock=${launch.workerLock} musePersonal=${musePersonal} onChange=${setValue}
      onNewThread=${() => {
        onClose();
        openNewThread();
      }} />
    <p class="run-picker-note run-picker-note--dim" data-note="carry-over">
      ${
        !switching
          ? 'A change applies from the next turn.'
          : launch.started
            ? `Continues on a fresh ${workerName(value.worker)} session that carries the conversation and plan, not the old session's files read or tool state.`
            : `Nothing has run yet: the thread restarts on ${workerName(value.worker)} with a fresh session.`
      }
    </p>
    <div class="rename-actions">
      <button type="button" class="action-btn" onClick=${onClose}>✕ Cancel</button>
      <button type="button" class="action-btn primary" data-run="apply" disabled=${busy} onClick=${save}>✓ Apply</button>
    </div>
  <//>`;
}

// --- "+ New thread" ----------------------------------------------------------------------------

/** The New thread picker: open (with an optional preset worker, role, where or draft) or closed (null). */
export const newThreadChooser = signal(null);

/** Foundry's own scopes in the Where picker, after Global and before the projects. */
const SCOPE_CHOICES = [
  ['@forge', 'Forge Master'],
  ['@feedback', 'Feedback'],
];
const isScope = (where) => where != null && Object.hasOwn(SCOPE_ROLES, where);
/** A Where choice as a select value: '' is Global, else the scope key or project id (never alike). */
const whereValue = (where) => where ?? '';
const whereOf = (value) => value || null;

/** Where a new thread goes: Global, Forge Master, Feedback, or a project (archived ones hidden). */
function WherePicker({ where, onChange }) {
  const listed = projects.value.filter((p) => p.status !== 'archived' || p.id === where);
  return html`<label class="run-picker-row">Where
    <select class="rp-select" data-run="where" value=${whereValue(where)}
      onChange=${(e) => onChange(whereOf(e.target.value))}>
      <option value="">Global</option>
      ${SCOPE_CHOICES.map(([id, label]) => html`<option key=${id} value=${id}>${label}</option>`)}
      ${
        listed.length
          ? html`<optgroup label="Projects">
              ${listed.map((p) => html`<option key=${p.id} value=${p.id}>${p.label || p.id}</option>`)}
            </optgroup>`
          : null
      }
    </select>
  </label>`;
}
export const openNewThread = (preset = {}) => {
  newThreadChooser.value = preset;
};

/**
 * Start a thread where it is picked (the active scope by default) on the picked worker, model,
 * effort and role. A Foundry scope's thread takes the scope's role, so it has no role to pick.
 */
export function NewThreadModal() {
  const preset = newThreadChooser.value;
  const [scope, setScope] = useState(null);
  const [value, setValue] = useState(null);
  const [name, setName] = useState('');
  const [where, setWhere] = useState(null);
  // Each open starts where the workspace is, unless the opener named a place.
  useEffect(() => {
    if (!preset) return;
    setName('');
    setWhere(preset.where !== undefined ? preset.where : currentScope());
  }, [preset]);
  const pinned = isScope(where);
  const projectId = pinned ? null : where;
  useEffect(() => {
    if (!preset) return undefined;
    let live = true;
    setScope(null);
    setValue(null);
    authFetch(projectId ? `/api/projects/${encodeURIComponent(projectId)}/workers` : '/api/workers')
      .then((res) => (res.ok ? res.json() : Promise.reject(Error(res.statusText))))
      .then((body) => {
        if (!live) return;
        const workers = body.workers ?? [];
        const worker =
          workers.find((w) => w.id === preset.worker) ??
          workers.find((w) => w.default) ??
          workers[0];
        setScope({ workers, unavailable: body.unavailable ?? [], roles: body.roles ?? [] });
        setValue({
          worker: worker?.id ?? '',
          model: worker?.defaultModel ?? '',
          effort: '',
          role: preset.role ?? '',
        });
      })
      .catch((error) => live && setScope({ error: error.message }));
    return () => {
      live = false;
    };
  }, [preset, projectId]);
  if (!preset) return null;
  const close = () => {
    newThreadChooser.value = null;
    // The next open reads its scope afresh, never picking from this one's choices.
    setScope(null);
    setValue(null);
  };
  const start = async () => {
    const worker = scope.workers.find((w) => w.id === value.worker);
    close();
    const created = await createThread({
      where,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(worker && !worker.default ? { worker: worker.id } : {}),
      ...(value.model && value.model !== worker?.defaultModel ? { model: value.model } : {}),
      ...(value.effort ? { effort: value.effort } : {}),
      ...(value.role && !pinned ? { role: value.role } : {}),
    });
    // A draft from the opener (a settings page asking the Forge Master) waits in the new thread's box.
    if (created && preset.draft) composerFill.value = preset.draft;
  };
  return html`<${Modal} title="New thread" onClose=${close} class="run-modal new-thread-modal">
    <div class="run-picker">
      <label class="run-picker-row">Name
        <input class="rp-select" data-run="name" placeholder="Optional" value=${name}
          onInput=${(e) => setName(e.target.value)} />
      </label>
      <${WherePicker} where=${where} onChange=${setWhere} />
    </div>
    ${
      scope?.error
        ? html`<p class="run-picker-note">Could not read the workers: ${scope.error}</p>`
        : scope && value
          ? html`<${RunPicker} value=${value} workers=${scope.workers} roles=${pinned ? [] : scope.roles} unavailable=${scope.unavailable} onChange=${setValue} />`
          : html`<p class="run-picker-note run-picker-note--dim">Reading the workers…</p>`
    }
    <div class="rename-actions">
      <button type="button" class="action-btn" onClick=${close}>✕ Cancel</button>
      <button type="button" class="action-btn primary" data-run="start" disabled=${!value}
        onClick=${start}>✓ Start thread</button>
    </div>
  <//>`;
}

/** Both pickers, mounted once at the app's root. */
export function RunPickers() {
  const launch = threadLaunch.value;
  const close = () => {
    threadRunOpen.value = false;
  };
  return html`
    ${threadRunOpen.value && launch ? html`<${ThreadRunModal} key=${launch.threadId} launch=${launch} onClose=${close} />` : null}
    <${NewThreadModal} />
  `;
}
