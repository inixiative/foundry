/**
 * DetailDrawer — right panel.
 *
 * Shows (in priority order):
 *   1. Trace detail with summary/raw tabs (when a trace is selected)
 *   2. Span detail (when a span within the trace is selected)
 *   3. Layer detail (when a layer is clicked in sidebar)
 *   4. Creation forms (when [+] is clicked)
 *   5. Empty state
 */

import { html, useState, useEffect } from "./lib.js";
import { liveThreadStatus } from './live-state.js';
import {
  selectedSpanId, currentTrace, layerColor, threadData,
  submitIntervention, executeAction, createDefinition, definitions,
  detailDrawerOpen, activeProjectId, activeThreadId, authFetch, showToast,
  loadDefinitions, worktrees, updateThreadWorktree,
  selectedEvent, messages, knowledgeInspection, loadKnowledge, loadTraceDetail, openTurnDetail, dismissTraceSelection,
} from "./store.js";
import { traceSpans, traceInjection, failurePresentation, selectionSummary, deliverySummary, knowledgeInspectionSummary, liveRuntimeLabel,
  expertParticipants, learningEntries, explanationLabel, domainUnderstanding, knowledgeEmptyLabel, expertAbsenceLabel,
  routingRequest, guardOutcomes, deliveredUnderstanding } from "./inspector-data.js";
