// Copied from the template's apps/api/src/ws/delivery.ts (local delivery only).
//
// Snapshot the id set before iterating: a dead socket triggers removeConnection,
// which mutates the very set being delivered to. readyState guards stand in for
// try/catch — a closed socket is removed, not sent to.
import { removeConnection, type WSRegistry } from './registry';
import type { WSOutbound, WSSocket } from './types';

const FRAME_DROPPED = 1013;

/** Bun's send returns 0 for a frame it dropped (backpressure limit, closing socket). The client would
 *  silently fall behind, so the connection closes instead: it reconnects and re-opens for fresh snapshots.
 *  Returns false when the connection is gone. */
const sendFrame = (ws: WSSocket, message: string): boolean => {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (ws.send(message) !== 0) return true;
  ws.close(FRAME_DROPPED, 'frame dropped');
  return false;
};

export const sendTo = (ws: WSSocket, event: WSOutbound): void => {
  sendFrame(ws, JSON.stringify(event));
};

/** Delivers to every connection holding the stream; `frameFor` builds each connection's frame (its own seq). */
export const sendToStreamLocal = (
  registry: WSRegistry,
  stream: string,
  frameFor: (ws: WSSocket) => WSOutbound,
): void => {
  const ids = registry.byStream.get(stream);
  if (!ids) return;
  for (const id of [...ids]) {
    const ws = registry.byId.get(id);
    // Backstop: an id in a reverse-index but gone from byId is stale — drop it so a missed deindex can't leak.
    if (!ws) {
      ids.delete(id);
      continue;
    }
    if (!sendFrame(ws, JSON.stringify(frameFor(ws)))) removeConnection(registry, ws);
  }
};
