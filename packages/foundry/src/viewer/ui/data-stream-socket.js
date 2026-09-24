// Port of the template's packages/ui/src/lib/ws/createApiWebsocket.ts for the
// viewer's data streams. The connection is authorized at upgrade (loopback, or
// the tunnel session cookie), so there are no identity frames.
//
// The set of open streams, refcounted across callers, is the single source of
// truth: it is replayed on every (re)open because the server forgets a
// connection's streams when it drops. Each re-open answers with a fresh
// snapshot, which is the whole recovery story — no sequence numbers, no replay.
import { createWebSocketClient } from "./ws-client.js";

const HEARTBEAT_MS = 30_000;
const PONG_TIMEOUT_MS = 5_000;
const RECONNECT_ACK_TIMEOUT_MS = 5_000;
const OPEN_RETRY_MS = 1_000;

/**
 * @param {string} url
 * @param {{ onData: (frame: { category: "data", action: "snapshot" | "append", stream: string, payload: any, requestedAt?: number }) => void,
 *   onStatus?: (status: "open" | "closed") => void, onReconnect?: () => void, onRejected?: (stream: string) => void,
 *   reconnectDelayMs?: number }} handlers
 * A snapshot frame carries `requestedAt`: when the open it answers left this client.
 */
export function createDataStreamSocket(url, { onData, onStatus, onReconnect, onRejected, reconnectDelayMs }) {
  const streams = new Map();
  // Per stream, send times of opens not yet answered by a snapshot, oldest first (the server answers in order).
  const requested = new Map();
  // Streams whose open this connection has acknowledged, and callers waiting for that.
  const acked = new Set();
  const ackWaiters = new Map();
  let everOpened = false;
  let heartbeat;
  let pongTimer;
  // Replayed opens still awaiting ack after a reconnect; onReconnect waits for this to drain.
  let pendingAcks = null;
  let reconnectAckTimer;

  const sendOpen = (stream) => {
    if (socket.status() !== "open") return;
    requested.set(stream, [...(requested.get(stream) ?? []), Date.now()]);
    socket.send({ action: "open", stream });
  };

  const replayStreams = () => {
    for (const stream of streams.keys()) sendOpen(stream);
  };

  const finishReconnect = () => {
    if (!pendingAcks) return;
    pendingAcks = null;
    clearTimeout(reconnectAckTimer);
    onReconnect?.();
  };

  const settleReconnectAck = (stream) => {
    if (!pendingAcks) return;
    pendingAcks.delete(stream);
    if (pendingAcks.size === 0) finishReconnect();
  };

  const settleWaiters = (stream) => {
    for (const resolve of ackWaiters.get(stream) ?? []) resolve();
    ackWaiters.delete(stream);
  };

  const socket = createWebSocketClient({
    url,
    reconnectDelayMs,
    onMessage: (frame) => {
      switch (frame.type) {
        case "pong":
          return void clearTimeout(pongTimer);
        case "openRejected":
          console.warn(`data stream open rejected: ${frame.stream}`);
          streams.delete(frame.stream);
          requested.delete(frame.stream);
          settleWaiters(frame.stream);
          onRejected?.(frame.stream);
          return void settleReconnectAck(frame.stream);
        case "opened":
          acked.add(frame.stream);
          settleWaiters(frame.stream);
          return void settleReconnectAck(frame.stream);
        case "error":
          // The server dropped or failed this open: ask again while it is still wanted.
          if (frame.action === "open") setTimeout(() => { if (streams.has(frame.stream)) sendOpen(frame.stream); }, OPEN_RETRY_MS);
          return;
      }
      if (frame.category !== "data") return;
      if (frame.action === "snapshot") {
        const queue = requested.get(frame.stream) ?? [];
        frame.requestedAt = queue.shift() ?? 0;
        if (!queue.length) requested.delete(frame.stream);
      }
      // Frames for a stream this client no longer holds are in flight from before its close.
      if (streams.has(frame.stream)) onData(frame);
    },
    onOpen: () => {
      onStatus?.("open");
      replayStreams();
      const reconnecting = everOpened;
      everOpened = true;
      if (!reconnecting) return;
      if (streams.size === 0) return void onReconnect?.();
      clearTimeout(reconnectAckTimer);
      pendingAcks = new Set(streams.keys());
      reconnectAckTimer = setTimeout(finishReconnect, RECONNECT_ACK_TIMEOUT_MS);
    },
    // A pong pending from the previous connection must not tear down the next one.
    onClose: () => {
      clearTimeout(pongTimer);
      requested.clear();
      acked.clear();
      onStatus?.("closed");
    },
  });

  return {
    connect: () => {
      socket.connect();
      if (heartbeat) return;
      // Bidirectional heartbeat: ping, expect a pong within PONG_TIMEOUT_MS; otherwise the
      // connection is dead (half-open) — drop it and let auto-reconnect + replay recover.
      heartbeat = setInterval(() => {
        clearTimeout(pongTimer);
        if (socket.status() !== "open") return;
        socket.send({ action: "ping" });
        pongTimer = setTimeout(() => socket.reconnect(), PONG_TIMEOUT_MS);
      }, HEARTBEAT_MS);
    },
    open: (stream) => {
      const refs = streams.get(stream) ?? 0;
      streams.set(stream, refs + 1);
      if (refs === 0) sendOpen(stream);
    },
    close: (stream) => {
      const refs = streams.get(stream) ?? 0;
      if (refs === 0) return;
      if (refs > 1) return void streams.set(stream, refs - 1);
      streams.delete(stream);
      requested.delete(stream);
      acked.delete(stream);
      settleWaiters(stream);
      if (socket.status() === "open") socket.send({ action: "close", stream });
    },
    /** Resolves once the server has acknowledged the held stream on this connection, or after `timeoutMs`. */
    opened: (stream, timeoutMs) => acked.has(stream) || !streams.has(stream) ? Promise.resolve()
      : new Promise(resolve => {
        const timer = setTimeout(resolve, timeoutMs);
        ackWaiters.set(stream, [...(ackWaiters.get(stream) ?? []), () => { clearTimeout(timer); resolve(); }]);
      }),
    /** Re-open every held stream for fresh snapshots. */
    resync: replayStreams,
    holds: (stream) => streams.has(stream),
    status: () => socket.status(),
  };
}
