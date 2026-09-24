// Copied from the template's apps/api/src/ws/handler.ts and adapted: the viewer
// authorizes the connection before upgrade (request-auth), so there is no
// authenticate/logout frame; subscribe/unsubscribe become data-stream open/close.
import type { Server } from "bun";
import { log } from "../logger";
import { cleanupStaleConnections, drainConnections, updateLastPing } from "./lifecycle";
import { addConnection, createRegistry, removeConnection, type WSRegistry } from "./registry";
import { sendTo } from "./delivery";
import { createSerializedQueue } from "./serialized-queue";
import { createDataStreams, type DataStreams } from "./streams";
import type { StreamFamily, WSData, WSMessage, WSSocket } from "./types";
import { makeUnrefInterval } from "./unref-interval";

// Backpressure: a socket flooding frames grows the per-connection queue without bound (each
// dispatch awaits authorization). Cap pending dispatches and overall frame rate; abusers are closed.
const MAX_PENDING_FRAMES = 32;
const FRAME_LIMIT = 300;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const FRAME_WINDOW_MS = 10_000;

export type WebSocketServer = {
  registry: WSRegistry;
  streams: DataStreams;
  /** Promote an already-authorized HTTP request. */
  accept: (req: Request, server: Server<WSData>) => Response | undefined;
  websocket: {
    open: (ws: WSSocket) => void;
    message: (ws: WSSocket, raw: string | Buffer) => Promise<void> | undefined;
    close: (ws: WSSocket) => void;
  };
  startStaleSweep: () => void;
  /** Tell clients to reconnect, close every socket and stop every producer. */
  shutdown: () => void;
};

// Parse an untrusted client frame. Malformed JSON or shape → null (dropped).
const parseFrame = (raw: string | Buffer): WSMessage | null => {
  try {
    const frame = JSON.parse(raw.toString()) as Partial<WSMessage> | null;
    if (!frame || typeof frame !== "object") return null;
    if (frame.action === "ping") return { action: "ping" };
    if ((frame.action === "open" || frame.action === "close") && typeof (frame as { stream?: unknown }).stream === "string")
      return frame as WSMessage;
    return null;
  } catch {
    return null;
  }
};

export const createWebSocketServer = ({ families, admit }: {
  families: StreamFamily[];
  /** Per-open authorization beyond the upgrade (e.g. Kingdom runtime check). False closes nothing by
   *  itself: an admit that means "this connection lost authorization" closes the socket before returning. */
  admit?: () => Promise<boolean>;
}): WebSocketServer => {
  let streams: DataStreams | null = null;
  const registry = createRegistry(stream => streams?.idle(stream));
  const dataStreams = createDataStreams(registry, families, admit);
  streams = dataStreams;
  const frameWindows = new WeakMap<WSSocket, { start: number; count: number }>();

  const overFrameLimit = (ws: WSSocket): boolean => {
    const now = Date.now();
    const window = frameWindows.get(ws);
    if (!window || now - window.start > FRAME_WINDOW_MS) {
      frameWindows.set(ws, { start: now, count: 1 });
      return false;
    }
    window.count++;
    return window.count > FRAME_LIMIT;
  };

  const dispatch = async (ws: WSSocket, msg: WSMessage): Promise<void> => {
    switch (msg.action) {
      case "open": return dataStreams.open(ws, msg.stream);
      case "close": return dataStreams.close(ws, msg.stream);
      case "ping":
        updateLastPing(ws);
        sendTo(ws, { type: "pong" });
        return;
    }
  };

  // Periodic stale-connection sweep, started explicitly (not a construction side effect).
  const staleSweep = makeUnrefInterval({
    intervalMs: 60_000,
    tick: () => {
      const cleaned = cleanupStaleConnections(registry);
      if (cleaned > 0) log.info(`[Viewer] cleaned up ${cleaned} stale WebSocket connections`);
    },
  });

  return {
    registry,
    streams: dataStreams,
    accept: (req, server) => {
      const clientId = new URL(req.url).searchParams.get("client");
      const data: WSData = { connectionId: crypto.randomUUID(), clientId: clientId && CLIENT_ID.test(clientId) ? clientId : null,
        streams: new Set(), lastPing: Date.now(), queue: createSerializedQueue() };
      return server.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 426 });
    },
    websocket: {
      open(ws) {
        addConnection(registry, ws);
        sendTo(ws, { type: "connected", connectionId: ws.data.connectionId });
      },
      close(ws) {
        removeConnection(registry, ws);
      },
      // Returns the dispatch promise (Bun ignores it; tests await it). The per-connection
      // queue keeps async opens in order; the catch keeps a failed dispatch scoped to its connection.
      message(ws, raw) {
        if (overFrameLimit(ws)) {
          ws.close(1008, "rate limit exceeded");
          return;
        }
        const msg = parseFrame(raw);
        if (!msg) return;
        // Dropped under backpressure: say so, so the client can retry an open instead of waiting forever.
        if (ws.data.queue.size() >= MAX_PENDING_FRAMES) {
          sendTo(ws, { type: "error", action: msg.action, ...(msg.action === "ping" ? {} : { stream: msg.stream }) });
          return;
        }
        return ws.data.queue.run(() => dispatch(ws, msg)).catch(err => {
          log.error(`[Viewer] ws dispatch failed (${msg.action}): ${err instanceof Error ? err.message : String(err)}`);
          sendTo(ws, { type: "error", action: msg.action, ...(msg.action === "ping" ? {} : { stream: msg.stream }) });
        });
      },
    },
    startStaleSweep: staleSweep.start,
    shutdown: () => {
      staleSweep.stop();
      drainConnections(registry);
      dataStreams.stopAll();
    },
  };
};
