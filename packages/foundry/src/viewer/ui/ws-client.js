// Port of the template's packages/shared/src/ws/createWebSocketClient.ts.
// Generic browser WebSocket client — transport only. Owns the socket lifecycle
// (connect, auto-reconnect) and forwards parsed inbound frames to a single
// onMessage callback. Knows nothing about the protocol. Callers send only while
// open; the data-stream layer replays its state on every open instead of queueing.

/** @returns {{ connect(): void, reconnect(): void, send(data: unknown): void, status(): "closed" | "connecting" | "open" }} */
export function createWebSocketClient({ url, onMessage, onOpen, onClose, reconnectDelayMs = 3000 }) {
  let ws = null;

  const connect = () => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(url);
    ws.onopen = () => onOpen?.();
    // Inbound from our own server — always valid JSON text.
    ws.onmessage = (e) => onMessage?.(JSON.parse(e.data));
    ws.onclose = () => {
      onClose?.();
      setTimeout(connect, reconnectDelayMs);
    };
  };

  // Drop the current socket but keep auto-reconnect — used to recover a half-open connection.
  // An already-closed socket can't fire onclose again, so connect directly.
  const reconnect = () => {
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
    else connect();
  };

  const send = (data) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  };

  const status = () => {
    if (ws?.readyState === WebSocket.OPEN) return "open";
    if (ws?.readyState === WebSocket.CONNECTING) return "connecting";
    return "closed";
  };

  return { connect, reconnect, send, status };
}
