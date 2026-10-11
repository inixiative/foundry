// Copied from the template's apps/api/src/ws/subscriptions.ts. The connection's
// own `streams` set and the byStream reverse-index are two halves of one fact;
// both mutate together so delivery and cleanup stay consistent.
import { deindexFrom, indexInto, type WSRegistry } from './registry';
import type { WSSocket } from './types';

// A re-open keeps the stream's seq, so no frame from before it can alias one after it.
export const subscribeToStream = (registry: WSRegistry, ws: WSSocket, stream: string): number => {
  const seq = ws.data.streams.get(stream) ?? 0;
  ws.data.streams.set(stream, seq);
  indexInto(registry.byStream, stream, ws.data.connectionId);
  return seq;
};

export const nextStreamSeq = (ws: WSSocket, stream: string): number => {
  const seq = (ws.data.streams.get(stream) ?? 0) + 1;
  ws.data.streams.set(stream, seq);
  return seq;
};

export const unsubscribeFromStream = (registry: WSRegistry, ws: WSSocket, stream: string): void => {
  if (!ws.data.streams.delete(stream)) return;
  if (deindexFrom(registry.byStream, stream, ws.data.connectionId)) registry.onStreamIdle(stream);
};
