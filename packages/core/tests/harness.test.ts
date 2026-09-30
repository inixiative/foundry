import { describe, expect, test } from 'bun:test';
import { Clarifier } from '../src/clarifier';
import { type Classification, Classifier } from '../src/classifier';
import { ContextLayer, type ContextSource } from '../src/context-layer';
import { ContextStack } from '../src/context-stack';
import { Executor } from '../src/executor';
import { Harness, type Message } from '../src/harness';
import { type Route, Router } from '../src/router';
import { Thread } from '../src/thread';

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

test('an unknown mandatory executor fails instead of returning router JSON', async () => {
  const stack = new ContextStack();
  const thread = new Thread('missing-executor', stack);
  thread.register(
    new Router({
      id: 'router',
      stack,
      handler: async () => ({ value: { destination: 'not-registered' }, confidence: 1 }),
    }),
  );
  const harness = new Harness(thread);
  harness.setRouter('router');
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

  // Register agents
  thread.register(
    new Classifier({
      id: 'classifier',
      stack,
      handler: async (ctx, payload: unknown) => ({
        value: { category: 'bug', tags: ['auth'] },
        confidence: 0.9,
      }),
    }),
  );

  thread.register(
    new Router({
      id: 'router',
      stack,
      handler: async (ctx, payload: any) => ({
        value: {
          destination: 'executor-fix',
          priority: 10,
          contextSlice: ['docs'],
        },
        confidence: 0.85,
      }),
    }),
  );

  thread.register(
    new Executor({
      id: 'executor-fix',
      stack,
      handler: async (ctx, payload: unknown) => `fixed: ${payload}`,
    }),
  );

  thread.register(
    new Executor({
      id: 'executor-answer',
      stack,
      handler: async (ctx, payload: unknown) => `answered: ${payload}`,
    }),
  );

  const harness = new Harness(thread);
  harness.setClassifier('classifier');
  harness.setRouter('router');
  harness.setDefaultExecutor('executor-answer');

  return { harness, thread, stack };
}

describe('Harness', () => {
  test('full pipeline: classify → route → dispatch', async () => {
    const { harness } = makeHarness();

    const result = await harness.send({
      id: 'msg-1',
      payload: 'fix the auth bug',
    });

    expect(result.messageId).toBe('msg-1');
    expect(result.classification).toBeDefined();
    expect(result.classification!.value.category).toBe('bug');
    expect(result.route).toBeDefined();
    expect(result.route!.value.destination).toBe('executor-fix');
    expect(result.result.output).toBe('fixed: fix the auth bug');
    expect(result.trace).toBeDefined();
    expect(result.timestamp).toBeGreaterThan(0);
  });

  test('trace records classify, route, dispatch spans', async () => {
    const { harness } = makeHarness();
    const result = await harness.send({ id: 'msg-1', payload: 'test' });

    const summary = result.trace.summary();
    const kinds = summary.stages.map((s) => s.kind);
    expect(kinds).toContain('ingress');
    expect(kinds).toContain('classify');
    expect(kinds).toContain('route');
    expect(kinds).toContain('execute');
  });

  test('works without classifier', async () => {
    const { thread } = makeHarness();
    const h = new Harness(thread);
    h.setRouter('router');
    h.setDefaultExecutor('executor-answer');

    const result = await h.send({ id: 'msg-1', payload: 'hello' });
    expect(result.classification).toBeUndefined();
    expect(result.route).toBeDefined();
  });

  test('works without router (uses default executor)', async () => {
    const { thread } = makeHarness();
    const h = new Harness(thread);
    h.setDefaultExecutor('executor-answer');

    const result = await h.send({ id: 'msg-1', payload: 'hello' });
    expect(result.classification).toBeUndefined();
    expect(result.route).toBeUndefined();
    expect(result.result.output).toBe('answered: hello');
  });

  test('throws without executor or router', async () => {
    const { thread } = makeHarness();
    const h = new Harness(thread);

    expect(h.send({ id: 'msg-1', payload: 'hello' })).rejects.toThrow('No target agent');
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

  test('direct dispatch bypasses classify/route', async () => {
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

test('classification and routing run concurrently on the frozen message; results apply in configured order', async () => {
  const stack = new ContextStack();
  const thread = new Thread('concurrent', stack);
  const inputs: Record<string, unknown> = {};
  const running = new Set<string>();
  let overlap = false;
  const decide = async <T>(id: string, input: unknown, value: T) => {
    inputs[id] = input;
    running.add(id);
    if (running.size > 1) overlap = true;
    await Bun.sleep(40);
    running.delete(id);
    return { value, confidence: 1 };
  };
  thread.register(
    new Classifier({
      id: 'classifier',
      stack,
      handler: async (_ctx, payload: unknown) =>
        decide('classifier', payload, { category: 'bug', tags: [] } as Classification),
    }),
  );
  thread.register(
    new Router({
      id: 'router',
      stack,
      handler: async (_ctx, payload: unknown) =>
        decide('router', payload, {
          destination: 'worker',
          contextSlice: [],
          priority: 1,
        } as Route),
    }),
  );
  thread.register(
    new Executor({
      id: 'worker',
      stack,
      handler: async (_ctx, payload: unknown) => ({ output: `done:${payload}`, contextHash: '' }),
    }),
  );
  const harness = new Harness(thread);
  harness.setClassifier('classifier');
  harness.setRouter('router');
  const classifications: unknown[] = [];
  thread.signals.on('classification', (signal) => {
    classifications.push(signal.content);
  });
  try {
    const started = performance.now();
    const result = await harness.send({ id: 'm1', payload: 'fix login' });
    expect(overlap).toBe(true);
    expect(performance.now() - started).toBeLessThan(75);
    expect(inputs).toEqual({ classifier: 'fix login', router: 'fix login' });
    expect(result.classification?.value).toEqual({ category: 'bug', tags: [] });
    expect(result.route?.value.destination).toBe('worker');
    expect(result.invokedAgents.map((a) => a.id)).toEqual(['classifier', 'router', 'worker']);
    expect(classifications).toEqual([{ category: 'bug', tags: [] }]);
    const spans = result.trace.root.children.map((s) => [s.name, s.status]);
    expect(spans).toEqual([
      ['classify:classifier', 'ok'],
      ['route:router', 'ok'],
      ['execute:worker', 'ok'],
    ]);
  } finally {
    thread.dispose();
  }
});

describe('clarify stage', () => {
  function clarifyHarness(needed: boolean) {
    const stack = new ContextStack();
    const thread = new Thread('clarify', stack);
    const seen: { clarify?: unknown; executed: boolean } = { executed: false };
    thread.register(
      new Classifier({
        id: 'classifier',
        stack,
        handler: async () => ({ value: { category: 'code-generation' }, confidence: 1 }),
      }),
    );
    thread.register(
      new Clarifier({
        id: 'clarifier',
        stack,
        handler: async (_ctx, payload) => {
          seen.clarify = payload;
          return {
            value: needed ? { needed: true, questions: ['Which language?'] } : { needed: false },
            confidence: 1,
          };
        },
      }),
    );
    thread.register(
      new Executor({
        id: 'executor',
        stack,
        handler: async () => {
          seen.executed = true;
          return 'done';
        },
      }),
    );
    const harness = new Harness(thread);
    harness.setFlow({
      stages: [
        { agentId: 'classifier', role: 'classify', invocation: 'always' },
        { agentId: 'clarifier', role: 'clarify', invocation: 'always' },
        { agentId: 'executor', role: 'execute', invocation: 'always' },
      ],
    });
    return { harness, thread, seen };
  }

  test('an underspecified request returns questions without executing', async () => {
    const { harness, thread, seen } = clarifyHarness(true);
    try {
      const result = await harness.send({ id: 'c1', payload: 'write a function' });
      expect(seen.clarify).toEqual({
        message: 'write a function',
        classification: { category: 'code-generation' },
      });
      expect(seen.executed).toBe(false);
      expect(result.clarification).toEqual({ needed: true, questions: ['Which language?'] });
      expect(result.result.output).toBeNull();
      expect(result.invokedAgents?.map((a) => a.id)).toEqual(['classifier', 'clarifier']);
    } finally {
      thread.dispose();
    }
  });

  test('a complete request executes', async () => {
    const { harness, thread, seen } = clarifyHarness(false);
    try {
      const result = await harness.send({ id: 'c2', payload: 'write a TypeScript function' });
      expect(seen.executed).toBe(true);
      expect(result.clarification).toEqual({ needed: false });
      expect(result.result.output).toBe('done');
    } finally {
      thread.dispose();
    }
  });
});
