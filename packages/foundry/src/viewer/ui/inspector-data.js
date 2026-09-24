export function traceSpans(root) {
  if (!root) return [];
  return [root, ...(root.children || []).flatMap(traceSpans)];
}

export function traceInjection(trace) {
  const failure = trace?.root?.annotations?.failure;
  if (failure) return failure.injection;
  if (trace?.injection) return trace.injection;
  const spans = traceSpans(trace?.root);
  const execute = spans.filter(span => span.kind === "execute").at(-1);
  if (execute) return execute.annotations?.injection;
  // Older snapshots did not always record span kinds.
  return spans.find(span => !span.kind && span.annotations?.injection)?.annotations.injection;
}

/** Shared labels for the conversation and historical failure inspector. */
export function failurePresentation(meta) {
  const native = meta?.nativeOutcome ?? meta?.native?.nativeOutcome;
  const nativeNotice = native === 'failed' ? 'Native failure observed; call capacity and cleanup are separate.'
    : native === 'completed' ? 'Native completion observed; call capacity and cleanup are separate.' : null;
  if (meta?.executionOutcome === "completed" && meta?.persistence !== "committed") {
    return { notices: [
      `Execution completed; result was not saved to local journal${meta.persistenceError ? `: ${meta.persistenceError}` : "."}`,
      "Completed output and evidence are browser-only. Do not replay completed work to repair storage.",
      nativeNotice ?? "Native terminal acknowledgment unavailable; native outcome remains unknown.",
    ] };
  }
  if (!meta || !["failed", "interrupted"].includes(meta.turnStatus)) return { notices: [] };
  const notices = [];
  if (meta.persistence === "failed") {
    notices.push(`Failure was not saved to local journal${meta.persistenceError ? `: ${meta.persistenceError}` : "."}`);
  } else if (meta.persistence === "committed") {
    notices.push(meta.turnStatus === "interrupted" ? "Interruption saved to local journal." : "Failure saved to local journal.");
  } else {
    notices.push("Failure persistence unavailable; this evidence may be lost on reload.");
  }
  if (meta.inputEvidence === "provider-boundary-recorded") {
    notices.push("Provider-boundary input recorded; delivery acknowledgment unavailable.");
  } else if (meta.inputEvidence === "prepared-only") {
    notices.push("Input prepared; provider boundary not recorded. Delivery acknowledgment unavailable.");
  } else {
    notices.push("Input unavailable: no executor snapshot is available. Delivery acknowledgment unavailable.");
  }
  notices.push(nativeNotice ?? "Native outcome unknown; check before retrying.");
  const browserEvidence = meta.browserFailureEvidence;
  if (browserEvidence) notices.push("Browser-only failure evidence; these details were not saved to the server journal.");
  return { notices, partialOutput: meta.partialOutput ?? browserEvidence?.partialOutput, browserEvidence };
}

export function eventsForThread(events, threadId) {
  return threadId ? events.filter(event =>
    (event.threadId ?? (event.kind === "session" ? event.event?.threadId : undefined)) === threadId
  ) : events;
}

/**
 * What the memory selector prepared for one layer instance: which records it
 * chose and why, what it left out grouped by reason, the budget, the focus and
 * any conflicts. Returns null for layers whose sources do not select. Wording
 * never says "delivered": a snapshot describes prepared input, and whether the
 * layer was included in the artifact; it is not acknowledgment of what the
 * model retained.
 */
