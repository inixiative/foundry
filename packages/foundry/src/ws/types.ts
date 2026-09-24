// Copied from the template's apps/api/src/ws/types.ts and adapted: no identity
// (the viewer authorizes the whole connection at upgrade), channels become data streams.
import type { ServerWebSocket } from "bun";
import type { SerializedQueue } from "./serialized-queue";

export type WSData = {
  connectionId: string; // unique per connection (multiple tabs = multiple ids)
  clientId: string | null; // the tab's own id, stable across its reconnects; addresses results to it
  streams: Set<string>; // data streams this connection has open
  lastPing: number; // staleness detection
  queue: SerializedQueue; // serializes this connection's async message handling
};

// Inbound: client → server, one per frame.
export type WSMessage =
  | { action: "open"; stream: string }
  | { action: "close"; stream: string }
  | { action: "ping" };

export type WSSocket = ServerWebSocket<WSData>;

// Outbound frames are opaque to the transport; the data-stream layer shapes them.
export type WSOutbound = Record<string, unknown>;

/** One data stream's server-side producer while at least one connection has it open. */
export type StreamSource = {
  /** Current state, sent only to the connection that just opened the stream. */
  snapshot: () => unknown;
  /** Called when the last connection closes the stream. */
  stop: () => void;
};

/** A family of stream names (`thread:<id>`, `prompts`, …) and how to produce them. */
export type StreamFamily = {
  matches: (stream: string) => boolean;
  /** False rejects the open. Runs before any state is created. */
  authorize: (stream: string) => boolean | Promise<boolean>;
  /** Begin producing; `append` delivers to every connection that has the stream open. */
  start: (stream: string, append: (payload: unknown) => void) => StreamSource;
};
