/**
 * Layers, Agents and Activity — the runtime lists that used to sit under the thread list, now
 * Settings sections. Each lists the active thread's instances (active, then inactive, then
 * definitions not yet instantiated) and shows the selected one's detail beneath the list.
 */

import {
  AgentDetail,
  CreateAgentForm,
  CreateLayerForm,
  JsonBlock,
  LayerDetail,
} from './detail-drawer.js';
import { eventsForThread } from './inspector-data.js';
import { html, useState } from './lib.js';
import { activeThreadId, layerColor, liveEvents, mergedAgents, mergedLayers } from './store.js';

const ACTIVE_LAYER_STATES = new Set(['warm', 'warming']);

function SectionIntro({ children, onAdd, addLabel }) {
  return html`<div class="runtime-intro">
    <p class="settings-desc">${children}</p>
    ${onAdd ? html`<button class="action-btn" onClick=${onAdd}>${addLabel}</button>` : null}
  </div>`;
}

function SelectedDetail({ children }) {
  return html`<section class="settings-card runtime-detail">${children}</section>`;
}

export function LayersSection() {
  const [selected, setSelected] = useState(null);
  const { instances, uninstantiated } = mergedLayers.value;
  const active = instances.filter((l) => ACTIVE_LAYER_STATES.has(l.state));
  const inactive = instances.filter((l) => !ACTIVE_LAYER_STATES.has(l.state));
  const row = (l, { dim = false, defined = false } = {}) => html`
    <button type="button" key=${l.id} class="layer-item ${dim ? 'dimmed' : ''} ${selected === l.id ? 'selected' : ''}"
      onClick=${() => setSelected(l.id)}>
      ${
        defined
          ? html`<span class="layer-dot-empty" style="border-color: ${layerColor(l.id)}"></span>`
          : html`<span class="layer-dot" style="background: ${layerColor(l.id)}; ${dim ? 'opacity: 0.4' : ''}"></span>`
      }
      <span class="layer-name">${l.id}</span>
      ${defined ? html`<span class="layer-state-def">defined</span>` : html`<span class="layer-state ${l.state}">${l.state}</span>`}
    </button>
  `;
  const total = instances.length + uninstantiated.length;
  return html`
    <${SectionIntro} onAdd=${() => setSelected('+')} addLabel="New layer">
      Context layers on the selected thread, then layers defined but not yet on it.
    </${SectionIntro}>
    <div class="layer-list runtime-list">
      ${active.map((l) => row(l))}
      ${inactive.map((l) => row(l, { dim: true }))}
      ${uninstantiated.map((l) => row(l, { dim: true, defined: true }))}
      ${total === 0 ? html`<div class="settings-empty">No layers</div>` : null}
    </div>
    ${
      selected === '+'
        ? html`<${SelectedDetail}><${CreateLayerForm} onCreated=${() => setSelected(null)} /></${SelectedDetail}>`
        : selected
          ? html`<${SelectedDetail}><${LayerDetail} key=${`${activeThreadId.value}:${selected}`} layerId=${selected} /></${SelectedDetail}>`
          : null
    }
  `;
}

export function AgentsSection() {
  const [selected, setSelected] = useState(null);
  const { instances, uninstantiated } = mergedAgents.value;
  const total = instances.length + uninstantiated.length;
  return html`
    <${SectionIntro} onAdd=${() => setSelected('+')} addLabel="New agent">
      Agents running on the selected thread, then agents defined but not yet instantiated.
    </${SectionIntro}>
    <div class="agent-list runtime-list">
      ${instances.map(
        (a) => html`
        <button type="button" key=${a.id} class="agent-item ${selected === a.agentId ? 'selected' : ''}" onClick=${() => setSelected(a.agentId)}>
          <span class="agent-icon">◆</span>
          <span class="agent-name">${a.agentId}</span>
        </button>
      `,
      )}
      ${uninstantiated.map(
        (a) => html`
        <button type="button" key=${a.id} class="agent-item dimmed ${selected === a.id ? 'selected' : ''}" onClick=${() => setSelected(a.id)}>
          <span class="agent-icon">○</span>
          <span class="agent-name">${a.id}</span>
          <span class="agent-kind">${a.kind}</span>
        </button>
      `,
      )}
      ${total === 0 ? html`<div class="settings-empty">No agents</div>` : null}
    </div>
    ${
      selected === '+'
        ? html`<${SelectedDetail}><${CreateAgentForm} onCreated=${() => setSelected(null)} /></${SelectedDetail}>`
        : selected
          ? html`<${SelectedDetail}><${AgentDetail} agentId=${selected} /></${SelectedDetail}>`
          : null
    }
  `;
}

export function ActivitySection() {
  const [selected, setSelected] = useState(null);
  const threadId = activeThreadId.value;
  const events = eventsForThread(liveEvents.value, threadId);
  return html`
    <${SectionIntro}>
      ${threadId ? 'Runtime events on the selected thread' : 'Runtime events across Foundry'}, newest first.
    </${SectionIntro}>
    <div class="live-events-list runtime-list">
      ${events.slice(0, 100).map(
        (ev, i) => html`
        <button type="button" key=${i} class="live-event-row activity-event ${selected === ev ? 'selected' : ''}" title="Inspect event"
          onClick=${() => setSelected(ev)}>
          <span class="le-kind">${ev.kind}</span>
          <span class="le-time">${ev._time}</span>
        </button>
      `,
      )}
      ${events.length === 0 ? html`<div class="settings-empty">No events yet</div>` : null}
    </div>
    ${
      selected
        ? html`<${SelectedDetail}>
        <div class="detail-header"><span class="detail-name">${selected.kind}</span><span class="detail-kind-badge">activity</span></div>
        <${JsonBlock} data=${selected} maxHeight=${600} />
      </${SelectedDetail}>`
        : null
    }
  `;
}
