/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Artifacts: what the agent made to show the person (`set_artifact`), beside Thread and Plan.
 *
 * The thread's meta holds the index (id, title, kind, versions); each version's content is read
 * from the journal when it is opened. Markdown and Mermaid render through the thread's Markdown
 * renderer, code as a fenced block. An HTML page runs in a sandboxed frame with an opaque origin
 * (no `allow-same-origin`), so its scripts run but cannot read the viewer, its cookies or its
 * storage, and the viewer's API refuses a request from it (`Origin: null`, `sameOrigin`). A CSP
 * placed first in the page also refuses fetch, XHR, WebSockets, forms and plugins.
 */
import { html, useEffect, useState } from './lib.js';
import { Markdown } from './markdown.js';
import { activeThreadId, artifactSelection, authFetch, openArtifact, threadData } from './store.js';

/** The policy an HTML artifact runs under: scripts and styles inline or over https; no connections. */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob: https:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/** The page an HTML artifact's frame loads: the policy first, so it holds before any of the page's own markup. */
export const artifactDocument = (content) =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">${content}`;

const KIND_LABELS = { markdown: 'Document', mermaid: 'Diagram', html: 'Page', code: 'Code' };

/** Newest first; the list keeps the last one saved at its end, which breaks a tie. */
const newestFirst = (artifacts) =>
  [...(artifacts ?? [])].reverse().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

const latestOf = (artifact) => artifact.versions.at(-1)?.version ?? 1;

/** Every version of one artifact, read from the journal; refetched when a new version lands. */
function useVersions(threadId, artifact) {
  const [state, setState] = useState({ key: null, versions: null, error: null });
  const key = artifact ? `${threadId}:${artifact.id}:${latestOf(artifact)}` : null;
  useEffect(() => {
    if (!key) return;
    let live = true;
    setState((s) => ({ ...s, error: null }));
    authFetch(
      `/api/threads/${encodeURIComponent(threadId)}/artifacts/${encodeURIComponent(artifact.id)}`,
    )
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw Error(body.error ?? res.statusText);
        if (live) setState({ key, versions: body.versions ?? [], error: null });
      })
      .catch((error) => live && setState({ key, versions: null, error: error.message }));
    return () => {
      live = false;
    };
  }, [key]);
  return state.key === key ? state : { key, versions: null, error: state.error };
}

function ArtifactBody({ record }) {
  if (record.kind === 'html')
    return html`<iframe class="artifact-frame" title=${record.title} sandbox="allow-scripts"
      referrerpolicy="no-referrer" srcdoc=${artifactDocument(record.content)}></iframe>`;
  if (record.kind === 'mermaid')
    return html`<${Markdown} className="artifact-md" text=${`\`\`\`mermaid\n${record.content}\n\`\`\``} />`;
  if (record.kind === 'code') {
    const fence = '`'.repeat(
      Math.max(3, ...(record.content.match(/`+/g) ?? []).map((m) => m.length + 1)),
    );
    return html`<${Markdown} className="artifact-md artifact-code"
      text=${`${fence}${record.language ?? ''}\n${record.content}\n${fence}`} />`;
  }
  return html`<${Markdown} className="artifact-md" text=${record.content} />`;
}

function ArtifactViewer({ threadId, artifact, version }) {
  const { versions, error } = useVersions(threadId, artifact);
  const shown = version ?? latestOf(artifact);
  const record = versions?.find((v) => v.version === shown) ?? versions?.at(-1);
  return html`<section class="artifact-viewer" data-artifact=${artifact.id}>
    <header class="artifact-head">
      <h3 class="artifact-title">${artifact.title}</h3>
      <span class="artifact-kind">${KIND_LABELS[artifact.kind] ?? artifact.kind}</span>
      ${
        artifact.versions.length > 1
          ? html`<select class="rp-select artifact-version" aria-label="Version" value=${String(record?.version ?? shown)}
              onChange=${(e) => openArtifact(artifact.id, Number(e.target.value))}>
              ${[...artifact.versions].reverse().map((v) => html`<option key=${v.version} value=${String(v.version)}>v${v.version}${v.version === latestOf(artifact) ? ' (latest)' : ''}</option>`)}
            </select>`
          : html`<span class="artifact-kind">v1</span>`
      }
    </header>
    ${
      error
        ? html`<div class="rp-dim">Could not read it: ${error}</div>`
        : record
          ? html`<div class="artifact-body"><${ArtifactBody} key=${`${artifact.id}:${record.version}`} record=${record} /></div>`
          : html`<div class="rp-dim">Reading…</div>`
    }
  </section>`;
}

/** The Artifacts tab: the thread's artifacts, newest first, and the one open. */
export function Artifacts() {
  const threadId = activeThreadId.value;
  const artifacts = newestFirst(threadData.value?.meta?.artifacts);
  if (!artifacts.length)
    return html`<div class="rp-empty artifacts-empty">No artifacts yet. When the agent makes something to show you (a document, a diagram, a page), it appears here and as a card on the turn that made it.</div>`;
  const selected = artifactSelection.value;
  const open = artifacts.find((a) => a.id === selected?.id) ?? artifacts[0];
  return html`<div class="artifacts">
    <nav class="artifact-list" aria-label="Artifacts">
      ${artifacts.map(
        (a) => html`<button key=${a.id} class="artifact-item ${a.id === open.id ? 'is-active' : ''}"
          aria-current=${a.id === open.id ? 'true' : undefined} onClick=${() => openArtifact(a.id)}>
          <span class="artifact-item-title">${a.title}</span>
          <span class="artifact-item-meta">${KIND_LABELS[a.kind] ?? a.kind} · v${latestOf(a)}</span>
        </button>`,
      )}
    </nav>
    <${ArtifactViewer} key=${open.id} threadId=${threadId}
      artifact=${open} version=${selected?.id === open.id ? selected.version : undefined} />
  </div>`;
}

/** Cards under a turn's message for each artifact version that turn wrote; a card opens it. */
export function ArtifactCards({ turnId }) {
  if (!turnId) return null;
  const made = (threadData.value?.meta?.artifacts ?? []).flatMap((a) =>
    a.versions.filter((v) => v.turnId === turnId).map((v) => ({ artifact: a, version: v.version })),
  );
  if (!made.length) return null;
  return html`<div class="artifact-cards">
    ${made.map(
      ({ artifact, version }) => html`<button key=${`${artifact.id}:${version}`} type="button"
        class="artifact-card" title="Open in Artifacts" onClick=${() => openArtifact(artifact.id, version)}>
        <span class="artifact-card-kind">${KIND_LABELS[artifact.kind] ?? artifact.kind}</span>
        <span class="artifact-card-title">${artifact.title}</span>
        <span class="artifact-card-version">v${version}</span>
      </button>`,
    )}
  </div>`;
}
