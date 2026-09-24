/** Patch one response, never whichever response happened to be appended last. */
export function updateTurnMessage(messages, turnId, patch) {
  const index = messages.findIndex(message => message.actor === "agent" && message.turnId === turnId);
  if (index === -1) return messages;
  const next = [...messages];
  // A saved earlier delta does not establish that this version reached storage.
  next[index] = { ...next[index], ...patch, browserStorage: undefined };
  return next;
}

/** Write one browser snapshot; publish saved status only after setItem returns.
 * A rejected write never removes the previous snapshot or discards live evidence.
 * Unchanged saved rows keep their status; a later ordinary write clears volatility.
 */
export function persistBrowserMessages(messages, write) {
  const saved = messages.map(message => message.browserStorage?.status === "saved"
    ? message : { ...message, browserStorage: { status: "saved" } });
  try {
    write(JSON.stringify(saved));
    return saved;
  } catch (error) {
    const name = error?.name || "Error";
    // Durable rows are an optional cache: retry with only what exists nowhere else
    // (browser-only, completed-unsaved, streaming, legacy rows without a journal id, and the
    // browser-only evidence fields riding on a server row, written as a projection).
    const transient = messages.filter(message => !isDurableRow(message))
      .map(message => ({ ...(message.storage === "server" ? browserEvidenceProjection(message) : message), browserStorage: { status: "saved" } }));
    if (transient.length && transient.length < messages.length) {
      try {
        write(JSON.stringify(transient));
        return messages.map(message => isDurableRow(message)
          ? { ...message, browserStorage: { status: "not-cached", error: name } }
          : { ...message, browserStorage: { status: "saved" } });
      } catch { /* fall through: nothing could be written */ }
    }
    return messages.map(message => message.browserStorage?.status === "saved" ? message
      : { ...message, browserStorage: { status: "volatile", error: name } });
  }
}

/** Fields that exist only in this browser even when the row itself is a server record:
 * failure evidence kept beside an interrupted journal row, a browser trace id, a journal record
 * kept beside a browser-only completion, or an unconfirmed partial. Ownership is per field. */
export function hasBrowserOnlyEvidence(message) {
  const evidence = message.meta?.browserFailureEvidence;
  return (evidence !== undefined && evidence !== null && typeof evidence === "object")
    || message.journalRecord !== undefined || message.browserTraceId !== undefined
    || message.connectionStatus === "unconfirmed";
}

/** A row the server journal holds in full; the browser copy is optional. A row carrying
 * browser-only evidence is never disposable, whatever its storage label says. */
export function isDurableRow(message) {
  if (message.streaming || isUnsavedCompletion(message)) return false;
  if (message.storage === "browser-only" || hasBrowserOnlyEvidence(message)) return false;
  return message.storage === "server" || message.meta?.persistence === "committed";
}

// Metadata worth keeping in the evidence projection: semantic status and the browser-only evidence.
// Server-owned heavy detail (injection, native payloads, provider transcripts) is re-fetched, not copied.
const EVIDENCE_PROJECTION_META = new Set(["turnStatus", "persistence", "executionOutcome", "nativeOutcome", "attemptOutcome",
  "providerOutcome", "inputEvidence", "deliveryAcknowledgment", "injectedLayers", "error", "browserFailureEvidence"]);

/** The part of a server row that only this browser holds, plus the identity needed to merge it back. */
export function browserEvidenceProjection(message) {
  const { trace, meta, ...rest } = message;
  const kept = {};
  for (const [key, value] of Object.entries(meta ?? {})) if (EVIDENCE_PROJECTION_META.has(key)) kept[key] = value;
  return { ...rest, ...(Object.keys(kept).length ? { meta: kept } : {}), browserEvidenceProjection: true };
}

