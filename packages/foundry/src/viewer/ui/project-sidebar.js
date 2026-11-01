/**
 * @atlas
 * @kind component
 * @partOf feature:threads, feature:viewer
 */
/**
 * Navigation column — the workspace's left column.
 *
 * Top: the pinned scopes, Global (threads no project owns), Forge Master (the internal
 * thread about this Foundry) and Feedback (the inbox of every feedback item). Then the projects, and below them the threads of whichever
 * scope is selected; the two lists scroll independently. Collapsed: a thin strip with
 * project dots.
 */

import { feedbackIn } from './feedback.js';
import { html, useEffect, useRef, useState } from './lib.js';
import { Modal } from './modal.js';
import { SizeControls } from './panel-sizes.js';
import {
  activeProjectId,
  authFetch,
  createProject,
  feedbackInboxOpen,
  forgeMasterOpen,
  openProjectHome,
  projectSidebarOpen,
  projects,
  selectScope,
  showToast,
  updateProject,
} from './store.js';
import { ThreadList } from './thread-tree.js';

const STATUS_COLORS = {
  active: 'var(--st-working)',
  idle: 'var(--st-idle)',
  archived: 'var(--st-archived)',
};

/** Focus (and select) an input once its modal opens. */
function useAutofocus() {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select?.();
  }, []);
  return ref;
}

// ---------------------------------------------------------------------------
// Add Project modal
// ---------------------------------------------------------------------------

function AddProjectModal({ onDone }) {
  const pathInput = useAutofocus();
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [browseDir, setBrowseDir] = useState(null);
  const [browseDirs, setBrowseDirs] = useState([]);
  const [browseParent, setBrowseParent] = useState(null);
  const [browseIsRepo, setBrowseIsRepo] = useState(false);
  const [browseName, setBrowseName] = useState('');

  const browse = async (dir) => {
    try {
      const url = dir ? `/api/browse?path=${encodeURIComponent(dir)}` : '/api/browse';
      const res = await authFetch(url);
      if (!res.ok) return;
      const data = await res.json();
      setBrowseDir(data.current);
      setBrowseDirs(data.dirs || []);
      setBrowseParent(data.parent);
      setBrowseIsRepo(data.isRepo || false);
      setBrowseName(data.name || '');
    } catch {
      showToast('Failed to browse directory', 'error');
    }
  };

  const openBrowser = () => {
    setBrowsing(true);
    browse(path || null);
  };

  const selectDir = () => {
    setPath(browseDir);
    if (!label) setLabel(browseName);
    setBrowsing(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!path.trim()) {
      showToast('Path is required', 'error');
      return;
    }
    const ok = await createProject({
      path: path.trim(),
      label: label.trim() || undefined,
    });
    if (ok) onDone();
  };

  return html`
    <${Modal} title="Add project" onClose=${onDone} class="proj-modal">
    <form class="proj-add-form" onSubmit=${handleSubmit}>
      <label class="proj-field-label" for="proj-add-path">Path</label>
      <div class="proj-path-row">
        <input id="proj-add-path" ref=${pathInput} class="proj-input proj-path-input" placeholder="/path/to/repo" value=${path}
          onInput=${(e) => setPath(e.target.value)} />
        <button type="button" class="proj-btn proj-browse-btn" onClick=${openBrowser}
          title="Browse folders">...</button>
      </div>

      ${
        browsing
          ? html`
        <div class="proj-browser">
          <div class="proj-browser-path" title=${browseDir}>${browseDir}</div>
          <div class="proj-browser-list">
            ${
              browseParent
                ? html`
              <div class="proj-browser-item proj-browser-parent" onClick=${() => browse(browseParent)}>
                ${'..'}
              </div>
            `
                : null
            }
            ${browseDirs.map(
              (d) => html`
              <div key=${d} class="proj-browser-item" onClick=${() => browse(browseDir + '/' + d)}>
                ${d}${'/'}
              </div>
            `,
            )}
            ${
              browseDirs.length === 0
                ? html`
              <div class="proj-browser-empty">No subdirectories</div>
            `
                : null
            }
          </div>
          <div class="proj-browser-actions">
            ${browseIsRepo ? html`<span class="proj-browser-repo">repo detected</span>` : null}
            <button type="button" class="proj-btn proj-btn-ok" onClick=${selectDir}>Select</button>
            <button type="button" class="proj-btn" onClick=${() => setBrowsing(false)}>Cancel</button>
          </div>
        </div>
      `
          : null
      }

      <label class="proj-field-label" for="proj-add-label">Label</label>
      <input id="proj-add-label" class="proj-input" placeholder="optional" value=${label}
        onInput=${(e) => setLabel(e.target.value)} />
      <div class="proj-form-actions">
        <button type="button" class="proj-btn" onClick=${onDone}>Cancel</button>
        <button type="submit" class="proj-btn proj-btn-ok">Add</button>
      </div>
    </form>
    <//>
  `;
}

