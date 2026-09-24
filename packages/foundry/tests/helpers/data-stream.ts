import { createSerializedQueue } from "../../src/ws/serialized-queue";
import type { WSData, WSSocket } from "../../src/ws/types";
import type { createViewer } from "../../src/viewer/server";
import type { RuntimeRoutesDeps } from "../../src/viewer/routes/runtime";
import { createViewerStreams } from "../../src/viewer/data-streams";
import { ViewerThreadDirectory } from "../../src/viewer/thread-directory";
import { createWebSocketServer, type WebSocketServer } from "../../src/ws/handler";

// A real recorder shaped like a ServerWebSocket (copied from the template's
// apps/api/tests/createTestSocket.ts). Bun sockets can't exist without a live
// server; real-socket behavior is covered by the upgrade tests.
const WS_OPEN = 1;
const WS_CLOSED = 3;
let seq = 0;

export function createTestSocket(data?: Partial<WSData>) {
  const sent: string[] = [];
  let readyState = WS_OPEN;
  let closeInfo: { code: number; reason: string } | null = null;
  const socket = {
    data: {
      connectionId: data?.connectionId ?? `conn-${++seq}`,
      clientId: data?.clientId === undefined ? `client-${seq}-${crypto.randomUUID().slice(0, 8)}` : data.clientId,
      streams: data?.streams ?? new Set<string>(),
      lastPing: data?.lastPing ?? Date.now(),
      queue: data?.queue ?? createSerializedQueue(),
    } satisfies WSData,
    get readyState() { return readyState; },
    send(message: string) { sent.push(message); },
    close(code: number, reason: string) { readyState = WS_CLOSED; closeInfo = { code, reason }; },
  } as unknown as WSSocket;
  return { socket, sent, markClosed: () => { readyState = WS_CLOSED; }, closeInfo: () => closeInfo };
}

type Handler = Pick<ReturnType<typeof createViewer>, "websocket">;

/** One in-process connection to a viewer's data-stream socket. */
export function connectStreams(viewer: Handler, clientId?: string | null) {
  const handle = createTestSocket({ clientId });
  viewer.websocket.open(handle.socket);
  const frames = () => handle.sent.map(text => JSON.parse(text));
  const data = (stream: string) => frames().filter(frame => frame.category === "data" && frame.stream === stream);
  /** Resolve with the first frame matching `match`, including one already received. */
  const next = async (match: (frame: any) => boolean, label = "data-stream frame", timeoutMs = 8000) => {
    const end = performance.now() + timeoutMs;
    for (;;) {
      const found = frames().find(match);
      if (found) return found;
      if (performance.now() > end) throw new Error(`Timed out waiting for ${label}`);
      await Bun.sleep(5);
    }
  };
  return {
    ...handle,
    frames,
    data,
    open: (stream: string) => viewer.websocket.message(handle.socket, JSON.stringify({ action: "open", stream })),
    close: (stream: string) => viewer.websocket.message(handle.socket, JSON.stringify({ action: "close", stream })),
    disconnect: () => { handle.markClosed(); viewer.websocket.close(handle.socket); },
    next,
    /** The turn's terminal on `thread:<threadId>`, shaped like the former SSE terminal event. */
    async terminal(threadId: string, turnId: string) {
      const frame = await next(f => f.category === "data" && f.stream === `thread:${threadId}` && f.action === "append"
        && (f.payload.kind === "done" || f.payload.kind === "error") && f.payload.turnId === turnId, `terminal for ${turnId}`);
      return { type: frame.payload.kind, ...frame.payload.result };
    },
    deltas: (threadId: string, turnId: string) => data(`thread:${threadId}`)
      .filter(f => f.action === "append" && f.payload.kind === "delta" && f.payload.turnId === turnId).map(f => f.payload.text as string),
  };
}

/** POST the send route as a connection holding `thread:<threadId>`; the body is its streamed terminal, or the refusal JSON. */
export async function postStreamedTurn(viewer: Pick<ReturnType<typeof createViewer>, "websocket" | "app">,
  turn: { id: string; threadId: string; message: string }) {
  const client = connectStreams(viewer);
  await client.open(`thread:${turn.threadId}`);
  try {
    const response = await viewer.app.request("/api/messages/send", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...turn, clientId:client.socket.data.clientId }) });
    if (response.status !== 202) return { status: response.status, body: await response.json() as any };
    return { status: response.status, body: await client.terminal(turn.threadId, turn.id) as any };
  } finally { client.disconnect(); }
}

/** Runtime route deps with the viewer's data streams and socket, for tests that mount the routes directly. */
export function withStreams<T extends Omit<RuntimeRoutesDeps, "streams">>(deps: T) {
  const directory = deps.directory ?? new ViewerThreadDirectory(deps.harness.thread, deps.projectRegistry, deps.threadFactory);
  let socket: WebSocketServer | undefined;
  const streams = createViewerStreams({ directory, eventStream: deps.eventStream,
    deliverTo: (clientId, stream, payload) => socket!.streams.appendTo(clientId, stream, payload) });
  socket = createWebSocketServer({ families: streams.families });
  return { ...deps, directory, streams, socket, websocket: socket.websocket };
}