/** One thread-level status for the optional cache; null when every row is saved. */
export function browserStorageSummary(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const notCached = list.filter(message => message.browserStorage?.status === "not-cached");
  const volatile = list.filter(message => message.browserStorage?.status === "volatile");
  if (!notCached.length && !volatile.length) return null;
  const error = (notCached[0] ?? volatile[0]).browserStorage.error;
  const transientSaved = list.filter(message => !isDurableRow(message) && message.browserStorage?.status === "saved").length;
  const evidenceAtRisk = list.filter(message => hasBrowserOnlyEvidence(message) && message.browserStorage?.status !== "saved").length;
  const message = notCached.length
    ? `Optional browser cache unavailable (${error}): ${notCached.length} server-saved row${notCached.length === 1 ? "" : "s"} are not cached in this browser and reload from the server. `
      + `${transientSaved} browser-only item${transientSaved === 1 ? "" : "s"} (unsaved completions, legacy rows, partial output) ${transientSaved === 1 ? "is" : "are"} saved in this browser.`
    : `Browser storage failed (${error}) for ${volatile.length} row${volatile.length === 1 ? "" : "s"}; see the notices on those rows.`;
  return { error, notCached: notCached.length, volatile: volatile.length, transientSaved, evidenceAtRisk,
    message: evidenceAtRisk ? `${message} ${evidenceAtRisk} row${evidenceAtRisk === 1 ? "" : "s"} with browser-only evidence ${evidenceAtRisk === 1 ? "is" : "are"} not saved in this browser.` : message };
}

/** Browser write outcome is independent of the server journal's outcome. */
export function browserStorageNotice(message) {
  if (message.browserStorage?.status === "not-cached") {
    // A not-cached server row is recoverable from the server only for its server-owned fields.
    if (!hasBrowserOnlyEvidence(message)) return null;
    return `Optional browser copy of the server record was not saved (${message.browserStorage.error}). `
      + "Additional failure evidence for this row is only in this tab and may be lost on reload or close.";
  }
  if (message.browserStorage?.status !== "volatile") return null;
  const prefix = `Browser storage failed (${message.browserStorage.error}). `;
  const committed = message.meta?.persistence === "committed" || message.storage === "server";
  if (committed && message.meta?.browserFailureEvidence) {
    return prefix + "Server record is saved. Additional failure evidence is only in this tab and may be lost on reload or close.";
  }
  if (committed) {
    return prefix + "This result is saved on the server; only its optional browser copy could not be saved.";
  }
  if (isUnsavedCompletion(message)) {
    return prefix + "This completed result and its evidence exist only in this tab and may be lost on reload or close. They are not saved on the server. Do not replay completed work to repair storage.";
  }
  return prefix + "This tab's latest copy was not saved in browser storage and may be lost on reload or close. Server persistence is unconfirmed.";
}

function identityKeys(message) {
  return [
    message.turnId && `turn:${message.actor}:${message.turnId}`,
    message.id && `message:${message.actor}:${message.id}`,
    message.traceId && `trace:${message.actor}:${message.traceId}`,
  ].filter(Boolean);
}

export function isUnsavedCompletion(message) {
  return message.meta?.executionOutcome === "completed" && message.meta?.persistence !== "committed";
}

/** Both HTTP error responses and SSE terminals can carry a completed result. */
export function terminalMessagePatch(event, fallback = "", source = "response") {
  const completed = event.meta?.executionOutcome === "completed";
  const hasOutput = Object.hasOwn(event, "output");
  return {
    // A full response is owned by its receiving tab. A bounded watch projection
    // may report later native activity but cannot replace that response.
    terminalSource: source,
    content: completed && hasOutput
      ? (typeof event.output === "string" ? event.output : JSON.stringify(event.output ?? null))
      : event.type === "done" ? event.content ?? fallback : event.error ?? fallback,
    ...(completed && hasOutput ? { output: event.output } : {}),
    timestamp: event.timestamp || Date.now(),
    traceId: event.traceId, trace: event.trace, traceSnapshot: event.traceSnapshot,
    classification: event.classification, route: event.route, meta: event.meta,
    streaming: false, error: !completed && event.type !== "done",
    ...(completed && event.meta.persistence !== "committed" ? { storage: "browser-only" } : {}),
  };
}

