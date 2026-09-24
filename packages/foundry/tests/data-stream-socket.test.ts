import { afterEach, beforeEach, expect, test } from "bun:test";
// @ts-expect-error native browser module
import { createDataStreamSocket } from "../src/viewer/ui/data-stream-socket.js";

// Adapted from the template's packages/ui/src/lib/ws/createApiWebsocket.test.ts.
let instances: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) { instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
}

const open = (ws: FakeWebSocket) => { ws.readyState = FakeWebSocket.OPEN; ws.onopen?.(); };
const receive = (ws: FakeWebSocket, frame: unknown) => ws.onmessage?.({ data: JSON.stringify(frame) });
const sends = (ws: FakeWebSocket) => ws.sent.map(s => JSON.parse(s));

const original = globalThis.WebSocket;
beforeEach(() => { instances = []; (globalThis as any).WebSocket = FakeWebSocket; });
afterEach(() => { (globalThis as any).WebSocket = original; });

function socket(handlers: Record<string, unknown> = {}) {
  const data: any[] = [];
  const statuses: string[] = [];
  const api = createDataStreamSocket("ws://viewer/ws", { onData: (frame: unknown) => data.push(frame),
    onStatus: (status: string) => statuses.push(status), reconnectDelayMs: 0, ...handlers });
  api.connect();
  return { api, data, statuses, ws: () => instances.at(-1)! };
}

test("opens are refcounted, sent once, and closed only when the last holder releases", () => {
  const { api, ws } = socket();
  open(ws());
  api.open("thread:a"); api.open("thread:a");
  expect(sends(ws())).toEqual([{ action: "open", stream: "thread:a" }]);
  api.close("thread:a");
  expect(sends(ws())).toHaveLength(1);
  api.close("thread:a");
  expect(sends(ws()).at(-1)).toEqual({ action: "close", stream: "thread:a" });
  expect(api.holds("thread:a")).toBe(false);
});

test("streams held before the socket opens are opened on open, once", () => {
  const { api, ws } = socket();
  api.open("prompts"); api.open("threads");
  expect(ws().sent).toEqual([]);
  open(ws());
  expect(sends(ws())).toEqual([{ action: "open", stream: "prompts" }, { action: "open", stream: "threads" }]);
});

test("a reconnect replays every held stream and reports reconnect after their acks", async () => {
  let reconnected = 0;
  const { api, ws, statuses } = socket({ onReconnect: () => reconnected++ });
  const first = ws();
  open(first);
  api.open("thread:a"); api.open("events:a");
  first.close();
  expect(statuses).toEqual(["open", "closed"]);
  await Bun.sleep(5);
  const second = ws();
  expect(second).not.toBe(first);
  open(second);
  expect(sends(second)).toEqual([{ action: "open", stream: "thread:a" }, { action: "open", stream: "events:a" }]);
  receive(second, { type: "opened", stream: "thread:a" });
  expect(reconnected).toBe(0);
  receive(second, { type: "opened", stream: "events:a" });
  expect(reconnected).toBe(1);
});

test("a rejected stream is dropped and not replayed; frames for unheld streams are ignored", async () => {
  const rejected: string[] = [];
  const { api, ws, data } = socket({ onRejected: (stream: string) => rejected.push(stream) });
  open(ws());
  api.open("thread:gone"); api.open("thread:a");
  receive(ws(), { type: "openRejected", stream: "thread:gone" });
  expect(rejected).toEqual(["thread:gone"]);
  receive(ws(), { category: "data", action: "snapshot", stream: "thread:a", payload: { turns: [] } });
  receive(ws(), { category: "data", action: "append", stream: "thread:gone", payload: {} });
  api.close("thread:a");
  receive(ws(), { category: "data", action: "append", stream: "thread:a", payload: { kind: "delta" } });
  expect(data).toEqual([{ category: "data", action: "snapshot", stream: "thread:a", payload: { turns: [] }, requestedAt: expect.any(Number) }]);
  ws().close();
  await Bun.sleep(5);
  open(ws());
  expect(sends(ws())).toEqual([]);
});

test("each snapshot carries when the open it answers was sent, oldest first", async () => {
  const { api, ws, data } = socket();
  open(ws());
  api.open("thread:a");
  await Bun.sleep(5);
  api.resync();
  expect(sends(ws())).toHaveLength(2);
  receive(ws(), { category: "data", action: "snapshot", stream: "thread:a", payload: { turns: [] } });
  receive(ws(), { category: "data", action: "snapshot", stream: "thread:a", payload: { turns: [] } });
  expect(data[0].requestedAt).toBeNumber();
  expect(data[1].requestedAt).toBeGreaterThan(data[0].requestedAt);
});

test("opened() waits for the server's ack, and a failed open is retried while still held", async () => {
  const { api, ws } = socket();
  open(ws());
  api.open("thread:a");
  let acked = false;
  const waiting = api.opened("thread:a", 1000).then(() => { acked = true; });
  await Bun.sleep(5);
  expect(acked).toBe(false);
  receive(ws(), { type: "opened", stream: "thread:a" });
  await waiting;
  expect(acked).toBe(true);
  expect(await Promise.race([api.opened("thread:a", 1000).then(() => "immediate"), Bun.sleep(20).then(() => "slow")])).toBe("immediate");

  api.open("events:a");
  receive(ws(), { type: "error", action: "open", stream: "events:a" });
  await Bun.sleep(1100);
  expect(sends(ws()).filter(f => f.stream === "events:a")).toHaveLength(2);
  api.close("events:a");
  receive(ws(), { type: "error", action: "open", stream: "events:a" });
  await Bun.sleep(1100);
  expect(sends(ws()).filter(f => f.action === "open" && f.stream === "events:a")).toHaveLength(2);
});
