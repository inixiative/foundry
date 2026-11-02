/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Incoming requests where you work: hatched rows at the top of Open › Shared (never styled like a
 * thread), and a request view in the centre that says who is asking, for what, and where it would
 * go if you accept. Nothing runs until you accept it in Kingdom.
 */

import { html, useState } from './lib.js';
import { activeProjectId, incoming, incomingOpenId, projects, showToast } from './store.js';

const ROUTES = [
  [
    'thread',
    'Start a thread in a project',
    'A new thread with your agent, inside the project. They see only that thread.',
  ],
  [
    'join',
    'Let them join a project',
    "They become a member of the project: they can open threads there under the Signet's terms.",
  ],
  [
    'personal',
    'Keep it personal',
    'A conversation with you, outside any project. It routes to your personal Archive.',
  ],
];

const routeWord = (route, project) =>
  route === 'join'
    ? `joins ${project}`
    : route === 'personal'
      ? 'personal'
      : `thread in ${project}`;

/** The route chosen for each request, kept while the viewer is open. */
const chosen = new Map();
function routeOf(request) {
  const active = projects.value.find((p) => p.id === activeProjectId.value);
  const project = active?.label ?? projects.value[0]?.label ?? 'Global';
  return chosen.get(request.id) ?? { route: 'thread', project };
}

export function IncomingRows() {
  const requests = incoming.value;
  if (!requests.length) return null;
  return html`<div class="incoming-rows" aria-label="Incoming requests, not accepted">
    ${requests.map((r) => {
      const { route, project } = routeOf(r);
      return html`<button type="button" key=${r.id} class="incoming-row ${incomingOpenId.value === r.id ? 'is-open' : ''}"
        title=${`${r.requester} · ${r.name} · not accepted yet`}
        onClick=${() => {
          incomingOpenId.value = r.id;
        }}>
        <span class="incoming-row-who"><span class="incoming-glyph" aria-hidden="true">⇩</span>${r.requester}</span>
        <span class="incoming-row-what"><i>wants</i> ${r.name}</span>
        <span class="incoming-row-route">→ ${routeWord(route, project)}${r.createdAt ? html`<span class="incoming-row-when">${new Date(r.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>` : null}</span>
      </button>`;
    })}
  </div>`;
}

export function RequestView() {
  const request = incoming.value.find((r) => r.id === incomingOpenId.value);
  const [, rerender] = useState(0);
  const [note, setNote] = useState('');
  if (!request) return null;
  const { route, project } = routeOf(request);
  const set = (next) => {
    chosen.set(request.id, { ...routeOf(request), ...next });
    rerender((n) => n + 1);
  };
  // Kingdom decides; the note can't ride the review link, so it goes on the clipboard.
  const carry = () => {
    if (!note.trim()) return;
    navigator.clipboard
      ?.writeText(note.trim())
      .then(() => showToast('Your note is copied: paste it in Kingdom', 'ok'))
      .catch(() => showToast("Couldn't copy your note", 'warn'));
  };
  const names = projects.value.filter((p) => p.status !== 'archived').map((p) => p.label);
  const until = request.until ? new Date(request.until).toLocaleDateString() : 'no end date';
  const allowance = request.maxRequests ? `${request.maxRequests} requests` : 'unlimited requests';
  const pick = (
    k,
  ) => html`<select class="settings-input" value=${project} onChange=${(e) => set({ route: k, project: e.target.value })}>
    ${names.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
  </select>`;
  return html`<section class="request-view" aria-label="Incoming request">
    <header class="request-head">
      <span class="incoming-glyph" aria-hidden="true">⇩</span>
      <div>
        <div class="request-eyebrow">Incoming · not accepted · nothing runs until you say yes</div>
        <h2>${request.requester}</h2>
      </div>
    </header>
    <div class="request-box">
      <h4>What they want</h4>
      <p>${request.name}</p>
      <div class="request-terms">
        ${request.full ? html`<span><i>Can</i> do everything it offers</span>` : null}
        ${request.operations.map((op) => html`<span key=${op}><i>Can</i> ${op}</span>`)}
        <span><i>For</i> ${request.lifecycle}</span>
        <span><i>Limit</i> ${allowance}</span>
        <span><i>Until</i> ${until}</span>
      </div>
    </div>
    <div class="request-box">
      <h4>Where it goes if you accept</h4>
      <div class="request-routes" role="radiogroup">
        ${ROUTES.map(
          ([
            k,
            title,
            body,
          ]) => html`<label key=${k} class="request-route ${route === k ? 'is-on' : ''}">
            <input type="radio" name="route" checked=${route === k} onChange=${() => set({ route: k })} />
            <span><b>${title}</b>${k !== 'personal' ? pick(k) : null}<small>${body}</small></span>
          </label>`,
        )}
      </div>
    </div>
    <p class="request-safe">Accepting opens Kingdom to issue a Signet with these terms; you can narrow them there. Declining happens there too and shares nothing.</p>
    <div class="request-compose">
      <textarea class="chat-input" rows="2" value=${note} onInput=${(e) => setNote(e.target.value)}
        placeholder=${`Add context for ${request.requester} or for your agent: it goes with Accept or Decline`}></textarea>
      <div class="composer-note-hint">Kingdom's review has no note field yet: your note is copied when you go there, to paste in</div>
    </div>
    <div class="request-actions">
      <a class="proj-btn" href=${request.reviewUrl} target="_blank" rel="noopener" onClick=${carry}>Decline ↗</a>
      <a class="proj-btn proj-btn-ok" href=${request.reviewUrl} target="_blank" rel="noopener" onClick=${carry}>Accept · ${routeWord(route, project)} · review in Kingdom ↗</a>
    </div>
  </section>`;
}
