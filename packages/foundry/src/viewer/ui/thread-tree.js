/**
 * Thread list — the lower half of the navigation column: the threads of the selected scope
 * (a project, Global, or Forge Master's one thread), each with its status, branch and references.
 */

import { html, useState } from './lib.js';
import {
  activeProjectId,
  activeThreadId,
  allThreads,
  createThread,
  executeAction,
  forgeMasterOpen,
  projects,
  promptCounts,
  selectThread,
  worktrees,
} from './store.js';
import {
  isUnnamed,
  nameSourceLabel,
  ReferenceChips,
  threadName,
  threadPlace,
} from './thread-labels.js';

// ---------------------------------------------------------------------------
// Active/inactive classification
// ---------------------------------------------------------------------------

const INACTIVE_THREAD_STATES = new Set(['archived', 'completed', 'done']);

function isActiveThread(t) {
  return !INACTIVE_THREAD_STATES.has(t.status);
}

// ---------------------------------------------------------------------------
// Inactive fold — "N inactive" / "N uninstantiated"
// ---------------------------------------------------------------------------

function InactiveFold({ count, label, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  if (count === 0) return null;

  return html`
    <div class="inactive-fold">
      <div class="inactive-fold-header" onClick=${() => setOpen(!open)}>
        <span class="inactive-caret">${open ? '▼' : '▶'}</span>
        <span class="inactive-label">${count} ${label}</span>
      </div>
      ${open ? html`<div class="inactive-fold-body">${children}</div>` : null}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Status dot
// ---------------------------------------------------------------------------

function StatusDot({ status }) {
  const colors = {
    active: '#4ade80',
    idle: '#6c9eff',
    waiting: '#facc15',
    archived: '#555',
    completed: '#555',
    done: '#555',
  };
  const color = colors[status] || '#555';
  return html`<span class="tree-status-dot" style="background: ${color}" title=${status}></span>`;
}

// ---------------------------------------------------------------------------
// Thread actions — overflow menu per thread (mirrors MessageActions)
// ---------------------------------------------------------------------------

function ThreadActions({ thread }) {
  const [open, setOpen] = useState(false);
  const toggle = (e) => {
    e.stopPropagation();
    setOpen((v) => !v);
  };
  const run = (kind) => (e) => {
    e.stopPropagation();
    setOpen(false);
    executeAction(kind, thread.id);
  };

  const status = thread.status || 'idle';
  const canPause = status === 'active' || status === 'idle';
  const canResume = status === 'waiting';
  const isArchived = INACTIVE_THREAD_STATES.has(status);

  return html`
    <div class="thread-actions ${open ? 'thread-actions-open' : ''}">
      <button class="thread-action-btn thread-action-trigger" onClick=${toggle}
        title="Actions" aria-expanded=${open}>${open ? '×' : '⋯'}</button>
      ${
        open
          ? html`
        ${
          canPause
            ? html`
          <button class="thread-action-btn" onClick=${run('thread:pause')}
            title="Pause thread">pause</button>
        `
            : null
        }
        ${
          canResume
            ? html`
          <button class="thread-action-btn" onClick=${run('thread:resume')}
            title="Resume thread">resume</button>
        `
            : null
        }
        ${
          !isArchived
            ? html`
          <button class="thread-action-btn" onClick=${run('thread:archive')}
            title="Archive thread">archive</button>
        `
            : null
        }
        <button class="thread-action-btn" onClick=${run('thread:inspect')}
          title="Inspect thread state">inspect</button>
      `
          : null
      }
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Thread node — shows metadata (model, temp, agent count, layers)
// ---------------------------------------------------------------------------

function ThreadNode({ thread, depth = 0, selectedId, onSelect, inactive = false }) {
  const [expanded, setExpanded] = useState(!inactive);
  const isSelected = selectedId === thread.id;
  const children = thread.children || [];
  const activeChildren = children.filter(isActiveThread);
  const inactiveChildren = children.filter((c) => !isActiveThread(c));
  const hasChildren = children.length > 0;

  return html`
    <div style="padding-left: ${depth * 16}px">
      <div
        class="tree-node ${isSelected ? 'selected' : ''} ${inactive ? 'dimmed' : ''}"
        onClick=${() => onSelect(thread.id)}
      >
        ${
          hasChildren
            ? html`
          <span
            class="tree-caret"
            onClick=${(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >${expanded ? '▼' : '▶'}</span>
        `
            : html`<span class="tree-caret-spacer"></span>`
        }
        <${StatusDot} status=${thread.status} />
        <span class="tree-text">
          <span class="tree-label ${thread.unnamed ? 'tree-label--unnamed' : ''}" data-name-source=${thread.nameSource || ''}
            title=${`${thread.id}${thread.nameSource ? ` · ${nameSourceLabel[thread.nameSource]}` : ''}`}>${thread.name}</span>
          ${
            thread.branch || thread.meta.context?.references?.length
              ? html`<span class="tree-sub">
            ${thread.branch ? html`<span class="thread-branch-badge" title=${thread.branch}>${thread.branch}</span>` : null}
            <${ReferenceChips} meta=${thread.meta} cls="thread-meta-tag" />
          </span>`
              : null
          }
        </span>
        ${(() => {
          const count = (promptCounts.value || {})[thread.id] || 0;
          return count > 0
            ? html`<span class="prompt-badge ${count > 2 ? 'urgent' : ''}" title="${count} pending prompt${count > 1 ? 's' : ''}">${count}</span>`
            : null;
        })()}
        <${ThreadActions} thread=${thread} />
      </div>

      ${
        expanded && hasChildren
          ? html`
        ${activeChildren.map(
          (child) =>
            html`<${ThreadNode}
            key=${child.id} thread=${child} depth=${depth + 1}
            selectedId=${selectedId} onSelect=${onSelect}
          />`,
        )}
        <${InactiveFold} count=${inactiveChildren.length} label="inactive">
          ${inactiveChildren.map(
            (child) =>
              html`<${ThreadNode}
              key=${child.id} thread=${child} depth=${depth + 1}
              selectedId=${selectedId} onSelect=${onSelect} inactive=${true}
            />`,
          )}
        </${InactiveFold}>
      `
          : null
      }
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Collapsible section with optional [+] button
// ---------------------------------------------------------------------------

function AddThreadForm({ onDone }) {
  const [name, setName] = useState('');
  const [selectedWorktree, setSelectedWorktree] = useState('');
  const [saving, setSaving] = useState(false);

  const wts = worktrees.value;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    const wt = wts.find((w) => w.path === selectedWorktree);
    const result = await createThread({
      name: name.trim() || undefined,
      worktreePath: selectedWorktree || undefined,
      branch: wt?.branch || undefined,
    });
    setSaving(false);
    if (result) onDone();
  };

  return html`
    <form class="thread-add-form" onSubmit=${handleSubmit}>
      <input class="proj-input" placeholder="name (optional)" value=${name}
        onInput=${(e) => setName(e.target.value)} />
      ${
        wts.length > 1
          ? html`
        <select class="proj-input" value=${selectedWorktree}
          onChange=${(e) => setSelectedWorktree(e.target.value)}>
          <option value="">main worktree</option>
          ${wts
            .filter((w) => !w.isMain)
            .map(
              (w) => html`
            <option key=${w.path} value=${w.path}>
              ${w.branch || w.path.split('/').pop()}
            </option>
          `,
            )}
        </select>
      `
          : null
      }
      <div class="proj-form-actions">
        <button type="submit" class="proj-btn proj-btn-ok" disabled=${saving}>
          ${saving ? '...' : 'create'}
        </button>
        <button type="button" class="proj-btn" onClick=${onDone}>cancel</button>
      </div>
    </form>
  `;
}

// Signals for creation mode (consumed by detail-drawer)
/** Forge Master is one persistent thread; it shows here when Forge Master is selected. */
function ForgeMasterThread() {
  return html`
    <div class="tree-node selected" title="Forge Master: the persistent thread about this Foundry">
      <span class="tree-caret-spacer"></span>
      <span class="tree-status-dot" style="background: #6c9eff"></span>
      <span class="tree-text"><span class="tree-label">Forge Master</span></span>
    </div>
  `;
}

export function ThreadList() {
  const [addingThread, setAddingThread] = useState(false);
  const forge = forgeMasterOpen.value;
  const selectedThread = activeThreadId.value;
  const activeProject = activeProjectId.value;
  const scopeLabel = forge
    ? 'Forge Master'
    : activeProject
      ? projects.value.find((p) => p.id === activeProject)?.label || activeProject
      : 'Global';

  const nodeById = new Map(
    allThreads.value.map((t) => [
      t.threadId,
      {
        id: t.threadId,
        status: t.meta?.status || 'idle',
        name: threadName(t),
        unnamed: isUnnamed(t),
        nameSource: t.title?.source || null,
        meta: t.meta || {},
        branch: threadPlace(t.meta).branch,
        cwd: t.meta?.cwd || null,
        parentThreadId: t.meta?.parentThreadId || null,
        children: [],
      },
    ]),
  );
  const threadNodes = [];
  for (const node of nodeById.values()) {
    const parent = node.parentThreadId ? nodeById.get(node.parentThreadId) : null;
    if (parent && parent !== node) parent.children.push(node);
    else threadNodes.push(node);
  }

  return html`
    <section class="thread-list" aria-label="Threads">
      <div class="sidebar-header">
        <span class="sidebar-section-title">THREADS</span>
        <span class="sidebar-scope-chip ${activeProject && !forge ? 'scope-project' : 'scope-global'}" title=${scopeLabel}>${scopeLabel}</span>
        ${
          forge
            ? null
            : html`<button class="sidebar-add-btn" onClick=${() => setAddingThread(true)} title="New thread">+</button>`
        }
      </div>

      ${!forge && addingThread ? html`<${AddThreadForm} onDone=${() => setAddingThread(false)} />` : null}

      <div class="sidebar-threads-list">
        ${
          forge
            ? html`<${ForgeMasterThread} />`
            : threadNodes.length > 0
              ? threadNodes.map(
                  (t) => html`
            <${ThreadNode} key=${t.id} thread=${t} selectedId=${selectedThread} onSelect=${selectThread} />
          `,
                )
              : html`<div class="sidebar-empty">${activeProject ? 'No threads in this project' : 'No threads'}</div>`
        }
      </div>
    </section>
  `;
}
