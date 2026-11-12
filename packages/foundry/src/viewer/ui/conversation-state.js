/**
 * @atlas
 * @kind component
 * @partOf feature:threads, feature:viewer
 */
/** Patch one response, never whichever response happened to be appended last. */
export function updateTurnMessage(messages, turnId, patch) {
  const index = messages.findIndex(
    (message) => message.actor === 'agent' && message.turnId === turnId,
  );
  if (index === -1) return messages;
  const next = [...messages];
  next[index] = { ...next[index], ...patch };
  return next;
}

function identityKeys(message) {
  return [
    message.turnId && `turn:${message.actor}:${message.turnId}`,
    message.id && `message:${message.actor}:${message.id}`,
    message.traceId && `trace:${message.actor}:${message.traceId}`,
  ].filter(Boolean);
}

export function isUnsavedCompletion(message) {
  return (
    message.meta?.executionOutcome === 'completed' && message.meta?.persistence !== 'committed'
  );
}

/** Both HTTP error responses and SSE terminals can carry a completed result. */
export function terminalMessagePatch(event, fallback = '', source = 'response') {
  const completed = event.meta?.executionOutcome === 'completed';
  const hasOutput = Object.hasOwn(event, 'output');
  return {
    // A full response is owned by its receiving tab. A bounded watch projection
    // may report later native activity but cannot replace that response.
    terminalSource: source,
    content:
      completed && hasOutput
        ? typeof event.output === 'string'
          ? event.output
          : JSON.stringify(event.output ?? null)
        : event.type === 'done'
          ? (event.content ?? fallback)
          : (event.error ?? fallback),
    ...(completed && hasOutput ? { output: event.output } : {}),
    timestamp: event.timestamp || Date.now(),
    traceId: event.traceId,
    trace: event.trace,
    traceSnapshot: event.traceSnapshot,
    classification: event.classification,
    route: event.route,
    meta: event.meta,
    streaming: false,
    error: !completed && event.type !== 'done',
    ...(completed && event.meta.persistence !== 'committed' ? { storage: 'browser-only' } : {}),
  };
}

/** Preserve unidentified legacy rows; repeated text is not proof of identity. */
export function mergeMessageHistory(local, server) {
  const cached = Array.isArray(local) ? local : [];
  const recorded = Array.isArray(server) ? server : [];
  const index = new Map();
  recorded.forEach((message, i) => {
    for (const key of identityKeys(message)) index.set(key, i);
  });
  const used = new Set();
  const merged = [];
  for (const message of cached) {
    const match = identityKeys(message)
      .map((key) => index.get(key))
      .find((i) => i !== undefined);
    if (match !== undefined) {
      if (!used.has(match)) {
        const saved = recorded[match];
        if (isUnsavedCompletion(message) && saved.meta?.turnStatus === 'interrupted') {
          // Keep the observed completion as browser evidence, alongside the
          // journal's unresolved record. Neither source silently overwrites the other.
          merged.push({
            ...message,
            journalRecord: saved,
            storage: 'browser-only',
            streaming: false,
            browserTraceId: message.browserTraceId ?? message.traceId,
            traceId: undefined,
            connectionStatus: undefined,
          });
          used.add(match);
          continue;
        }
        if (message.terminalSource === 'response') {
          // The index is a journal projection, not a replacement response. Keep
          // original input/trace/error even when those fields are absent from it.
          // Contradictory persistence/outcome stays beside the observed response.
          const differs =
            saved.content !== message.content ||
            saved.meta?.turnStatus !== message.meta?.turnStatus ||
            saved.meta?.persistence !== message.meta?.persistence;
          merged.push({
            ...saved,
            ...message,
            id: saved.id ?? message.id,
            seq: saved.seq ?? message.seq,
            meta: { ...saved.meta, ...message.meta },
            traceId: message.traceId ?? saved.traceId,
            trace: message.trace ?? saved.trace,
            // The turn's chorus health is the journal's alone: a retry or dismissal changes it later.
            chorus: saved.chorus,
            ...(differs ? { journalRecord: saved } : {}),
            streaming: false,
            connectionStatus: undefined,
            storage: message.meta?.persistence === 'committed' ? 'server' : 'browser-only',
          });
          used.add(match);
          continue;
        }
        // An interrupted journal row cannot erase evidence that only reached
        // this browser. Keep that evidence explicitly separate from the record.
        let browserFailureEvidence;
        if (saved.meta?.turnStatus === 'interrupted') {
          browserFailureEvidence =
            message.meta?.browserFailureEvidence ??
            (message.meta?.persistence === 'failed' ? message.meta : undefined);
          if (
            !browserFailureEvidence &&
            (message.streaming || message.connectionStatus === 'unconfirmed') &&
            message.content
          ) {
            browserFailureEvidence = {
              partialOutput: message.content,
              persistence: 'browser-only',
              nativeOutcome: 'unknown',
            };
          }
        }
        merged.push({
          ...message,
          ...saved,
          streaming: false,
          // Journal fields have replaced the bounded preview. Retaining its watch
          // marker would let a later snapshot overwrite this recovered terminal.
          ...(message.terminalSource === 'watch' ? { terminalSource: 'journal' } : {}),
          traceId: saved.traceId,
          trace: saved.trace,
          chorus: saved.chorus,
          meta: browserFailureEvidence ? { ...saved.meta, browserFailureEvidence } : saved.meta,
          error: saved.error ?? false,
          connectionStatus: undefined,
          storage: 'server',
        });
        used.add(match);
      }
    } else {
      merged.push({
        ...message,
        storage: message.storage ?? 'browser-only',
        ...(message.streaming ? { streaming: false, connectionStatus: 'unconfirmed' } : {}),
      });
    }
  }
  recorded.forEach((message, i) => {
    if (!used.has(i))
      merged.push({
        ...message,
        streaming: false,
        error: message.error ?? false,
        storage: 'server',
      });
  });
  return orderHistory(merged);
}

