/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * What a thread runs on: its worker (Claude Code, Codex, Muse: those with a working login), the
 * model (that worker's) and the effort (that model's levels). One picker, two places: the thread
 * header's run pill (a change applies from the next turn) and "+ New thread" (chosen before the
 * first message, starting from the scope's defaults). The choices come from the daemon (the launch
 * view's `options.workers`, or `/api/workers` for a new thread); nothing here keeps its own list.
 */

import { html, signal, useEffect, useState } from './lib.js';
import { Modal } from './modal.js';
import {
  activeProjectId,
  activeThreadId,
  authFetch,
  createThread,
  loadLaunch,
  showToast,
  threadLaunch,
} from './store.js';
import { harnessName } from './thread-labels.js';

/** "Claude Code", "Codex", "Muse"; the registry label without its "(…subscription)" for anything else. */
export const workerName = (worker) =>
  harnessName(worker?.id ?? worker) ?? worker?.label?.replace(/\s*\(.*\)\s*$/, '') ?? null;

/** The model entry of a worker choice. */
const modelOf = (worker, modelId) => worker?.models?.find((m) => m.id === modelId) ?? null;

/**
 * The three choices, controlled. `value` is `{ worker, model, effort }`; an empty effort is the
 * model's own default (named, so the choice is never blank). `lock` is why the worker is fixed.
 */
export function RunPicker({
  value,
  workers,
  unavailable = [],
  lock = null,
  onChange,
  onNewThread,
}) {
  const worker = workers.find((w) => w.id === value.worker) ?? workers[0];
  const model = modelOf(worker, value.model) ?? modelOf(worker, worker?.defaultModel);
  const efforts = model?.efforts ?? [];
  const pickWorker = (id) => {
    const next = workers.find((w) => w.id === id);
    // A worker and its model are chosen together: the new worker starts on its own default model.
    onChange({ worker: id, model: next?.defaultModel ?? '', effort: '' });
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
      worker?.id === 'muse'
        ? html`<p class="run-picker-note" data-note="muse-personal">Muse is personal: this thread goes to your personal Archive, whatever project it's in.</p>`
        : null
    }
    ${
      lock
        ? html`<p class="run-picker-note" data-note="worker-lock">The worker is fixed: ${lock}. Another worker needs a new thread.
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
 * Apply a picked run to a thread. A worker change goes first (allowed only before the first turn:
 * the thread is rebuilt on the new worker, and its native session starts fresh there); then the
 * model and effort, which its idle session picks up on the next turn.
 */
async function applyRun(threadId, launch, next) {
  const json = { 'Content-Type': 'application/json' };
  if (next.worker !== launch.worker) {
    const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ worker: next.worker }),
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
  const [value, setValue] = useState({
    worker: launch.worker,
    model: launch.model,
    effort: launch.effort ?? '',
  });
  const [busy, setBusy] = useState(false);
  const workers = launch.options?.workers ?? [];
  const switching = value.worker !== launch.worker;
  const save = async () => {
    setBusy(true);
    try {
      await applyRun(threadId, launch, value);
      await loadLaunch(threadId);
      showToast(
        switching
          ? `This thread now runs on ${workerName(value.worker)}`
          : 'Applies from the next turn',
        'ok',
      );
      onClose();
    } catch (error) {
      showToast(`Could not change it: ${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return html`<${Modal} title="Runs on" onClose=${onClose} class="run-modal">
    <${RunPicker} value=${value} workers=${workers} unavailable=${launch.options?.unavailableWorkers ?? []}
      lock=${launch.workerLock} onChange=${setValue}
      onNewThread=${() => {
        onClose();
        openNewThread();
      }} />
    <p class="run-picker-note run-picker-note--dim">
      ${switching ? `Nothing has run yet: the thread restarts on ${workerName(value.worker)} with a fresh session.` : 'A change applies from the next turn.'}
    </p>
    <div class="rename-actions">
      <button type="button" class="action-btn" onClick=${onClose}>✕ Cancel</button>
      <button type="button" class="action-btn primary" data-run="apply" disabled=${busy} onClick=${save}>✓ Apply</button>
    </div>
  <//>`;
}

// --- "+ New thread" ----------------------------------------------------------------------------

/** The New thread picker: open (with an optional preset worker) or closed (null). */
export const newThreadChooser = signal(null);
export const openNewThread = (preset = {}) => {
  newThreadChooser.value = preset;
};

/** Start a thread in the active scope on the picked worker, model and effort. */
export function NewThreadModal() {
  const preset = newThreadChooser.value;
  const [scope, setScope] = useState(null);
  const [value, setValue] = useState(null);
  const projectId = activeProjectId.value || null;
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
        setScope({ workers, unavailable: body.unavailable ?? [] });
        setValue({ worker: worker?.id ?? '', model: worker?.defaultModel ?? '', effort: '' });
      })
      .catch((error) => live && setScope({ error: error.message }));
    return () => {
      live = false;
    };
  }, [preset, projectId]);
  if (!preset) return null;
  const close = () => {
    newThreadChooser.value = null;
  };
  const start = async () => {
    const worker = scope.workers.find((w) => w.id === value.worker);
    close();
    await createThread({
      ...(worker && !worker.default ? { worker: worker.id } : {}),
      ...(value.model && value.model !== worker?.defaultModel ? { model: value.model } : {}),
      ...(value.effort ? { effort: value.effort } : {}),
    });
  };
  return html`<${Modal} title="New thread" onClose=${close} class="run-modal new-thread-modal">
    ${
      scope?.error
        ? html`<p class="run-picker-note">Could not read the workers: ${scope.error}</p>`
        : scope && value
          ? html`<${RunPicker} value=${value} workers=${scope.workers} unavailable=${scope.unavailable} onChange=${setValue} />`
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
