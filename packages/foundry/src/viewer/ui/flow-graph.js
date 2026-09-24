/**
 * Graph builders for the viewer's graph panel: recorded data in, positioned nodes and edges out.
 * No DOM. Every builder reads what the runtime recorded (thread meta, the `flow:<threadId>` stream's
 * bounded turn records, learning signals) through the inspector's existing extractors; absent data
 * yields absent nodes, never inferred ones.
 *
 *   applyFlowFrame   `flow:<threadId>` snapshot/append → panel state
 *   threadGraph      thread + subagent hierarchy (meta.parentThreadId), big subtrees folded
 *   turnFlowGraph    one turn's loop: input → assessment ∥ routing → sealed plan → layers → executor → guards → delivery → learning
 *   learningLoop     per-domain lanes across turns: assessed revision → writeback → the revision a later turn assessed
 */
import { routingRequest, expertParticipants, guardOutcomes, deliverySummary, learningEntries } from "./inspector-data.js";

// ---------------------------------------------------------------------------
// Stream state
// ---------------------------------------------------------------------------

export const emptyFlow = (threadId = null) => ({ threadId, journal: "loading", error: null, turns: [], learning: [], knowledge: null, review: null, limits: { turns: 16, learning: 200 } });

/** Apply one `flow:<threadId>` frame. Returns the same object when nothing changed. */
export function applyFlowFrame(state, frame) {
  const payload = frame.payload;
  if (frame.action === "snapshot") {
    return { threadId: payload.threadId, journal: payload.journal, error: payload.error ?? null, turns: sortTurns(payload.turns ?? []),
      learning: payload.learning ?? [], knowledge: payload.knowledge ?? null, review: payload.review ?? null, limits: payload.limits ?? state.limits };
  }
  if (payload.kind === "turn") {
    const rest = state.turns.filter(turn => turn.turnId !== payload.turn.turnId);
    return { ...state, turns: sortTurns([...rest, payload.turn]).slice(-state.limits.turns) };
  }
  if (payload.kind === "learning") {
    const seen = new Set(state.learning.map(entry => entry.signal?.id));
    const fresh = payload.entries.filter(entry => !seen.has(entry.signal?.id));
    if (!fresh.length) return state;
    return { ...state, learning: [...state.learning, ...fresh].slice(-state.limits.learning) };
  }
  if (payload.kind === "knowledge") return { ...state, knowledge: payload.knowledge ?? null, review: payload.review ?? null };
  return state;
}

const sortTurns = turns => turns.slice().sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

// ---------------------------------------------------------------------------
// Shared layout
// ---------------------------------------------------------------------------

export const NODE_W = 176;
export const NODE_H = 46;
const COL_GAP = 64;
const ROW_GAP = 18;

/** Column layout: each node carries `col`; rows stack within a column, centred on the tallest column. */
export function layoutColumns(nodes, { colGap = COL_GAP, rowGap = ROW_GAP, nodeW = NODE_W, nodeH = NODE_H } = {}) {
  const columns = new Map();
  for (const node of nodes) {
    if (!columns.has(node.col)) columns.set(node.col, []);
    columns.get(node.col).push(node);
  }
  const tallest = Math.max(0, ...[...columns.values()].map(list => list.length));
  const height = tallest * nodeH + Math.max(0, tallest - 1) * rowGap;
  const order = [...columns.keys()].sort((a, b) => a - b);
  order.forEach((col, index) => {
    const list = columns.get(col);
    const own = list.length * nodeH + (list.length - 1) * rowGap;
    list.forEach((node, row) => Object.assign(node, { x: index * (nodeW + colGap), y: (height - own) / 2 + row * (nodeH + rowGap), w: nodeW, h: nodeH }));
  });
  return { width: Math.max(nodeW, order.length * nodeW + Math.max(0, order.length - 1) * colGap), height: Math.max(nodeH, height) };
}

