/**
 * Sidebar — left panel with full navigation.
 *
 * Every list splits: active instances → inactive instances → uninstantiated defs.
 * Each thread node shows its metadata (model, temp, agent, layer).
 * [+] buttons on layers/agents open creation forms in the detail drawer.
 */

import { html, useState } from "./lib.js";
import {
  threadData, allThreads, layerColor, liveEvents, mergedLayers, mergedAgents,
  definitions, showToast, activeProjectId, promptCounts, createThread, projects,
  activeThreadId, selectThread, worktrees, loadWorktrees,
} from "./store.js";
import { settingsOpen } from "./settings.js";
import { analyticsOpen } from "./analytics.js";

// ---------------------------------------------------------------------------
// Active/inactive classification
// ---------------------------------------------------------------------------

const INACTIVE_THREAD_STATES = new Set(["archived", "completed", "done"]);
const ACTIVE_LAYER_STATES = new Set(["warm", "warming"]);

function isActiveThread(t) { return !INACTIVE_THREAD_STATES.has(t.status); }
function isActiveLayer(l) { return ACTIVE_LAYER_STATES.has(l.state); }

// ---------------------------------------------------------------------------
// Inactive fold — "N inactive" / "N uninstantiated"
// ---------------------------------------------------------------------------

function InactiveFold({ count, label, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  if (count === 0) return null;

  return html`
    <div class="inactive-fold">
      <div class="inactive-fold-header" onClick=${() => setOpen(!open)}>
        <span class="inactive-caret">${open ? "▼" : "▶"}</span>
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
    active: "#4ade80",
    idle: "#6c9eff",
    waiting: "#facc15",
    archived: "#555",
    completed: "#555",
    done: "#555",
  };
  const color = colors[status] || "#555";
  return html`<span class="tree-status-dot" style="background: ${color}" title=${status}></span>`;
}

// ---------------------------------------------------------------------------
// Thread node — shows metadata (model, temp, agent count, layers)
// ---------------------------------------------------------------------------

function ThreadNode({ thread, depth = 0, selectedId, onSelect, inactive = false }) {
  const [expanded, setExpanded] = useState(!inactive);
  const isSelected = selectedId === thread.id;
  const children = thread.children || [];
  const activeChildren = children.filter(isActiveThread);
  const inactiveChildren = children.filter(c => !isActiveThread(c));
  const hasChildren = children.length > 0;

  return html`
    <div style="padding-left: ${depth * 16}px">
      <div
        class="tree-node ${isSelected ? "selected" : ""} ${inactive ? "dimmed" : ""}"
        onClick=${() => onSelect(thread.id)}
      >
        ${hasChildren ? html`
          <span
            class="tree-caret"
            onClick=${(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          >${expanded ? "▼" : "▶"}</span>
        ` : html`<span class="tree-caret-spacer"></span>`}
        <${StatusDot} status=${thread.status} />
        <span class="tree-label" title=${thread.id}>${thread.description || thread.id}</span>
        ${thread.branch ? html`
          <span class="thread-branch-badge" title=${thread.branch}>${thread.branch}</span>
        ` : null}
        ${(() => {
          const count = (promptCounts.value || {})[thread.id] || 0;
          return count > 0
            ? html`<span class="prompt-badge ${count > 2 ? "urgent" : ""}" title="${count} pending prompt${count > 1 ? "s" : ""}">${count}</span>`
            : null;
        })()}
      </div>

      ${expanded && hasChildren ? html`
        ${activeChildren.map(child =>
          html`<${ThreadNode}
            key=${child.id} thread=${child} depth=${depth + 1}
            selectedId=${selectedId} onSelect=${onSelect}
          />`
        )}
        <${InactiveFold} count=${inactiveChildren.length} label="inactive">
          ${inactiveChildren.map(child =>
            html`<${ThreadNode}
              key=${child.id} thread=${child} depth=${depth + 1}
              selectedId=${selectedId} onSelect=${onSelect} inactive=${true}
            />`
          )}
        </${InactiveFold}>
      ` : null}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Collapsible section with optional [+] button
// ---------------------------------------------------------------------------

function SidebarSection({ title, count, defaultOpen = true, onAdd, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return html`
    <div class="sidebar-section">
      <div class="sidebar-section-header">
        <span class="sidebar-section-toggle" onClick=${() => setOpen(!open)}>
          <span class="sidebar-caret">${open ? "▼" : "▶"}</span>
          <span class="sidebar-section-title">${title}</span>
          ${count != null ? html`<span class="sidebar-badge">${count}</span>` : null}
        </span>
        ${onAdd ? html`
          <button class="sidebar-add-btn sm" onClick=${(e) => { e.stopPropagation(); onAdd(); }} title="Add ${title.toLowerCase()}">+</button>
        ` : null}
      </div>
      ${open ? html`<div class="sidebar-section-body">${children}</div>` : null}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Sidebar (exported)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Inline thread creation form
// ---------------------------------------------------------------------------

function AddThreadForm({ onDone }) {
  const [name, setName] = useState("");
  const [selectedWorktree, setSelectedWorktree] = useState("");
  const [saving, setSaving] = useState(false);

  const wts = worktrees.value;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    const wt = wts.find(w => w.path === selectedWorktree);
    const result = await createThread({
      description: name.trim() || undefined,
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
      ${wts.length > 1 ? html`
        <select class="proj-input" value=${selectedWorktree}
          onChange=${(e) => setSelectedWorktree(e.target.value)}>
          <option value="">main worktree</option>
          ${wts.filter(w => !w.isMain).map(w => html`
            <option key=${w.path} value=${w.path}>
              ${w.branch || w.path.split("/").pop()}
            </option>
          `)}
        </select>
      ` : null}
      <div class="proj-form-actions">
        <button type="submit" class="proj-btn proj-btn-ok" disabled=${saving}>
          ${saving ? "..." : "create"}
        </button>
        <button type="button" class="proj-btn" onClick=${onDone}>cancel</button>
      </div>
    </form>
  `;
}

// Signals for creation mode (consumed by detail-drawer)
export const creatingType = { value: null }; // "layer" | "agent" | null

export function Sidebar({ onLayerClick, onAgentClick, onCreateLayer, onCreateAgent }) {
  const data = threadData.value;
  const events = liveEvents.value;
  const selectedThread = activeThreadId.value;
  const [addingThread, setAddingThread] = useState(false);

  const { instances: layerInstances, uninstantiated: uninstantiatedLayers } = mergedLayers.value;
  const { instances: agentInstances, uninstantiated: uninstantiatedAgents } = mergedAgents.value;

  // Split layer instances into active/inactive
  const activeLayers = layerInstances.filter(isActiveLayer);
  const inactiveLayers = layerInstances.filter(l => !isActiveLayer(l));

  // All agent instances are active for now (future: track completion state)
  const activeAgents = agentInstances;
  const inactiveAgents = [];

  const threads = allThreads.value;
  const activeProject = activeProjectId.value;

  // Resolve project label for display
  const activeProjectLabel = activeProject
    ? (projects.value.find(p => p.id === activeProject)?.label || activeProject)
    : null;

  const threadNodes = threads.map(t => ({
    id: t.threadId,
    status: t.meta?.status || "idle",
    description: t.meta?.description || "",
    branch: t.meta?.branch || null,
    cwd: t.meta?.cwd || null,
    children: [],
  }));

  const handleSelect = (id) => { selectThread(id); };

  const totalLayers = activeLayers.length + inactiveLayers.length + uninstantiatedLayers.length;
  const totalAgents = activeAgents.length + inactiveAgents.length + uninstantiatedAgents.length;

  return html`
    <div class="sidebar">
      <!-- ─── THREADS ─── -->
      <div class="sidebar-threads">
        <div class="sidebar-header">
          <span class="sidebar-section-title">THREADS</span>
          ${activeProject ? html`
            <span class="sidebar-scope-chip scope-project" title=${activeProject}>
              ${activeProjectLabel}
            </span>
          ` : html`
            <span class="sidebar-scope-chip scope-global">global</span>
          `}
          <button class="sidebar-add-btn" onClick=${() => setAddingThread(true)} title="New thread">+</button>
        </div>

        ${addingThread ? html`
          <${AddThreadForm} onDone=${() => setAddingThread(false)} />
        ` : null}

        <div class="sidebar-threads-list">
          ${threadNodes.length > 0 ? threadNodes.map(t => html`
            <${ThreadNode}
              key=${t.id}
              thread=${t}
              selectedId=${selectedThread}
              onSelect=${handleSelect}
            />
          `) : html`<div class="sidebar-empty">${
            activeProject ? "No threads in this project" : "No threads"
          }</div>`}
        </div>
      </div>

      <!-- ─── LAYERS ─── -->
      <div class="sidebar-mid">
        <${SidebarSection}
          title="LAYERS"
          count=${totalLayers || null}
          onAdd=${onCreateLayer}
        >
          <div class="layer-list scrollable-list">
            <!-- Active instances -->
            ${activeLayers.map(l => html`
              <div class="layer-item" key=${l.id}
                onClick=${() => onLayerClick && onLayerClick(l.id)}>
                <span class="layer-dot" style="background: ${layerColor(l.id)}"></span>
                <span class="layer-name">${l.id}</span>
                <span class="layer-state ${l.state}">${l.state}</span>
                <span class="layer-trust">${l.trust}</span>
              </div>
            `)}

            <!-- Inactive instances -->
            ${inactiveLayers.map(l => html`
              <div class="layer-item dimmed" key=${l.id}
                onClick=${() => onLayerClick && onLayerClick(l.id)}>
                <span class="layer-dot" style="background: ${layerColor(l.id)}; opacity: 0.4"></span>
                <span class="layer-name">${l.id}</span>
                <span class="layer-state ${l.state}">${l.state}</span>
                <span class="layer-trust">${l.trust}</span>
              </div>
            `)}

            <!-- Uninstantiated definitions -->
            ${uninstantiatedLayers.map(l => html`
              <div class="layer-item dimmed" key=${l.id}
                onClick=${() => onLayerClick && onLayerClick(l.id)}>
                <span class="layer-dot-empty" style="border-color: ${layerColor(l.id)}"></span>
                <span class="layer-name">${l.id}</span>
                <span class="layer-state-def">defined</span>
              </div>
            `)}

            ${totalLayers === 0 ? html`<div class="sidebar-empty-sm">No layers</div>` : null}
          </div>
        </${SidebarSection}>

        <!-- ─── AGENTS ─── -->
        <${SidebarSection}
          title="AGENTS"
          count=${totalAgents || null}
          onAdd=${onCreateAgent}
        >
          <div class="agent-list scrollable-list">
            <!-- Active instances -->
            ${activeAgents.map(a => html`
              <div class="agent-item" key=${a.id}
                onClick=${() => onAgentClick && onAgentClick(a.agentId)}>
                <span class="agent-icon">◆</span>
                <span class="agent-name">${a.agentId}</span>
              </div>
            `)}

            <!-- Inactive instances -->
            ${inactiveAgents.map(a => html`
              <div class="agent-item dimmed" key=${a.id}
                onClick=${() => onAgentClick && onAgentClick(a.agentId)}>
                <span class="agent-icon">◇</span>
                <span class="agent-name">${a.agentId}</span>
              </div>
            `)}

            <!-- Uninstantiated definitions -->
            ${uninstantiatedAgents.map(a => html`
              <div class="agent-item dimmed" key=${a.id}
                onClick=${() => onAgentClick && onAgentClick(a.id)}>
                <span class="agent-icon">○</span>
                <span class="agent-name">${a.id}</span>
                <span class="agent-kind">${a.kind}</span>
              </div>
            `)}

            ${totalAgents === 0 ? html`<div class="sidebar-empty-sm">No agents</div>` : null}
          </div>
        </${SidebarSection}>
      </div>

      <!-- ─── LIVE EVENTS + FOOTER ─── -->
      <div class="sidebar-bottom">
        <${SidebarSection}
          title="LIVE EVENTS"
          count=${events.length}
          defaultOpen=${false}
        >
          <div class="live-events-list">
            ${events.slice(0, 30).map((ev, i) => html`
              <div key=${i} class="live-event-row">
                <span class="le-kind">${ev.kind}</span>
                <span class="le-time">${ev._time}</span>
              </div>
            `)}
            ${events.length === 0 ? html`<div class="sidebar-empty-sm">No events yet</div>` : null}
          </div>
        </${SidebarSection}>

        <div class="sidebar-footer">
          <button class="sidebar-footer-btn"
            onClick=${() => { settingsOpen.value = true; }}
            title="Settings (s)">settings</button>
          <button class="sidebar-footer-btn"
            onClick=${() => { analyticsOpen.value = true; }}
            title="Analytics (a)">analytics</button>
        </div>
      </div>
    </div>
  `;
}

export const ThreadTree = Sidebar;
