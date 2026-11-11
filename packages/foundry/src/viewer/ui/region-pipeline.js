/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The region pipeline on the Knowledge page (`GET /api/regions/pipeline`): the region builds on this
 * machine (template commit, when, regions, the largest, how many over 20k), the detection tests'
 * last results, and builds run from here (`POST /api/regions/pipeline/runs`, one at a time, after a
 * confirm that it spends model calls), with their live state and log. Setup, the delta and the doc
 * analysis run as parts of a build. The detection test has no committed runner, so it isn't run here.
 */

import { html, useEffect, useState } from './lib.js';
import { authFetch, showToast } from './store.js';

const POLL_MS = 2000;

/** The pipeline status; re-read every two seconds while a build runs. */
export function usePipeline() {
  const [body, setBody] = useState(undefined);
  const [tick, setTick] = useState(0);
  const running = body?.runs?.some((r) => r.state === 'running');
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick re-reads; running keeps polling.
  useEffect(() => {
    let live = true;
    const read = () =>
      authFetch('/api/regions/pipeline')
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null)
        .then((next) => live && setBody(next));
    read();
    const timer = running ? setInterval(read, POLL_MS) : null;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [tick, running]);
  return [body, () => setTick((n) => n + 1)];
}

const when = (value) =>
  value
    ? new Date(value).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';
const k = (n) => (n == null ? '—' : `${Math.round(n / 1000)}k`);

/** The latest build, as the step 1–3 summaries read it. */
export const latestBuild = (pipeline) => pipeline?.builds?.[0] ?? null;

export function BuildHistory({ pipeline }) {
  const builds = pipeline?.builds ?? [];
  if (pipeline === undefined) return html`<span class="rp-dim">Reading the topic builds…</span>`;
  if (!builds.length) return html`<span class="rp-dim">No topic build on this machine yet.</span>`;
  return html`<table class="ktable kbuilds">
    <tr><th>Built</th><th>Template commit</th><th>Topics</th><th>Largest</th><th>Over 20k</th></tr>
    ${builds.slice(0, 5).map(
      (b) => html`<tr key=${b.dir}>
        <td>${when(b.builtAt)}</td><td class="mono">${b.templateCommit?.slice(0, 10) ?? '—'}</td>
        <td>${b.regions ?? '—'}</td><td>${k(b.maxTokens)}</td>
        <td class=${b.over20k ? 'kwarn' : 'kok'}>${b.over20k}</td>
      </tr>`,
    )}
  </table>`;
}

/** Build regions: confirm (it spends model calls), one run at a time, with its live state and log. */
export function BuildRegions({ pipeline, reread }) {
  const [confirming, setConfirming] = useState(false);
  const [commit, setCommit] = useState('');
  const [busy, setBusy] = useState(false);
  const runs = pipeline?.runs ?? [];
  const running = runs.find((r) => r.state === 'running');
  const start = async () => {
    setBusy(true);
    try {
      const res = await authFetch('/api/regions/pipeline/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'region-build', commit: commit.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return showToast(body.error || 'The build did not start', 'error');
      setConfirming(false);
      reread();
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="kbuild">
    ${
      confirming
        ? html`<div class="kconfirm" role="group" aria-label="Confirm the topic build">
            <p><b>This spends model calls.</b> The build reads the template at this commit, splits its docs, rules and primitives into topics and describes each with the model.</p>
            <label class="settings-field">Template commit
              <input class="settings-input mono" value=${commit} placeholder="a commit SHA" onInput=${(e) => setCommit(e.target.value)} />
            </label>
            <div class="kconfirm-actions">
              <button type="button" class="proj-btn" onClick=${() => setConfirming(false)}>Cancel</button>
              <button type="button" class="proj-btn is-go" disabled=${busy || !commit.trim()} onClick=${start}>Spend model calls and build</button>
            </div>
          </div>`
        : null
    }
    ${runs.slice(0, 3).map(
      (r) => html`<div key=${r.id} class="krun" data-state=${r.state}>
        <div class="krun-head"><b>${r.state === 'running' ? 'Building' : r.state === 'done' ? 'Built' : 'Failed'}</b>
          <span class="mono">${r.commit.slice(0, 10)}</span>
          <span class="rp-dim">started ${when(r.startedAt)}${r.finishedAt ? ` · finished ${when(r.finishedAt)}` : ''}${r.exitCode != null && r.state === 'failed' ? ` · exit ${r.exitCode}` : ''}</span></div>
        ${r.log ? html`<pre class="krun-log">${r.log}</pre>` : null}
      </div>`,
    )}
    ${
      confirming
        ? null
        : html`<button type="button" class="proj-btn is-go kbuild-start" disabled=${!!running}
            title=${running ? 'A build is running; one at a time' : 'Build topics (spends model calls)'}
            onClick=${() => {
              setCommit(latestBuild(pipeline)?.templateCommit ?? '');
              setConfirming(true);
            }}>${running ? 'Building…' : 'Build topics'}</button>`
    }
  </div>`;
}

/** A metrics object as rows: its plain values, and nested objects as JSON. */
function Metrics({ metrics }) {
  if (!metrics || typeof metrics !== 'object') return null;
  return html`<table class="ktable">${Object.entries(metrics)
    .filter(([key]) => key !== 'reading')
    .map(
      ([key, value]) =>
        html`<tr key=${key}><td>${key}</td><td class="mono">${
          value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)
        }</td></tr>`,
    )}</table>`;
}

export function DetectionTests({ pipeline, bar }) {
  const tests = pipeline?.detectionTests ?? [];
  if (pipeline === undefined) return html`<span class="rp-dim">Reading the detection tests…</span>`;
  if (!tests.length)
    return html`<span class="rp-dim">No detection test results on this machine yet · bar ${bar}</span>`;
  const [last, ...earlier] = tests;
  return html`<div class="kdetect">
    <div><b>${last.id}</b> <span class="rp-dim">${last.date ?? ''} · bar ${bar}</span></div>
    ${last.reading ? html`<p class="kreading">${last.reading}</p>` : null}
    <${Metrics} metrics=${last.metrics} />
    ${
      earlier.length
        ? html`<p class="rp-dim">${earlier.length} earlier: ${earlier
            .slice(0, 4)
            .map((t) => t.id)
            .join(', ')}${earlier.length > 4 ? '…' : ''}</p>`
        : null
    }
  </div>`;
}
