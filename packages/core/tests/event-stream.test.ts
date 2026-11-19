import { describe, expect, test } from 'bun:test';
import {
  boundedPlainCopy,
  EVENT_BOUNDS,
  EventStream,
  OUTAGE_GRACE_MS,
  type StreamEvent,
} from '../src/event-stream';

function makeEvent(kind: StreamEvent['kind'], threadId: string = 'main'): StreamEvent {
  if (kind === 'session') {
    return {
      kind: 'session',
      event: { type: 'thread:added', threadId, timestamp: Date.now() },
    };
  }
  if (kind === 'signal') {
    return {
      kind: 'signal',
      threadId,
      signal: {
        id: 's1',
        kind: 'correction',
        source: 'test',
        content: {},
        timestamp: Date.now(),
      },
    };
  }
  return { kind: 'journal', threadId, turnId: null, timestamp: Date.now() };
}

describe('EventStream', () => {
  test('push notifies subscribers', () => {
    const stream = new EventStream();
    const received: StreamEvent[] = [];
    stream.subscribe((e) => received.push(e));

    stream.push(makeEvent('journal'));
    expect(received.length).toBe(1);
    expect(received[0].kind).toBe('journal');
  });

  test('multiple subscribers all get events', () => {
    const stream = new EventStream();
    const a: StreamEvent[] = [];
    const b: StreamEvent[] = [];
    stream.subscribe((e) => a.push(e));
    stream.subscribe((e) => b.push(e));

    stream.push(makeEvent('journal'));
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
  });

  test('unsubscribe stops notifications', () => {
    const stream = new EventStream();
    const received: StreamEvent[] = [];
    const unsub = stream.subscribe((e) => received.push(e));

    stream.push(makeEvent('journal'));
    unsub();
    stream.push(makeEvent('journal'));
    expect(received.length).toBe(1);
  });

  test("unsubscribe during iteration doesn't skip", () => {
    const stream = new EventStream();
    const order: string[] = [];
    let unsub2: () => void;

    stream.subscribe(() => {
      order.push('first');
      unsub2(); // unsubscribe second listener during iteration
    });
    unsub2 = stream.subscribe(() => {
      order.push('second');
    });
    stream.subscribe(() => {
      order.push('third');
    });

    stream.push(makeEvent('journal'));
    // Because we snapshot, all three should fire
    expect(order).toEqual(['first', 'second', 'third']);
  });

  test("bad listener doesn't break others", () => {
    const stream = new EventStream();
    const received: string[] = [];

    stream.subscribe(() => {
      throw new Error('bad');
    });
    stream.subscribe(() => {
      received.push('ok');
    });

    stream.push(makeEvent('journal'));
    expect(received).toEqual(['ok']);
  });

  test('recent returns history', () => {
    const stream = new EventStream();
    stream.push(makeEvent('journal', 'main'));
    stream.push(makeEvent('signal', 'main'));
    stream.push(makeEvent('journal', 'child'));

    expect(stream.recent().length).toBe(3);
  });

  test('recent filters by kind', () => {
    const stream = new EventStream();
    stream.push(makeEvent('journal'));
    stream.push(makeEvent('signal'));
    stream.push(makeEvent('journal'));

    const signals = stream.recent({ kind: 'signal' });
    expect(signals.length).toBe(1);
  });

  test('recent filters by threadId', () => {
    const stream = new EventStream();
    stream.push(makeEvent('journal', 'main'));
    stream.push(makeEvent('journal', 'child'));
    stream.push(makeEvent('session')); // session events are global

    const mainEvents = stream.recent({ threadId: 'main' });
    // main dispatch + session event (session events pass through)
    expect(mainEvents.length).toBe(2);
  });

  test('recent respects limit', () => {
    const stream = new EventStream();
    for (let i = 0; i < 10; i++) {
      stream.push(makeEvent('journal'));
    }

    expect(stream.recent({ limit: 3 }).length).toBe(3);
  });

  test('history is bounded by maxHistory', () => {
    const stream = new EventStream(5);
    for (let i = 0; i < 10; i++) {
      stream.push(makeEvent('journal'));
    }

    expect(stream.recent({ limit: 100 }).length).toBe(5);
  });

  test('clear empties history', () => {
    const stream = new EventStream();
    stream.push(makeEvent('journal'));
    stream.push(makeEvent('signal'));
    stream.clear();
    expect(stream.recent().length).toBe(0);
  });
  test('activity keeps the latest of each key past the history bound', () => {
    const stream = new EventStream(2);
    const seen: StreamEvent[] = [];
    stream.subscribe((event) => seen.push(event));
    const base = { source: 's', summary: 'x', detail: 'd' };
    stream.pushActivity({ ...base, key: 'a', state: 'working' });
    stream.pushActivity({ ...base, key: 'b', state: 'failed' });
    stream.pushActivity({ ...base, key: 'a', state: 'ready' });
    for (let i = 0; i < 5; i++) stream.push(makeEvent('journal'));
    expect(seen.filter((e) => e.kind === 'activity').length).toBe(3);
    expect(stream.activities().map((a) => [a.key, a.state])).toEqual([
      ['b', 'failed'],
      ['a', 'ready'],
    ]);
    stream.clear();
    expect(stream.activities()).toEqual([]);
  });
  test('an outage keeps the time it began until the key recovers; a new outage starts again', () => {
    const stream = new EventStream();
    const seen: StreamEvent[] = [];
    stream.subscribe((event) => seen.push(event));
    const base = { source: 's', summary: 'x', detail: 'd', key: 'a' };
    const at = (
      timestamp: number,
      state: 'working' | 'ready' | 'degraded' | 'failed',
      until?: number,
    ) => stream.push({ kind: 'activity', ...base, state, timestamp, ...(until ? { until } : {}) });
    const started = () => {
      const last = seen.at(-1);
      return last?.kind === 'activity' ? last.outageStartedAt : 'not activity';
    };
    at(1, 'working');
    expect(started()).toBeUndefined();
    at(2, 'degraded');
    expect(started()).toBe(2);
    at(3, 'failed');
    expect(started()).toBe(2);
    at(4, 'ready');
    expect(started()).toBeUndefined();
    at(5, 'failed');
    expect(started()).toBe(5);
    expect(stream.activities()[0]?.outageStartedAt).toBe(5);
    // A rate limit's next attempt lands after its `until`: the same outage, not a new notice.
    at(6, 'degraded', 7);
    expect(started()).toBe(5);
    at(9, 'degraded', 10);
    expect(started()).toBe(5);
    // A retry between failed starts stays in the outage.
    at(11, 'working');
    expect(started()).toBe(5);
    at(12, 'degraded');
    expect(started()).toBe(5);
    at(13, 'ready');
    at(14, 'working');
    expect(started()).toBeUndefined();
    // Quiet for longer than the grace after its `until`: a later limit is a new outage.
    at(20, 'degraded', 21);
    expect(started()).toBe(20);
    at(21 + OUTAGE_GRACE_MS, 'degraded', 22 + OUTAGE_GRACE_MS);
    expect(started()).toBe(21 + OUTAGE_GRACE_MS);
  });
});

