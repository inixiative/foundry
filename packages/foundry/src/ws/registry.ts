// Copied from the template's apps/api/src/ws/registry.ts. Foundry runs several
// viewers in one process (tests), so the maps live on an instance instead of the
// module. Siblings attach meaning: subscriptions.ts (byStream), delivery.ts
// (sends), lifecycle.ts (sweeps). No cross-instance fan-out: one viewer, one process.
import type { WSSocket } from "./types";

export type WSRegistry = {
  byId: Map<string, WSSocket>;
  byStream: Map<string, Set<string>>;
  /** A stream's last connection is gone; its producer should stop. */
  onStreamIdle: (stream: string) => void;
};

export const createRegistry = (onStreamIdle: (stream: string) => void = () => {}): WSRegistry => ({
  byId: new Map(),
  byStream: new Map(),
  onStreamIdle,
});

export const indexInto = (map: Map<string, Set<string>>, key: string, connectionId: string): void => {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(connectionId);
};

/** Returns true when the key lost its last connection. */
export const deindexFrom = (map: Map<string, Set<string>>, key: string, connectionId: string): boolean => {
  const set = map.get(key);
  if (!set) return false;
  set.delete(connectionId);
  if (set.size > 0) return false;
  map.delete(key);
  return true;
};

export const addConnection = (registry: WSRegistry, ws: WSSocket): void => {
  registry.byId.set(ws.data.connectionId, ws);
};

// Removes the connection and cleans every index it appears in. Streams left
// with no connection are reported idle so their producers stop.
export const removeConnection = (registry: WSRegistry, ws: WSSocket): void => {
  const { connectionId, streams } = ws.data;
  registry.byId.delete(connectionId);
  for (const stream of [...streams]) {
    streams.delete(stream);
    if (deindexFrom(registry.byStream, stream, connectionId)) registry.onStreamIdle(stream);
  }
};

// Clears all registry state; every open stream becomes idle.
export const clearRegistry = (registry: WSRegistry): void => {
  const streams = [...registry.byStream.keys()];
  for (const ws of registry.byId.values()) ws.data.streams.clear();
  registry.byId.clear();
  registry.byStream.clear();
  for (const stream of streams) registry.onStreamIdle(stream);
};
