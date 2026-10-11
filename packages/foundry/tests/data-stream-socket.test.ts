import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createDataStreamSocket } from '../src/viewer/ui/data-stream-socket.js';

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
  constructor(readonly url: string) {
    instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const open = (ws: FakeWebSocket) => {
  ws.readyState = FakeWebSocket.OPEN;
  ws.onopen?.();
};
const receive = (ws: FakeWebSocket, frame: unknown) =>
  ws.onmessage?.({ data: JSON.stringify(frame) });
const sends = (ws: FakeWebSocket) => ws.sent.map((s) => JSON.parse(s));

const original = globalThis.WebSocket;
beforeEach(() => {
  instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
});
afterEach(() => {
  (globalThis as any).WebSocket = original;
});

function socket(handlers: Record<string, unknown> = {}) {
  const data: any[] = [];
  const statuses: string[] = [];
  const api = createDataStreamSocket('ws://viewer/ws', {
    onData: (frame: unknown) => data.push(frame),
    onStatus: (status: string) => statuses.push(status),
    reconnectDelayMs: 0,
    ...handlers,
  });
  api.connect();
  return { api, data, statuses, ws: () => instances.at(-1)! };
}

test('opens are refcounted, sent once, and closed only when the last holder releases', () => {
  const { api, ws } = socket();
  open(ws());
  api.open('thread:a');
  api.open('thread:a');
  expect(sends(ws())).toEqual([{ action: 'open', stream: 'thread:a' }]);
  api.close('thread:a');
  expect(sends(ws())).toHaveLength(1);
  api.close('thread:a');
  expect(sends(ws()).at(-1)).toEqual({ action: 'close', stream: 'thread:a' });
  expect(api.holds('thread:a')).toBe(false);
});

test('streams held before the socket opens are opened on open, once', () => {
  const { api, ws } = socket();
  api.open('prompts');
  api.open('threads');
  expect(ws().sent).toEqual([]);
  open(ws());
  expect(sends(ws())).toEqual([
    { action: 'open', stream: 'prompts' },
    { action: 'open', stream: 'threads' },
  ]);
});

test('a reconnect replays every held stream and reports reconnect after their acks', async () => {
  let reconnected = 0;
  const { api, ws, statuses } = socket({ onReconnect: () => reconnected++ });
  const first = ws();
  open(first);
  api.open('thread:a');
  api.open('events:a');
  first.close();
  expect(statuses).toEqual(['open', 'closed']);
  await Bun.sleep(5);
  const second = ws();
  expect(second).not.toBe(first);
  open(second);
  expect(sends(second)).toEqual([
    { action: 'open', stream: 'thread:a' },
    { action: 'open', stream: 'events:a' },
  ]);
  receive(second, { type: 'opened', stream: 'thread:a' });
  expect(reconnected).toBe(0);
  receive(second, { type: 'opened', stream: 'events:a' });
  expect(reconnected).toBe(1);
});

test('a rejected stream is dropped and not replayed; frames for unheld streams are ignored', async () => {
  const rejected: string[] = [];
  const { api, ws, data } = socket({ onRejected: (stream: string) => rejected.push(stream) });
  open(ws());
  api.open('thread:gone');
  api.open('thread:a');
  receive(ws(), { type: 'openRejected', stream: 'thread:gone' });
  expect(rejected).toEqual(['thread:gone']);
  receive(ws(), {
    category: 'data',
    action: 'snapshot',
    stream: 'thread:a',
    seq: 0,
    payload: { turns: [] },
  });
  receive(ws(), { category: 'data', action: 'append', stream: 'thread:gone', payload: {} });
  api.close('thread:a');
  receive(ws(), {
    category: 'data',
    action: 'append',
    stream: 'thread:a',
    payload: { kind: 'delta' },
  });
  expect(data).toEqual([
    {
      category: 'data',
      action: 'snapshot',
      stream: 'thread:a',
      seq: 0,
      payload: { turns: [] },
      requestedAt: expect.any(Number),
    },
  ]);
  ws().close();
  await Bun.sleep(5);
  open(ws());
  expect(sends(ws())).toEqual([]);
});

test('each snapshot carries when the open it answers was sent, oldest first', async () => {
  const { api, ws, data } = socket();
  open(ws());
  api.open('thread:a');
  await Bun.sleep(5);
  api.resync();
  expect(sends(ws())).toHaveLength(2);
  receive(ws(), {
    category: 'data',
    action: 'snapshot',
    stream: 'thread:a',
    seq: 0,
    payload: { turns: [] },
  });
  receive(ws(), {
    category: 'data',
    action: 'snapshot',
    stream: 'thread:a',
    seq: 0,
    payload: { turns: [] },
  });
  expect(data[0].requestedAt).toBeNumber();
  expect(data[1].requestedAt).toBeGreaterThan(data[0].requestedAt);
});

test("opened() waits for the server's ack, and a failed open is retried while still held", async () => {
  const { api, ws } = socket();
  open(ws());
  api.open('thread:a');
  let acked = false;
  const waiting = api.opened('thread:a', 1000).then(() => {
    acked = true;
  });
  await Bun.sleep(5);
  expect(acked).toBe(false);
  receive(ws(), { type: 'opened', stream: 'thread:a' });
  await waiting;
  expect(acked).toBe(true);
  expect(
    await Promise.race([
      api.opened('thread:a', 1000).then(() => 'immediate'),
      Bun.sleep(20).then(() => 'slow'),
    ]),
  ).toBe('immediate');

  api.open('events:a');
  receive(ws(), { type: 'error', action: 'open', stream: 'events:a' });
  await Bun.sleep(1100);
  expect(sends(ws()).filter((f) => f.stream === 'events:a')).toHaveLength(2);
  api.close('events:a');
  receive(ws(), { type: 'error', action: 'open', stream: 'events:a' });
  await Bun.sleep(1100);
  expect(sends(ws()).filter((f) => f.action === 'open' && f.stream === 'events:a')).toHaveLength(2);
});

describe('sequence numbers', () => {
  const snapshot = (seq: number, ids: string[]) => ({
    category: 'data',
    action: 'snapshot',
    stream: 'thread:a',
    seq,
    payload: { ids },
  });
  const append = (seq: number, id: string) => ({
    category: 'data',
    action: 'append',
    stream: 'thread:a',
    seq,
    payload: { id },
  });
  const opens = (ws: FakeWebSocket) => sends(ws).filter((frame) => frame.action === 'open');

  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const held = () => {
    const client = socket();
    open(client.ws());
    client.api.open('thread:a');
    receive(client.ws(), { type: 'opened', stream: 'thread:a' });
    return client;
  };
  const applied = (data: any[]) =>
    data.map((frame) => (frame.action === 'snapshot' ? frame.payload.ids : frame.payload.id));

  test('applies the next seq and ignores an append already applied', () => {
    const { ws, data } = held();
    receive(ws(), snapshot(4, ['a']));
    receive(ws(), append(4, 'already-in-snapshot'));
    receive(ws(), append(5, 'b'));
    receive(ws(), append(5, 'b-again'));
    expect(applied(data)).toEqual([['a'], 'b']);
    expect(opens(ws())).toHaveLength(1);
  });

  test('a dropped append makes the stream re-open, and the fresh snapshot converges', () => {
    const { ws, data } = held();
    receive(ws(), snapshot(0, []));
    receive(ws(), append(1, 'a'));
    receive(ws(), append(3, 'c')); // 2 was lost
    expect(opens(ws())).toHaveLength(2);

    receive(ws(), append(4, 'before-resync-snapshot'));
    receive(ws(), snapshot(4, ['a', 'b', 'c', 'd']));
    receive(ws(), append(4, 'stale-after-resync'));
    receive(ws(), append(5, 'e'));
    expect(applied(data)).toEqual([[], 'a', ['a', 'b', 'c', 'd'], 'e']);
  });

  test('a gap while an open is already pending waits for that snapshot instead of sending another', () => {
    const { api, ws, data } = held();
    receive(ws(), snapshot(0, []));
    api.resync();
    receive(ws(), append(2, 'gap'));
    expect(opens(ws())).toHaveLength(2);
    receive(ws(), snapshot(2, ['x', 'gap']));
    expect(applied(data)).toEqual([[], ['x', 'gap']]);
  });

  test('an open the server answered with an error does not block a later gap from re-opening', async () => {
    const { ws, data } = held();
    receive(ws(), { type: 'error', action: 'open', stream: 'thread:a' });
    await Bun.sleep(1100);
    expect(opens(ws())).toHaveLength(2);
    receive(ws(), snapshot(0, []));
    receive(ws(), append(2, 'gap'));
    expect(opens(ws())).toHaveLength(3);
    receive(ws(), snapshot(2, ['gap']));
    expect(applied(data)).toEqual([[], ['gap']]);
  });

  test('after the server closes a socket that dropped a frame, the reconnect snapshot restores state', async () => {
    const { ws, data } = held();
    const first = ws();
    receive(first, snapshot(0, []));
    receive(first, append(1, 'a'));
    first.close();
    await Bun.sleep(5);
    const second = ws();
    open(second);
    expect(opens(second)).toEqual([{ action: 'open', stream: 'thread:a' }]);
    receive(second, append(9, 'before-snapshot'));
    receive(second, snapshot(0, ['a', 'b']));
    receive(second, append(1, 'c'));
    expect(applied(data)).toEqual([[], 'a', ['a', 'b'], 'c']);
  });
});