import { settingsConfig } from "./settings.js";
import { LayerBand } from "./layer-band.js";

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function Section({ title, open: defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return html`
    <div class="detail-section">
      <div class="detail-section-header" onClick=${() => setOpen(!open)}>
        <span class="detail-caret">${open ? "▼" : "▶"}</span>
        <span class="detail-section-title">${title}</span>
      </div>
      ${open ? html`<div class="detail-section-body">${children}</div>` : null}
    </div>
  `;
}

function JsonBlock({ data, maxHeight = 300 }) {
  if (data === undefined || data === null) return html`<span class="detail-null">null</span>`;
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return html`<pre class="detail-json" style="max-height: ${maxHeight}px">${text}</pre>`;
}

// ---------------------------------------------------------------------------
// Trace detail — summary / raw tabs
// ---------------------------------------------------------------------------

function TraceDetail({ trace, onSpanSelect }) {
  const [tab, setTab] = useState("summary"); // "summary" | "spans" | "raw"
  const summary = trace.summary || trace;

  return html`
    <div class="detail-content">
      <div class="detail-header">
        <span class="detail-name">${trace.messageId || trace.id}</span>
        <span class="detail-kind-badge">trace</span>
        ${trace.durationMs ? html`
          <span class="detail-status ok">${trace.durationMs.toFixed(0)}ms</span>
        ` : null}
      </div>

      ${trace.archive ? html`<div class="detail-meta"><label>Checkpoint archive</label><span>Native outcome not reverified</span></div>` : null}
      <${HistoricalDetail} trace=${trace} />
      <${FailureDetail} meta=${trace.root?.annotations?.failure ?? trace.root?.annotations?.completion} />
      <${NativeOutcomeDetail} trace=${trace} />

      <!-- Tabs: summary / spans / raw -->
      <div class="detail-tabs">
        <button class="detail-tab ${tab === "summary" ? "active" : ""}"
          onClick=${() => setTab("summary")}>Summary</button>
        <button class="detail-tab ${tab === "spans" ? "active" : ""}"
          onClick=${() => setTab("spans")}>Spans</button>
        <button class="detail-tab ${tab === "context" ? "active" : ""}"
          onClick=${() => setTab("context")}>Turn Context</button>
        <button class="detail-tab ${tab === "raw" ? "active" : ""}"
          onClick=${() => setTab("raw")}>Raw</button>
      </div>

      ${tab === "summary" ? html`
        <${TraceSummaryView} trace=${trace} summary=${summary} onSpanSelect=${onSpanSelect} />
      ` : tab === "spans" ? html`
        <${TraceSpanTree} trace=${trace} onSpanSelect=${onSpanSelect} />
      ` : tab === "context" ? html`
        <${LearningDeliveryDetail} trace=${trace} />
        <${PhaseHistory} trace=${trace} />
        <${SelectedReviewHistory} trace=${trace} />
        <${InjectionDetail} injection=${traceInjection(trace)} phases=${trace.detail?.phases} trace=${trace} />
      ` : html`
        <${TraceRawView} trace=${trace} />
      `}
    </div>
  `;
}

const DETAIL_STATUS_TEXT = {
  inline: "Detail carried with the message (full history or browser copy).",
  none: "No journal detail requested for this row (browser-only or pre-journal history).",
  loading: "Loading owned turn detail from the journal…",
  loaded: "Owned turn detail loaded from the journal. Historical record; not recomputed.",
  "not-journalled": "This turn is not in the server journal; only what this browser holds is shown.",
};

/** Selected turn, detail availability and artifact links from the owned detail route. */
function HistoricalDetail({ trace }) {
  const turn = trace.selectedTurn;
  const status = trace.detailStatus;
  const artifacts = trace.detail?.artifacts ?? [];
  const journalTurn = trace.detail?.turn;
  if (!turn && !status) return null;
  const text = DETAIL_STATUS_TEXT[status] ?? (status ? `Owned turn detail ${status}.` : null);
  return html`<${Section} title="Historical detail" open=${true}>
    <div class="historical-detail">
      ${turn?.turnId ? html`<div class="detail-meta"><label>Selected turn</label><span><code>${turn.turnId}</code>${turn.actor ? ` · ${turn.actor}` : ""}</span></div>` : null}
      ${journalTurn ? html`<div class="detail-meta"><label>Journal turn status</label><span>${journalTurn.status}${journalTurn.error ? ` · ${journalTurn.error}` : ""}</span></div>` : null}
      ${text ? html`<div class="detail-null historical-detail-status" data-status=${status}>${text}</div>` : null}
      ${turn?.summaryMeta?.length ? html`<div class="detail-meta historical-meta-summary"><label>Carried by the message row</label><span>${turn.summaryMeta.join(", ")}</span></div>` : null}
      ${turn?.detailOnlyMeta?.length ? html`<div class="detail-meta historical-meta-detail-only"><label>In journal detail only</label>
        <span>${turn.detailOnlyMeta.join(", ")}${status === "loaded" ? " (loaded below and in Turn Context)" : status === "loading" ? " (loading)" : " (not loaded)"}</span></div>` : null}
      ${artifacts.length ? html`
        <div class="detail-meta"><label>Artifacts</label><span>${artifacts.length}</span></div>
        <ul class="detail-artifact-list">
          ${artifacts.map((artifact, i) => html`<li key=${i}>
            <span class="detail-kind-badge">${artifact.kind}</span>
            ${artifact.href ? html` <a href=${artifact.href} target="_blank" rel="noopener">${artifact.id ?? artifact.href}</a>`
              : html` <code>${artifact.id ?? "(recorded)"}</code>`}
          </li>`)}
        </ul>
        <div class="detail-null">Links open the recorded server artifact (JSON). Workspace files are not linked: no recorded artifact carries a file path.</div>
      ` : status === "loaded" ? html`<div class="detail-null">No artifacts recorded for this turn.</div>` : null}
    </div>
  </${Section}>`;
}

function NativeOutcomeDetail({ trace }) {
  const observed = traceSpans(trace.root).map(span => span.annotations?.native).filter(Boolean);
  const message = messages.value.find(m => m.threadId === activeThreadId.value && m.traceId === trace.id);
  // Lazily loaded owned turn detail first; inline metadata for full-history or browser-only rows.
  const nativeSource = Array.isArray(trace.detail?.nativeHistory) ? trace.detail.nativeHistory : message?.meta?.nativeHistory;
  const toolSource = Array.isArray(trace.detail?.nativeTools) ? trace.detail.nativeTools : message?.meta?.nativeTools;
  const history = Array.isArray(nativeSource) ? nativeSource.filter(e =>
    e?.owner?.threadId === activeThreadId.value && e.owner.messageId === trace.messageId) : [];
  const terminal = [...history].reverse().find(e => e.terminal && ["completed", "failed"].includes(e.nativeOutcome));
  const tools = Array.isArray(toolSource) ? toolSource.filter(e =>
    e?.record?.owner?.threadId === activeThreadId.value && e.record.association?.owner?.messageId === trace.messageId) : [];
  if (!observed.length && !history.length && !tools.length) return null;
  return html`<${Section} title="Native execution evidence">
    <div class="detail-null">Historical observation. Local completion and native terminal are separate; later journal reconciliation does not rewrite delivered context.</div>
    <div class="native-public-tools">${history.filter(e => e.kind === "tool_use" || e.kind === "tool_result").map((e, i) => html`
      <details key=${i} class="native-public-tool">
        <summary>${e.toolName ?? "Tool unavailable"} · ${e.kind === "tool_use" ? "started" : "result reported"}</summary>
        <div class="detail-meta"><label>Original call</label><span>${e.callId ?? e.itemId ?? "unavailable"}</span></div>
        <div class="detail-null">Public preview; full original observation is retained below.</div>
        <pre class="detail-json">${String(typeof (e.kind === "tool_use" ? e.toolInput : e.toolOutput) === "string"
          ? (e.kind === "tool_use" ? e.toolInput : e.toolOutput)
          : JSON.stringify(e.kind === "tool_use" ? e.toolInput : e.toolOutput) ?? "unavailable").slice(0, 2000)}</pre>
      </details>`)}</div>
    ${observed.map((e, i) => html`<div key=${i}>
      <div class="detail-meta"><label>Native / local / transport</label><span>${e.nativeOutcome ?? "unknown"} / ${e.localOutcome ?? "unknown"} / ${e.transportOutcome ?? "unknown"}</span></div>
      ${e.observationFailures ? html`<div class="detail-status error">${e.observationFailures} evidence observation failures; some journal evidence may be unavailable</div>` : null}
      <${JsonBlock} data=${e} maxHeight=${260} />
    </div>`)}
    ${history.length ? html`<div class="native-journal-evidence">
      <div class="detail-meta"><label>Current journal terminal</label><span>${terminal?.nativeOutcome ?? "unknown"}</span></div>
      <div class="detail-null">Additional owned observations. Historical delivery above remains unchanged.</div>
      <${JsonBlock} data=${history} maxHeight=${300} />
    </div>` : null}
    ${tools.length ? html`<div class="native-bridge-evidence">
      <div class="detail-meta"><label>Owned Foundry tool delivery</label><span>${tools.length} operations</span></div>
      <div class="detail-null">Admission-window association is captured at operation start. Native call/item correlation remains unknown unless separately observed.</div>
      ${tools.map(e => html`<div key=${e.record.id}>
        <div class="detail-meta"><label>${e.record.operation}</label><span>${e.record.status} · journal ${e.persistence} · publication ${e.publication}</span></div>
        ${e.persistence !== 'committed' ? html`<div class="detail-status error">Tool evidence is not saved in the server journal; this observation may be unavailable after restart.</div>` : null}
        ${e.publication === 'reconciliation-needed' && e.persistence === 'committed' ? html`<div class="detail-null">Journal saved; observer reconciliation is needed.</div>` : null}
        <${JsonBlock} data=${e} maxHeight=${300} />
      </div>`)}
    </div>` : null}
  </${Section}>`;
}

function TraceSummaryView({ trace, summary, onSpanSelect }) {
  const stages = summary.stages || [];
  const spans = traceSpans(trace.root);
  return html`
    <div class="trace-summary">
      <!-- Timing -->
      <div class="detail-meta-row">
        ${trace.durationMs ? html`<div class="detail-meta"><label>Duration</label><span>${trace.durationMs.toFixed(1)}ms</span></div>` : null}
        ${stages.length ? html`<div class="detail-meta"><label>Stages</label><span>${stages.length}</span></div>` : null}
      </div>

      <!-- Pipeline stages -->
      ${stages.length > 0 ? html`
        <${Section} title="Pipeline (${stages.length} stages)">
          <div class="trace-stages-list">
            ${stages.map((s, i) => html`
              <button key=${i} class="trace-stage-row inspector-stage"
                disabled=${!spans[i]} title=${spans[i] ? "Inspect stage" : "Stage detail not retained"}
                onClick=${() => { selectedSpanId.value = spans[i].id; onSpanSelect?.(spans[i]); }}>
                <span class="trace-stage-idx">${i + 1}</span>
                <span class="trace-stage-name">${s.name}</span>
                <span class="trace-stage-status ${s.status}">${s.status}</span>
                ${s.durationMs != null ? html`
                  <span class="trace-stage-dur">${s.durationMs.toFixed(0)}ms</span>
                ` : null}
                ${s.agentId ? html`
                  <span class="trace-stage-agent">${s.agentId}</span>
                ` : null}
              </button>
            `)}
          </div>
        </${Section}>
      ` : null}
    </div>
  `;
}

function TraceSpanTree({ trace, onSpanSelect }) {
  if (!trace.root) return html`<div class="sidebar-empty-sm">No spans</div>`;

  return html`
    <div class="trace-span-tree">
      ${renderSpanList(trace.root.children || [trace.root], 0, onSpanSelect)}
    </div>
  `;
}

function renderSpanList(spans, depth, onSelect) {
  return spans.map((span, i) => html`
    <${SpanRow} key=${span.id} span=${span} depth=${depth} onSelect=${onSelect} />
  `);
}

function SpanRow({ span, depth, onSelect }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const isSelected = selectedSpanId.value === span.id;
  const hasChildren = span.children && span.children.length > 0;
  const statusColor = span.status === "ok" ? "var(--ok)" : span.status === "error" ? "var(--error)" : "var(--warn)";

  return html`
    <div style="padding-left: ${depth * 12}px">
      <div class="span-row ${isSelected ? "selected" : ""}"
        onClick=${() => { selectedSpanId.value = span.id; if (onSelect) onSelect(span); }}>
        ${hasChildren ? html`
          <span class="tree-caret" onClick=${(e) => { e.stopPropagation(); setExpanded(!expanded); }}>
            ${expanded ? "▼" : "▶"}
          </span>
        ` : html`<span class="tree-caret-spacer"></span>`}
        <span class="span-status-dot" style="background: ${statusColor}"></span>
        <span class="span-kind-badge">${span.kind}</span>
        <span class="span-name-col">${span.name || span.agentId || ""}</span>
        ${span.durationMs ? html`<span class="span-duration">${span.durationMs.toFixed(0)}ms</span>` : null}
      </div>
      ${expanded && hasChildren ? renderSpanList(span.children, depth + 1, onSelect) : null}
    </div>
  `;
}

function TraceRawView({ trace }) {
  return html`
    <div class="trace-raw">
      <${JsonBlock} data=${trace} maxHeight=${600} />
    </div>
  `;
}

function SelectionSection({ layer }) {
  const summary = selectionSummary(layer);
  if (!summary) return null;
  const omittedCount = summary.omitted.reduce((n, o) => n + o.count, 0);
  return html`
    <${Section} title="Selection" open=${false}>
      <p class="selection-notice">${summary.notice}</p>
      <div class="def-field"><label>Budget</label><span>${summary.budget.used} / ${summary.budget.chars} chars${summary.budget.exceeded ? " (exceeded by pinned records)" : ""}</span></div>
      <div class="def-field"><label>Retained</label><span>${summary.retained.count} records, ${summary.retained.chars} chars in the owned log</span></div>
      ${summary.focus ? html`<div class="def-field"><label>Focus</label><span>${summary.focus}</span></div>` : null}
      ${summary.currentMessages.map(identity => html`<div class="def-field"><label>Selection request</label><span>${identity}</span></div>`)}
      ${summary.conflicts.length ? html`<div class="def-field"><label>Conflicts</label><span>${summary.conflicts.join("; ")}</span></div>` : null}
      <div class="def-field"><label>Selected (${summary.selected.length})</label></div>
      <ul class="selection-list">
        ${summary.selected.map((s) => html`<li key=${s.id}><code>${s.id}</code> ${s.reason}${s.detail ? html` <span class="muted">${s.detail}</span>` : null}</li>`)}
      </ul>
      <div class="def-field"><label>Not selected (${omittedCount})</label></div>
      <ul class="selection-list">
        ${summary.omitted.map((o) => html`<li key=${o.reason}>${o.reason}: ${o.count} records, ${o.chars} chars (${o.kinds})</li>`)}
      </ul>
      ${summary.exclusions.length ? html`<div class="def-field"><label>Current-message audit exclusions</label></div>
        <ul class="selection-list">${summary.exclusions.map(o => html`<li key=${o.id}><code>${o.id}</code> ${o.reason}: ${o.identity}</li>`)}</ul>` : null}
    </${Section}>`;
}

function LayerSnapshot({ layer }) {
  return html`
    <div class="detail-meta-row">
      <div class="detail-meta"><label>State</label><span>${layer.state}</span></div>
      <div class="detail-meta"><label>Hash</label><span class="mono">${layer.hash || "empty"}</span></div>
      <div class="detail-meta"><label>Updated</label><span>${layer.lastWarmed ? new Date(layer.lastWarmed).toLocaleString() : "Never"}</span></div>
    </div>
    <${Section} title="Instructions"><${JsonBlock} data=${layer.prompt || "No instructions recorded"} /></${Section}>
    <${Section} title="Cached content"><${JsonBlock} data=${layer.content || "Empty"} /></${Section}>
    <${SelectionSection} layer=${layer} />
    <${Section} title="Sources" open=${false}><${JsonBlock} data=${layer.sourceIds || []} /></${Section}>
  `;
}

function FailureDetail({ meta }) {
  const failure = failurePresentation(meta);
  if (!failure.notices.length) return null;
  return html`
    <${Section} title=${meta.executionOutcome === "completed" ? "Completion evidence" : "Failure evidence"}>
      ${failure.notices.map(notice => html`<div class="detail-meta">${notice}</div>`)}
      ${failure.partialOutput ? html`<${Section} title="Partial output (unconfirmed)"><${JsonBlock} data=${failure.partialOutput} /></${Section}>` : null}
    </${Section}>
  `;
}

/**
 * Historical delivery and learning state recorded when this turn was prepared.
 * The selected trace is not the current runtime: this never reads live
 * learning state, and unrecorded metadata stays unavailable.
 */
function LearningDeliveryDetail({ trace }) {
  const message = messages.value.find(m => m.traceId === trace.id);
  // Index rows carry no delivery record; the lazily loaded owned detail holds the full journal row.
  const detailAgent = Array.isArray(trace.detail?.messages) ? trace.detail.messages.find(m => m.actor === "agent" && m.meta?.delivery) : null;
  const summary = deliverySummary(trace, detailAgent ?? message);
  if (!summary) {
    return html`<${Section} title="Learning and delivery at this turn" open=${true}>
      <div class="detail-null">Delivery and learning metadata were not recorded for this turn (older record). Current learning state is shown in the thread view, not here.</div>
    </${Section}>`;
  }
  return html`<${Section} title="Learning and delivery at this turn" open=${true}>
    <div class="detail-meta-row">
      <div class="detail-meta"><label>Source</label><span>${summary.source === "trace" ? "trace record" : "durable message metadata"}; immutable historical record</span></div>
    </div>
    ${summary.learning ? html`
      <div class="detail-meta-row">
        <div class="detail-meta"><label>Learning</label><span class="detail-status ${summary.learning.outcome === "pending" ? "running" : summary.learning.known ? "ok" : "stale"}">${summary.learning.outcome}</span></div>
        <div class="detail-meta"><label>Added wait</label><span>${summary.learning.waitedMs === null ? "not recorded" : `${summary.learning.waitedMs} ms`}</span></div>
      </div>
      <div class="detail-meta learning-barrier" data-outcome=${summary.learning.outcome}><span>${summary.learning.label}</span></div>
      ${summary.learning.pending.length ? html`<div class="detail-meta"><label>Outstanding then</label><span>${summary.learning.pending.map(p => `${p.domain} (${p.reviews})`).join(", ")}</span></div>` : null}
    ` : html`<div class="detail-null">Learning barrier not recorded for this turn.</div>`}
    <${Section} title=${`Delivered layers (${summary.layers.length})`} open=${false}>
      ${summary.layers.length ? summary.layers.map(layer => html`
        <div class="detail-meta" key=${layer.id}><label>${layer.id}</label>
          <span class="mono">${layer.deliveredHash}${layer.assessedHash && layer.assessedHash !== layer.deliveredHash ? ` (assessed ${layer.assessedHash}, drift)` : layer.drift ? " (drift)" : ""}</span></div>
      `) : html`<div class="detail-null">No delivered layer ledger recorded.</div>`}
    </${Section}>
  </${Section}>`;
}

/** A recorded provider request, collapsed: state label, provider, then each message. Never filled from current source. */
function RecordedRequest({ request, title }) {
  const count = request.state === "recorded" ? request.messages.length : 0;
  return html`<${Section} title=${title} open=${false}>
    <div class="participant-request" data-state=${request.state} data-messages=${String(count)}>
      ${request.state === "recorded" ? html`
        <div class="detail-meta"><label>Provider</label><span>${request.providerId ?? "Not recorded"}</span></div>
        <div class="detail-null">Provider input recorded; native receipt unverified.</div>
        ${request.messages.map((m, i) => html`<${Section} key=${i} title=${`${m.role} message`} open=${true}><${JsonBlock} data=${m.content} maxHeight=${260} /></${Section}>`)}`
      : request.state === "not-sent" ? html`<span class="detail-null">Not sent: ${request.reason ?? "reason not recorded"}.</span>`
      : request.state === "unobserved" ? html`<span class="detail-null">Unobserved: ${request.reason ?? "the call may have been made; its input was not captured"}.</span>`
      : html`<span class="detail-null">Request not recorded.</span>`}
    </div>
  </${Section}>`;
}

/** Routing and guard phases of the selected turn, from the retained trace. Historical; nothing recomputed. */
function PhaseHistory({ trace }) {
  const routing = routingRequest(trace);
  const guards = guardOutcomes(trace);
  const tone = s => s === "completed" || s === "routed" || s === "reported" ? "ok" : s === "pending" || s === "skipped" || s === "cold-cache" ? "cold" : "stale";
  return html`
    <${Section} title="Routing (historical)" open=${false}>
      <div class="phase-routing" data-state=${routing.state} data-status=${routing.state === "recorded" ? routing.status : "unrecorded"}>
        ${routing.state !== "recorded" ? html`<div class="detail-null">Routing not recorded for this turn.</div>` : html`
          <div class="detail-meta-row">
            <div class="detail-meta"><label>Status</label><span class="detail-status ${tone(routing.status)}">${routing.status}</span></div>
            <div class="detail-meta"><label>Domains</label><span>${routing.domains.length ? routing.domains.join(", ") : "none"}</span></div>
            <div class="detail-meta"><label>Layers</label><span>${routing.layers.length ? routing.layers.join(", ") : "none"}</span></div>
            ${routing.confidence !== null ? html`<div class="detail-meta"><label>Confidence</label><span>${routing.confidence}</span></div>` : null}
          </div>
          ${routing.reason ? html`<div class="detail-meta"><label>Reason</label><span>${routing.reason}</span></div>` : null}
          <${RecordedRequest} request=${routing.request} title="Routing request" />`}
      </div>
    </${Section}>
    <${Section} title=${`Guard outcomes (historical${guards ? `, ${guards.length}` : ""})`} open=${false}>
      ${!guards ? html`<div class="detail-null guard-outcomes-absent">No guard outcomes recorded for this turn.</div>`
      : !guards.length ? html`<div class="detail-null">No tool observation reached the guards during this turn.</div>`
      : guards.map((g, i) => html`
        <div class="guard-observation" key=${i} data-status=${g.status} data-tool=${g.tool} data-failed=${String(g.failed.length)} data-source=${g.source} data-correlation=${g.correlation ?? "unrecorded"}>
          <div class="detail-meta-row">
            <div class="detail-meta"><label>Tool</label><span>${g.tool}${g.callId ? html` <code>${g.callId}</code>` : ""}</span></div>
            <div class="detail-meta"><label>Guards</label><span class="detail-status ${g.failed.length ? "stale" : tone(g.status)}">${g.status}${g.failed.length ? ` (${g.failed.length} not completed)` : ""}</span></div>
            <div class="detail-meta"><label>Record</label><span>${g.source === "journal" ? "journal" : "turn meta"}${g.correlation && g.correlation !== "live-dispatch" ? ` · ${g.correlation}` : ""}</span></div>
            ${g.findings !== null ? html`<div class="detail-meta"><label>Findings</label><span>${g.findings}${g.critical ? ` (${g.critical} critical)` : ""}</span></div>` : null}
            ${g.failed.length ? html`<div class="detail-meta"><label>Not completed</label><span>${g.failed.join(", ")}</span></div>` : null}
          </div>
          ${g.error ? html`<div class="detail-meta"><label>Error</label><span>${g.error}</span></div>` : null}
          ${g.status === "pending" ? html`<div class="detail-null">Requested; no outcome recorded yet. No all-clear.</div>` : null}
          ${g.conflict ? html`<div class="detail-meta guard-conflict" data-conflict=${g.conflict}><label>Conflict</label><span>${g.conflict}: ${g.duplicates.join(", ")} (earliest outcome shown; others retained)</span></div>` : null}
          ${g.outcomes.map(o => html`
            <div class="guard-outcome" key=${o.domain} data-domain=${o.domain} data-status=${o.status}>
              <div class="detail-meta-row">
                <div class="detail-meta"><label>Expert</label><span>${o.domain}</span></div>
                <div class="detail-meta"><label>Check</label><span class="detail-status ${tone(o.status)}">${o.status}</span></div>
                <div class="detail-meta"><label>Findings</label><span>${o.status === "completed" ? o.findings : "none (not completed)"}</span></div>
                ${o.revision !== null ? html`<div class="detail-meta"><label>Understanding revision</label><span>${o.revision}</span></div>` : null}
              </div>
              ${o.error ? html`<div class="detail-meta"><label>Error</label><span>${o.error}</span></div>` : null}
              ${o.admission !== null ? html`<div class="detail-meta"><label>Native admission</label><span class="mono">${typeof o.admission === "string" ? o.admission : JSON.stringify(o.admission)}</span></div>` : null}
              ${o.reference && o.reference !== "resolved" && o.reference !== "unreferenced" ? html`<div class="detail-meta guard-reference" data-reference=${o.reference}><label>Input reference</label><span>${o.reference === "missing" ? `${o.requestRecord ?? "unrecorded"}: request row not found` : o.reference === "foreign" ? `${o.requestRecord}: belongs to another observation or domain; not shown` : o.reference === "journal-failed" ? "request row refused by the configured journal; input retained on the turn only" : o.reference === "journal-absent" ? "no phase journal configured when requested" : "no request reference recorded"}</span></div>` : null}
              <${RecordedRequest} request=${o.request} title="Guard request" />
            </div>`)}
        </div>`)}
    </${Section}>`;
}

/** Who advised at this turn's preparation, from what exact inputs. Historical and immutable:
 * the segments are the recorded ones, never the current cache. */
function ExpertParticipants({ injection, phases, trace }) {
  const record = expertParticipants(injection, phases);
  if (!record) return html`<${Section} title="Expert participants (historical preparation)" open=${true}>
    <div class="detail-null expert-participants-absent">Expert participation was not recorded for this turn (older record or no domain experts configured). Nothing is inferred from the current cache.</div>
  </${Section}>`;
  const segmentTitle = { instructions: "Instructions (configured)", domainKnowledge: "Domain knowledge (shared expertise)", threadKnowledge: "This expert's understanding of the thread (at that time)" };
  return html`<${Section} title=${`Expert participants (historical preparation, ${record.participants.length})`} open=${true}>
    <div class="detail-null">Each domain expert advised from three recorded inputs before the central executor ran. Shown as prepared then; later learning does not change this record.</div>
    ${record.participants.map(p => html`
      <div class="expert-participant" key=${p.id} data-domain=${p.id} data-decision=${p.decision} data-revision=${p.revision === null ? "unrecorded" : String(p.revision)}>
        <div class="detail-meta-row">
          <div class="detail-meta"><label>Expert</label><span>${p.id}</span></div>
          <div class="detail-meta"><label>Decision</label><span class="detail-status ${p.decision === "contribute" ? "ok" : p.decision === "abstain" ? "cold" : "stale"}">${p.decision}</span></div>
          <div class="detail-meta"><label>Understanding revision then</label><span>${p.revision === null ? "not recorded" : p.revision}${p.revisionDrift ? " (drifted before delivery)" : ""}</span></div>
          ${(() => { const d = deliveredUnderstanding(trace, p.id); return html`<div class="detail-meta participant-delivered" data-state=${d.state} data-revision=${d.deliveredRevision ?? "unrecorded"} data-hash=${d.deliveredHash ?? "unrecorded"} data-relation=${d.relation ?? "none"}><label>Delivered understanding</label>
            <span>${d.state === "recorded" ? (d.relation === "advanced" ? `revision ${d.deliveredRevision} (hash ${String(d.deliveredHash).slice(0, 16)}): a later revision than the assessed ${d.assessedRevision}; the central input carried revision ${d.deliveredRevision}`
              : `revision ${d.deliveredRevision}, same as assessed`)
              : d.state === "unverified" ? `bytes hash ${String(d.deliveredHash).slice(0, 16)}; owner revision ${d.deliveredRevision ?? "not marked"} (${d.relation ?? "unknown"}): not verified`
              : d.state === "legacy" ? "revision not recorded (older record)" : "no delivery record"}</span>
            ${d.state === "recorded" ? html`<div class="participant-delivered-content"><${JsonBlock} data=${d.content} maxHeight=${220} /></div>` : null}</div>`; })()}
          ${p.confidence !== null ? html`<div class="detail-meta"><label>Confidence</label><span>${p.confidence}</span></div>` : null}
        </div>
        <div class="detail-meta participant-rationale" data-state=${p.reason ? "recorded" : "absent"}><label>Rationale</label><span>${p.reason ?? (p.decision === "abstain" ? "Abstained without a recorded reason." : "No rationale recorded for this decision.")}</span></div>
        <div class="detail-meta participant-guidance"><label>Attributed guidance</label>
          <span>${p.snippets.length ? html`<ul class="participant-snippets">${p.snippets.map((s, i) => html`<li key=${i}>${s}</li>`)}</ul>` : p.decision === "abstain" ? "Abstained: no guidance supplied." : "No guidance recorded."}</span></div>
        ${["instructions", "domainKnowledge", "threadKnowledge"].map(key => html`
          <${Section} key=${key} title=${segmentTitle[key]} open=${true}>
            <div class="participant-segment" data-segment=${key} data-present=${p.segments[key] === null ? "absent" : p.segments[key] === "" ? "empty" : "present"}>
              ${p.segments[key] === null ? html`<span class="detail-null">Segment not recorded.</span>`
                : p.segments[key] === "" ? html`<span class="detail-null">${key === "threadKnowledge" ? "Empty: this expert had no interpretation of the thread yet (revision 0)." : "Empty at preparation."}</span>`
                : html`<${JsonBlock} data=${p.segments[key]} maxHeight=${220} />`}
            </div>
          </${Section}>`)}
        <${Section} title="Advice request" open=${false}>
          <div class="participant-request" data-state=${p.request.state} data-messages=${p.request.state === "recorded" ? String(p.request.messages.length) : "0"}>
            ${p.request.state === "recorded" ? html`
              <div class="detail-meta"><label>Provider</label><span>${p.request.providerId ?? "Not recorded"}</span></div>
              <div class="detail-null">Provider input recorded; native receipt unverified.</div>
              ${p.request.messages.map((m, i) => html`<${Section} key=${i} title=${`${m.role} message`} open=${true}><${JsonBlock} data=${m.content} maxHeight=${260} /></${Section}>`)}`
            : p.request.state === "not-sent" ? html`<span class="detail-null">Not sent: ${p.request.reason ?? "reason not recorded"}.</span>`
            : p.request.state === "unobserved" ? html`<span class="detail-null">Unobserved: ${p.request.reason ?? "input not captured"}.</span>`
            : html`<span class="detail-null">Advice request not recorded.</span>`}
          </div>
        </${Section}>
        ${p.cacheHash || p.deliveredCacheHash ? html`<div class="detail-meta"><label>Cache hashes</label><span class="mono">assessed ${p.cacheHash ?? "n/a"}; delivered ${p.deliveredCacheHash ?? "n/a"}</span></div>` : null}
      </div>`)}
    ${record.omissions.length ? html`<div class="detail-meta"><label>Omitted</label><span>${record.omissions.map(o => `${o.id}: ${o.reason}`).join("; ")}</span></div>` : null}
    ${record.conflicts.length ? html`<div class="detail-meta"><label>Conflicts</label><span>${record.conflicts.map(c => `${c.kind} ${c.id}: ${c.detail}`).join("; ")}</span></div>` : null}
  </${Section}>`;
}

/** The layer as a domain expert: role, and its own current understanding of the active thread. */
function ExpertUnderstanding({ layerId }) {
  const threadId = activeThreadId.value;
  const state = knowledgeInspection.value;
  useEffect(() => { if (threadId && (!state || state.threadId !== threadId)) loadKnowledge(threadId); }, [threadId]);
  const loaded = state && state.threadId === threadId && state.payload !== null;
  const summary = loaded ? knowledgeInspectionSummary(state.payload) : null;
  const und = summary ? domainUnderstanding(summary, summary.history, layerId) : null;
  return html`<${Section} title="Expert: this thread's understanding (owned)" open=${true}>
    <div class="detail-meta-row expert-role">
      <div class="detail-meta"><label>Role</label><span>domain expert layer</span></div>
      <div class="detail-meta"><label>Advises before</label><span>each message, from its three parts</span></div>
      <div class="detail-meta"><label>Reviews after</label><span>completion; revises only its own understanding</span></div>
      <div class="detail-meta"><label>Not</label><span>the central executor, router or classifier; not a shared thread fact</span></div>
    </div>
    ${!loaded ? html`<div class="detail-null expert-understanding" data-state="loading" data-revision="unknown">Loading this expert's current understanding…</div>`
      : !und.present ? html`<div class="detail-null expert-understanding" data-state=${expertAbsenceLabel(summary, layerId).state} data-revision="unknown">${expertAbsenceLabel(summary, layerId).text}</div>`
      : html`<div class="expert-understanding" data-state=${und.state} data-revision=${String(und.revision)} data-status=${und.status}>
        <div class="detail-meta-row">
          <div class="detail-meta"><label>Revision</label><span>${und.revision}${und.state === "none" ? " (nothing committed yet)" : ""}</span></div>
          <div class="detail-meta"><label>Review status</label><span class="detail-status ${und.status === "learned" ? "ok" : ["pending", "delayed"].includes(und.status) ? "running" : "cold"}">${und.statusLabel}</span></div>
          ${und.updatedAt ? html`<div class="detail-meta"><label>Committed</label><span>${new Date(und.updatedAt).toLocaleString()} by ${und.author ?? "unknown"}</span></div>` : null}
        </div>
        ${["pending", "delayed"].includes(und.status) ? html`<div class="detail-null">A review is pending; the last committed understanding below stays current until it commits. No turn waits for it.</div>` : null}
        <div class="detail-meta"><label>Current understanding</label></div>
        ${und.content ? html`<${JsonBlock} data=${und.content} maxHeight=${260} />` : html`<div class="detail-null">Empty: this expert has not committed an interpretation of this thread.</div>`}
        <div class="detail-meta knowledge-revision-evidence" data-source=${und.revision > 0 ? (und.revisionEvidenceMessageId ? "snapshot" : "unrecorded") : "none"}><label>Committed revision evidence</label><span>${und.revision > 0 ? html`turn ${und.revisionEvidenceMessageId ?? "unrecorded in snapshot"} ${und.revisionEvidenceMessageId ? html`<button class="back-btn knowledge-open-turn" onClick=${() => openEvidenceTurn(und.revisionEvidenceMessageId)}>open turn</button>` : null}` : "none"}</span></div>
        <div class="detail-meta knowledge-explanation knowledge-revision-explanation" data-state=${und.revisionExplanation.state}><label>Committed revision explanation</label><span>${und.revisionExplanation.text}</span></div>
        <div class="detail-meta"><label>Latest post-hook</label><span>${und.latest ? `${und.latest.decision}${und.latest.revision !== null ? ` → revision ${und.latest.revision}` : ""}${und.latest.evidenceMessageId ? `, evidence turn ${und.latest.evidenceMessageId}` : ""}` : "none in the recent history window"}</span></div>
        <div class="detail-meta knowledge-explanation knowledge-latest-explanation" data-state=${und.explanation.state}><label>Latest review explanation</label><span>${und.explanation.text}</span></div>
        <div class="detail-null">Full history, evidence navigation and review job ownership: open the thread view (clear the selection).</div>
      </div>`}
  </${Section}>`;
}

function InjectionDetail({ injection, phases, trace }) {
  if (!injection) return html`<${ExpertParticipants} injection=${null} phases=${phases} /><div class="detail-empty">Input unavailable: context snapshot not recorded for this turn.</div>`;
  return html`
    <div class="detail-meta-row">
      <div class="detail-meta"><label>Snapshot</label><span>${injection.capturedAt ? new Date(injection.capturedAt).toLocaleString() : "Time not recorded"}</span></div>
      <div class="detail-meta"><label>Scope</label><span>Prepared at executor dispatch; delivery acknowledgment unavailable</span></div>
    </div>
    <${Section} title="User message"><${JsonBlock} data=${injection.userMessage} /></${Section}>
    <${ExpertParticipants} injection=${injection} phases=${phases} trace=${trace} />
    <${Section} title="Prepared initial provider messages" open=${false}>
      <${JsonBlock} data=${injection.providerMessages || "Not recorded for this turn"} maxHeight=${500} />
    </${Section}>
    <${Section} title="Executor context" open=${false}>
      <${JsonBlock} data=${injection.executorContext ?? "Not recorded for this turn"} maxHeight=${500} />
    </${Section}>
    <${Section} title="Contributions">
      ${(injection.blocks || []).map(block => html`
        <${Section} key=${block.id} title=${`${block.source} / ${block.kind}`} open=${false}>
          <div class="detail-meta-row">
            <div class="detail-meta"><label>Hash</label><span class="mono">${block.hash}</span></div>
            <div class="detail-meta"><label>Tokens (est.)</label><span>${block.tokens}</span></div>
          </div>
          <${JsonBlock} data=${block.text} />
        </${Section}>
      `)}
    </${Section}>
    <${Section} title="Layer snapshots">
      ${injection.layers ? injection.layers.map(layer => html`
        <${Section} key=${layer.id} title=${`${layer.id} / ${layer.included ? "included" : "not included"}`} open=${false}>
          <${LayerSnapshot} layer=${layer} />
        </${Section}>
      `) : html`<div class="detail-null">Layer snapshots not recorded for this turn.</div>`}
    </${Section}>
  `;
}

/** Later owned audit beside (never replacing) the frozen turn preparation. */
function SelectedReviewHistory({ trace }) {
  const selected = trace.selectedTurn, threadId = selected?.threadId;
  useEffect(() => { if (threadId) loadKnowledge(threadId); }, [threadId]);
  const state = knowledgeInspection.value;
  if (!selected?.turnId || state?.threadId !== threadId) return null;
  const summary = knowledgeInspectionSummary(state.payload);
  const history = summary.history.filter(row => row.signal?.content?.evidence?.messageId === selected.turnId);
  return html`<${Section} title="Post-review for selected turn" open=${true}>
    <div class="selected-review-history" data-turn-id=${selected.turnId} data-status=${summary.status}>
      <div class="detail-null">Owned audit for turn ${selected.turnId}, from the server's recent history window. Later outcomes append here; historical preparation below stays unchanged.</div>
      ${["blocked", "unavailable", "reconciliation-needed"].includes(summary.status) ? html`<div class="detail-status error">${summary.status}: ${summary.error ?? state.error ?? "Inspection unavailable"}</div>` : null}
      <${LearningHistory} history=${history} emptyText="No entries for this turn in the available audit window; older entries may not be loaded." />
      ${summary.domains.map(d => { const u = domainUnderstanding(summary, summary.history, d.domain); return html`
        <div class="selected-review-current" data-domain=${d.domain} data-revision=${String(u.revision)}>
          <div class="detail-meta"><label>Current ${d.domain} understanding (not historical input)</label><span>revision ${u.revision} · ${u.statusLabel}</span></div>
          <${JsonBlock} data=${u.content || "No committed interpretation."} maxHeight=${220} />
        </div>`; })}
    </div>
  </${Section}>`;
}

// ---------------------------------------------------------------------------
// Span detail (when a specific span is selected within the trace)
// ---------------------------------------------------------------------------

function SpanDetail({ span, traceId }) {
  const isOverrideable = span.kind === "route" || span.kind === "classify";

  return html`
    <div class="detail-content">
      <div class="detail-header">
        <span class="detail-name">${span.name}</span>
        <span class="detail-kind-badge">${span.kind}</span>
        <span class="detail-status ${span.status}">${span.status}</span>
      </div>

      <div class="detail-meta-row">
        ${span.agentId ? html`<div class="detail-meta"><label>Agent</label><span>${span.agentId}</span></div>` : null}
        ${span.durationMs != null ? html`<div class="detail-meta"><label>Duration</label><span>${span.durationMs.toFixed(1)}ms</span></div>` : null}
        ${span.contextHash ? html`<div class="detail-meta"><label>Context</label><span class="mono">${span.contextHash}</span></div>` : null}
      </div>

      ${span.layerIds && span.layerIds.length > 0 ? html`
        <${Section} title="Layers (${span.layerIds.length})">
          <div class="detail-layers">
            ${span.layerIds.map(id => html`
              <span key=${id} class="detail-layer-chip" style="border-color: ${layerColor(id)}">
                <span class="detail-layer-dot" style="background: ${layerColor(id)}"></span>
                ${id}
              </span>
            `)}
          </div>
        </${Section}>
      ` : null}

      ${span.input !== undefined ? html`<${Section} title="Input"><${JsonBlock} data=${span.input} /></${Section}>` : null}
      ${span.output !== undefined ? html`<${Section} title="Output"><${JsonBlock} data=${span.output} /></${Section}>` : null}
      ${span.annotations?.injection ? html`<${Section} title="Turn Context"><${InjectionDetail} injection=${span.annotations.injection} /></${Section}>` : null}
      ${span.error ? html`<${Section} title="Error"><${JsonBlock} data=${span.error} /></${Section}>` : null}
      ${span.annotations && Object.keys(span.annotations).length > 0 ? html`
        <${Section} title="Annotations" open=${false}><${JsonBlock} data=${span.annotations} /></${Section}>
      ` : null}

      ${isOverrideable ? html`
        <${Section} title="Correction" open=${false}>
          <${OverrideForm} traceId=${traceId} spanId=${span.id} />
        </${Section}>
      ` : null}
    </div>
  `;
}

function OverrideForm({ traceId, spanId }) {
  const [correction, setCorrection] = useState("");
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);

  if (submitted) return html`<div class="detail-ok">Correction submitted</div>`;

  return html`
    <div class="override-form">
      <textarea class="override-input" placeholder="What should this have been?"
        value=${correction} onInput=${(e) => setCorrection(e.target.value)} rows="3"></textarea>
      <input class="override-reason" placeholder="Reason (optional)"
        value=${reason} onInput=${(e) => setReason(e.target.value)} />
      <button class="override-submit" disabled=${!correction.trim()}
        onClick=${async () => { await submitIntervention(traceId, spanId, correction, reason); setSubmitted(true); }}
      >Submit Correction</button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Layer detail
// ---------------------------------------------------------------------------

function LayerDetail({ layerId }) {
  const data = threadData.value;
  const threadId = activeThreadId.value;
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setError(null);
    if (!threadId) return;
    const load = async () => {
      try {
        const res = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/layers/${encodeURIComponent(layerId)}`);
        if (!res.ok) throw new Error(`Layer state unavailable (${res.status})`);
        const value = await res.json();
        if (!cancelled) { setSnapshot(value); setError(null); }
      } catch (err) { if (!cancelled) setError(err.message); }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [threadId, layerId]);
  const layer = (data?.layers || []).find(l => l.id === layerId);
  const layerDef = (definitions.value?.layers || []).find(l => l.id === layerId);

  if (!layer && !layerDef) return html`<div class="detail-empty">Layer not found</div>`;

  if (layer) {
    return html`
      <div class="detail-content">
        <div class="detail-header">
          <span class="detail-layer-dot-lg" style="background: ${layerColor(layer.id)}"></span>
          <span class="detail-name">${layer.id}</span>
          <span class="detail-status ${layer.state}">${layer.state}</span>
        </div>
        <${ScopeBar} section="layers" itemId=${layer.id} />
        <${ExpertUnderstanding} key=${`${threadId}:${layer.id}`} layerId=${layer.id} />
        <div class="detail-meta-row"><div class="detail-meta"><label>Scope</label><span>${snapshot?.sharedWith?.length ? `Shared cache (${snapshot.sharedWith.length + 1} threads)` : "Current cache"}</span></div></div>
        ${snapshot?.sharedWith?.length ? html`<${Section} title="Shared with" open=${false}><${JsonBlock} data=${snapshot.sharedWith} /></${Section}>` : null}
        ${error ? html`<div class="detail-empty">${error}</div>` : snapshot
          ? html`<${LayerSnapshot} layer=${snapshot} />`
          : html`<div class="detail-null">Loading current state...</div>`}
        <div class="detail-meta-row">
          <div class="detail-meta"><label>Content</label><span>${layer.contentLength} chars</span></div>
          <div class="detail-meta"><label>Tokens</label><span>~${Math.ceil(layer.contentLength / 4)}</span></div>
          <div class="detail-meta"><label>Hash</label><span class="mono">${layer.hash || "\u2014"}</span></div>
        </div>
        ${layerDef ? html`
          <${Section} title="Definition" open=${false}>
            <div class="detail-def-fields">
              ${layerDef.prompt ? html`<div class="def-field"><label>Prompt</label><pre class="detail-json">${layerDef.prompt}</pre></div>` : null}
              <div class="def-field"><label>Sources</label><span>${(layerDef.sourceIds || []).join(", ") || "none"}</span></div>
              <div class="def-field"><label>Staleness</label><span>${layerDef.staleness ? layerDef.staleness + "ms" : "never"}</span></div>
            </div>
          </${Section}>
        ` : null}
      </div>
    `;
  }

  // No instance in the thread payload. The thread's own layer route is still authoritative: when it
  // answers, this layer is instantiated for the active thread and its current cache is shown.
  const instantiated = !!snapshot;
  return html`
    <div class="detail-content">
      <div class="detail-header">
        <span class="detail-layer-dot-lg" style="background: ${layerColor(layerDef.id)}; opacity: ${instantiated ? 1 : 0.5}"></span>
        <span class="detail-name">${layerDef.id}</span>
        <span class="detail-status ${instantiated ? snapshot.state : "cold"}">${instantiated ? snapshot.state : error ? "instance state unavailable" : "not instantiated"}</span>
      </div>
      <${ScopeBar} section="layers" itemId=${layerDef.id} />
      <${ExpertUnderstanding} key=${`${threadId}:${layerDef.id}`} layerId=${layerDef.id} />
      ${instantiated ? html`<${LayerSnapshot} layer=${snapshot} />` : error ? html`<div class="detail-null">${error}</div>` : null}
      <div class="detail-def-fields">
        ${layerDef.prompt ? html`<div class="def-field"><label>Prompt</label><pre class="detail-json">${layerDef.prompt}</pre></div>` : null}
        <div class="def-field"><label>Sources</label><span>${(layerDef.sourceIds || []).join(", ") || "none"}</span></div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Scope bar — global vs project with fork/unfork controls
// ---------------------------------------------------------------------------

function ScopeBar({ section, itemId }) {
  const projectId = activeProjectId.value;
  const config = settingsConfig.value;

  // No project selected → always global
  if (!projectId || !config) {
    return html`<div class="scope-bar"><span class="scope-label scope-global">global</span></div>`;
  }

  const projectConfig = config.projects?.[projectId];
  const hasOverride = projectConfig?.[section]?.[itemId] != null;

  const handleFork = async () => {
    // Copy global config into project overrides
    const globalItem = config[section]?.[itemId];
    if (!globalItem) return;
    try {
      const patch = { [section]: { ...projectConfig?.[section], [itemId]: { ...globalItem } } };
      const res = await authFetch(`/api/settings/projects`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [projectId]: { ...projectConfig, ...patch } }),
      });
      if (res.ok) {
        settingsConfig.value = await res.json();
        showToast(`Created project override for ${itemId}`, "ok");
      }
    } catch { showToast("Failed to create project copy", "error"); }
  };

  const handleUnfork = async () => {
    // Remove the project override — fall back to global
    try {
      const overrides = { ...projectConfig?.[section] };
      delete overrides[itemId];
      const patch = { [section]: overrides };
      const res = await authFetch(`/api/settings/projects`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [projectId]: { ...projectConfig, ...patch } }),
      });
      if (res.ok) {
        settingsConfig.value = await res.json();
        showToast(`Removed project override — using global ${itemId}`, "ok");
      }
    } catch { showToast("Failed to remove project copy", "error"); }
  };

  return html`
    <div class="scope-bar">
      ${hasOverride ? html`
        <span class="scope-label scope-project">${projectId} override</span>
        <button class="scope-btn" onClick=${handleUnfork} title="Remove project override, use global">use global</button>
      ` : html`
        <span class="scope-label scope-global">global</span>
        <button class="scope-btn" onClick=${handleFork} title="Create project-specific copy">fork for ${projectId}</button>
      `}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Agent detail
// ---------------------------------------------------------------------------

function AgentDetail({ agentId }) {
  const data = threadData.value;
  const instance = (data?.agents || []).find(a => a.agentId === agentId);
  const agentDef = (definitions.value?.agents || []).find(a => a.id === agentId);

  if (!instance && !agentDef) return html`<div class="detail-empty">Agent not found</div>`;

  const def = agentDef || {};

  return html`
    <div class="detail-content">
      <div class="detail-header">
        <span class="agent-icon">${instance ? "◆" : "○"}</span>
        <span class="detail-name">${agentId}</span>
        ${def.kind ? html`<span class="detail-kind-badge">${def.kind}</span>` : null}
        <span class="detail-status ${instance ? "ok" : "cold"}">${instance ? "active" : "defined"}</span>
      </div>

      <${ScopeBar} section="agents" itemId=${agentId} />

      <div class="detail-meta-row">
        ${def.provider ? html`<div class="detail-meta"><label>Provider</label><span>${def.provider}</span></div>` : null}
        ${def.model ? html`<div class="detail-meta"><label>Model</label><span class="mono">${def.model}</span></div>` : null}
        ${def.temperature != null ? html`<div class="detail-meta"><label>Temp</label><span>${def.temperature}</span></div>` : null}
        ${def.maxDepth != null ? html`<div class="detail-meta"><label>Max Depth</label><span>${def.maxDepth}</span></div>` : null}
      </div>

      ${def.prompt ? html`
        <${Section} title="Prompt">
          <pre class="detail-json">${def.prompt}</pre>
        </${Section}>
      ` : null}

      ${def.visibleLayers?.length > 0 ? html`
        <${Section} title="Visible Layers" open=${false}>
          <div class="detail-layers">
            ${def.visibleLayers.map(id => html`
              <span key=${id} class="detail-layer-chip" style="border-color: ${layerColor(id)}">
                <span class="detail-layer-dot" style="background: ${layerColor(id)}"></span>
                ${id}
              </span>
            `)}
          </div>
        </${Section}>
      ` : null}

      ${def.peers?.length > 0 ? html`
        <${Section} title="Peers" open=${false}>
          <div class="detail-peers">
            ${def.peers.map(p => html`<span key=${p} class="detail-peer-chip">${p}</span>`)}
          </div>
        </${Section}>
      ` : null}

      ${def.enabled != null ? html`
        <div class="detail-meta-row" style="margin-top: 8px">
          <div class="detail-meta"><label>Status</label><span>${def.enabled ? "enabled" : "disabled"}</span></div>
          ${def.invocation ? html`<div class="detail-meta"><label>Invocation</label><span>${def.invocation}</span></div>` : null}
          ${def.flowRole ? html`<div class="detail-meta"><label>Flow Role</label><span>${def.flowRole}</span></div>` : null}
        </div>
      ` : null}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Creation forms
