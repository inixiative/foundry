// Copied from the template's apps/api/src/ws/delivery.ts (local delivery only).
//
// Snapshot the id set before iterating: a dead socket triggers removeConnection,
// which mutates the very set being delivered to. readyState guards stand in for
// try/catch — a closed socket is removed, not sent to.
import { removeConnection, type WSRegistry } from "./registry";
import type { WSOutbound, WSSocket } from "./types";

const deliver = (registry: WSRegistry, connectionIds: Set<string>, message: string): void => {
  for (const id of [...connectionIds]) {
    const ws = registry.byId.get(id);
    // Backstop: an id in a reverse-index but gone from byId is stale — drop it so a missed deindex can't leak.
    if (!ws) {
      connectionIds.delete(id);
      continue;
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
    else removeConnection(registry, ws);
  }
};

export const sendTo = (ws: WSSocket, event: WSOutbound): void => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
};

export const sendToStreamLocal = (registry: WSRegistry, stream: string, event: WSOutbound): void => {
  const ids = registry.byStream.get(stream);
  if (ids) deliver(registry, ids, JSON.stringify(event));
};