const fmtMs = ms => !Number.isFinite(ms) ? null : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`;
const short = (text, max = 28) => !text ? "" : text.length > max ? `${text.slice(0, max - 1)}…` : text;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------
// Thread graph
// ---------------------------------------------------------------------------

const INACTIVE = new Set(["archived", "completed", "done"]);

/**
 * Threads and their subagent threads as a top-down tree. A thread whose parent is not in view is a root.
 * A node shows at most `maxChildren` children unless expanded; the rest fold into one "+N more" node,
 * as does everything past `maxNodes`.
 */
export function threadGraph(threads, { activeThreadId = null, expanded = new Set(), maxChildren = 8, maxNodes = 120, promptCounts = {} } = {}) {
  const byId = new Map();
  for (const t of threads ?? []) {
    const layers = Array.isArray(t.layers) ? t.layers : [];
    byId.set(t.threadId, { id: t.threadId, threadId: t.threadId, parentId: t.meta?.parentThreadId ?? null, status: t.meta?.status ?? "idle",
      label: t.meta?.description || t.threadId, branch: t.meta?.branch ?? null, lastActiveAt: t.meta?.lastActiveAt ?? null,
      agents: Array.isArray(t.agents) ? t.agents.length : 0, layers: layers.map(l => ({ id: l.id, state: l.state })),
      warm: layers.filter(l => l.state === "warm" || l.state === "warming").length, prompts: promptCounts[t.threadId] ?? 0, children: [] });
  }
  // A parent chain that loops back is cut at the node that closes it.
  const loops = id => { const seen = new Set(); for (let at = id; at; at = byId.get(at)?.parentId) { if (seen.has(at)) return true; seen.add(at); } return false; };
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : null;
    if (parent && parent !== node && !loops(node.id)) parent.children.push(node);
    else roots.push(node);
  }
  const recency = (a, b) => (INACTIVE.has(a.status) - INACTIVE.has(b.status)) || ((b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  roots.sort(recency);

  const nodes = [], edges = [];
  let hidden = 0;
  const place = (node, depth, parent) => {
    const visible = { ...node, kind: "thread", depth, childCount: node.children.length, active: node.id === activeThreadId, inactive: INACTIVE.has(node.status), children: undefined,
      detail: { thread: node.id, status: node.status, branch: node.branch, agents: node.agents, "warm layers": node.layers.filter(l => l.state === "warm" || l.state === "warming").map(l => l.id).join(", ") || "none",
        layers: node.layers.length, subagents: node.children.length || null, "pending prompts": node.prompts || null } };
    nodes.push(visible);
    if (parent) edges.push({ id: `${parent.id}->${node.id}`, from: parent.id, to: node.id, kind: "subagent" });
    const kids = node.children.slice().sort(recency);
    const limit = expanded.has(node.id) ? kids.length : maxChildren;
    const shown = [];
    for (const kid of kids) {
      if (shown.length >= limit || nodes.length >= maxNodes) break;
      shown.push(kid);
      place(kid, depth + 1, visible);
    }
    const folded = kids.length - shown.length;
    if (folded > 0) {
      const count = kids.slice(shown.length).reduce((n, kid) => n + subtreeSize(kid), 0);
      hidden += count;
      const more = { id: `more:${node.id}`, kind: "more", parentId: node.id, depth: depth + 1, label: `+${folded} more`, sub: `${plural(count, "thread")} folded`, hiddenCount: count, expandable: nodes.length < maxNodes };
      nodes.push(more);
      edges.push({ id: `${node.id}->${more.id}`, from: node.id, to: more.id, kind: "folded" });
    }
  };
  let skippedRoots = 0, skippedThreads = 0;
  for (const root of roots) {
    if (nodes.length >= maxNodes) { skippedRoots++; skippedThreads += subtreeSize(root); continue; }
    place(root, 0, null);
  }
  if (skippedRoots) {
    hidden += skippedThreads;
    nodes.push({ id: "more:", kind: "more", parentId: null, depth: 0, label: `+${skippedRoots} more`, sub: `${plural(skippedThreads, "thread")} over the ${maxNodes}-node limit`, hiddenCount: skippedThreads, expandable: false });
  }
  const { width, height } = layoutTree(nodes, edges);
  return { nodes, edges, width, height, hidden, total: byId.size };
}

const subtreeSize = node => 1 + node.children.reduce((n, kid) => n + subtreeSize(kid), 0);

/** Tidy top-down tree: leaves take consecutive slots, a parent centres over its children. */
function layoutTree(nodes, edges, { gapX = 24, gapY = 56 } = {}) {
  const kids = new Map(nodes.map(n => [n.id, []]));
  const hasParent = new Set();
  for (const e of edges) { kids.get(e.from)?.push(e.to); hasParent.add(e.to); }
  const byId = new Map(nodes.map(n => [n.id, n]));
  let slot = 0;
  const assign = id => {
    const node = byId.get(id);
    const children = kids.get(id);
    if (!children.length) node.cx = slot++;
    else { children.forEach(assign); node.cx = (byId.get(children[0]).cx + byId.get(children.at(-1)).cx) / 2; }
  };
  for (const node of nodes) if (!hasParent.has(node.id)) assign(node.id);
  let depth = 0;
  for (const node of nodes) {
    Object.assign(node, { x: node.cx * (NODE_W + gapX), y: node.depth * (NODE_H + gapY), w: NODE_W, h: NODE_H });
    delete node.cx;
    depth = Math.max(depth, node.depth);
  }
  return { width: Math.max(NODE_W, slot * NODE_W + Math.max(0, slot - 1) * gapX), height: (depth + 1) * NODE_H + depth * gapY };
}

// ---------------------------------------------------------------------------
// Turn flow
// ---------------------------------------------------------------------------

const ROUTE_STATUS = { routed: "ok", fallback: "warn", timeout: "warn", error: "error" };
const DECISION_STATUS = { contribute: "ok", abstain: "skip", error: "error", timeout: "warn", excluded: "skip", omitted: "warn" };
const TURN_STATUS = { completed: "ok", failed: "error", interrupted: "warn", active: "pending" };
const LEARN_STATUS = { learned: "ok", restored: "ok", abstain: "skip", delayed: "pending", requested: "pending", deferred: "pending",
  rejected: "error", invalid: "error", error: "error", expired: "error", "write-failed": "error", "reconciliation-needed": "error", timeout: "warn", stale: "warn", discarded: "warn" };
/** Learning lifecycle bookkeeping, not an outcome of the loop. */
const LEARN_BOOKKEEPING = new Set(["native-admission", "native-evidence", "native-cleanup", "capacity-settled", "duplicate", "foreign"]);
const MAX_LAYER_NODES = 10;

/** The configured cache layer a domain owns, per the turn's delivery record; its generated understanding otherwise. */
export function domainLayer(turn, domain) {
  const layers = Array.isArray(turn?.delivery?.layers) ? turn.delivery.layers : [];
  return layers.find(l => l?.domain === domain && !String(l.id).startsWith("thread-knowledge:"))?.id ?? `thread-knowledge:${domain}`;
}

/** Outcomes recorded for work at this turn, per domain (latest record per domain). */
function writebacksFor(learning, turnId) {
  const latest = new Map();
  for (const entry of learningEntries(learning)) {
    if (entry.evidenceMessageId !== turnId || LEARN_BOOKKEEPING.has(entry.decision)) continue;
    latest.set(entry.domain, entry);
  }
  return [...latest.values()];
}

/** One turn's recorded loop as a left-to-right graph. Edges carry the decision that connects two steps. */
export function turnFlowGraph(turn, { learning = [] } = {}) {
  if (!turn) return { nodes: [], edges: [], width: 0, height: 0 };
  const nodes = [], edges = [];
  const turnTarget = { type: "turn", threadId: turn.threadId, turnId: turn.turnId };
  const add = node => { nodes.push({ target: turnTarget, ...node }); return node.id; };
  const link = (from, to, label, status) => edges.push({ id: `${from}->${to}`, from, to, label: label ?? null, status: status ?? null });
  const plan = turn.plan ?? null;
  const record = { detail: { phases: turn.phases ?? [] } };
  const spans = Array.isArray(turn.spans) ? turn.spans : [];

  let col = 0;
  let last = [add({ id: "input", kind: "input", col, label: "Input", sub: short(turn.input?.preview, 30) || `${turn.input?.chars ?? 0} chars`,
    status: "ok", detail: { message: turn.input?.preview, chars: turn.input?.chars, started: turn.startedAt, turn: turn.turnId } })];

  // Harness stages ahead of the executor (a configured classifier or router).
  for (const kind of ["classify", "route"]) {
    const span = spans.find(s => s.kind === kind);
    if (!span) continue;
    col++;
    const id = add({ id: `span:${kind}`, kind: "stage", col, label: kind === "classify" ? "Classifier" : "Router", sub: [span.agentId, fmtMs(span.durationMs)].filter(Boolean).join(" · "),
      status: span.status === "error" ? "error" : "ok", detail: { span: span.name, agent: span.agentId, duration: fmtMs(span.durationMs), status: span.status } });
    for (const from of last) link(from, id, null);
    last = [id];
  }

  // Pre-message: the Cartographer routes while every domain assesses the same frozen input.
  const routing = routingRequest(record);
  const routed = routing.state === "recorded" ? routing : plan?.routing ? { status: plan.routing.status, reason: plan.routing.reason, domains: plan.routing.domains ?? [],
    layers: plan.routing.layers ?? [], confidence: plan.routing.confidence ?? null, elapsedMs: plan.routing.elapsedMs ?? null } : null;
  const contributions = Array.isArray(plan?.contributions) ? plan.contributions : null;
  const participants = contributions
    ? contributions.map(c => ({ id: c.domain, decision: c.decision, reason: c.reason ?? null, revision: c.provenance?.threadKnowledgeRevision ?? null,
      confidence: c.confidence ?? null, elapsedMs: c.provenance?.elapsedMs ?? null, layers: c.layers ?? [], snippets: Array.isArray(c.snippets) ? c.snippets.length : 0 }))
    : (expertParticipants(null, turn.phases)?.participants ?? []).map(p => ({ id: p.id, decision: p.decision, reason: p.reason, revision: p.revision, confidence: p.confidence,
      elapsedMs: null, layers: p.layers, snippets: p.snippets.length }));
  const assessed = [];
  if (routed || participants.length) col++;
  if (routed) {
    assessed.push(add({ id: "routing", kind: "routing", col, label: "Cartographer", sub: [routed.status, fmtMs(routed.elapsedMs)].filter(Boolean).join(" · "),
      status: ROUTE_STATUS[routed.status] ?? "warn", detail: { status: routed.status, reason: routed.reason, domains: routed.domains?.join(", ") || "none",
        layers: routed.layers?.join(", ") || "none", confidence: routed.confidence, elapsed: fmtMs(routed.elapsedMs) } }));
  }
  for (const p of participants) {
    assessed.push(add({ id: `domain:${p.id}`, kind: "domain", col, domain: p.id, label: p.id, sub: [p.decision, p.revision === null ? null : `rev ${p.revision}`, fmtMs(p.elapsedMs)].filter(Boolean).join(" · "),
      status: DECISION_STATUS[p.decision] ?? "warn", detail: { decision: p.decision, reason: p.reason, "assessed revision": p.revision, confidence: p.confidence,
        elapsed: fmtMs(p.elapsedMs), layers: p.layers?.join(", ") || "none", snippets: p.snippets } }));
  }
  for (const from of last) for (const to of assessed) link(from, to, null);
  if (assessed.length) last = assessed;

  // The sealed plan: what every participant decided, frozen before the executor is called.
  if (plan || assessed.length) {
    col++;
    const outstanding = Array.isArray(plan?.outstanding) ? plan.outstanding.length : 0;
    const id = add({ id: "plan", kind: "plan", col, label: "Sealed plan", sub: plan ? [plural(plan.layers?.length ?? 0, "layer"), fmtMs(plan.elapsed)].filter(Boolean).join(" · ") : "journalled phases only",
      status: outstanding ? "warn" : plan ? "ok" : "skip", detail: plan ? { elapsed: fmtMs(plan.elapsed), layers: plan.layers?.join(", ") || "none", snippets: turn.snippets,
        consulted: plan.domainsConsulted?.join(", ") || "none", confidence: plan.confidence, outstanding: outstanding || null,
        omitted: plan.omissions?.map(o => `${o.domain}: ${o.reason}`).join("; ") || null, fresh: plan.fresh } : { note: "No sealed plan on this turn's injection; phase rows only." } });
    for (const from of last) {
      const p = from === "routing" ? routed : participants.find(x => `domain:${x.id}` === from);
      const label = from === "routing" ? [routed?.domains?.length ? plural(routed.domains.length, "domain") : null, Number.isFinite(routed?.confidence) ? `conf ${routed.confidence}` : null].filter(Boolean).join(" · ")
        : p ? p.decision + (p.snippets ? ` · ${plural(p.snippets, "snippet")}` : "") : null;
      link(from, id, label || null, from === "routing" ? ROUTE_STATUS[routed?.status] : DECISION_STATUS[p?.decision]);
    }
    last = [id];
  }

  // Delivered layers: what the executor was actually given, against what was assessed.
  const delivery = deliverySummary(turn.delivery ? { delivery: turn.delivery } : null, null);
  const layers = delivery?.layers ?? [];
  if (layers.length) {
    col++;
    const layerIds = [];
    for (const layer of layers.slice(0, MAX_LAYER_NODES)) {
      const revisions = layer.assessedRevision !== null || layer.deliveredRevision !== null ? `rev ${layer.assessedRevision ?? "?"}→${layer.deliveredRevision ?? "?"}` : null;
      layerIds.push(add({ id: `layer:${layer.id}`, kind: "layer", col, layerId: layer.id, label: short(layer.id, 24), sub: [layer.drift ? "drift" : "delivered", revisions].filter(Boolean).join(" · "),
        status: layer.drift || layer.relation === "inconsistent" ? "warn" : "ok", target: { type: "layer", layerId: layer.id },
        detail: { domain: layer.domain, relation: layer.relation, drift: layer.drift, assessed: layer.assessedHash?.slice(0, 12), delivered: layer.deliveredHash?.slice(0, 12),
          "assessed revision": layer.assessedRevision, "delivered revision": layer.deliveredRevision } }));
    }
    if (layers.length > MAX_LAYER_NODES) layerIds.push(add({ id: "layer:more", kind: "more", col, label: `+${layers.length - MAX_LAYER_NODES} layers`, sub: "see turn detail", status: "skip" }));
    for (const from of last) for (const to of layerIds) link(from, to, null);
    last = layerIds;
  }

  // The executor dispatch.
  col++;
  const execute = spans.filter(s => s.kind === "execute").at(-1);
  const outcome = turn.outcome?.executionOutcome ?? turn.status;
  const executor = add({ id: "executor", kind: "executor", col, label: execute?.agentId ? `Executor ${short(execute.agentId, 14)}` : "Executor",
    sub: [turn.status, fmtMs(execute?.durationMs ?? (turn.endedAt ? turn.endedAt - turn.startedAt : null))].filter(Boolean).join(" · "),
    status: TURN_STATUS[turn.status] ?? "warn", detail: { status: turn.status, outcome, native: turn.outcome?.nativeOutcome, persistence: turn.outcome?.persistence,
      duration: fmtMs(execute?.durationMs), "trace total": fmtMs(turn.trace?.durationMs), error: turn.error, "native events": turn.native?.events } });
  for (const from of last) link(from, executor, from === "plan" && plan ? `${plural(plan.layers?.length ?? 0, "layer")} · ${plural(turn.snippets ?? 0, "snippet")}` : null);
  last = [executor];

  // The executor's own task lists, recorded as its plan-tool input.
  for (const list of turn.tasks ?? []) {
    const done = list.items.filter(i => i.status === "completed").length;
    const id = add({ id: `tasks:${list.source}`, kind: "tasks", col: col + 1, label: `Tasks (${list.source})`, sub: `${done}/${list.items.length} completed`,
      status: done === list.items.length ? "ok" : "pending", detail: { ...(list.goal ? { goal: list.goal } : {}), ...Object.fromEntries(list.items.map((i, n) => [`${n + 1}. ${i.status}`, i.text])) } });
    link(executor, id, "plan tool");
  }

  // Post-action guards, one per tool observation, beside the executor.
  const guards = guardOutcomes(record) ?? [];
  if (guards.length) {
    const gcol = col + 1;
    guards.slice(0, 12).forEach((g, n) => {
      const status = g.status === "pending" ? "pending" : g.status === "failed" ? "error" : (g.critical ?? 0) > 0 ? "error" : (g.findings ?? 0) > 0 ? "warn" : "ok";
      const id = add({ id: `guard:${n}`, kind: "guard", col: gcol, label: `Guard ${short(g.tool, 18)}`, sub: [g.status, g.findings === null ? null : plural(g.findings, "finding")].filter(Boolean).join(" · "),
        status, detail: { tool: g.tool, call: g.callId, status: g.status, findings: g.findings, critical: g.critical, correlation: g.correlation,
          domains: g.outcomes.map(o => `${o.domain}: ${o.status}${o.findings ? ` (${o.findings})` : ""}`).join("; ") || "none", error: g.error } });
      link(executor, id, g.tool, status);
    });
    if (guards.length > 12) link(executor, add({ id: "guard:more", kind: "more", col: gcol, label: `+${guards.length - 12} guards`, sub: "see turn detail", status: "skip" }), null);
  }

  // Delivery ledger commit, then each domain's writeback from this turn's evidence.
  if (delivery) {
    col += 2;
    const drift = layers.filter(l => l.drift).length;
    const id = add({ id: "delivery", kind: "delivery", col, label: "Delivery ledger", sub: `${plural(delivery.committed.length, "layer")} committed${drift ? ` · ${drift} drift` : ""}`,
      status: drift ? "warn" : "ok", detail: { committed: delivery.committed.join(", ") || "none", drift: drift || null, learning: delivery.learning?.label } });
    link(executor, id, drift ? `${drift} drift` : "delivered", drift ? "warn" : "ok");
    last = [id];
  } else col++;
  const writebacks = writebacksFor(learning, turn.turnId);
  if (writebacks.length) {
    col++;
    for (const w of writebacks) {
      const id = add({ id: `learn:${w.domain}`, kind: "learning", col, domain: w.domain, label: `Writeback ${short(w.domain, 14)}`,
        sub: [w.decision, w.revision !== null ? `rev ${w.baseRevision ?? "?"}→${w.revision}` : null].filter(Boolean).join(" · "),
        status: LEARN_STATUS[w.decision] ?? "warn", target: { type: "layer", layerId: domainLayer(turn, w.domain) },
        detail: { decision: w.decision, revision: w.revision, base: w.baseRevision, reason: w.reason, author: w.author, persistence: w.persistence, job: w.jobId } });
      for (const from of last) link(from, id, w.decision, LEARN_STATUS[w.decision]);
    }
  }
  // Wide gaps: the decisions ride the edges and need the room.
  const { width, height } = layoutColumns(nodes, { colGap: 112 });
  return { nodes, edges, width, height };
}

// ---------------------------------------------------------------------------
// Learning loop over time
// ---------------------------------------------------------------------------

/**
 * Per-domain lanes across the window's turns. At each turn a domain assessed some revision of its own
 * understanding (advice), then its reviewer wrote back an outcome from that turn's work. A learned
 * revision links forward to the first later turn that assessed it: the feedback loop, made visible.
 */
export const LOOP_LANE_H = NODE_H + 30;
export const LOOP_GUTTER = 120;
const LOOP_COL_W = Math.round(NODE_W * 0.7), LOOP_GAP = 56;

export function learningLoop(flow, { maxTurns = 16 } = {}) {
  const turns = (flow?.turns ?? []).slice(-maxTurns);
  const entries = learningEntries(flow?.learning ?? []).filter(e => !LEARN_BOOKKEEPING.has(e.decision));
  const inWindow = new Set(turns.map(t => t.turnId));
  const domains = new Set();
  const assessedAt = turns.map(turn => {
    const map = new Map();
    const contributions = Array.isArray(turn.plan?.contributions) ? turn.plan.contributions.map(c => ({ id: c.domain, decision: c.decision, revision: c.provenance?.threadKnowledgeRevision ?? null }))
      : (expertParticipants(null, turn.phases)?.participants ?? []).map(p => ({ id: p.id, decision: p.decision, revision: p.revision }));
    for (const c of contributions) { map.set(c.id, c); domains.add(c.id); }
    return map;
  });
  for (const e of entries) if (inWindow.has(e.evidenceMessageId)) domains.add(e.domain);
  for (const d of Object.keys(flow?.knowledge?.domains ?? {})) domains.add(d);
  const lanes = [...domains].sort();
  const lane = new Map(lanes.map((d, i) => [d, i]));
  const nodes = [], edges = [];
  const colW = LOOP_COL_W, gap = LOOP_GAP, laneH = LOOP_LANE_H;
  const at = (col, domain) => ({ x: LOOP_GUTTER + col * (colW + gap), y: lane.get(domain) * laneH, w: colW, h: NODE_H });

  turns.forEach((turn, t) => {
    for (const [domain, a] of assessedAt[t]) {
      nodes.push({ id: `assess:${turn.turnId}:${domain}`, kind: "domain", domain, turnId: turn.turnId, label: a.revision === null ? "assessed" : `assessed rev ${a.revision}`, sub: a.decision,
        status: DECISION_STATUS[a.decision] ?? "warn", revision: a.revision, target: { type: "turn", threadId: turn.threadId, turnId: turn.turnId },
        detail: { turn: turn.turnId, input: turn.input?.preview, decision: a.decision, "assessed revision": a.revision }, ...at(t * 2, domain) });
    }
    const writes = new Map();
    for (const e of entries) if (e.evidenceMessageId === turn.turnId) writes.set(e.domain, e);
    for (const [domain, e] of writes) {
      const id = `write:${turn.turnId}:${domain}`;
      nodes.push({ id, kind: "learning", domain, turnId: turn.turnId, label: e.decision, sub: e.revision !== null ? `rev ${e.baseRevision ?? "?"}→${e.revision}` : short(e.reason, 22) || "no revision",
        status: LEARN_STATUS[e.decision] ?? "warn", revision: e.decision === "learned" ? e.revision : null, target: { type: "layer", layerId: domainLayer(turn, domain) },
        detail: { turn: turn.turnId, decision: e.decision, revision: e.revision, base: e.baseRevision, reason: e.reason, persistence: e.persistence }, ...at(t * 2 + 1, domain) });
      const from = `assess:${turn.turnId}:${domain}`;
      if (assessedAt[t].has(domain)) edges.push({ id: `${from}->${id}`, from, to: id, kind: "writeback", label: null, status: LEARN_STATUS[e.decision] ?? null });
    }
  });
  // Feedback: a learned revision → the first later assessment that worked from it.
  for (const node of nodes.filter(n => n.kind === "learning" && n.revision !== null)) {
    const t = turns.findIndex(turn => turn.turnId === node.turnId);
    for (let later = t + 1; later < turns.length; later++) {
      const a = assessedAt[later].get(node.domain);
      if (a?.revision === node.revision) {
        // Skipping past other steps in the lane, the edge arcs over them.
        edges.push({ id: `${node.id}->feedback:${turns[later].turnId}`, from: node.id, to: `assess:${turns[later].turnId}:${node.domain}`, kind: "feedback", label: `rev ${node.revision}`, status: "ok", arc: later > t + 1 });
        break;
      }
    }
  }
  // Now: the committed revision and live review status per domain.
  const nowCol = turns.length * 2;
  for (const domain of lanes) {
    const committed = flow?.knowledge?.domains?.[domain];
    const review = flow?.review?.[domain];
    if (!committed && !review) continue;
    const pending = review && !["idle", "learned", "abstain"].includes(review.status);
    nodes.push({ id: `now:${domain}`, kind: "knowledge", domain, label: `${domain} now`, sub: `rev ${committed?.revision ?? 0}${review ? ` · ${review.status}` : ""}`,
      status: pending ? "pending" : "ok", target: { type: "layer", layerId: domainLayer(turns.at(-1), domain) },
      detail: { "committed revision": committed?.revision ?? 0, updated: committed?.updatedAt ?? null, author: committed?.author, review: review?.status ?? "not reported", queued: review?.queued }, ...at(nowCol, domain) });
    const lastWrite = [...nodes].reverse().find(n => n.domain === domain && n.kind === "learning" && n.revision !== null);
    if (lastWrite && lastWrite.revision === committed?.revision) {
      const adjacent = lastWrite.turnId === turns.at(-1)?.turnId;
      edges.push({ id: `${lastWrite.id}->now:${domain}`, from: lastWrite.id, to: `now:${domain}`, kind: "feedback", label: "committed", status: "ok", arc: !adjacent });
    }
  }
  const earlier = entries.filter(e => e.evidenceMessageId && !inWindow.has(e.evidenceMessageId)).length;
  const right = nodes.length ? Math.max(...nodes.map(n => n.x + n.w)) : LOOP_GUTTER;
  return { nodes, edges, lanes, turns: turns.map((t, i) => ({ turnId: t.turnId, x: LOOP_GUTTER + i * 2 * (colW + gap), preview: t.input?.preview ?? "" })),
    width: right, height: Math.max(0, lanes.length * laneH - 30), earlier };
}

/** Straight-in cubic path between two positioned nodes (left→right, or top→bottom for trees). An `arc`
 * edge, or one that runs backwards, leaves the top of its source and lands on the top of its target. */
export function edgePath(from, to, direction = "lr", arc = false) {
  if (direction === "tb") {
    const x1 = from.x + from.w / 2, y1 = from.y + from.h, x2 = to.x + to.w / 2, y2 = to.y, dy = Math.max(16, (y2 - y1) / 2);
    return { d: `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`, mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } };
  }
  // A backward or same-column edge (feedback to an earlier lane position) arcs above both nodes.
  if (arc || to.x <= from.x) {
    // Lifted just clear of the nodes, inside their lane's padding.
    const x1 = from.x + from.w / 2, y1 = from.y, x2 = to.x + to.w / 2, y2 = to.y, lift = Math.min(y1, y2) - 14;
    return { d: `M${x1},${y1} C${x1},${lift} ${x2},${lift} ${x2},${y2}`, mid: { x: (x1 + x2) / 2, y: lift + 6 } };
  }
  const x1 = from.x + from.w, y1 = from.y + from.h / 2, x2 = to.x, y2 = to.y + to.h / 2, dx = Math.max(16, (x2 - x1) / 2);
  return { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } };
}
