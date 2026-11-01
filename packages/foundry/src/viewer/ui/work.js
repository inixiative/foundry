/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Work: what this thread produced. File changes, commits, artifacts and the Signets in play.
 *
 * Files are the paths the turns' write tools named (the flow stream's `files`); commits are the
 * thread's branch ahead of the origin's default branch (`GET /api/threads/:id/commits`, read-only);
 * artifacts are its pull requests and each turn's journalled records; Signets are its members'
 * grants, read-only, managed in Kingdom. Diffs open in GitHub: the diff viewer is VIEWER-003.
 */
import { useFlowStream } from './graph-view.js';
import { html, useEffect, useState } from './lib.js';
import { activeThreadId, detailDrawerOpen, openTurnDetail, rightTab, threadData } from './store.js';

const githubRef = (ref) => /^#?\d+$/.test(ref) || /^[\w.-]+\/[\w.-]+#\d+$/.test(ref);

/** Kingdom's own wording for a member's terms (Kingdom `ThreadsLensEditor.tsx`). */
const LENS_WORDS = {
  view: {
    own: 'Its own posts and what is sent to it',
    thread: 'The whole thread: messages and answers, never tool calls',
  },
  delivery: { note: 'A note on your next turn', turn: 'A turn of its own' },
  outbound: {
    review: 'You review what your agent sends it',
    auto: 'Your agent sends to it directly',
  },
};

function Section({ title, count, children }) {
  return html`<section class="rp-section work-section">
    <h3 class="rp-section-title">${title}${count ? html` <span class="rp-dim">${count}</span>` : null}</h3>
    ${children}
  </section>`;
}