export function selectionSummary(layer) {
  const sources = layer?.selection?.sources;
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const reports = sources.map((s) => s.report).filter(Boolean);
  const currentMessages = [...new Set(reports.filter(r => r.currentMessage).map(r => selectionIdentity(r.currentMessage)))];
  const exclusions = reports.flatMap(r => (r.omitted || []).filter(o => o.excludedFor).map(o => ({
    id: o.id, reason: o.reason, identity: selectionIdentity(o.excludedFor),
  })));
  const selected = reports.flatMap((r) => (r.selected || []).map((s) => ({ id: s.id, reason: s.reason, detail: selectedDetail(s) })));
  const groups = new Map();
  for (const r of reports) {
    for (const o of r.omitted || []) {
      const g = groups.get(o.reason) || { reason: o.reason, count: 0, chars: 0, kinds: new Map() };
      const kind = o.kind || "unknown";
      g.count += 1;
      g.chars += o.chars || 0;
      g.kinds.set(kind, (g.kinds.get(kind) || 0) + 1);
      groups.set(o.reason, g);
    }
  }
  const omitted = [...groups.values()].map((g) => ({
    reason: g.reason, count: g.count, chars: g.chars,
    kinds: [...g.kinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(", "),
  }));
  const budget = reports.reduce((acc, r) => ({
    chars: acc.chars + (r.budget?.chars || 0), used: acc.used + (r.budget?.used || 0), exceeded: acc.exceeded || Boolean(r.budget?.exceeded),
  }), { chars: 0, used: 0, exceeded: false });
  const retained = reports.reduce((acc, r) => ({
    count: acc.count + (r.retained?.count || 0), chars: acc.chars + (r.retained?.chars || 0),
  }), { count: 0, chars: 0 });
  const focused = reports.find((r) => r.focus);
  const focus = focused ? `${focused.focus.terms} terms from this message` : null;
  const conflicts = reports.flatMap((r) => (r.conflicts || []).map((c) => `${c.kind}: ${(c.ids || []).join(", ")}`));
  const omittedCount = omitted.reduce((n, o) => n + o.count, 0);
  const notice = layer.included === false
    ? `This layer was not included in the prepared input for this turn. ${selected.length} of ${retained.count} retained records had been selected; the full owned log stays searchable with the memory tool.`
    : `${selected.length} of ${retained.count} owned records were prepared as model input; ${omittedCount} were left out for the reasons below. Preparation is not acknowledgment of what the model retained. The full owned log stays searchable with the memory tool.`;
  return { selected, omitted, budget, retained, focus, conflicts, notice, currentMessages, exclusions };
}

const KNOWN_BARRIER_OUTCOMES = new Set(["none", "pending", "timeout"]);

/**
 * Immutable delivery/learning metadata recorded when a historical turn was
 * prepared. Read from the trace when it carries a delivery record, otherwise
 * from the matching durable message. Never derived from current runtime state:
 * "pending" here means pending at that time, and the input used the revision
 * committed then. Returns null when nothing was recorded.
 */
export function deliverySummary(trace, message) {
  const source = trace?.delivery ? "trace" : message?.meta?.delivery ? "message" : null;
  if (!source) return null;
  const delivery = source === "trace" ? trace.delivery : message.meta.delivery;
  const barrier = delivery.learningBarrier;
  let learning = null;
  if (barrier && typeof barrier === "object") {
    const outcome = typeof barrier.outcome === "string" ? barrier.outcome : "unrecorded";
    const known = KNOWN_BARRIER_OUTCOMES.has(outcome);
    const waitedMs = Number.isFinite(barrier.waitedMs) ? barrier.waitedMs : null;
    const pending = Array.isArray(barrier.pending) ? barrier.pending.map(p => ({ domain: p.domain, reviews: p.reviews })) : [];
    const stale = Array.isArray(barrier.stale) ? barrier.stale : [];
    const wait = waitedMs === null ? "added wait not recorded" : `${waitedMs} ms added wait`;
    const label = outcome === "pending"
      ? `Learning at this turn: pending (historical; ${wait}). ${pending.map(p => `${p.domain}: ${p.reviews} review${p.reviews === 1 ? "" : "s"} outstanding`).join("; ") || "domains not recorded"}. The input used the revision committed at that time.`
      : outcome === "none" ? `Learning at this turn: none outstanding (${wait}).`
      : outcome === "timeout" ? `Learning at this turn: an earlier serial barrier timed out (${wait}); stale domains ${stale.join(", ") || "not recorded"}.`
      : `Learning at this turn: recorded status "${outcome}" is not interpreted by this viewer (${wait}).`;
    learning = { outcome, known, waitedMs, pending, stale, label, historical: true };
  }
  const layers = Array.isArray(delivery.layers) ? delivery.layers.map(l => ({
    id: l.id, deliveredHash: l.deliveredHash, assessedHash: l.assessedHash, drift: Boolean(l.drift),
    domain: typeof l.domain === "string" ? l.domain : null, assessedRevision: Number.isInteger(l.assessedRevision) ? l.assessedRevision : null,
    deliveredRevision: Number.isInteger(l.deliveredRevision) ? l.deliveredRevision : null, relation: typeof l.relation === "string" ? l.relation : null,
  })) : [];
  const committed = Array.isArray(delivery.committed) ? delivery.committed : [];
  return { source, learning, layers, committed,
    provenance: learning || layers.length ? "recorded" : "unavailable" };
}

const KNOWN_REVIEW_STATUSES = new Set(["idle", "pending", "delayed", "learned", "abstain", "invalid", "error", "expired", "stale",
  "duplicate", "foreign", "discarded", "write-failed", "reconciliation-needed", "blocked-previous-occupancy"]);
const BUDGET_LABELS = {
  "requested-unverified": "requested; native support unverified",
  "requested-unenforced": "requested; not enforced by the native facade",
  "not-requested": "not requested",
};

function evidenceIdentity(evidence) {
  if (!evidence) return "unknown evidence";
  return `${evidence.messageId ? `message ${evidence.messageId}` : evidence.kind ?? "evidence"} (${evidence.id ?? "no id"})`;
}

/**
 * Current owned learning inspection from GET /api/threads/:id/knowledge. This
 * is live runtime state, kept separate from historical delivery metadata. Only
 * the last durable commit counts as knowledge; requested configuration is
 * labeled as requested, never as acknowledged. Unknown statuses are shown as
 * recorded, and missing data is unavailable rather than zero.
 */
/** Truthful live-state wording. A response without `learning` means the server did not report live
 * learning state; it is not evidence that no runtime owns the thread. Durable data stays visible. */
export function liveRuntimeLabel(summary) {
  if (!summary || summary.status === "unavailable") {
    return { state: "unavailable", text: summary?.error ? `live state unavailable: ${summary.error}` : "live state unavailable (no inspection response)" };
  }
  if (summary.learningAvailable) return { state: "reporting", text: "reporting (live learning state included in this response)" };
  const recorded = summary.domains.some(domain => domain.committed?.available) || summary.history.length > 0;
  return { state: "not-reported", text: recorded
    ? "live learning state not reported by this server; durable snapshot and history are shown below"
    : "live learning state not reported by this server; no durable knowledge recorded for this thread yet" };
}

export function knowledgeInspectionSummary(payload) {
  if (!payload || typeof payload !== "object") return { status: "unavailable", error: "No inspection response", domains: [], learningAvailable: false, history: [] };
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  if (Array.isArray(payload) || (payload.history !== undefined && (!Array.isArray(payload.history) || payload.history.some(entry =>
      !object(entry) || !Number.isFinite(entry.storedAt) || !object(entry.signal) || !object(entry.signal.content))))
      || (payload.snapshot != null && (!object(payload.snapshot) || !object(payload.snapshot.domains)))
      || (payload.learning != null && (!object(payload.learning) || !object(payload.learning.domains)))) {
    return { status: "unavailable", error: "Malformed knowledge inspection response; refresh to recover", domains: [], learningAvailable: false, history: [] };
  }
  const status = typeof payload.status === "string" ? payload.status : "unknown";
  const snapshotDomains = payload.snapshot?.domains ?? {};
  const live = payload.learning?.domains;
  const learningAvailable = Boolean(live && typeof live === "object");
  const names = [...new Set([...(learningAvailable ? Object.keys(live) : []), ...Object.keys(snapshotDomains)])].sort();
  const domains = names.map(domain => {
    const state = learningAvailable ? live[domain] ?? {} : {};
    const snapshot = snapshotDomains[domain];
    const reviewStatus = typeof state.status === "string" ? state.status : "unavailable";
    const known = KNOWN_REVIEW_STATUSES.has(reviewStatus);
    const job = state.job && typeof state.job === "object" ? state.job : null;
    const requested = job?.requested ?? {};
    const budgets = job?.budgets ?? {};
    const items = [["model", requested.model], ["maxTokens", requested.maxTokens], ["thinking", requested.thinking],
      ["provider", job?.providerId]].filter(([, value]) => value !== undefined)
      .map(([label, value]) => ({ label, value: String(value), acknowledged: false }));
    const limits = [
      budgets.nativeTokens ? `tokens: ${BUDGET_LABELS[budgets.nativeTokens] ?? `recorded "${budgets.nativeTokens}"`}` : null,
      budgets.nativeEffort ? `effort: ${BUDGET_LABELS[budgets.nativeEffort] ?? `recorded "${budgets.nativeEffort}"`}` : null,
      budgets.maxKnowledgeChars ? `knowledge cap ${budgets.maxKnowledgeChars} chars; response cap ${budgets.maxResponseChars ?? "unrecorded"} chars` : null,
    ].filter(Boolean);
    return {
      domain, status: reviewStatus, known,
      statusLabel: known ? reviewStatus : `recorded status "${reviewStatus}" (not interpreted by this viewer)`,
      queued: Number.isInteger(state.queued) ? state.queued : null,
      queuedEvidence: Array.isArray(state.queuedEvidence) ? state.queuedEvidence.map(evidenceIdentity) : [],
      localSettled: typeof state.localSettled === "boolean" ? state.localSettled : null,
      nativeOutcome: typeof state.nativeOutcome === "string" ? state.nativeOutcome : "unavailable",
      lifecycle: {
        ...Object.fromEntries(["localOutcome", "localError", "rpcOutcome", "transportOutcome", "capacity", "cleanup"]
          .map(key => [key, typeof state[key] === "string" ? state[key] : "unavailable"])),
        admissionId: typeof state.native?.admissionId === "string" ? state.native.admissionId : "unavailable",
        providerSessionKey: typeof state.native?.owner?.providerSessionKey === "string" ? state.native.owner.providerSessionKey : "unavailable",
        eligibility: state.closed === true ? "closed" : state.closed === false ? "open" : "unavailable",
      },
      persistence: state.persistence ?? null,
      committed: snapshot ? { available: true, revision: snapshot.revision, hash: snapshot.hash, author: snapshot.author, updatedAt: snapshot.updatedAt, content: typeof snapshot.content === "string" ? snapshot.content : null,
          // The durable snapshot's own evidence: current revision provenance independent of the bounded history window.
          evidence: Array.isArray(snapshot.evidence) ? snapshot.evidence : [] }
        : { available: false, revision: job?.base?.revision ?? null },
      job: job ? { id: job.id, threadId: job.threadId, projectId: job.projectId ?? null, generation: job.generation, epoch: job.epoch,
        baseRevision: job.base?.revision ?? null, baseHash: job.base?.hash ?? null, evidenceMessageId: job.evidence?.messageId ?? null,
        evidenceId: job.evidence?.id ?? null, admittedAt: job.admittedAt ?? null, eligibleUntil: job.eligibleUntil ?? null } : null,
      requested: { items, limits,
        notice: items.length ? "Requested by Foundry for this review; the native engine has not acknowledged these values." : "No review request recorded for this domain." },
      segments: job?.segments ? { ...job.segments, source: "job" }
        : { threadKnowledge: snapshot?.content ?? "", source: snapshot ? "snapshot" : "none" },
    };
  });
  return { status, error: typeof payload.error === "string" ? payload.error : null, domains, learningAvailable,
    history: Array.isArray(payload.history) ? payload.history : [],
    uncorrelatedGuards: Array.isArray(payload.uncorrelatedPhases) ? guardOutcomes({ detail: { phases: payload.uncorrelatedPhases } }) ?? [] : null,
    capturedAt: payload.snapshot?.capturedAt ?? null };
}

function selectionIdentity(identity) {
  return `message ${identity.messageId}; thread ${identity.threadId}; project ${identity.projectId ?? "not assigned"}`;
}

function selectedDetail(s) {
  const parts = [];
  if (s.kind) parts.push(s.kind);
  if (Array.isArray(s.matched) && s.matched.length) parts.push(`matched ${s.matched.join(", ")}`);
  if (s.truncated) parts.push(Array.isArray(s.ranges) && s.ranges.length ? `excerpt chars ${s.ranges.map(([a, b]) => `${a}-${b}`).join(", ")}` : "excerpt");
  parts.push(`${s.chars} chars`);
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// Expert loop inspection (CORE-006 M1/M2). Everything below reads recorded
// fields only: the pre-hook decoration frozen in the turn's injection artifact,
// the journalled learning history, and the durable knowledge snapshot. Absent
// data is labelled absent; nothing is inferred or recomputed.
// ---------------------------------------------------------------------------

/** The provider input one expert supplied at its phase, as recorded in the artifact. Absence is labelled;
 * nothing is filled from the current protocol, instructions or cache. Recorded input is not native receipt. */
export function participantRequest(request) {
  if (!request || typeof request !== "object") return { state: "not-recorded" };
  const phase = typeof request.phase === "string" ? request.phase : null;
  if (request.status === "not-sent") return { state: "not-sent", phase, reason: typeof request.reason === "string" && request.reason.length ? request.reason : null };
  if (request.status === "unobserved") return { state: "unobserved", phase, reason: typeof request.reason === "string" && request.reason.length ? request.reason : null };
  if (request.status === "supplied" && Array.isArray(request.messages)) {
    return { state: "recorded", phase, providerId: typeof request.providerId === "string" ? request.providerId : null,
      capturedAt: Number.isFinite(request.capturedAt) ? request.capturedAt : null,
      messages: request.messages.filter(m => m && typeof m.role === "string" && typeof m.content === "string").map(m => ({ role: m.role, content: m.content })) };
  }
  return { state: "not-recorded" };
}

/** The expert understanding the central provider actually received at this turn, from the turn's delivery record
 * (owner revision at assembly), beside the frozen assessment. Absence and legacy shapes are labelled, never inferred. */
export function deliveredUnderstanding(trace, domain) {
  const agents = Array.isArray(trace?.detail?.messages) ? trace.detail.messages.filter(m => m?.actor === "agent" && m.meta?.delivery) : [];
  const agent = agents[0];
  const delivery = agent?.meta?.delivery ?? trace?.delivery ?? null;
  const layers = Array.isArray(delivery?.layers) ? delivery.layers : [];
  const matches = layers.filter(l => l?.id === `thread-knowledge:${domain}`);
  const layer = matches[0];
  if (!layer) return { state: "not-recorded" };
  const assessedRevision = Number.isInteger(layer.assessedRevision) ? layer.assessedRevision : null;
  const deliveredRevision = Number.isInteger(layer.deliveredRevision) ? layer.deliveredRevision : null;
  const relation = typeof layer.relation === "string" ? layer.relation : null;
  if (matches.length === 1 && assessedRevision === null && deliveredRevision === null && relation === null) return { state: "legacy", deliveredHash: layer.deliveredHash };
  const unverified = { state: "unverified", assessedRevision, deliveredRevision, relation, deliveredHash: layer.deliveredHash, assessedHash: layer.assessedHash ?? null };
  const injection = agent?.meta?.injection ?? trace?.injection;
  try {
    if (matches.length !== 1 || agents.length > 1) return unverified;
    // Join every present selection/journal identity; a valid foreign artifact
    // cannot prove delivery for the historical turn the user selected.
    const threads = [agent?.threadId, trace?.detail?.threadId, trace?.detail?.turn?.threadId, trace?.selectedTurn?.threadId].filter(x => x !== undefined);
    const turns = [agent?.turnId, trace?.detail?.turnId, trace?.detail?.turn?.id, trace?.selectedTurn?.turnId].filter(x => x !== undefined);
    if (new Set(threads).size !== 1 || new Set(turns).size !== 1) return unverified;
    const proof = verifyExpertDelivery(injection, delivery, domain, {
      threadId: threads[0],
      messageId: turns[0],
      projectId: trace?.detail?.thread?.projectId ?? injection?.decoration?.input?.currentMessage?.projectId,
    });
    return { state: "recorded", ...proof, assessedHash: layer.assessedHash };
  } catch { return unverified; }
}

/** Each expert's exact three inputs, decision, attributed guidance and recorded provider request at the historical preparation of a turn. */
export function expertParticipants(injection, phases) {
  let decoration = injection?.decoration;
  if ((!decoration || typeof decoration !== "object") && Array.isArray(phases)) {
    // No delivered artifact (failed or interrupted turn): the sealed advice row journalled before the central call.
    const sealed = phases.filter(row => row?.phase === "advice" && Array.isArray(row.record?.participants)).at(-1);
    if (sealed) decoration = { participants: sealed.record.participants.map(p => ({ id: p.domain, decision: p.decision, reason: p.reason, segments: p.segments, request: p.request,
      provenance: { threadKnowledgeRevision: p.threadKnowledgeRevision, cacheHash: p.cacheHash } })), omissions: [], conflicts: [], input: { hash: sealed.record.inputHash, capturedAt: sealed.record.sealedAt }, source: "journal" };
  }
  if (!decoration || typeof decoration !== "object") return null;
  const list = Array.isArray(decoration.participants) ? decoration.participants : [];
  const participants = list.map(p => {
    const prov = p?.provenance && typeof p.provenance === "object" ? p.provenance : {};
    const segments = p?.segments && typeof p.segments === "object" ? p.segments : {};
    const revision = Number.isInteger(prov.threadKnowledgeRevision) ? prov.threadKnowledgeRevision : null;
    return {
      id: String(p?.id ?? "unknown"), decision: typeof p?.decision === "string" ? p.decision : "unrecorded",
      reason: typeof p?.reason === "string" && p.reason.length ? p.reason : null,
      segments: { instructions: typeof segments.instructions === "string" ? segments.instructions : null,
        domainKnowledge: typeof segments.domainKnowledge === "string" ? segments.domainKnowledge : null,
        threadKnowledge: typeof segments.threadKnowledge === "string" ? segments.threadKnowledge : null },
      revision, cacheHash: typeof prov.cacheHash === "string" ? prov.cacheHash : null,
      deliveredCacheHash: typeof prov.deliveredCacheHash === "string" ? prov.deliveredCacheHash : null,
      revisionDrift: prov.revisionDrift === true, confidence: Number.isFinite(prov.confidence) ? prov.confidence : null,
      snippets: Array.isArray(prov.snippets) ? prov.snippets.filter(s => typeof s === "string") : [],
      layers: Array.isArray(prov.layers) ? prov.layers : [],
      request: participantRequest(p?.request),
    };
  });
  return { participants, omissions: Array.isArray(decoration.omissions) ? decoration.omissions : [],
    conflicts: Array.isArray(decoration.conflicts) ? decoration.conflicts : [], capturedAt: decoration.input?.capturedAt ?? null, inputHash: decoration.input?.hash ?? null };
}

/** A middleware annotation of the dispatch: recorded on the execute span (like the injection artifact),
 * with the root as fallback for older or flattened records. */
function dispatchAnnotation(trace, key) {
  const agentMeta = trace?.detail?.messages?.find?.(m => m?.actor === "agent")?.meta ?? trace?.selectedTurn?.meta;
  if (agentMeta?.phases && typeof agentMeta.phases === "object" && agentMeta.phases[key] !== undefined) return agentMeta.phases[key];
  const execute = traceSpans(trace?.root).filter(span => span.kind === "execute").at(-1);
  return execute?.annotations?.[key] ?? trace?.root?.annotations?.[key];
}

/** The Cartographer's routing at a turn's preparation, from the sealed plan retained on the trace. */
function phaseRows(trace, phase) {
  const rows = Array.isArray(trace?.detail?.phases) ? trace.detail.phases : [];
  return rows.filter(row => row?.phase === phase && row.record && typeof row.record === "object");
}

export function routingRequest(trace) {
  const durable = phaseRows(trace, "route").at(-1);
  const routing = durable?.record?.routing ?? dispatchAnnotation(trace, "routing") ?? dispatchAnnotation(trace, "injectionPlan")?.routing;
  if (!routing || typeof routing !== "object") return { state: "not-recorded" };
  return { state: "recorded", status: typeof routing.status === "string" ? routing.status : "unrecorded",
    reason: typeof routing.reason === "string" && routing.reason.length ? routing.reason : null,
    domains: Array.isArray(routing.domains) ? routing.domains : [], layers: Array.isArray(routing.layers) ? routing.layers : [],
    confidence: Number.isFinite(routing.confidence) ? routing.confidence : null, elapsedMs: Number.isFinite(routing.elapsedMs) ? routing.elapsedMs : null,
    request: participantRequest(routing.request) };
}

/** Guard outcomes recorded on a turn's trace under each tool observation's identity. Null when the turn
 * has no such record (older record, or no observation reached the runtime while the dispatch was live). */
/** Guard history from durable phase rows: request rows (pending until an outcome row references them) merged with outcome rows. */
function durableGuardEntries(trace) {
  const requests = phaseRows(trace, "guard-request"), outcomes = phaseRows(trace, "guard-outcome");
  if (!requests.length && !outcomes.length) return null;
  const requestById = new Map(requests.map(row => [row.id, row]));
  const slots = new Map();
  const key = row => row.record.observation?.signalId ?? row.id;
  const slot = row => { const k = key(row); if (!slots.has(k)) slots.set(k, { observation: row.record.observation ?? {}, correlation: row.record.correlation ?? null, requests: [], outcomes: [] }); return slots.get(k); };
  for (const row of requests) slot(row).requests.push(row);
  for (const row of outcomes) slot(row).outcomes.push(row);
  return [...slots.values()].map(({ observation, correlation, requests, outcomes }) => {
    // The earliest outcome row settles the observation; later rows for the same observation are a recorded conflict.
    const [settledRow, ...duplicates] = outcomes;
    const settled = settledRow?.record ?? null;
    const referenced = new Set();
    const resolved = settled && Array.isArray(settled.outcomes) ? settled.outcomes.map(o => {
      // Join only through the explicit reference (per-outcome requestRecord, else the recorded mapping) and only when
      // the referenced row belongs to the same domain, observation, turn and dispatch. Never the latest same-domain request.
      const domain = String(o?.domain ?? "unknown");
      // The recorded mapping holds a row id when the request row was durable, otherwise the explicit journal state.
      const journalState = settled.requestJournal && typeof settled.requestJournal[domain] === "string" ? settled.requestJournal[domain] : null;
      const mapped = settled.requests && typeof settled.requests[domain] === "string" && !["failed", "absent"].includes(settled.requests[domain]) ? settled.requests[domain] : null;
      const ref = typeof o?.requestRecord === "string" ? o.requestRecord : mapped;
      const row = ref ? requestById.get(ref) : undefined;
      const sameOwner = !!row && row.record.domain === domain
        && ["threadId", "turnId", "dispatchId"].every(field => (row[field] ?? null) === (settledRow[field] ?? null))
        && ["signalId", "tool", "callId", "agentId", "dispatchId"].every(field =>
          (row.record.observation?.[field] ?? null) === (settledRow.record.observation?.[field] ?? null));
      const reference = ref ? (!row ? "missing" : !sameOwner ? "foreign" : "resolved")
        : journalState === "failed" ? "journal-failed" : journalState === "absent" ? "journal-absent" : "none";
      if (reference === "resolved") referenced.add(ref);
      const request = reference === "resolved" ? row.record.request
        : o?.requestState === "unobserved" ? { status: "unobserved", phase: "guard", reason: "request not observed" } : undefined;
      return { ...o, domain, status: typeof o?.status === "string" ? o.status : "unrecorded", findings: Number.isInteger(o?.findings) ? o.findings : 0, request, reference, requestRecord: ref };
    }) : [];
    // Request rows no outcome references stay pending under their own identity, whether or not another same-domain check settled.
    const pending = requests.filter(r => !referenced.has(r.id)).map(r => ({ domain: String(r.record.domain ?? "unknown"), status: "pending", findings: 0,
      threadKnowledgeRevision: r.record.threadKnowledgeRevision, request: r.record.request, reference: "unreferenced", requestRecord: r.id }));
    return { source: "journal", observation, correlation, status: settled ? (typeof settled.status === "string" ? settled.status : "unrecorded") : "pending",
      error: typeof settled?.error === "string" ? settled.error : undefined, failed: Array.isArray(settled?.failed) ? settled.failed : [],
      findings: Number.isInteger(settled?.findings) ? settled.findings : null, critical: Number.isInteger(settled?.critical) ? settled.critical : null,
      outcomes: [...resolved, ...pending], ...(duplicates.length ? { conflict: "duplicate-outcome", duplicates: duplicates.map(d => d.id) } : {}) };
  });
}

export function guardOutcomes(trace) {
  const guards = durableGuardEntries(trace) ?? dispatchAnnotation(trace, "guards");
  if (!Array.isArray(guards)) return null;
  return guards.map(entry => {
    const o = entry?.observation && typeof entry.observation === "object" ? entry.observation : {};
    const outcomes = Array.isArray(entry?.outcomes) ? entry.outcomes.map(x => ({
      domain: String(x?.domain ?? "unknown"), status: typeof x?.status === "string" ? x.status : "unrecorded",
      findings: Number.isInteger(x?.findings) ? x.findings : 0, error: typeof x?.error === "string" && x.error.length ? x.error : null,
      admission: x?.admission === undefined ? null : x.admission, revision: Number.isInteger(x?.threadKnowledgeRevision) ? x.threadKnowledgeRevision : null,
      request: participantRequest(x?.request), reference: typeof x?.reference === "string" ? x.reference : null, requestRecord: typeof x?.requestRecord === "string" ? x.requestRecord : null })) : [];
    return { tool: typeof o.tool === "string" ? o.tool : "unknown", callId: typeof o.callId === "string" ? o.callId : null,
      dispatchId: typeof o.dispatchId === "string" ? o.dispatchId : null, agentId: typeof o.agentId === "string" ? o.agentId : null,
      source: entry?.source === "journal" ? "journal" : "turn-meta", correlation: typeof entry?.correlation === "string" ? entry.correlation : null,
      status: typeof entry?.status === "string" ? entry.status : "unrecorded", error: typeof entry?.error === "string" ? entry.error : null,
      conflict: typeof entry?.conflict === "string" ? entry.conflict : null, duplicates: Array.isArray(entry?.duplicates) ? entry.duplicates : [],
      failed: Array.isArray(entry?.failed) ? entry.failed : [], findings: Number.isInteger(entry?.findings) ? entry.findings : null,
      critical: Number.isInteger(entry?.critical) ? entry.critical : null, outcomes };
  });
}

/** Journalled post-hook outcomes, oldest first; `reason` is null when the runtime recorded none. */
export function learningEntries(history, domain) {
  const list = Array.isArray(history) ? history : [];
  return list.map(entry => {
    const content = entry?.signal?.content && typeof entry.signal.content === "object" ? entry.signal.content : {};
    if (domain && content.domain !== domain) return null;
    return { at: Number.isFinite(entry.storedAt) ? entry.storedAt : null, id: entry.signal?.id ?? null, domain: typeof content.domain === "string" ? content.domain : "unknown",
      decision: typeof content.decision === "string" ? content.decision : "unrecorded", revision: Number.isInteger(content.revision) ? content.revision : null,
      baseRevision: Number.isInteger(content.job?.base?.revision) ? content.job.base.revision : null,
      reason: typeof content.reason === "string" && content.reason.length ? content.reason : null,
      evidenceMessageId: typeof content.evidence?.messageId === "string" ? content.evidence.messageId : null,
      jobId: typeof content.job?.id === "string" ? content.job.id : null,
      author: typeof content.author === "string" ? content.author : null, persistence: typeof content.persistence === "string" ? content.persistence : null,
      request: participantRequest(content.request) };
  }).filter(Boolean);
}

/** The supplied review explanation, or an honest absence. */
export function explanationLabel(entry) {
  if (!entry) return { state: "none", text: "No post-hook outcome recorded for this expert yet." };
  if (entry.reason) return { state: "recorded", text: entry.reason };
  return { state: "absent", text: `Rationale not recorded by the runtime for this ${entry.decision} record (absent in the journal, not hidden by the viewer).` };
}

/** One expert's current owned understanding of a thread. Current revision provenance comes from the
 * durable snapshot's own evidence; a historical learn outcome is attached only when its revision and
 * evidence match that snapshot. Missing before-revision or rationale stays unrecorded, never 0. */
export function domainUnderstanding(summary, history, domain) {
  const entry = summary?.domains?.find(d => d.domain === domain) ?? null;
  const entries = learningEntries(history, domain);
  const latest = entries.at(-1) ?? null;
  const latestLearned = [...entries].reverse().find(e => e.decision === "learned") ?? null;
  const committed = entry?.committed?.available ? entry.committed : null;
  const revision = committed && Number.isInteger(committed.revision) ? committed.revision : 0;
  const state = revision > 0 ? "committed" : "none";
  const committedEvidence = Array.isArray(committed?.evidence) ? committed.evidence.filter(e => e && typeof e === "object") : [];
  const evidenceMessageIds = committedEvidence.map(e => typeof e.messageId === "string" ? e.messageId : null).filter(Boolean);
  // A learn outcome matches the snapshot only on the same revision and (when either side names one) the same evidence turn.
  const matchedLearn = revision > 0 ? [...entries].reverse().find(e => e.decision === "learned" && e.revision === revision
    && (!e.evidenceMessageId || evidenceMessageIds.length === 0 || evidenceMessageIds.includes(e.evidenceMessageId))) ?? null : null;
  const dispatchEvidence = committedEvidence.find(e => e.kind === "dispatch" && typeof e.messageId === "string") ?? committedEvidence.find(e => typeof e.messageId === "string") ?? null;
  const revisionEvidenceMessageId = dispatchEvidence?.messageId ?? matchedLearn?.evidenceMessageId ?? null;
  const revisionExplanation = revision === 0 ? { state: "none", text: "No revision committed." }
    : matchedLearn ? explanationLabel(matchedLearn)
    : { state: "unavailable", text: "The outcome that produced this revision is not in the recent history window; its rationale is not shown (not invented)." };
  const revisionChange = revision === 0 ? "0 (nothing committed)"
    : matchedLearn ? `${matchedLearn.baseRevision === null ? "unrecorded" : matchedLearn.baseRevision} → ${revision}`
    : `→ ${revision} (before-revision not in the recent history window)`;
  return { domain, present: !!entry, revision, state, status: entry?.status ?? "unavailable", statusLabel: entry?.statusLabel ?? "unavailable",
    content: committed?.content ?? null, hash: committed?.hash ?? null, author: committed?.author ?? null, updatedAt: committed?.updatedAt ?? null,
    committedEvidence, revisionEvidenceMessageId, matchedLearn, revisionExplanation, revisionChange,
    latest, latestLearned, entries, explanation: explanationLabel(latest) };
}

/** Wording for a knowledge view with no domains: distinguishes an unreported live state from actual empty data. */
export function knowledgeEmptyLabel(summary) {
  if (!summary) return { state: "unavailable", text: "Knowledge inspection unavailable." };
  if (summary.learningAvailable) return { state: "empty", text: "No domain has committed or pending knowledge for this thread (live state reported by the server)." };
  return { state: "unreported", text: "No durable knowledge snapshot for this thread, and this server did not report live review state; whether experts are configured, idle or pending cannot be told from this response." };
}

/** Wording for a layer with no domain entry: only a reported live state can prove it is not a configured expert. */
export function expertAbsenceLabel(summary, layerId) {
  if (!summary || summary.status === "unavailable") return { state: "unavailable", text: `Expert record unavailable for ${layerId}: ${summary?.error ?? "no inspection response"}.` };
  if (summary.learningAvailable) return { state: "not-configured", text: `${layerId} is not a configured domain expert for this thread (live state reports no such domain).` };
  return { state: "unavailable", text: `No durable snapshot names ${layerId} and this server did not report live expert state; configured, idle or empty cannot be distinguished from this response.` };
}
import { verifyExpertDelivery } from "./delivery-evidence.js";