// ---------------------------------------------------------------------------
// Rename Project modal
// ---------------------------------------------------------------------------

function RenameProjectModal({ project, onDone }) {
  const input = useAutofocus();
  const [label, setLabel] = useState(project.label || '');
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!label.trim()) {
      showToast('Label is required', 'error');
      return;
    }
    if (await updateProject(project.id, { label: label.trim() })) onDone();
  };
  return html`
    <${Modal} title="Rename project" onClose=${onDone} class="proj-modal">
      <form class="proj-add-form" onSubmit=${handleSubmit}>
        <label class="proj-field-label" for="proj-rename-label">Label</label>
        <input id="proj-rename-label" ref=${input} class="proj-input" value=${label}
          onInput=${(e) => setLabel(e.target.value)} />
        <div class="proj-form-actions">
          <button type="button" class="proj-btn" onClick=${onDone}>Cancel</button>
          <button type="submit" class="proj-btn proj-btn-ok">Rename</button>
        </div>
      </form>
    <//>
  `;
}

// ---------------------------------------------------------------------------
// Project item (expanded view)
// ---------------------------------------------------------------------------

function ProjectItem({ project, isActive, onSelect, onRename }) {
  const statusColor = STATUS_COLORS[project.status] || 'var(--st-archived)';
  const archived = project.status === 'archived';
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpen]);
  const act = (e, action) => {
    e.stopPropagation();
    setMenuOpen(false);
    action();
  };

  return html`
    <div
      class="proj-item ${isActive ? 'proj-active' : ''} ${archived ? 'proj-archived' : ''}"
      onClick=${() => onSelect(project.id)}
      title=${project.path}
    >
      <div class="proj-item-body">
        <div class="proj-item-label">${project.label}</div>
        <div class="proj-item-meta">
          <span class="proj-status-dot" style="background: ${statusColor}"></span>
          <span>${archived ? 'archived · ' : `${project.activeThreadCount ?? 0} open · `}${project.threadCount || 0} threads</span>
          ${(project.tags || []).map((t) => html`<span class="proj-tag" key=${t}>${t}</span>`)}
        </div>
      </div>
      <button
        type="button"
        class="proj-menu-btn ${menuOpen ? 'open' : ''}"
        aria-label="Project actions"
        aria-haspopup="menu"
        aria-expanded=${menuOpen}
        onClick=${(e) => {
          e.stopPropagation();
          setMenuOpen(!menuOpen);
        }}
      >⋯</button>
      ${
        menuOpen
          ? html`
        <div class="proj-menu" role="menu" onClick=${(e) => e.stopPropagation()}>
          <button type="button" role="menuitem" onClick=${(e) => act(e, () => onRename(project))}>Rename</button>
          <button type="button" role="menuitem" onClick=${(e) =>
            act(e, () => updateProject(project.id, { status: archived ? 'active' : 'archived' }))}>
            ${archived ? 'Unarchive' : 'Archive'}
          </button>
        </div>
      `
          : null
      }
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Collapsed strip — just icons
// ---------------------------------------------------------------------------

function CollapsedStrip() {
  const items = projects.value.filter((p) => p.status !== 'archived');
  const active = activeProjectId.value;

  return html`
    <div class="proj-collapsed">
      <div class="proj-collapsed-controls"><${SizeControls} side="left" /></div>
      <div class="proj-collapsed-icon">P</div>
      <div class="proj-collapsed-dots">
        ${items.map(
          (p) => html`
          <span
            key=${p.id}
            class="proj-collapsed-dot ${p.id === active ? 'active' : ''}"
            style="background: ${STATUS_COLORS[p.status] || 'var(--st-archived)'}"
            title=${p.label}
          ></span>
        `,
        )}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// ProjectSidebar (exported)
