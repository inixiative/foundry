/**
 * Atlas in the panels: what this thread touches, by concept (Context), other threads sharing those
 * concepts (Heralds), and the "Set up Atlas" call when the project has no Atlas. Data from
 * `GET /api/threads/:id/atlas` (the thread's read and written files through the project's `atlas
 * graph`). Atlas has no init command yet (`atlas setup` only adds Claude Code hooks), so setting it
 * up from here isn't built.
 */

import { html, useEffect, useState } from './lib.js';
import { allThreads, authFetch, selectThread } from './store.js';
import { threadName } from './thread-labels.js';

const cache = new Map();

/** The thread's Atlas read, shared by the tabs (re-read when the thread changes). */
function useThreadAtlas(threadId) {
  const [body, setBody] = useState(cache.get(threadId));
  useEffect(() => {
    if (!threadId) return;
    let live = true;
    authFetch(`/api/threads/${encodeURIComponent(threadId)}/atlas`)
      .then((res) =>
        res.ok ? res.json() : { mapped: false, error: `unavailable (${res.status})` },
      )
      .catch((err) => ({ mapped: false, error: err.message }))
      .then((value) => {
        cache.set(threadId, value);
        if (live) setBody(value);
      });
    return () => {
      live = false;
    };
  }, [threadId]);
  return body;
}

/** The project has no Atlas: what it would give, and the (not built) way to set it up. */
export function SetUpAtlas({ project }) {
  return html`<div class="atlas-cta">
    <b>${project ? `${project} has no Atlas yet` : 'This project has no Atlas yet'}</b>
    <p>Atlas maps the code into concepts (what each area is and the primitives in it). With it, this thread shows what it touches, Heralds spot overlapping work, and the code and diff viewers can annotate.</p>
    <button type="button" class="proj-btn" disabled title="Atlas has no init command yet: atlas setup only adds Claude Code hooks">Set up Atlas · not built</button>
  </div>`;
}

const fileName = (path) => path.split('/').pop();

/** Where in the concept: the touched files by name, the first two and a count of the rest. */
function where(c) {
  const names = c.paths.map(fileName);
  const shown = names.slice(0, 2).join(', ');
  return c.files > 2 ? `${shown} +${c.files - 2}` : shown;
}

export function AtlasTouches({ threadId, project }) {
  const body = useThreadAtlas(threadId);
  return html`<section class="rp-section">
    <h3 class="rp-section-title">Atlas · what this touches</h3>
    ${
      body === undefined
        ? html`<div class="rp-dim">Reading the project’s Atlas…</div>`
        : !body.mapped
          ? body.reason === 'no project'
            ? html`<div class="rp-dim">This thread isn’t in a project, so there’s no Atlas to read.</div>`
            : body.error
              ? html`<div class="rp-dim">The project’s Atlas couldn’t be read: ${body.error}.</div>`
              : html`<${SetUpAtlas} project=${project} />`
          : html`${
              body.concepts.length
                ? html`<ul class="atlas-list">${body.concepts.map(
                    (c) => html`<li key=${c.concept} class="atlas-row">
                      <b>${c.concept}</b>
                      <small title=${c.paths.join('\n')}>${where(c)}${c.changed ? ` · ${c.changed} changed` : ''}</small>
                      ${c.doc ? html`<code class="atlas-doc" title=${c.doc}>† ${c.doc}</code>` : null}
                      <i>${c.files} file${c.files === 1 ? '' : 's'}</i>
                    </li>`,
                  )}</ul>`
                : html`<div class="rp-dim">No Atlas concepts yet: nothing it read or changed is mapped.</div>`
            }
            <p class="rp-dim atlas-note">From the files this thread read and changed. Heralds use the same concepts to spot overlap with other work.</p>`
    }
  </section>`;
}

export function SharedConcepts({ threadId, project }) {
  const body = useThreadAtlas(threadId);
  if (body === undefined) return html`<div class="rp-dim">Reading the project’s Atlas…</div>`;
  if (!body.mapped)
    return body.reason === 'no project' ? null : html`<${SetUpAtlas} project=${project} />`;
  if (!body.shared.length)
    return html`<div class="rp-dim">No other thread in this project touches the same concepts.</div>`;
  return html`<ul class="atlas-list">${body.shared.map((s) => {
    const listed = allThreads.value.find((t) => t.threadId === s.threadId);
    return html`<li key=${s.threadId}>
      <button type="button" class="rp-link" onClick=${() => selectThread(s.threadId)}>${listed ? threadName(listed) : s.name}</button>
      <span class="atlas-shared">${s.concepts.map((c) => html`<code key=${c} class="cmd">${c}</code>`)}</span>
    </li>`;
  })}</ul>`;
}