/** Preserve unidentified legacy rows; repeated text is not proof of identity. */
export function mergeMessageHistory(local, server) {
  const cached = Array.isArray(local) ? local : [];
  const recorded = Array.isArray(server) ? server : [];
  const index = new Map();
  recorded.forEach((message, i) => { for (const key of identityKeys(message)) index.set(key, i); });
  const used = new Set();
  const merged = [];
  for (const message of cached) {
    const match = identityKeys(message).map(key => index.get(key)).find(i => i !== undefined);
    if (match !== undefined) {
      if (!used.has(match)) {
        const saved = recorded[match];
        if (isUnsavedCompletion(message) && saved.meta?.turnStatus === "interrupted") {
          // Keep the observed completion as browser evidence, alongside the
          // journal's unresolved record. Neither source silently overwrites the other.
          merged.push({ ...message, journalRecord: saved, storage: "browser-only", streaming: false,
            browserTraceId: message.browserTraceId ?? message.traceId,
            traceId: undefined, connectionStatus: undefined });
          used.add(match);
          continue;
        }
        if (message.terminalSource === "response") {
          // The index is a journal projection, not a replacement response. Keep
          // original input/trace/error even when those fields are absent from it.
          // Contradictory persistence/outcome stays beside the observed response.
          const differs = saved.content !== message.content
            || saved.meta?.turnStatus !== message.meta?.turnStatus
            || saved.meta?.persistence !== message.meta?.persistence;
          merged.push({ ...saved, ...message,
            id: saved.id ?? message.id, seq: saved.seq ?? message.seq,
            meta: { ...saved.meta, ...message.meta },
            traceId: message.traceId ?? saved.traceId,
            trace: message.trace ?? saved.trace,
            ...(differs ? { journalRecord: saved } : {}),
            streaming: false, connectionStatus: undefined,
            storage: message.meta?.persistence === "committed" ? "server" : "browser-only",
          });
          used.add(match);
          continue;
        }
        // An interrupted journal row cannot erase evidence that only reached
        // this browser. Keep that evidence explicitly separate from the record.
        let browserFailureEvidence;
        if (saved.meta?.turnStatus === "interrupted") {
          browserFailureEvidence = message.meta?.browserFailureEvidence
            ?? (message.meta?.persistence === "failed" ? message.meta : undefined);
          if (!browserFailureEvidence && (message.streaming || message.connectionStatus === "unconfirmed") && message.content) {
            browserFailureEvidence = { partialOutput: message.content, persistence: "browser-only", nativeOutcome: "unknown" };
          }
        }
        merged.push({ ...message, ...saved, streaming: false,
          // Journal fields have replaced the bounded preview. Retaining its watch
          // marker would let a later snapshot overwrite this recovered terminal.
          ...(message.terminalSource === "watch" ? { terminalSource: "journal" } : {}),
          traceId: saved.traceId, trace: saved.trace,
          meta: browserFailureEvidence ? { ...saved.meta, browserFailureEvidence } : saved.meta,
          error: saved.error ?? false, connectionStatus: undefined, storage: "server", browserStorage: undefined });
        used.add(match);
      }
    } else {
      merged.push({ ...message, storage: message.storage ?? "browser-only",
        ...(message.streaming ? { streaming: false, connectionStatus: "unconfirmed" } : {}) });
    }
  }
  recorded.forEach((message, i) => {
    if (!used.has(i)) merged.push({ ...message, streaming: false, error: message.error ?? false, storage: "server" });
  });
  // Keep the same request/response grouping as the live composer, even when
  // the journal records two overlapping turns finishing in reverse order.
  // Journal rows carry `seq`; two groups that both have one order by the journal, not by
  // wall-clock timestamps that tie inside a burst (an older page must sort before the cache).
  const groups = new Map();
  for (const message of merged) {
    const key = message.turnId ?? message;
    if (!groups.has(key)) groups.set(key, { at: message.timestamp ?? 0, order: groups.size, seq: undefined });
    const group = groups.get(key);
    if (message.actor === "user") group.at = message.timestamp ?? 0;
    if (Number.isFinite(message.seq) && (group.seq === undefined || message.seq < group.seq)) group.seq = message.seq;
  }
  return merged.sort((a, b) => {
    const first = groups.get(a.turnId ?? a);
    const second = groups.get(b.turnId ?? b);
    if (first !== second && first.seq !== undefined && second.seq !== undefined && first.seq !== second.seq) return first.seq - second.seq;
    return first.at - second.at || first.order - second.order
      || Number(a.actor !== "user") - Number(b.actor !== "user")
      || (a.timestamp ?? 0) - (b.timestamp ?? 0);
  });
}