// ---------------------------------------------------------------------------

function CreateLayerForm({ onCreated }) {
  const [id, setId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [staleness, setStaleness] = useState("0");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!id.trim()) return;
    setSaving(true);
    const ok = await createDefinition("layers", id.trim(), {
      id: id.trim(), prompt, sourceIds: [],
      staleness: parseInt(staleness) || 0,
      enabled: true,
    });
    setSaving(false);
    if (ok && onCreated) onCreated();
  };

  return html`
    <div class="detail-content">
      <div class="detail-header"><span class="detail-name">New Layer</span></div>
      <div class="create-form">
        <div class="settings-field">
          <label class="settings-label">ID</label>
          <input class="settings-input" placeholder="e.g. security-rules"
            value=${id} onInput=${(e) => setId(e.target.value)} />
        </div>
        <div class="settings-field">
          <label class="settings-label">Prompt</label>
          <textarea class="settings-input" rows="3" placeholder="What this layer provides..."
            value=${prompt} onInput=${(e) => setPrompt(e.target.value)}></textarea>
        </div>
        <div class="settings-row">
          <div class="settings-field"><label class="settings-label">Staleness (ms)</label>
            <input class="settings-input small" type="number" min="0"
              value=${staleness} onInput=${(e) => setStaleness(e.target.value)} /></div>
        </div>
        <div class="detail-actions" style="margin-top: 12px">
          <button class="action-btn" disabled=${!id.trim() || saving}
            onClick=${handleSave}>${saving ? "Saving..." : "Create Layer"}</button>
        </div>
      </div>
    </div>
  `;
}

