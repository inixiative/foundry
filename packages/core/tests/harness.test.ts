import { describe, expect, test } from 'bun:test';
import { ContextLayer, type ContextSource } from '../src/context-layer';
import { ContextStack } from '../src/context-stack';
import { Executor } from '../src/executor';
import { Harness } from '../src/harness';
import { Thread } from '../src/thread';

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

test('an unregistered default executor fails instead of returning nothing', async () => {
  const stack = new ContextStack();
  const thread = new Thread('missing-executor', stack);
  const harness = new Harness(thread);
  harness.setDefaultExecutor('not-registered');
  try {
    await expect(harness.send({ id: 'missing', payload: 'Do real work' })).rejects.toThrow(
      'not-registered',
    );
  } finally {
    thread.dispose();
  }
});

function makeHarness(): {
  harness: Harness;
  thread: Thread;
  stack: ContextStack;
} {
  const stack = new ContextStack([
    (() => {
      const l = new ContextLayer({
        id: 'docs',
        sources: [source('docs', 'test docs')],
      });
      l.set('test docs');
      return l;
    })(),
  ]);
  const thread = new Thread('main', stack);

  thread.register(
    new Executor({
      id: 'executor-fix',
      stack,
      handler: async (_ctx, payload: unknown) => `fixed: ${payload}`,
    }),
  );

  thread.register(
    new Executor({
      id: 'executor-answer',
      stack,
      handler: async (_ctx, payload: unknown) => `answered: ${payload}`,
    }),
  );

  const harness = new Harness(thread);
  harness.setDefaultExecutor('executor-answer');

  return { harness, thread, stack };
}

describe('Harness', () => {
  test('the default executor runs every message', async () => {
    const { harness } = makeHarness();

    const result = await harness.send({
      id: 'msg-1',
      payload: 'fix the auth bug',
    });

    expect(result.messageId).toBe('msg-1');
    expect(result.result.output).toBe('answered: fix the auth bug');
    expect(result.trace).toBeDefined();
    expect(result.timestamp).toBeGreaterThan(0);
    expect(result.trace.summary().stages.map((s) => s.kind)).toEqual(
      expect.arrayContaining(['ingress', 'execute']),
    );
  });

  test('throws without a default executor', async () => {
    const { thread } = makeHarness();
    const h = new Harness(thread);

    expect(h.send({ id: 'msg-1', payload: 'hello' })).rejects.toThrow(
      'No default executor is configured',
    );
  });

  test('error in pipeline records trace', async () => {
    const { thread, stack } = makeHarness();
    thread.register(
      new Executor({
        id: 'failing',
        stack,
        handler: async () => {
          throw new Error('execution failed');
        },
      }),
    );

    const h = new Harness(thread);
    h.setDefaultExecutor('failing');

    try {
      await h.send({ id: 'msg-1', payload: 'test' });
    } catch (e) {
      expect((e as Error).message).toBe('execution failed');
    }

    // Trace should still be recorded
    expect(h.traces.length).toBe(1);
    const trace = h.traces[0];
    expect(trace.endedAt).toBeDefined();
  });

  test('trace history is bounded', async () => {
    const { thread } = makeHarness();
    const h = new Harness(thread, { maxTraces: 3 });
    h.setDefaultExecutor('executor-answer');

    for (let i = 0; i < 5; i++) {
      await h.send({ id: `msg-${i}`, payload: 'test' });
    }

    expect(h.traces.length).toBe(3);
    // Most recent should be kept
    expect(h.traces[h.traces.length - 1].messageId).toBe('msg-4');
  });

  test('getTrace and getTraceForMessage', async () => {
    const { harness } = makeHarness();
    const result = await harness.send({ id: 'msg-1', payload: 'test' });

    expect(harness.getTrace(result.trace.id)).toBe(result.trace);
    expect(harness.getTraceForMessage('msg-1')).toBe(result.trace);
    expect(harness.getTrace('nonexistent')).toBeUndefined();
    expect(harness.getTraceForMessage('nonexistent')).toBeUndefined();
  });

  test('direct dispatch bypasses the pipeline', async () => {
    const { harness } = makeHarness();
    const result = await harness.dispatch('executor-answer', 'hello');
    expect(result.output).toBe('answered: hello');
  });

  test('fan dispatches to multiple agents', async () => {
    const { harness } = makeHarness();
    const results = await harness.fan(['executor-fix', 'executor-answer'], 'test');
    expect(results.length).toBe(2);
    expect(results[0].result?.output).toBe('fixed: test');
    expect(results[1].result?.output).toBe('answered: test');
  });
});