// ---------------------------------------------------------------------------

export function ProjectSidebar() {
  const isOpen = projectSidebarOpen.value;
  const all = projects.value;
  const active = activeProjectId.value;
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const archivedCount = all.filter((p) => p.status === 'archived').length;
  // Archived projects are hidden until asked for; the active one stays visible.
  const items = showArchived ? all : all.filter((p) => p.status !== 'archived' || p.id === active);

  if (!isOpen) {
    return html`<${CollapsedStrip} />`;
  }

  const forge = forgeMasterOpen.value;
  const inbox = feedbackInboxOpen.value;
  const pinned = forge || inbox;
  const openFeedback = feedbackIn().filter((item) => item.inbox === 'open').length;
  const handleSelect = (id) => openProjectHome(id);

  return html`
    <div class="proj-sidebar nav-column">
      <section class="nav-projects ${listOpen ? '' : 'nav-projects--collapsed'}" aria-label="Projects">
        <div class="proj-sidebar-header">
          <button type="button" class="nav-section-toggle" aria-expanded=${listOpen}
            title=${listOpen ? 'Collapse projects' : 'Expand projects'} onClick=${() => setListOpen(!listOpen)}>
            <span class="sidebar-caret">${listOpen ? '\u25BC' : '\u25B6'}</span>
            <span class="proj-sidebar-title">PROJECTS</span>
            <span class="proj-sidebar-count">${items.length}</span>
          </button>
          <button class="sidebar-add-btn" onClick=${() => setAdding(true)} title="Add project">+</button>
        </div>

        <div class="proj-list">
          <div class="proj-defaults nav-pinned" role="group" aria-label="Pinned scopes">
            <div
              class="proj-item proj-global ${!active && !pinned ? 'proj-active' : ''}"
              onClick=${() => openProjectHome(null)}
            >
              <span class="proj-runtime-icon">*</span>
              <div class="proj-item-body">
                <div class="proj-item-label">Global</div>
                <div class="proj-item-meta"><span>threads outside any project</span></div>
              </div>
            </div>
            <div
              class="proj-item proj-global ${forge ? 'proj-active' : ''}"
              onClick=${() => selectScope('forge')}
            >
              <span class="proj-runtime-icon">\u2692</span>
              <div class="proj-item-body">
                <div class="proj-item-label">Forge Master</div>
                <div class="proj-item-meta"><span>this Foundry and its settings</span></div>
              </div>
            </div>
            <div
              class="proj-item proj-global nav-feedback ${inbox ? 'proj-active' : ''}"
              onClick=${() => selectScope('feedback')}
            >
              <span class="proj-runtime-icon">\u25C6</span>
              <div class="proj-item-body">
                <div class="proj-item-label">Feedback</div>
                <div class="proj-item-meta"><span>${openFeedback ? `${openFeedback} open · ` : ''}everything you’ve given</span></div>
              </div>
              ${openFeedback ? html`<span class="nav-count" aria-label=${`${openFeedback} open`}>${openFeedback}</span>` : null}
            </div>
          </div>
          <div class="proj-list-divider" role="separator"></div>
          ${
            listOpen
              ? html`
          ${items.map(
            (p) => html`
            <${ProjectItem}
              key=${p.id}
              project=${p}
              isActive=${!pinned && active === p.id}
              onSelect=${handleSelect}
              onRename=${setRenaming}
            />
          `,
          )}
          ${all.length === 0 ? html`<div class="proj-empty">No projects yet</div>` : null}
          ${
            archivedCount > 0
              ? html`
            <button type="button" class="proj-archived-toggle" onClick=${() => setShowArchived(!showArchived)}>
              ${showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
            </button>
          `
              : null
          }
          `
              : null
          }
        </div>
      </section>

      <div class="nav-threads" id="workspace-threads">
        <${ThreadList} />
      </div>

      ${adding ? html`<${AddProjectModal} onDone=${() => setAdding(false)} />` : null}
      ${renaming ? html`<${RenameProjectModal} project=${renaming} onDone=${() => setRenaming(null)} />` : null}
    </div>
  `;
}
