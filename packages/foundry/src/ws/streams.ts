// Data streams: open a stream, get its data, close it.
//
//   client → { action: 'open', stream }        authorize, then
//   server → { type: 'opened', stream }
//   server → { category: 'data', action: 'snapshot', stream, payload }
//   server → { category: 'data', action: 'append', stream, payload } …
//   client → { action: 'close', stream }  →  { type: 'closed', stream }
//   socket close = every stream on it closed
//
// No sequence numbers and no replay: a reconnecting client re-opens its streams
// and gets a fresh snapshot. A stream's producer runs only while some connection
// has it open. Re-opening a stream already open on a connection re-sends its snapshot.
// An append goes to every connection holding the stream; appendTo addresses one
// client's connections (a result meant only for the tab that requested it).
import { sendTo, sendToStreamLocal } from "./delivery";
import type { WSRegistry } from "./registry";
import { subscribeToStream, unsubscribeFromStream } from "./subscriptions";
import type { StreamFamily, StreamSource, WSSocket } from "./types";

const MAX_STREAM_NAME = 256;

export type DataStreams = {
  open: (ws: WSSocket, stream: string) => Promise<void>;
  close: (ws: WSSocket, stream: string) => void;
  /** Registry callback: the stream lost its last connection. */
  idle: (stream: string) => void;
  /** Whether any connection has the stream open. */
  isOpen: (stream: string) => boolean;
  /** Append only to the connections of one client (a tab, across its reconnects) that have the stream open. */
  appendTo: (clientId: string, stream: string, payload: unknown) => void;
  stopAll: () => void;
};

export const createDataStreams = (registry: WSRegistry, families: StreamFamily[],
  admit: () => Promise<boolean> = async () => true): DataStreams => {
  const sources = new Map<string, StreamSource>();
  const familyFor = (stream: unknown) => typeof stream === "string" && stream.length > 0 && stream.length <= MAX_STREAM_NAME
    ? families.find(family => family.matches(stream)) : undefined;
  const appendTo = (stream: string) => (payload: unknown) =>
    sendToStreamLocal(registry, stream, { category: "data", action: "append", stream, payload });

  const stop = (stream: string) => {
    const source = sources.get(stream);
    if (!source) return;
    sources.delete(stream);
    source.stop();
  };

  return {
    async open(ws, stream) {
      const family = familyFor(stream);
      const granted = !!family && await admit() && await family.authorize(stream);
      // The socket may have closed while authorization was pending.
      if (!registry.byId.has(ws.data.connectionId)) return;
      if (!family || !granted) {
        unsubscribeFromStream(registry, ws, stream);
        sendTo(ws, { type: "openRejected", stream });
        return;
      }
      let source = sources.get(stream);
      if (!source) {
        source = family.start(stream, appendTo(stream));
        sources.set(stream, source);
      }
      let payload: unknown;
      try { payload = source.snapshot(); }
      catch (error) {
        if (!registry.byStream.has(stream)) stop(stream);
        throw error;
      }
      // Snapshot and subscription happen in one synchronous step: every later append follows the snapshot.
      subscribeToStream(registry, ws, stream);
      sendTo(ws, { type: "opened", stream });
      sendTo(ws, { category: "data", action: "snapshot", stream, payload });
    },
    close(ws, stream) {
      unsubscribeFromStream(registry, ws, stream);
      sendTo(ws, { type: "closed", stream });
    },
    idle: stop,
    isOpen: stream => registry.byStream.has(stream),
    appendTo(clientId, stream, payload) {
      for (const id of registry.byStream.get(stream) ?? []) {
        const ws = registry.byId.get(id);
        if (ws?.data.clientId === clientId) sendTo(ws, { category: "data", action: "append", stream, payload });
      }
    },
    stopAll() {
      for (const stream of [...sources.keys()]) stop(stream);
    },
  };
};
