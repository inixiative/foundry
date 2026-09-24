// Copied from the template's apps/api/src/ws/lifecycle.ts.
import { clearRegistry, removeConnection, type WSRegistry } from "./registry";
import type { WSSocket } from "./types";

const STALE_TIMEOUT_MS = 5 * 60 * 1000;

export const updateLastPing = (ws: WSSocket): void => {
  ws.data.lastPing = Date.now();
};

// Closes + removes connections that haven't pinged within the window. Snapshots
// the values first (removeConnection mutates byId).
export const cleanupStaleConnections = (registry: WSRegistry): number => {
  const now = Date.now();
  let cleaned = 0;
  for (const ws of [...registry.byId.values()]) {
    if (now - ws.data.lastPing > STALE_TIMEOUT_MS) {
      if (ws.readyState === WebSocket.OPEN) ws.close(1001, "Connection stale");
      removeConnection(registry, ws);
      cleaned++;
    }
  }
  return cleaned;
};

/** Close every connection with one code/reason (authorization lost, shutdown). */
export const closeAllConnections = (registry: WSRegistry, code: number, reason: string): void => {
  for (const ws of [...registry.byId.values()]) {
    if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
    removeConnection(registry, ws);
  }
};

export const getConnectionStats = (registry: WSRegistry): { connections: number; streams: number } => ({
  connections: registry.byId.size,
  streams: registry.byStream.size,
});

// Graceful shutdown: tell clients to reconnect, close sockets, clear the registry.
export const drainConnections = (registry: WSRegistry): void => {
  const message = JSON.stringify({ type: "reconnect", reason: "server_shutdown" });
  for (const ws of [...registry.byId.values()]) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      ws.close(1001, "Server shutting down");
    }
  }
  clearRegistry(registry);
};