function orderHistory(merged) {
  // Keep the same request/response grouping as the live composer, even when
  // the journal records two overlapping turns finishing in reverse order.
  // Journal rows carry `seq`; two groups that both have one order by the journal, not by
  // wall-clock timestamps that tie inside a burst (an older page must sort before the cache).
  const groups = new Map();
  for (const message of merged) {
    const key = message.turnId ?? message;
    if (!groups.has(key))
      groups.set(key, { at: message.timestamp ?? 0, order: groups.size, seq: undefined });
    const group = groups.get(key);
    if (message.actor === 'user') group.at = message.timestamp ?? 0;
    if (Number.isFinite(message.seq) && (group.seq === undefined || message.seq < group.seq))
      group.seq = message.seq;
  }
  return merged.sort((a, b) => {
    const first = groups.get(a.turnId ?? a);
    const second = groups.get(b.turnId ?? b);
    if (
      first !== second &&
      first.seq !== undefined &&
      second.seq !== undefined &&
      first.seq !== second.seq
    )
      return first.seq - second.seq;
    return (
      first.at - second.at ||
      first.order - second.order ||
      Number(a.actor !== 'user') - Number(b.actor !== 'user') ||
      (a.timestamp ?? 0) - (b.timestamp ?? 0)
    );
  });
}

/**
 * Which thread's durable state an owned event (from its thread data stream) may have changed.
 * Completed or failed work changes the message journal; learning decisions
 * change knowledge inspection. Context/token-level events change neither, so
 * they never trigger a history fetch.
 */
export function reconcileTargets(event) {
  const threadId =
    event?.threadId ?? (event?.kind === 'session' ? event.event?.threadId : undefined);
  if (!threadId) return null;
  if (event.kind === 'error' || event.kind === 'journal')
    return {
      threadId,
      messages: true,
      knowledge: event.scope === 'phase' || event.scope === 'learning',
    };
  if (event.kind !== 'signal') return null;
  const kind = event.signal?.kind;
  if (kind === 'dispatch') return { threadId, messages: true, knowledge: false };
  if (kind === 'domain_learning') return { threadId, messages: false, knowledge: true };
  return null;
}

/** Refresh only the selected original journal turn; inactive/foreign changes never select a turn. */
export function selectedDetailTarget(event, selected, activeThread) {
  if (
    !selected?.turnId ||
    selected.threadId !== activeThread ||
    event?.threadId !== selected.threadId
  )
    return null;
  const turnId =
    event.kind === 'journal'
      ? event.turnId
      : event.kind === 'signal' && event.signal?.kind === 'domain_learning'
        ? event.signal.content?.evidence?.messageId
        : null;
  return turnId === selected.turnId ? { threadId: selected.threadId, turnId } : null;
}

function stableMessageKey(message) {
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  return JSON.stringify(canonical(message));
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
  const recorded = (Array.isArray(server) ? server : []).filter(
    (message) => !message?.threadId || message.threadId === threadId,
  );
  if (recorded.length !== (Array.isArray(server) ? server.length : 0)) return local;
  const streaming = new Set(
    local
      .filter((message) => message.actor === 'agent' && message.streaming && message.turnId)
      .map((message) => message.turnId),
  );
  const merged = mergeMessageHistory(
    local,
    recorded.filter((message) => !(message.actor === 'agent' && streaming.has(message.turnId))),
  );
  const next = merged.map((message) => {
    if (message.actor !== 'agent' || !streaming.has(message.turnId)) return message;
    return (
      local.find(
        (candidate) => candidate.actor === 'agent' && candidate.turnId === message.turnId,
      ) ?? message
    );
  });
  if (
    next.length === local.length &&
    next.every((message, i) => stableMessageKey(message) === stableMessageKey(local[i]))
  )
    return local;
  return next;
}
