/**
 * Graph panel — the center panel's graph mode. Three views of structures Foundry records:
 *   Threads        thread + subagent hierarchy (the live `threads` stream the store already holds)
 *   Turn flow      one turn's recorded loop (the `flow:<threadId>` stream, held only while shown)
 *   Learning loop  per-domain assessment → writeback → later assessment, across the window's turns
 * Plain SVG, pan/zoom on interaction only; click inspects in the detail drawer, hover shows the record.
 */
import { html, signal, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "./lib.js";
import { allThreads, activeThreadId, activePanel, selectThread, openTurnDetail, promptCounts, currentTrace, holdStream, layerColor } from "./store.js";
import { applyFlowFrame, emptyFlow, threadGraph, turnFlowGraph, learningLoop, edgePath, LOOP_LANE_H } from "./flow-graph.js";

export const graphTab = signal("threads"); // "threads" | "turn" | "loop"
const TABS = [["threads", "Threads"], ["turn", "Turn flow"], ["loop", "Learning loop"]];
const MIN_ZOOM = 0.2, MAX_ZOOM = 3, READABLE_ZOOM = 0.75;

// ---------------------------------------------------------------------------
// Visibility + the flow stream
// ---------------------------------------------------------------------------

/** True while the element is laid out on screen and the tab is in the foreground. */
function useVisible(ref) {
  const [onScreen, setOnScreen] = useState(false);
  const [foreground, setForeground] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(entries => setOnScreen(entries.some(e => e.isIntersecting)));
    observer.observe(el);
    const onVisibility = () => setForeground(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);
  return onScreen && foreground;
}

/** The thread's `flow:<id>` stream, held only while `active`. A re-hold starts from a fresh snapshot. */
function useFlowStream(threadId, active) {
  const [flow, setFlow] = useState(() => emptyFlow(threadId));
  useEffect(() => {
    setFlow(emptyFlow(threadId));
    if (!threadId || !active) return;
    return holdStream(`flow:${threadId}`, frame => setFlow(state => applyFlowFrame(state, frame)));
  }, [threadId, active]);
  return flow;
}

// ---------------------------------------------------------------------------
// Canvas: pan/zoom SVG with hover and activation
// ---------------------------------------------------------------------------

const PAD = 24;

/** Scale to fit, never above 1.2 or below `minK`. A graph still wider than the view starts at its left
 * edge (where the flow begins) and pans from there; the fit control passes the true minimum. */
function fitView(graph, box, minK = READABLE_ZOOM) {
  if (!box.width || !box.height || !graph.width) return { x: PAD, y: PAD, k: 1 };
  const k = Math.min(1.2, Math.max(minK, Math.min((box.width - PAD * 2) / graph.width, (box.height - PAD * 2) / (graph.height + 40))));
  const x = graph.width * k > box.width - PAD * 2 ? PAD : (box.width - graph.width * k) / 2;
  return { x, y: Math.max(PAD + 16, (box.height - graph.height * k) / 2), k };
}

/** Clip a label to what fits a node of width `w` at the node font's character width. */
const fit = (text, w, charW) => { const max = Math.max(4, Math.floor((w - 20) / charW)); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };

function detailRows(detail) {
  return Object.entries(detail ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "");
}

function GraphNode({ node, selected, onActivate, onHover, onFocusNode }) {
  const layers = node.kind === "thread" ? node.layers.filter(l => l.state === "warm" || l.state === "warming").slice(0, 24) : [];
  const activate = () => onActivate(node);
  return html`<g class="graph-node graph-node--${node.kind} graph-status--${node.status ?? (node.inactive ? "skip" : "ok")} ${selected ? "graph-node--selected" : ""}"
    transform=${`translate(${node.x},${node.y})`} tabIndex="0" role="button" data-node-id=${node.id} data-kind=${node.kind}
    aria-label=${`${node.label}${node.sub ? `: ${node.sub}` : ""}`}
    onClick=${activate} onKeyDown=${e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } }}
    onPointerEnter=${() => onHover(node)} onPointerLeave=${() => onHover(null)} onFocus=${() => { onFocusNode(node); onHover(node); }} onBlur=${() => onHover(null)}>
    <rect class="graph-node-box" width=${node.w} height=${node.h} rx="6" />
    <rect class="graph-node-bar" width="3" height=${node.h - 12} x="5" y="6" rx="1.5" />
    <text class="graph-node-label" x="14" y="18">${fit(node.label, node.w, 6.8)}</text>
    <text class="graph-node-sub" x="14" y="34">${fit(node.kind === "thread" ? threadSub(node) : node.sub ?? "", node.w, 5.9)}</text>
    ${layers.map((l, i) => html`<rect key=${l.id} class="graph-node-layer" x=${14 + i * 6} y=${node.h - 6} width="4" height="3" fill=${layerColor(l.id)} />`)}
    ${node.prompts ? html`<g class="graph-node-badge"><circle cx=${node.w - 10} cy="10" r="7" /><text x=${node.w - 10} y="13" text-anchor="middle">${node.prompts}</text></g>` : null}
  </g>`;
}

const threadSub = node => [node.status, `${node.warm}/${node.layers.length} warm`, node.childCount ? `${node.childCount} sub` : null].filter(Boolean).join(" · ");

function GraphCanvas({ graph, direction = "lr", fitKey, selectedId, onActivate, underlay, label }) {
  const box = useRef(null);
  const [view, setView] = useState({ x: PAD, y: PAD, k: 1 });
  const [hover, setHover] = useState(null);
  const drag = useRef(null);
  const frame = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;

  // Fit when the graph's subject changes (before paint, so the unfitted view never shows), and when the
  // canvas is resized until the reader pans or zooms; a live update never moves the view.
  const moved = useRef(false);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    moved.current = false;
    const refit = () => { if (!moved.current) setView(fitView(graphRef.current, el.getBoundingClientRect())); };
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitKey]);

  // Wheel zoom about the pointer. Non-passive so the page does not scroll under the canvas.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = e => {
      e.preventDefault();
      moved.current = true;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const v = viewRef.current;
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * Math.exp(-e.deltaY * 0.0015)));
      setView({ k, x: px - (px - v.x) * (k / v.k), y: py - (py - v.y) * (k / v.k) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = e => {
    if (e.button !== 0 || e.target.closest(".graph-node")) return;
    drag.current = { x: e.clientX, y: e.clientY, view: viewRef.current };
    moved.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = e => {
    const d = drag.current;
    if (!d) return;
    const next = { ...d.view, x: d.view.x + e.clientX - d.x, y: d.view.y + e.clientY - d.y };
    // Pan repaints at most once per animation frame, and only while dragging.
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setView(next));
  };
  const onPointerUp = () => { drag.current = null; };
  const zoomBy = factor => {
    const el = box.current, v = viewRef.current;
    if (!el) return;
    moved.current = true;
    const rect = el.getBoundingClientRect(), cx = rect.width / 2, cy = rect.height / 2;
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
    setView({ k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) });
  };
  const onHover = useCallback(node => setHover(node ? { node } : null), []);

  // Keyboard focus on a node outside the view pans it into the centre.
  const onFocusNode = useCallback(node => {
    const el = box.current, v = viewRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = v.x + node.x * v.k, top = v.y + node.y * v.k;
    if (left >= 0 && top >= 0 && left + node.w * v.k <= width && top + node.h * v.k <= height) return;
    moved.current = true;
    setView({ ...v, x: width / 2 - (node.x + node.w / 2) * v.k, y: height / 2 - (node.y + node.h / 2) * v.k });
  }, []);
  const byId = useMemo(() => new Map(graph.nodes.map(n => [n.id, n])), [graph]);
  const rows = hover ? detailRows(hover.node.detail) : [];
  const boxWidth = box.current?.clientWidth ?? 0;
  // The tooltip sits beside its node in the current view (so it follows a pan), kept inside the canvas.
  const tip = hover ? { left: Math.max(8, Math.min(view.x + (hover.node.x + hover.node.w) * view.k + 8, boxWidth - 280)), top: Math.max(8, view.y + hover.node.y * view.k) } : null;
  return html`<div class="graph-canvas" ref=${box} aria-label=${label}
    onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp} onPointerCancel=${onPointerUp}>
    <svg class="graph-svg" width="100%" height="100%">
      <defs>
        <marker id="graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" class="graph-arrow" />
        </marker>
      </defs>
      <g transform=${`translate(${view.x},${view.y}) scale(${view.k})`}>
        ${underlay ? underlay(graph) : null}
        ${graph.edges.map(edge => {
          const from = byId.get(edge.from), to = byId.get(edge.to);
          if (!from || !to) return null;
          const { d, mid } = edgePath(from, to, direction, edge.arc);
          return html`<g key=${edge.id} class="graph-edge graph-edge--${edge.kind ?? "flow"} ${edge.status ? `graph-status--${edge.status}` : ""}" data-edge-id=${edge.id}>
            <path d=${d} marker-end="url(#graph-arrow)" />
            ${edge.label ? html`<text class="graph-edge-label" x=${mid.x} y=${mid.y - 4} text-anchor="middle">${edge.label}</text>` : null}
          </g>`;
        })}
        ${graph.nodes.map(node => html`<${GraphNode} key=${node.id} node=${node} selected=${node.id === selectedId} onActivate=${onActivate} onHover=${onHover} onFocusNode=${onFocusNode} />`)}
      </g>
    </svg>
    <div class="graph-controls">
      <button class="graph-control" onClick=${() => zoomBy(1.25)} title="Zoom in" aria-label="Zoom in">+</button>
      <button class="graph-control" onClick=${() => zoomBy(0.8)} title="Zoom out" aria-label="Zoom out">−</button>
      <button class="graph-control" onClick=${() => box.current && setView(fitView(graph, box.current.getBoundingClientRect(), MIN_ZOOM))} title="Fit to view" aria-label="Fit to view">fit</button>
    </div>
    ${hover ? html`<div class="graph-tooltip" role="tooltip"
      style=${`left:${tip.left}px; top:${tip.top}px`}>
      <div class="graph-tooltip-title">${hover.node.label}</div>
      ${hover.node.sub ? html`<div class="graph-tooltip-sub">${hover.node.kind === "thread" ? threadSub(hover.node) : hover.node.sub}</div>` : null}
      ${rows.map(([k, v]) => html`<div class="graph-tooltip-row" key=${k}><span class="graph-tooltip-key">${k}</span><span class="graph-tooltip-value">${String(v)}</span></div>`)}
    </div>` : null}
  </div>`;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function ThreadsView() {
  const [expanded, setExpanded] = useState(() => new Set());
  const graph = useMemo(() => threadGraph(allThreads.value, { activeThreadId: activeThreadId.value, expanded, promptCounts: promptCounts.value }),
    [allThreads.value, activeThreadId.value, expanded, promptCounts.value]);
  const activate = node => {
    if (node.kind === "more") { if (node.expandable && node.parentId) setExpanded(prev => new Set(prev).add(node.parentId)); return; }
    selectThread(node.threadId);
  };
  if (!graph.nodes.length) return html`<div class="graph-empty">No threads in this scope.</div>`;
  return html`
    <div class="graph-caption">${graph.total} threads${graph.hidden ? ` · ${graph.hidden} folded` : ""} · subagent threads nest under their parent · click a thread to open it</div>
    <${GraphCanvas} graph=${graph} direction="tb" fitKey=${`threads:${graph.total}`} selectedId=${activeThreadId.value} onActivate=${activate} label="Thread graph" />`;
}

const TURN_STATUS_CLASS = { completed: "ok", failed: "error", interrupted: "warn", active: "pending" };

function TurnStrip({ turns, selected, onSelect }) {
  return html`<div class="graph-turns" role="listbox" aria-label="Turns">
    ${turns.map((turn, i) => html`<button key=${turn.turnId} role="option" aria-selected=${turn.turnId === selected}
      class="graph-turn graph-status--${TURN_STATUS_CLASS[turn.status] ?? "skip"} ${turn.turnId === selected ? "graph-turn--selected" : ""}"
      title=${turn.input?.preview || turn.turnId} data-turn-id=${turn.turnId} onClick=${() => onSelect(turn.turnId)}>
      <span class="graph-turn-dot"></span>${i + 1}. ${turn.input?.preview?.slice(0, 24) || turn.turnId.slice(0, 12)}
    </button>`)}
  </div>`;
}

function TaskLists({ turn }) {
  const lists = turn?.tasks ?? [];
  if (!lists.length) return html`<div class="graph-tasks graph-tasks--empty">No task list recorded on this turn.</div>`;
  return html`<div class="graph-tasks">${lists.map(list => html`<div class="graph-task-list" key=${list.source}>
    <div class="graph-task-title">Tasks · ${list.source}${list.goal ? ` · ${list.goal}` : ""}</div>
    ${list.items.map((item, i) => html`<div key=${i} class="graph-task graph-task--${item.status}"><span class="graph-task-status">${item.status}</span>${item.text}</div>`)}
  </div>`)}</div>`;
}

function flowNotice(flow) {
  if (flow.journal === "loading") return "Loading recorded turns…";
  if (flow.journal === "unavailable") return "This viewer runs without a session journal; turn flows and learning history are recorded only by the local journal.";
  if (flow.journal === "error") return `The session journal could not be read: ${flow.error}`;
  return null;
}

function TurnFlowView({ flow, onInspect }) {
  const [picked, setPicked] = useState(null);
  const turns = flow.turns;
  // The turn opened elsewhere (a message's trace) is the default, then the newest.
  const traced = currentTrace.value?.selectedTurn?.turnId;
  const selectedId = [picked, traced, turns.at(-1)?.turnId].find(id => id && turns.some(t => t.turnId === id)) ?? null;
  const turn = turns.find(t => t.turnId === selectedId) ?? null;
  const graph = useMemo(() => turnFlowGraph(turn, { learning: flow.learning }), [turn, flow.learning]);
  const notice = flowNotice(flow);
  if (notice) return html`<div class="graph-empty">${notice}</div>`;
  if (!turns.length) return html`<div class="graph-empty">No turns recorded on this thread yet. Send a message; its flow fills in here as each phase is journalled.</div>`;
  return html`
    <${TurnStrip} turns=${turns} selected=${selectedId} onSelect=${setPicked} />
    <div class="graph-caption">Turn ${turn.turnId} · ${turn.status}${turn.plan?.elapsed != null ? ` · pre-message ${Math.round(turn.plan.elapsed)} ms` : ""} · click a step to inspect it</div>
    <${GraphCanvas} graph=${graph} fitKey=${`turn:${selectedId}`} onActivate=${onInspect} label="Turn flow graph" />
    <${TaskLists} turn=${turn} />`;
}

function LoopUnderlay(graph) {
  const laneH = LOOP_LANE_H;
  return html`<g class="graph-lanes">
    ${graph.lanes.map((lane, i) => html`<g key=${lane}>
      <rect class="graph-lane" x="0" y=${i * laneH - 12} width=${graph.width + 12} height=${laneH - 6} rx="4" />
      <text class="graph-lane-label" x="8" y=${i * laneH + 26}>${lane.length > 14 ? `${lane.slice(0, 13)}…` : lane}</text>
    </g>`)}
    ${graph.turns.map((turn, i) => html`<text key=${turn.turnId} class="graph-turn-label" x=${turn.x} y="-20">${`${i + 1}. ${turn.preview.slice(0, 18)}`}</text>`)}
  </g>`;
}

function LoopView({ flow, onInspect }) {
  const graph = useMemo(() => learningLoop(flow), [flow.turns, flow.learning, flow.knowledge, flow.review]);
  const notice = flowNotice(flow);
  if (notice) return html`<div class="graph-empty">${notice}</div>`;
  if (!graph.lanes.length) return html`<div class="graph-empty">No domain expert assessed a turn in this window and no knowledge is committed on this thread.</div>`;
  return html`
    <div class="graph-caption">${graph.lanes.length} domains × ${graph.turns.length} turns · assessed revision → writeback → the later turn that worked from it${graph.earlier ? ` · ${graph.earlier} earlier outcomes outside the window` : ""}</div>
    <${GraphCanvas} graph=${graph} fitKey=${`loop:${flow.threadId}:${graph.lanes.join(",")}`} onActivate=${onInspect} underlay=${LoopUnderlay} label="Learning loop graph" />`;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function GraphPanel({ onLayerClick }) {
  const root = useRef(null);
  const visible = useVisible(root);
  const tab = graphTab.value;
  const threadId = activeThreadId.value;
  // Only the flow views need the flow stream; the thread view reads the list the store already holds.
  const flow = useFlowStream(threadId, visible && tab !== "threads");
  const inspect = node => {
    const target = node.target;
    if (!target) return;
    if (target.type === "layer") onLayerClick?.(target.layerId);
    else if (target.type === "turn") openTurnDetail(target.threadId, target.turnId);
  };
  return html`<div class="graph-panel" ref=${root} data-tab=${tab} data-flow=${flow.journal}>
    <div class="graph-header">
      <div class="graph-tabs" role="tablist" aria-label="Graph views">
        ${TABS.map(([id, label]) => html`<button key=${id} role="tab" aria-selected=${tab === id} class="graph-tab ${tab === id ? "graph-tab--active" : ""}"
          onClick=${() => { graphTab.value = id; }}>${label}</button>`)}
      </div>
      ${tab !== "threads" && visible && threadId ? html`<span class="graph-live" title=${`flow:${threadId} is open`}><span class="status-dot on"></span>live</span>` : null}
      <button class="graph-tab graph-close" onClick=${() => { activePanel.value = "conversation"; }} title="Back to chat (g)">chat</button>
    </div>
    <div class="graph-body">
      ${tab === "threads" ? html`<${ThreadsView} />`
        : !threadId ? html`<div class="graph-empty">Select a thread to see its turns.</div>`
        : tab === "turn" ? html`<${TurnFlowView} key=${threadId} flow=${flow} onInspect=${inspect} />`
        : html`<${LoopView} flow=${flow} onInspect=${inspect} />`}
    </div>
  </div>`;
}
