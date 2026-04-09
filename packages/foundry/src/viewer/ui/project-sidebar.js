/**
 * Project Sidebar — collapsible left-most panel for project management.
 *
 * Shows registered projects grouped by tags, with selection state.
 * Collapsed: thin strip with project icons. Expanded: full list.
 */

import { html, useState } from "./lib.js";
import {
  projects, projectTags, activeProjectId, projectSidebarOpen,
  createProject, deleteProject, showToast,
} from "./store.js";

// ---------------------------------------------------------------------------
// Runtime icons
// ---------------------------------------------------------------------------

const RUNTIME_ICONS = {
  "claude-code": "C",
  codex: "X",
  cursor: "→",
};

const STATUS_COLORS = {
  active: "#4ade80",
  idle: "#6c9eff",
  archived: "#555",
};

// ---------------------------------------------------------------------------
// Add Project form (inline)
// ---------------------------------------------------------------------------

function AddProjectForm({ onDone }) {
  const [id, setId] = useState("");
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [tags, setTags] = useState("");
  const [runtime, setRuntime] = useState("claude-code");

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!id.trim() || !path.trim()) {
      showToast("ID and path are required", "error");
      return;
    }
    const ok = await createProject({
      id: id.trim(),
      path: path.trim(),
      label: label.trim() || id.trim(),
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      runtime,
    });
    if (ok) onDone();
  };

  return html`
    <form class="proj-add-form" onSubmit=${handleSubmit}>
      <input class="proj-input" placeholder="id" value=${id}
        onInput=${(e) => setId(e.target.value)} />
      <input class="proj-input" placeholder="/path/to/repo" value=${path}
        onInput=${(e) => setPath(e.target.value)} />
      <input class="proj-input" placeholder="label" value=${label}
        onInput=${(e) => setLabel(e.target.value)} />
      <input class="proj-input" placeholder="tags (comma sep)" value=${tags}
        onInput=${(e) => setTags(e.target.value)} />
      <select class="proj-input" value=${runtime}
        onChange=${(e) => setRuntime(e.target.value)}>
        <option value="claude-code">Claude Code</option>
        <option value="codex">Codex</option>
        <option value="cursor">Cursor</option>
      </select>
      <div class="proj-form-actions">
        <button type="submit" class="proj-btn proj-btn-ok">add</button>
        <button type="button" class="proj-btn" onClick=${onDone}>cancel</button>
      </div>
    </form>
  `;
}

// ---------------------------------------------------------------------------
// Project item (expanded view)
// ---------------------------------------------------------------------------

function ProjectItem({ project, isActive, onSelect }) {
  const statusColor = STATUS_COLORS[project.status] || "#555";
  const runtimeIcon = RUNTIME_ICONS[project.runtime] || "?";

  return html`
    <div
      class="proj-item ${isActive ? "proj-active" : ""}"
      onClick=${() => onSelect(project.id)}
      title=${project.path}
    >
      <span class="proj-runtime-icon" title=${project.runtime}>${runtimeIcon}</span>
      <div class="proj-item-body">
        <div class="proj-item-label">${project.label}</div>
        <div class="proj-item-meta">
          <span class="proj-status-dot" style="background: ${statusColor}"></span>
          <span>${project.threadCount || 0} threads</span>
          ${(project.tags || []).map(
            (t) => html`<span class="proj-tag" key=${t}>${t}</span>`
          )}
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Collapsed strip — just icons
// ---------------------------------------------------------------------------

function CollapsedStrip({ onExpand }) {
  const items = projects.value;
  const active = activeProjectId.value;

  return html`
    <div class="proj-collapsed" onClick=${onExpand} title="Expand projects">
      <div class="proj-collapsed-icon">P</div>
      <div class="proj-collapsed-dots">
        ${items.map((p) => html`
          <span
            key=${p.id}
            class="proj-collapsed-dot ${p.id === active ? "active" : ""}"
            style="background: ${STATUS_COLORS[p.status] || "#555"}"
            title=${p.label}
          ></span>
        `)}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// ProjectSidebar (exported)
// ---------------------------------------------------------------------------

export function ProjectSidebar() {
  const isOpen = projectSidebarOpen.value;
  const items = projects.value;
  const tags = projectTags.value;
  const active = activeProjectId.value;
  const [adding, setAdding] = useState(false);
  const [filterTag, setFilterTag] = useState(null);

  if (!isOpen) {
    return html`<${CollapsedStrip} onExpand=${() => { projectSidebarOpen.value = true; }} />`;
  }

  const filtered = filterTag
    ? items.filter((p) => (p.tags || []).includes(filterTag))
    : items;

  const handleSelect = (id) => {
    activeProjectId.value = active === id ? null : id;
  };

  return html`
    <div class="proj-sidebar">
      <div class="proj-sidebar-header">
        <span class="proj-sidebar-title">PROJECTS</span>
        <span class="proj-sidebar-count">${items.length}</span>
        <button class="sidebar-add-btn" onClick=${() => setAdding(true)} title="Add project">+</button>
        <button class="proj-collapse-btn" onClick=${() => { projectSidebarOpen.value = false; }}
          title="Collapse">‹</button>
      </div>

      <!-- Tag filter chips -->
      ${tags.length > 0 ? html`
        <div class="proj-tags-bar">
          <span
            class="proj-filter-chip ${!filterTag ? "active" : ""}"
            onClick=${() => setFilterTag(null)}
          >all</span>
          ${tags.map((t) => html`
            <span
              key=${t}
              class="proj-filter-chip ${filterTag === t ? "active" : ""}"
              onClick=${() => setFilterTag(filterTag === t ? null : t)}
            >${t}</span>
          `)}
        </div>
      ` : null}

      <!-- Global scope item -->
      <div
        class="proj-item proj-global ${!active ? "proj-active" : ""}"
        onClick=${() => { activeProjectId.value = null; }}
      >
        <span class="proj-runtime-icon">*</span>
        <div class="proj-item-body">
          <div class="proj-item-label">Global</div>
          <div class="proj-item-meta">
            <span>all projects</span>
          </div>
        </div>
      </div>

      <!-- Project list -->
      <div class="proj-list">
        ${filtered.map((p) => html`
          <${ProjectItem}
            key=${p.id}
            project=${p}
            isActive=${active === p.id}
            onSelect=${handleSelect}
          />
        `)}
        ${filtered.length === 0 && items.length > 0 ? html`
          <div class="proj-empty">No projects match "${filterTag}"</div>
        ` : null}
        ${items.length === 0 ? html`
          <div class="proj-empty">No projects yet</div>
        ` : null}
      </div>

      <!-- Add form -->
      ${adding ? html`<${AddProjectForm} onDone=${() => setAdding(false)} />` : null}
    </div>
  `;
}
