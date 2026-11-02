/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The thread header's worktree pill, beside the branch pill: which checkout the thread works in,
 * from the thread's worktree record (`meta.context.checkout`). Template mode names its slot (its own
 * ports, database and Redis); classic mode names the folder; the main checkout is muted; a worktree
 * released after merge reads "· released" with Recreate (`POST /api/threads/:id/worktree/recreate`,
 * the project's own worktree mode run from the thread's branch), then "· recreating" until it's back.
 */

import { html } from './lib.js';

const svg = (d) =>
  html`<svg class="pill-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

/** A git branch (lucide git-branch). */
export const BranchIcon = () =>
  svg(
    html`<line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />`,
  );

/** A folder: a worktree is its own checkout folder (lucide folder). */
export const FolderIcon = () =>
  svg(
    html`<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />`,
  );

const base = (path) => path?.split('/').filter(Boolean).at(-1) ?? '';

/** What the pill says and how it looks, from the worktree record. */
export function worktreeLabel(checkout) {
  const name = base(checkout.path);
  if (checkout.mode === 'none')
    return {
      tone: 'muted',
      label: 'no checkout',
      title: 'This thread works outside any git checkout',
    };
  if (checkout.main)
    return {
      tone: 'muted',
      label: 'main checkout',
      title: [checkout.path, 'The repository’s main checkout, not a worktree']
        .filter(Boolean)
        .join('\n'),
    };
  const mode =
    checkout.mode === 'template'
      ? 'Template worktree: its own ports, database and Redis'
      : 'Classic git worktree';
  if (checkout.state === 'recreating')
    return {
      tone: 'released',
      label: `${name} · recreating`,
      title: `${checkout.path ?? name}\n${mode}\nRecreating from the thread’s branch`,
    };
  if (checkout.state === 'released')
    return {
      tone: 'released',
      label: `${name} · released${checkout.merged ? ` · merged into ${checkout.merged.into}` : ''}`,
      title: `${checkout.path ?? name}\n${mode}\nReleased: the worktree was removed after merge${checkout.error ? `\nThe last recreate failed: ${checkout.error}` : ''}`,
    };
  const merged = checkout.merged ? ` · merged into ${checkout.merged.into}` : '';
  return {
    tone: 'live',
    label:
      checkout.mode === 'template' && checkout.slot != null
        ? `slot ${checkout.slot} · ${name}${merged}`
        : `${name}${merged}`,
    title: `${checkout.path ?? name}\n${mode}${checkout.merged ? `\nIts branch merged into ${checkout.merged.into}` : ''}`,
  };
}

export function WorktreePill({ checkout, onRecreate }) {
  if (!checkout) return null;
  const { tone, label, title } = worktreeLabel(checkout);
  return html`<span class="band-pill worktree-pill is-${tone}" title=${title}>${FolderIcon()}${label}${
    checkout.state === 'released'
      ? html`<button type="button" class="worktree-recreate" title="Recreate the worktree from the thread’s branch, with the project’s worktree mode"
          onClick=${onRecreate}>${checkout.error ? 'Retry recreate' : 'Recreate'}</button>`
      : null
  }</span>`;
}
