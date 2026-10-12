import { afterEach, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { DataStreamClient } from '../src/client';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

/** A socket server the test scripts: every frame the client sends is recorded, frames go out by hand. */
function scriptedServer() {
  const received: Array<Record<string, unknown>> = [];
  let peer: ServerWebSocket<unknown> | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no', { status: 400 })),
    websocket: {
      open(ws) {
        peer = ws;
      },
      message(_ws, text) {
        received.push(JSON.parse(String(text)) as Record<string, unknown>);
      },
    },
  });
  cleanup.push(() => server.stop(true));
  const frame = (stream: string, action: 'snapshot' | 'append', seq: number, payload: unknown) =>
    peer!.send(JSON.stringify({ category: 'data', action, stream, seq, payload }));
  const opens = () => received.filter((f) => f.action === 'open').length;
  return { endpoint: `http://127.0.0.1:${server.port}`, frame, opens };
}

const settle = () => Bun.sleep(50);

test('a duplicate append (seq at or below the last) is dropped, not resynced', async () => {
  const s = scriptedServer();
  const client = new DataStreamClient({ endpoint: s.endpoint, reconnectDelayMs: 20 });
  cleanup.push(() => client.dispose());
  const seen: unknown[] = [];
  const ready = client.open('thread:t', {
    snapshot: (payload) => seen.push(['snapshot', payload]),
    append: (payload) => seen.push(payload),
  });
  await settle();
  s.frame('thread:t', 'snapshot', 3, 's');
  await ready;
  s.frame('thread:t', 'append', 3, 'dup-in-snapshot');
  s.frame('thread:t', 'append', 4, 'a4');
  s.frame('thread:t', 'append', 4, 'a4-again');
  s.frame('thread:t', 'append', 5, 'a5');
  await settle();
  expect(seen).toEqual([['snapshot', 's'], 'a4', 'a5']);
  expect(s.opens()).toBe(1);
});

test('after a gap, appends wait for the fresh snapshot instead of applying ahead of it', async () => {
  const s = scriptedServer();
  const client = new DataStreamClient({ endpoint: s.endpoint, reconnectDelayMs: 20 });
  cleanup.push(() => client.dispose());
  const seen: unknown[] = [];
  const ready = client.open('thread:t', {
    snapshot: (payload) => seen.push(['snapshot', payload]),
    append: (payload) => seen.push(payload),
  });
  await settle();
  s.frame('thread:t', 'snapshot', 1, 's1');
  await ready;
  s.frame('thread:t', 'append', 3, 'gap');
  await settle();
  expect(s.opens()).toBe(2);
  // Already in flight before the resync's snapshot: dropped, it is in that snapshot.
  s.frame('thread:t', 'append', 4, 'before-snapshot');
  s.frame('thread:t', 'snapshot', 4, 's4');
  s.frame('thread:t', 'append', 5, 'a5');
  await settle();
  expect(seen).toEqual([['snapshot', 's1'], ['snapshot', 's4'], 'a5']);
});
