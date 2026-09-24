import { terminalMessagePatch } from './conversation-state.js';

/** Local execution and native/RPC observations are independent. Legacy full
 * terminal rows predate terminalSource; a watch-only terminal is never promoted
 * to full response evidence just because its persistence label matches. */
function hasFullTerminal(message) {
  if (message.terminalSource === 'watch' || message.streaming) return false;
  return message.terminalSource === 'response'
    || ['completed', 'failed'].includes(message.meta?.executionOutcome)
    || ['completed', 'failed', 'interrupted'].includes(message.meta?.turnStatus);
}

export function liveExecutionStatus(message) {
  if (hasFullTerminal(message)) {
    if (message.meta?.executionOutcome === 'completed') return 'completed';
    if (message.error || ['failed', 'interrupted'].includes(message.meta?.turnStatus)) return 'failed';
    return 'completed';
  }
  return message.live?.status;
}

export function liveWorkLabel(message) {
  const status = liveExecutionStatus(message);
  const meta = hasFullTerminal(message) ? message.meta : message.live?.terminal?.meta;
  let label;
  if (message.connectionStatus === 'unconfirmed' && !hasFullTerminal(message)) label = 'Connection interrupted · outcome unconfirmed';
  else if (status === 'accepted') label = 'Accepted · preparing';
  else if (status === 'running') label = 'Running';
  else if (status === 'failed') label = meta?.nativeOutcome === 'failed'
    ? 'Failed' : `Local observation failed · native ${message.live?.native?.outcome ?? 'unconfirmed'}`;
  else label = 'Completed';
  return label + (meta?.persistence === 'failed' ? ' · persistence failed' : '');
}

export function liveThreadStatus(messages) {
  if (messages.some(m => ['accepted', 'running'].includes(liveExecutionStatus(m)))) return 'active';
  if (messages.some(m => m.connectionStatus === 'unconfirmed'
    || m.live?.native?.outcome === 'unknown' || m.live?.native?.rpc === 'pending')) return 'unconfirmed';
  return null;
}

/** Full owned snapshots, never concatenated with deltas. Cursor is scoped to a server epoch.
 * Request generations are checked by the caller before allowing an epoch change. */
export function acceptLiveSnapshot(previous, incoming, threadId, projectId) {
  if (!incoming || incoming.threadId !== threadId || incoming.projectId !== projectId
    || typeof incoming.epoch !== 'string' || !Number.isSafeInteger(incoming.cursor) || incoming.cursor < 0
    || !Array.isArray(incoming.buffers) || incoming.buffers.length > 256) return previous;
  const ids=new Set();
  for(const b of incoming.buffers) {
    if(!b || b.threadId!==threadId || b.projectId!==projectId || b.epoch!==incoming.epoch || typeof b.messageId!=='string'
      || ids.has(b.messageId) || !Number.isSafeInteger(b.revision) || b.revision<0 || b.revision>incoming.cursor
      || !['accepted','running','completed','failed'].includes(b.status) || !Array.isArray(b.activity) || b.activity.length>64
      || typeof b.content!=='string' || (b.terminal?.id&&b.terminal.id!==b.messageId)) return previous;
    ids.add(b.messageId);
  }
  if(previous?.epoch===incoming.epoch && incoming.cursor<previous.cursor)return previous;
  return incoming;
}
export function mergeLiveSnapshot(messages, snapshot) {
  if (!snapshot) return messages;
  const next = messages.slice(), seen = new Set();
  for (const b of snapshot.buffers) {
    seen.add(b.messageId);
    const i = next.findIndex(m => m.actor === 'agent' && m.turnId === b.messageId);
    const old = i < 0 ? {} : next[i];
    if (old.threadId && old.threadId !== b.threadId) continue;
    const done = b.status === 'completed' || b.status === 'failed';
    if (hasFullTerminal(old)) {
      // Preserve ALL full result fields and local terminal truth, including an
      // unsaved answer/error. Still attach the latest owned public/native view;
      // native terminal or pending RPC does not change local execution outcome.
      next[i] = { ...old, live: b };
      continue;
    }
    const terminal = done ? terminalMessagePatch({
      type: b.status === 'completed' ? 'done' : 'error',
      ...b.terminal, content: b.content, error: b.error,
    }, b.content, 'watch') : {};
    for (const key of Object.keys(terminal)) if (terminal[key] === undefined) delete terminal[key];
    const row = {
      ...old, ...terminal, actor: 'agent', threadId: b.threadId, turnId: b.messageId,
      timestamp: old.timestamp ?? b.startedAt,
      ...(!done ? { content: b.content, streaming: true, error: false } : {}),
      live: b, connectionStatus: done ? undefined : old.connectionStatus,
    };
    if (old.meta) row.meta = { ...old.meta, ...row.meta };
    if (done && b.terminal?.meta?.persistence === 'committed' && !old.meta?.browserFailureEvidence) row.storage = 'server';
    if (old.meta?.browserFailureEvidence) row.meta = { ...row.meta, browserFailureEvidence: old.meta.browserFailureEvidence };
    if (i < 0) next.push(row); else next[i] = row;
  }
  return next.map(m => m.live && !seen.has(m.turnId) && m.streaming
    ? { ...m, streaming: false, connectionStatus: 'unconfirmed' } : m);
}
