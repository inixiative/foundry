// Copied from the template's apps/api/src/ws/subscriptions.ts. The connection's
// own `streams` set and the byStream reverse-index are two halves of one fact;
// both mutate together so delivery and cleanup stay consistent.
import { deindexFrom, indexInto, type WSRegistry } from "./registry";
import type { WSSocket } from "./types";

export const subscribeToStream = (registry: WSRegistry, ws: WSSocket, stream: string): void => {
  ws.data.streams.add(stream);
  indexInto(registry.byStream, stream, ws.data.connectionId);
};

export const unsubscribeFromStream = (registry: WSRegistry, ws: WSSocket, stream: string): void => {
  if (!ws.data.streams.delete(stream)) return;
  if (deindexFrom(registry.byStream, stream, ws.data.connectionId)) registry.onStreamIdle(stream);
};