/**
 * Which thread's durable state an owned WebSocket event may have changed.
 * Completed or failed work changes the message journal; learning decisions
 * change knowledge inspection. Context/token-level events change neither, so
 * they never trigger a history fetch.
 */
export function reconcileTargets(event) {
  const threadId = event?.threadId ?? (event?.kind === "session" ? event.event?.threadId : undefined);
  if (!threadId) return null;
  if (event.kind === "error" || event.kind === "journal") return { threadId, messages: true, knowledge: event.scope === "phase" || event.scope === "learning" };
  if (event.kind !== "signal") return null;
  const kind = event.signal?.kind;
  if (kind === "dispatch") return { threadId, messages: true, knowledge: false };
  if (kind === "domain_learning") return { threadId, messages: false, knowledge: true };
  return null;
}

/** Refresh only the selected original journal turn; inactive/foreign changes never select a turn. */
export function selectedDetailTarget(event, selected, activeThread) {
  if (!selected?.turnId || selected.threadId !== activeThread || event?.threadId !== selected.threadId) return null;
  const turnId = event.kind === "journal" ? event.turnId
    : event.kind === "signal" && event.signal?.kind === "domain_learning" ? event.signal.content?.evidence?.messageId : null;
  return turnId === selected.turnId ? { threadId: selected.threadId, turnId } : null;
}

function stableMessageKey(message) {
  // Ordered, identity-relevant fields only; browser storage status is a local
  // write outcome and does not make the durable history different.
  const { browserStorage, ...rest } = message;
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(rest));
}

/**
 * Bring a thread's in-tab cache up to date with its durable journal without
 * losing what only this tab knows. A stream still running in this tab keeps
 * its partial output until its own terminal arrives; completed-unsaved results
 * stay browser-only evidence; rows naming another thread are refused. Returns
 * the same array when nothing changed so the composer and scroll stay still.
 */
export function reconcileThreadMessages(cache, server, threadId) {
  const local = Array.isArray(cache) ? cache : [];
  const recorded = (Array.isArray(server) ? server : []).filter(message => !message?.threadId || message.threadId === threadId);
  if (recorded.length !== (Array.isArray(server) ? server.length : 0)) return local;
  const streaming = new Set(local.filter(message => message.actor === "agent" && message.streaming && message.turnId).map(message => message.turnId));
  const merged = mergeMessageHistory(local, recorded.filter(message => !(message.actor === "agent" && streaming.has(message.turnId))));
  const next = merged.map(message => {
    if (message.actor !== "agent" || !streaming.has(message.turnId)) return message;
    return local.find(candidate => candidate.actor === "agent" && candidate.turnId === message.turnId) ?? message;
  });
  if (next.length === local.length && next.every((message, i) => stableMessageKey(message) === stableMessageKey(local[i]))) return local;
  return next;
}

/** A closed transport is not evidence that the model completed its turn. */
export async function readMessageStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  function frame(text) {
    const data = text.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return;
    const event = JSON.parse(data);
    onEvent(event);
    terminal = event.type === "done" || event.type === "error";
  }
  try {
    while (!terminal) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const text of frames) {
        frame(text);
        if (terminal) break;
      }
      if (done && !terminal) {
        if (buffer.trim()) frame(buffer);
        if (!terminal) throw new Error("Response stream ended before completion; server outcome is unconfirmed");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