/** Read `path` while `threadId` is open; null until it answers, or when it fails. */
function useThreadRead(threadId, path, key = '') {
  const [body, setBody] = useState(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read on the thread and its key only.
  useEffect(() => {
    setBody(null);
    if (!threadId) return;
    let live = true;
    fetch(`/api/threads/${encodeURIComponent(threadId)}/${path}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((value) => {
        if (live) setBody(value);
      })
      .catch(() => {
        if (live) setBody(null);
      });
    return () => {
      live = false;
    };
  }, [threadId, key]);
  return body;
}

/** Kingdom's Access page for the Foundry's integration, from the conversation's invite link. */
function kingdomManageUrl(view) {
  const invite = view?.invites?.find((candidate) => candidate.url)?.url;
  if (!invite) return null;
  try {
    const url = new URL(invite);
    url.searchParams.delete('threadId');
    return url.toString();
  } catch {
    return null;
  }
}

function SignetCard({ member, manageUrl }) {
  const lens = member.lens;
  const limits = member.limits ?? {};
  return html`<li class="signet-card" data-member=${member.member.id}>
    <div class="signet-card-head">
      <span class="signet-seal" aria-hidden="true"></span>
      <span class="signet-card-name">${member.displayName}</span>
      ${member.listed ? null : html`<span class="rp-dim">no longer listed by Kingdom</span>`}
    </div>
    <dl class="rp-facts">
      ${lens ? html`<dt>It reads</dt><dd>${LENS_WORDS.view[lens.view] ?? lens.view}</dd>` : null}
      ${lens ? html`<dt>Its posts arrive as</dt><dd>${LENS_WORDS.delivery[lens.delivery] ?? lens.delivery}</dd>` : null}
      ${lens ? html`<dt>Replies to it</dt><dd>${LENS_WORDS.outbound[lens.outbound] ?? lens.outbound}</dd>` : null}
      <dt>Requests</dt><dd>${limits.maxRequests ?? 'unlimited'}</dd>
      <dt>Expires</dt><dd>${limits.expiresAt ? new Date(limits.expiresAt).toLocaleString() : 'no grant deadline'}</dd>
    </dl>
    ${manageUrl ? html`<a class="rp-link" href=${manageUrl} target="_blank" rel="noopener noreferrer">Manage in Kingdom ↗</a>` : null}
  </li>`;
}

export function Work() {
  const data = threadData.value;
  const threadId = activeThreadId.value;
  const flow = useFlowStream(threadId, !!threadId);
  const meta = data?.meta || {};
  const context = meta.context ?? {};
  const branch = context.branch ?? meta.branch ?? null;
  const repository = context.repository ?? null;
  const commits = useThreadRead(threadId, 'commits', branch ?? '');
  const conversationKey = JSON.stringify(data?.conversation ?? null);
  const conversation = useThreadRead(
    data?.conversation ? threadId : null,
    'conversation',
    conversationKey,
  );
  if (!data || !threadId) return html`<div class="rp-empty">Open a thread to see its work.</div>`;

  const turns = flow.turns ?? [];
  const files = new Map();
  turns.forEach((turn, i) => {
    for (const file of turn.files ?? [])
      files.set(file.path, { ...file, turnId: turn.turnId, turn: i + 1 });
  });
  const prs = (context.references ?? []).filter(
    (r) => r.integration === 'github' && githubRef(r.ref),
  );
  const compareUrl =
    repository && branch
      ? `https://github.com/${repository}/compare/${encodeURIComponent(commits?.base?.replace(/^origin\//, '') || 'main')}...${encodeURIComponent(branch)}`
      : null;
  const members = conversation?.members ?? [];
  const manageUrl = kingdomManageUrl(conversation);

  return html`<div class="rp-stack work">
    <section class="rp-section coming-soon-card">
      <h3 class="rp-section-title">Diff viewer <span class="coming-soon">Coming soon</span></h3>
      <p class="rp-dim">Each hunk tagged by its Atlas concept, the gloss inline, and the Warden pointers and guards that touched it. Until then, diffs open on GitHub (Compare, below).</p>
    </section>
    <${Section} title="File changes" count=${files.size || null}>
      ${
        files.size
          ? html`<ul class="rp-list work-files">${[...files.values()].map(
              (f) => html`<li key=${f.path} class="work-file">
                <span class="rp-mono work-file-path" title=${f.path}>${f.path}</span>
                <span class="rp-dim">${f.tool} · t${f.turn}</span>
              </li>`,
            )}</ul>`
          : html`<div class="rp-dim">No file writes recorded on this thread’s recent turns.</div>`
      }
      ${compareUrl ? html`<a class="rp-link" href=${compareUrl} target="_blank" rel="noopener noreferrer">See the diff in GitHub ↗</a>` : null}
    </${Section}>

    <${Section} title="Commits" count=${commits?.commits?.length || null}>
      ${
        commits === null
          ? html`<div class="rp-dim">Reading the branch…</div>`
          : commits.commits.length
            ? html`<div class="rp-dim">${branch ? html`<span class="rp-mono">${branch}</span>` : 'This branch'} ahead of <span class="rp-mono">${commits.base}</span></div>
              <ul class="rp-list work-commits">${commits.commits.map(
                (c) => html`<li key=${c.sha} class="work-commit">
                  ${
                    repository
                      ? html`<a class="rp-mono" href=${`https://github.com/${repository}/commit/${c.sha}`} target="_blank" rel="noopener noreferrer">${c.short}</a>`
                      : html`<span class="rp-mono">${c.short}</span>`
                  }
                  <span class="work-commit-subject">${c.subject}</span>
                  <span class="rp-dim">${c.author} · ${new Date(c.at).toLocaleString()}</span>
                </li>`,
              )}</ul>`
            : html`<div class="rp-dim">No commits ahead of ${commits.base ?? 'the base branch'}.</div>`
      }
    </${Section}>

    <${Section} title="Artifacts">
      ${
        prs.length
          ? html`<ul class="rp-list">${prs.map(
              (r) =>
                html`<li key=${r.ref}>${
                  r.url
                    ? html`<a href=${r.url} target="_blank" rel="noopener noreferrer">Pull request ${r.ref} ↗</a>`
                    : html`<span>Pull request ${r.ref}</span>`
                }</li>`,
            )}</ul>`
          : null
      }
      ${
        turns.length
          ? html`<ul class="rp-list">${[...turns].reverse().map(
              (t) => html`<li key=${t.turnId} class="work-turn">
                <span class="work-turn-input">${t.input?.preview || '(no message)'}</span>
                <span class="rp-dim">${t.status}</span>
                <button class="rp-link" onClick=${() => openTurnDetail(threadId, t.turnId)}>Turn records ›</button>
              </li>`,
            )}</ul>`
          : html`<div class="rp-dim">No turns recorded yet.</div>`
      }
    </${Section}>

    <${Section} title="Signets" count=${members.length || null}>
      ${
        members.length
          ? html`<ul class="signet-cards">${members.map((m) => html`<${SignetCard} key=${m.member.id} member=${m} manageUrl=${manageUrl} />`)}</ul>`
          : html`<div class="rp-dim">No Signet is in use on this thread.</div>`
      }
      <button class="rp-link" onClick=${() => {
        rightTab.value = 'permissions';
        detailDrawerOpen.value = true;
      }}>This project’s Kingdom grants are on Permissions ›</button>
    </${Section}>
  </div>`;
}