describe('what the stream keeps', () => {
  const signalWith = (content: Record<string, unknown>): StreamEvent => ({
    kind: 'signal',
    threadId: 'main',
    signal: { id: 's', kind: 'tool_observation', source: 'test', content, timestamp: 1 },
  });

  test('an event holding a cycle is kept serializable, and its path is reported', () => {
    const stream = new EventStream();
    const node: Record<string, unknown> = { id: 'n' };
    node.self = node;
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (line: string) => warned.push(line);
    try {
      stream.push(signalWith({ node }));
      stream.push(signalWith({ node }));
    } finally {
      console.warn = warn;
    }
    const [kept] = stream.recent({ limit: 1 });
    expect(JSON.parse(JSON.stringify(kept))).toMatchObject({
      signal: { content: { node: { id: 'n', self: '[cycle]' } } },
    });
    expect(warned).toEqual([
      '[EventStream] cycle at signal:tool_observation:test:.signal.content.node.self (copied as a placeholder)',
    ]);
  });

  test('listeners get the kept copy, never the live object', () => {
    const stream = new EventStream();
    const content = { n: 1 };
    let heard: StreamEvent | undefined;
    stream.subscribe((event) => {
      heard = event;
    });
    stream.push(signalWith(content));
    content.n = 2;
    expect(heard).toEqual(stream.recent({ limit: 1 })[0]);
    expect((heard as Extract<StreamEvent, { kind: 'signal' }>).signal.content).toEqual({ n: 1 });
  });

  test('long strings, long lists and deep nesting are cut to the bounds', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < EVENT_BOUNDS.depth + 2; i++) deep = { deep };
    const copy = boundedPlainCopy({
      text: 'x'.repeat(EVENT_BOUNDS.string + 5),
      list: Array.from({ length: EVENT_BOUNDS.items + 3 }, (_, i) => i),
      deep,
      skip: () => 1,
      big: 10n,
      when: new Date(0),
      failure: new Error('boom'),
    }) as Record<string, unknown>;
    expect(copy.text).toBe(`${'x'.repeat(EVENT_BOUNDS.string)}… [+5 chars]`);
    expect((copy.list as unknown[]).length).toBe(EVENT_BOUNDS.items + 1);
    expect((copy.list as unknown[]).at(-1)).toBe('… [+3 items]');
    expect(JSON.stringify(copy.deep)).toContain('[too deep]');
    expect('skip' in copy).toBe(false);
    expect(copy.big).toBe('10');
    expect(copy.when).toBe('1970-01-01T00:00:00.000Z');
    expect(copy.failure).toEqual({ name: 'Error', message: 'boom' });
  });

  test('a shared object seen twice is not a cycle', () => {
    const shared = { a: 1 };
    expect(boundedPlainCopy({ x: shared, y: shared })).toEqual({ x: { a: 1 }, y: { a: 1 } });
  });

  test('a toJSON returning its own object is applied once, and its fields are copied', () => {
    const self = {
      id: 'n',
      toJSON() {
        return this;
      },
    };
    expect(boundedPlainCopy({ self })).toEqual({ self: { id: 'n' } });
    const chained = { toJSON: () => ({ toJSON: () => 'never', kept: 1 }) };
    expect(boundedPlainCopy(chained)).toEqual({ kept: 1 });
  });

  test('a value that throws when read becomes a placeholder; push never throws', () => {
    const problems: string[] = [];
    const hostile = {
      ok: 1,
      get bad(): never {
        throw new Error('nope');
      },
    };
    const copy = boundedPlainCopy(
      {
        hostile,
        json: {
          toJSON: () => {
            throw new Error('no');
          },
        },
      },
      (p) => problems.push(`${p.problem}${p.path}`),
    );
    expect(copy).toEqual({ hostile: { ok: 1, bad: '[unreadable]' }, json: '[unreadable]' });
    expect(problems).toEqual(['unreadable.hostile.bad', 'unreadable.json']);
    const stream = new EventStream();
    const event = makeEvent('signal');
    if (event.kind !== 'signal') throw new Error('expected a signal event');
    const hostileSignal: StreamEvent = {
      ...event,
      signal: { ...event.signal, content: { hostile } },
    };
    expect(() => stream.push(hostileSignal)).not.toThrow();
    expect(stream.recent()[0]).toMatchObject({
      signal: { content: { hostile: { bad: '[unreadable]' } } },
    });
  });

  test('a shared subtree referenced many times is bounded in total', () => {
    const wide = Array.from({ length: 50 }, () => 'x'.repeat(2_000));
    let tree: unknown = wide;
    for (let level = 0; level < 4; level++) tree = Array.from({ length: 50 }, () => tree);
    const problems: string[] = [];
    const copy = boundedPlainCopy(tree, (p) => problems.push(p.problem));
    const size = JSON.stringify(copy).length;
    expect(size).toBeLessThan(EVENT_BOUNDS.chars + EVENT_BOUNDS.nodes * 40);
    expect(problems).toEqual(['size']);
  });

  test('recent with a condition returns the newest matches, oldest first', () => {
    const stream = new EventStream();
    for (let i = 0; i < 6; i++) stream.push(makeEvent('journal', i % 2 ? 'odd' : 'even'));
    const odd = stream.recent({ where: (e) => 'threadId' in e && e.threadId === 'odd', limit: 2 });
    expect(odd.length).toBe(2);
    expect(stream.recent({ limit: 0 }).length).toBe(6);
  });
});