function CreateAgentForm({ onCreated }) {
  const [id, setId] = useState("");
  const [kind, setKind] = useState("executor");
  const [prompt, setPrompt] = useState("");
  const [temperature, setTemperature] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!id.trim()) return;
    setSaving(true);
    const data = {
      id: id.trim(), kind, prompt,
      visibleLayers: [], peers: [], maxDepth: 3, enabled: true,
    };
    if (temperature !== "") data.temperature = parseFloat(temperature);
    const ok = await createDefinition("agents", id.trim(), data);
    setSaving(false);
    if (ok && onCreated) onCreated();
  };

  return html`
    <div class="detail-content">
      <div class="detail-header"><span class="detail-name">New Agent</span></div>
      <div class="create-form">
        <div class="settings-field">
          <label class="settings-label">ID</label>
          <input class="settings-input" placeholder="e.g. code-reviewer"
            value=${id} onInput=${(e) => setId(e.target.value)} />
        </div>
        <div class="settings-field">
          <label class="settings-label">Kind</label>
          <select class="settings-input" value=${kind} onChange=${(e) => setKind(e.target.value)}>
            <option value="executor">Executor</option>
            <option value="classifier">Classifier</option>
            <option value="router">Router</option>
            <option value="decider">Decider</option>
          </select>
        </div>
        <div class="settings-field">
          <label class="settings-label">System Prompt</label>
          <textarea class="settings-input" rows="4" placeholder="What this agent does..."
            value=${prompt} onInput=${(e) => setPrompt(e.target.value)}></textarea>
        </div>
        <div class="settings-row">
          <div class="settings-field"><label class="settings-label">Temperature</label>
            <input class="settings-input small" type="number" step="0.1" min="0" max="2"
              value=${temperature} onInput=${(e) => setTemperature(e.target.value)} /></div>
        </div>
        <div class="detail-actions" style="margin-top: 12px">
          <button class="action-btn" disabled=${!id.trim() || saving}
            onClick=${handleSave}>${saving ? "Saving..." : "Create Agent"}</button>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Thread detail — shows metadata + worktree assignment
// ---------------------------------------------------------------------------

function ThreadDetail() {
  const data = threadData.value;
  const wts = worktrees.value;
  const tid = activeThreadId.value;

  if (!data) return null;

  const meta = data.meta || {};

  const handleWorktreeChange = async (e) => {
    const path = e.target.value;
    const wt = wts.find(w => w.path === path);
    await updateThreadWorktree(tid, path || undefined, wt?.branch || undefined);
  };

  return html`
    <div class="detail-content">
      <div class="detail-header">
        <span class="detail-name">${meta.description || data.threadId}</span>
        <span class="detail-status ${liveThreadStatus(messages.value) || meta.status || "idle"}">${liveThreadStatus(messages.value) || meta.status || "idle"}</span>
      </div>

      <div class="detail-meta-row">
        <div class="detail-meta"><label>ID</label><span class="mono">${data.threadId}</span></div>
        ${meta.branch ? html`
          <div class="detail-meta"><label>Branch</label><span class="mono">${meta.branch}</span></div>
        ` : null}
      </div>

      ${meta.cwd ? html`
        <div class="detail-meta-row">
          <div class="detail-meta"><label>Worktree</label><span class="mono">${meta.cwd}</span></div>
        </div>
      ` : null}

      ${wts.length > 1 ? html`
        <${Section} title="Worktree">
          <select class="settings-input" value=${meta.cwd || ""}
            onChange=${handleWorktreeChange}>
            <option value="">main worktree</option>
            ${wts.filter(w => !w.isMain).map(w => html`
              <option key=${w.path} value=${w.path}>
                ${w.branch || w.path.split("/").pop()}
              </option>
            `)}
          </select>
        </${Section}>
      ` : null}

      ${data.agents?.length ? html`
        <${Section} title="Agents (${data.agents.length})" open=${false}>
          <div class="agent-list">
            ${data.agents.map(a => html`
              <div class="agent-item" key=${a.id}>
                <span class="agent-icon">◆</span>
                <span class="agent-name">${a.agentId}</span>
              </div>
            `)}
          </div>
        </${Section}>
      ` : null}

      <${KnowledgeInspection} key=${tid} threadId=${tid} />
    </div>
  `;
}

/**
 * Current owned learning for the active thread, from the existing knowledge
 * endpoint. Live state: distinct from the historical Turn Context record.
 */
function KnowledgeInspection({ threadId }) {
  useEffect(() => { if (threadId) loadKnowledge(threadId); }, [threadId]);
  const state = knowledgeInspection.value;
  if (!threadId) return null;
  if (!state || state.threadId !== threadId || (state.payload === null && state.pending)) {
    return html`<${Section} title="Thread knowledge (current)"><div class="detail-null">Loading current learning inspection…</div></${Section}>`;
  }
  const summary = knowledgeInspectionSummary(state.payload);
  const refresh = html`<span style="display: inline-flex; gap: 6px; align-items: center;">
    <button class="back-btn" onClick=${() => loadKnowledge(threadId)}>Refresh</button>
    ${state.pending ? html`<span class="detail-status running">refresh in progress; showing the last observed state</span>` : null}
    ${state.superseded ? html`<span class="detail-status cold" title="Older same-thread responses that resolved after a newer request were ignored">out-of-order responses ignored: ${state.superseded}</span>` : null}
  </span>`;
  if (summary.status === "unavailable" || summary.status === "blocked" || summary.status === "reconciliation-needed") {
    return html`<${Section} title="Thread knowledge (current)">
      <div class="detail-meta-row">
        <div class="detail-meta"><label>Status</label><span class="detail-status error">${summary.status}</span></div>
        ${refresh}
      </div>
      <div class="detail-meta"><span>${summary.error ?? state.error ?? "No detail recorded."}</span></div>
      ${summary.domains.length ? summary.domains.map(domain => html`<${KnowledgeDomain} key=${domain.domain} domain=${domain} />`) : null}
    </${Section}>`;
  }
  return html`<${Section} title="Thread knowledge (current)">
    <div class="detail-meta-row">
      <div class="detail-meta"><label>Durable</label><span class="detail-status ${summary.status === "durable" ? "ok" : "cold"}">${summary.status}</span></div>
      <div class="detail-meta"><label>Live runtime</label><span class="knowledge-live-state" data-state=${liveRuntimeLabel(summary).state}>${liveRuntimeLabel(summary).text}</span></div>
      <div class="detail-meta"><label>Checked</label><span>${new Date(state.loadedAt).toLocaleTimeString()}</span></div>
      ${refresh}
    </div>
    ${summary.domains.length ? summary.domains.map(domain => html`<${KnowledgeDomain} key=${domain.domain} domain=${domain} history=${summary.history} />`)
      : html`<div class="detail-null knowledge-empty" data-state=${knowledgeEmptyLabel(summary).state}>${knowledgeEmptyLabel(summary).text}</div>`}
    <${LearningHistory} history=${summary.history} />
    <${Section} title=${`Uncorrelated guard history${summary.uncorrelatedGuards ? ` (${summary.uncorrelatedGuards.length})` : ""}`} open=${false}>
      ${summary.uncorrelatedGuards === null ? html`<div class="detail-null uncorrelated-guards" data-state="unavailable">Not reported by this server.</div>`
      : !summary.uncorrelatedGuards.length ? html`<div class="detail-null uncorrelated-guards" data-state="none">No guard records without a turn association.</div>`
      : summary.uncorrelatedGuards.map((g, i) => html`<div class="guard-observation uncorrelated-guards" key=${i} data-state="present" data-status=${g.status} data-correlation=${g.correlation ?? "unrecorded"}>
          <div class="detail-meta-row">
            <div class="detail-meta"><label>Tool</label><span>${g.tool}${g.callId ? html` <code>${g.callId}</code>` : ""}</span></div>
            <div class="detail-meta"><label>Dispatch</label><span class="mono">${g.dispatchId ?? "unrecorded"} · ${g.correlation ?? "unrecorded"}; no turn association</span></div>
            <div class="detail-meta"><label>Guards</label><span class="detail-status ${g.failed.length ? "stale" : g.status === "reported" ? "ok" : "cold"}">${g.status}</span></div>
          </div>
          ${g.outcomes.map(o => html`<div class="guard-outcome" key=${o.domain} data-domain=${o.domain} data-status=${o.status}>
            <div class="detail-meta"><label>${o.domain}</label><span class="detail-status ${o.status === "completed" ? "ok" : o.status === "pending" ? "cold" : "stale"}">${o.status}</span></div>
            <${RecordedRequest} request=${o.request} title="Guard request" /></div>`)}
        </div>`)}
    </${Section}>
  </${Section}>`;
}

/** Open the turn that produced a piece of learning evidence, in this same panel. */
function openEvidenceTurn(messageId) {
  const row = messages.value.find(m => m.turnId === messageId && m.actor === "agent" && m.traceId);
  if (row) { loadTraceDetail(row.traceId); return; }
  // Not in the loaded page: the owned journal detail route resolves the turn directly.
  openTurnDetail(activeThreadId.value, messageId);
}

/** Journalled post-hook outcomes, readable per entry; raw records stay available below. */
function LearningHistory({ history, emptyText = "No post-hook outcomes recorded for this thread." }) {
  const entries = learningEntries(history);
  return html`<${Section} title=${`Learning history (${entries.length})`} open=${true}>
    ${entries.length ? entries.map((e, i) => html`
      <div class="learning-entry" key=${e.id ?? i} data-domain=${e.domain} data-decision=${e.decision} data-revision=${e.revision === null ? "none" : String(e.revision)}>
        <span class="learning-entry-when">${e.at ? new Date(e.at).toLocaleTimeString() : "time unrecorded"}</span>
        <span class="learning-entry-domain">${e.domain}</span>
        <span class="detail-status ${e.decision === "learned" ? "ok" : e.decision === "abstain" ? "cold" : "stale"}">${e.decision}</span>
        <span class="learning-entry-revision">${e.decision === "learned" ? `revision ${e.baseRevision ?? 0} → ${e.revision ?? "?"}` : e.revision !== null ? `revision ${e.revision}` : "no revision change"}</span>
        ${e.evidenceMessageId ? html`<button class="back-btn knowledge-open-turn" onClick=${() => openEvidenceTurn(e.evidenceMessageId)} title="Open the turn this outcome reviewed">turn ${e.evidenceMessageId}</button>` : html`<span class="detail-null">evidence turn unrecorded</span>`}
        <span class="learning-entry-reason knowledge-explanation" data-state=${explanationLabel(e).state}>${explanationLabel(e).text}</span>
        <span class="learning-entry-request" data-state=${e.request.state}>${e.request.state === "recorded" ? "request recorded" : e.request.state === "not-sent" ? `not sent: ${e.request.reason ?? "reason not recorded"}` : "request not recorded"}</span>
        ${e.request.state === "recorded" ? html`<${RecordedRequest} request=${e.request} title="Review request" />` : null}
      </div>`) : html`<div class="detail-null">${emptyText}</div>`}
    <${Section} title="Raw learning records" open=${false}><${JsonBlock} data=${history} maxHeight=${300} /></${Section}>
  </${Section}>`;
}

function KnowledgeDomain({ domain, history }) {
  const tone = domain.status === "learned" ? "ok" : ["pending", "delayed"].includes(domain.status) ? "running" : domain.known ? "stale" : "cold";
  const und = domainUnderstanding({ domains: [domain] }, history, domain.domain);
  return html`<div class="knowledge-domain" data-domain=${domain.domain} data-status=${domain.status} data-revision=${String(und.revision)}><${Section} title=${`${domain.domain}: ${domain.statusLabel}`} open=${true}>
    <div class="detail-meta-row">
      <div class="detail-meta"><label>Review status</label><span class="detail-status ${tone}">${domain.statusLabel}</span></div>
      <div class="detail-meta"><label>Revision</label><span class="knowledge-revision-change">${und.revisionChange}</span></div>
      <div class="detail-meta knowledge-evidence"><label>Latest post-hook</label><span>${und.latest ? html`${und.latest.decision}, turn ${und.latest.evidenceMessageId ?? "unrecorded"} ${und.latest.evidenceMessageId ? html`<button class="back-btn knowledge-open-turn" onClick=${() => openEvidenceTurn(und.latest.evidenceMessageId)}>open turn</button>` : null}` : "no post-hook evidence recorded"}</span></div>
      <div class="detail-meta knowledge-revision-evidence" data-source=${und.revision > 0 ? (und.revisionEvidenceMessageId ? "snapshot" : "unrecorded") : "none"}><label>Committed revision evidence</label><span>${und.revision > 0
        ? html`revision ${und.revision} from turn ${und.revisionEvidenceMessageId ?? "unrecorded in snapshot"} ${und.revisionEvidenceMessageId ? html`<button class="back-btn knowledge-open-turn" onClick=${() => openEvidenceTurn(und.revisionEvidenceMessageId)}>open turn</button>` : null}${und.matchedLearn ? "" : " (its learn outcome is outside the recent history window)"}`
        : "no committed revision"}</span></div>
    </div>
    <div class="detail-meta knowledge-explanation knowledge-revision-explanation" data-state=${und.revisionExplanation.state}><label>Committed revision explanation</label><span>${und.revisionExplanation.text}</span></div>
    <div class="detail-meta knowledge-explanation knowledge-latest-explanation" data-state=${und.explanation.state}><label>Latest review explanation</label><span>${und.explanation.text}</span></div>
    ${["pending", "delayed"].includes(domain.status) ? html`<div class="detail-null knowledge-last-committed">Review pending; last committed understanding stays readable: ${und.revision > 0 ? `revision ${und.revision}` : "none committed (revision 0)"}. No turn waits for this review.</div>` : null}
    <div class="detail-meta"><label>Current understanding (owned by ${domain.domain})</label></div>
    ${und.content ? html`<${JsonBlock} data=${und.content} maxHeight=${200} />` : html`<div class="detail-null">Nothing committed yet.</div>`}
    <div class="detail-meta-row">
      <div class="detail-meta"><label>Queued</label><span>${domain.queued === null ? "unavailable" : domain.queued}</span></div>
      <div class="detail-meta"><label>Native outcome</label><span>${domain.nativeOutcome}</span></div>
      ${domain.localSettled !== null ? html`<div class="detail-meta"><label>Local settlement</label><span>${domain.localSettled ? "settled" : "outstanding"}</span></div>` : null}
      ${domain.persistence ? html`<div class="detail-meta"><label>Persistence</label><span>${domain.persistence}</span></div>` : null}
    </div>
    <${Section} title="Owned review execution and cleanup" open=${false}>
      <${JsonBlock} data=${domain.lifecycle} maxHeight=${260} />
    </${Section}>
    <div class="detail-meta"><label>Latest committed revision</label>
      <span>${domain.committed.available
        ? `${domain.committed.revision} by ${domain.committed.author}${domain.committed.updatedAt ? ` at ${new Date(domain.committed.updatedAt).toLocaleString()}` : ""} (hash ${domain.committed.hash})`
        : domain.committed.revision !== null ? `none committed durably (review base revision ${domain.committed.revision})` : "none committed"}</span></div>
    ${domain.queuedEvidence.length ? html`<div class="detail-meta"><label>Queued evidence</label><span>${domain.queuedEvidence.join("; ")}</span></div>` : null}
    ${domain.job ? html`<${Section} title="Review job ownership" open=${false}>
      <div class="detail-meta"><label>Job</label><span class="mono">${domain.job.id}</span></div>
      <div class="detail-meta"><label>Owner</label><span>thread ${domain.job.threadId}; project ${domain.job.projectId ?? "not assigned"}; generation ${domain.job.generation}; epoch ${domain.job.epoch}</span></div>
      <div class="detail-meta"><label>Evidence</label><span>${domain.job.evidenceMessageId ? `message ${domain.job.evidenceMessageId}` : "message not recorded"} (${domain.job.evidenceId ?? "no id"})</span></div>
      <div class="detail-meta"><label>Base</label><span>revision ${domain.job.baseRevision ?? "unrecorded"}${domain.job.baseHash ? ` (hash ${domain.job.baseHash})` : ""}</span></div>
      <div class="detail-meta"><label>Eligibility</label><span>${domain.job.admittedAt ? `admitted ${new Date(domain.job.admittedAt).toLocaleTimeString()}` : "admission unrecorded"}${domain.job.eligibleUntil ? `; eligible until ${new Date(domain.job.eligibleUntil).toLocaleTimeString()}` : ""}</span></div>
    </${Section}>` : html`<div class="detail-null">No review job is recorded for this domain.</div>`}
    <${Section} title="Requested review configuration (not acknowledged)" open=${false}>
      <div class="detail-meta"><span>${domain.requested.notice}</span></div>
      ${domain.requested.items.map(item => html`<div class="detail-meta" key=${item.label}><label>${item.label}</label><span>${item.value} (requested)</span></div>`)}
      ${domain.requested.limits.map(limit => html`<div class="detail-meta" key=${limit}><span>${limit}</span></div>`)}
    </${Section}>
    <${Section} title="Review instructions" open=${false}>
      <${JsonBlock} data=${domain.segments.instructions ?? "Unavailable: no review job recorded for this domain."} maxHeight=${240} />
    </${Section}>
    <${Section} title="Configured domain knowledge" open=${false}>
      <${JsonBlock} data=${domain.segments.domainKnowledge ?? "Unavailable: no review job recorded for this domain."} maxHeight=${240} />
    </${Section}>
    <${Section} title=${`Thread knowledge (${domain.segments.source === "job" ? "frozen at review admission" : domain.segments.source === "snapshot" ? "latest durable commit" : "none"})`} open=${false}>
      <${JsonBlock} data=${domain.segments.threadKnowledge || "(nothing committed yet)"} maxHeight=${240} />
    </${Section}>
  </${Section}></div>`;
}

// ---------------------------------------------------------------------------
// Detail drawer (main export)
// ---------------------------------------------------------------------------

export function DetailDrawer({ selectedSpan, selectedLayer, selectedAgent, creating, onCreated, onSpanSelect }) {
  const trace = currentTrace.value;
  const spanId = selectedSpanId.value;

  // Find selected span in trace tree
  let span = null;
  if (spanId && trace?.root) {
    span = findSpan(trace.root, spanId);
  }

  // Priority: creation form > selected span > trace > selected agent > selected layer > empty
  let content;
  if (selectedEvent.value) {
    content = html`<div class="detail-content">
      <div class="detail-header"><span class="detail-name">${selectedEvent.value.kind}</span><span class="detail-kind-badge">activity</span></div>
      <${JsonBlock} data=${selectedEvent.value} maxHeight=${600} />
    </div>`;
  } else if (creating === "layer") {
    content = html`<${CreateLayerForm} onCreated=${onCreated} />`;
  } else if (creating === "agent") {
    content = html`<${CreateAgentForm} onCreated=${onCreated} />`;
  } else if (span && trace) {
    content = html`
      <div>
        <button class="back-btn" style="margin: 8px 8px 0"
          onClick=${() => { selectedSpanId.value = null; }}>← Back to trace</button>
        <${SpanDetail} span=${span} traceId=${trace.id} />
      </div>
    `;
  } else if (trace) {
    content = html`<${TraceDetail} key=${trace.id} trace=${trace} onSpanSelect=${onSpanSelect} />`;
  } else if (selectedAgent) {
    content = html`<${AgentDetail} agentId=${selectedAgent} />`;
  } else if (selectedLayer) {
    content = html`<${LayerDetail} key=${`${activeThreadId.value}:${selectedLayer}`} layerId=${selectedLayer} />`;
  } else if (threadData.value) {
    content = html`<${ThreadDetail} />`;
  } else {
    content = html`
      <div class="detail-empty">
        <p>Select a trace, span, agent, or layer to inspect</p>
        <div class="detail-hint">
          Click <kbd>trace</kbd> on a message to see pipeline details
        </div>
      </div>
    `;
  }

  const isOpen = detailDrawerOpen.value;

  if (!isOpen) {
    return html`
      <div class="detail-drawer detail-drawer--collapsed">
        <button class="panel-collapse-strip"
          onClick=${() => { detailDrawerOpen.value = true; }}
          title="Expand detail panel">
          <span class="panel-collapse-label">DETAIL</span>
        </button>
      </div>
    `;
  }

  return html`
    <div class="detail-drawer">
      <div class="panel-header">
        <span class="panel-title">DETAIL</span>
        <div style="margin-left: auto; display: flex; gap: 4px;">
          ${trace ? html`
            <button class="back-btn"
              onClick=${() => dismissTraceSelection()}>
              Clear
            </button>
          ` : null}
          <button class="panel-collapse-btn"
            onClick=${() => { detailDrawerOpen.value = false; }}
            title="Collapse detail panel">\u00bb</button>
        </div>
      </div>
      ${content}
    </div>
  `;
}

function findSpan(root, id) {
  if (root.id === id) return root;
  if (root.children) {
    for (const child of root.children) {
      const found = findSpan(child, id);
      if (found) return found;
    }
  }
  return null;
}
